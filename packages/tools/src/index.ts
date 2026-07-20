import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerConfig } from '@kyokao/config';
const run = promisify(execFile);
const DEFAULT_MAX_OUTPUT = 30_000;
const DEFAULT_MAX_SHELL_TIMEOUT = 120_000;
const DEFAULT_MAX_FILE_BYTES = 2_000_000;
export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
export type Approve = (action: string, detail: string) => Promise<boolean>;
export interface ToolResult {
  content: string;
  isError?: boolean;
  data?: unknown;
}
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}
export interface ToolLimits {
  maxShellTimeoutMs: number;
  maxOutputChars: number;
  maxFileBytes: number;
  allowedHosts: string[];
}
export interface ToolExecutor {
  definitions(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close?(): Promise<void>;
}
export interface KyokaoPlugin {
  name: string;
  tools: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult | undefined>;
  close?(): Promise<void>;
}
const clipped = (s: string, max = DEFAULT_MAX_OUTPUT) =>
  s.length > max ? `${s.slice(0, max)}\n…truncated…` : s;
const comparablePath = (path: string) => {
  const withoutDevicePrefix =
    process.platform === 'win32'
      ? path.startsWith('\\\\?\\UNC\\')
        ? `\\\\${path.slice(8)}`
        : path.startsWith('\\\\?\\')
          ? path.slice(4)
          : path
      : path;
  const normalized = resolve(withoutDevicePrefix);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const isWithin = (root: string, candidate: string) => {
  const path = relative(comparablePath(root), comparablePath(candidate));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const spec = (
  name: string,
  description: string,
  properties: object,
  required: string[] = [],
): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
});
export class WorkspaceSandbox {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  async path(input: unknown): Promise<string> {
    if (typeof input !== 'string' || !input || input.includes('\0'))
      throw new Error('path must be a non-empty string');
    const target = resolve(this.root, input);
    if (!isWithin(this.root, target)) throw new Error('Path escapes workspace');
    const canonicalRoot = await realpath(this.root);
    let ancestor = target;
    while (true) {
      try {
        const actual = await realpath(ancestor);
        if (!isWithin(canonicalRoot, actual)) throw new Error('Symlink escapes workspace');
        break;
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw new Error('Path has no existing ancestor');
        ancestor = parent;
      }
    }
    return target;
  }
}
export class CoreTools implements ToolExecutor {
  constructor(
    private sandbox: WorkspaceSandbox,
    private approval: ApprovalMode,
    private approve: Approve = async () => false,
    private limits: ToolLimits = {
      maxShellTimeoutMs: DEFAULT_MAX_SHELL_TIMEOUT,
      maxOutputChars: DEFAULT_MAX_OUTPUT,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      allowedHosts: [],
    },
  ) {}
  definitions(): ToolDefinition[] {
    return [
      spec(
        'read_file',
        'Read a UTF-8 file',
        { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } },
        ['path'],
      ),
      spec(
        'list_files',
        'List a directory tree',
        { path: { type: 'string' }, depth: { type: 'integer' } },
        [],
      ),
      spec(
        'glob',
        'Find files by simple glob',
        { pattern: { type: 'string' }, path: { type: 'string' } },
        ['pattern'],
      ),
      spec(
        'grep',
        'Search files using a regex',
        { query: { type: 'string' }, path: { type: 'string' } },
        ['query'],
      ),
      spec(
        'write_file',
        'Create or replace a UTF-8 file',
        { path: { type: 'string' }, content: { type: 'string' } },
        ['path', 'content'],
      ),
      spec(
        'apply_patch',
        'Replace exact text in a file',
        { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } },
        ['path', 'search', 'replace'],
      ),
      spec(
        'shell',
        'Execute a command in the workspace',
        { command: { type: 'string' }, timeoutMs: { type: 'number' } },
        ['command'],
      ),
      spec(
        'git',
        'Run a read-only git subcommand',
        { args: { type: 'array', items: { type: 'string' } } },
        ['args'],
      ),
      spec('http_get', 'Fetch a HTTP(S) URL', { url: { type: 'string' } }, ['url']),
    ];
  }
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'read_file':
          return await this.read(args);
        case 'list_files':
          return await this.list(args);
        case 'glob':
          return await this.glob(args);
        case 'grep':
          return await this.grep(args);
        case 'write_file':
          return await this.write(args);
        case 'apply_patch':
          return await this.patch(args);
        case 'shell':
          return await this.shell(args);
        case 'git':
          return await this.git(args);
        case 'http_get':
          return await this.http(args);
        default:
          return { content: `Unknown tool: ${name}`, isError: true };
      }
    } catch (e: any) {
      return { content: e.message ?? String(e), isError: true };
    }
  }
  private async allowed(action: string, detail: string) {
    return (
      this.approval === 'full-auto' ||
      (this.approval === 'auto-edit' && (action === 'write_file' || action === 'apply_patch')) ||
      (await this.approve(action, detail))
    );
  }
  private async read(a: Record<string, unknown>): Promise<ToolResult> {
    const path = await this.sandbox.path(a.path);
    if ((await stat(path)).size > this.limits.maxFileBytes)
      throw new Error(`File exceeds safety limit of ${this.limits.maxFileBytes} bytes`);
    const text = await readFile(path, 'utf8');
    const start = typeof a.startLine === 'number' ? a.startLine : 1,
      end = typeof a.endLine === 'number' ? a.endLine : undefined;
    const out = text
      .split('\n')
      .slice(start - 1, end)
      .map((l, i) => `${start + i}: ${l}`)
      .join('\n');
    return { content: clipped(out, this.limits.maxOutputChars) };
  }
  private async list(a: Record<string, unknown>): Promise<ToolResult> {
    const depth = Math.min(typeof a.depth === 'number' ? a.depth : 2, 5),
      out: string[] = [];
    const walk = async (d: string, n: number): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'dist'].includes(e.name)) continue;
        const f = resolve(d, e.name);
        out.push(`${e.isDirectory() ? 'd' : 'f'} ${relative(this.sandbox.root, f)}`);
        if (e.isDirectory() && n < depth && out.length < 500) await walk(f, n + 1);
      }
    };
    await walk(await this.sandbox.path(a.path ?? '.'), 0);
    return { content: clipped(out.join('\n'), this.limits.maxOutputChars), data: out };
  }
  private async glob(a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.pattern !== 'string') throw new Error('pattern must be a string');
    const regex = new RegExp(
      '^' +
        a.pattern
          .split('*')
          .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    );
    const tree = await this.list({ path: a.path ?? '.', depth: 5 });
    const found = (tree.data as string[])
      .filter((x) => x.startsWith('f ') && regex.test(x.slice(2)))
      .map((x) => x.slice(2));
    return { content: clipped(found.join('\n'), this.limits.maxOutputChars), data: found };
  }
  private async grep(a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.query !== 'string') throw new Error('query must be a string');
    const re = new RegExp(a.query, 'g'),
      root = await this.sandbox.path(a.path ?? '.'),
      out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'dist'].includes(e.name)) continue;
        const f = resolve(d, e.name);
        if (e.isDirectory()) await walk(f);
        else {
          try {
            const t = await readFile(f, 'utf8');
            t.split('\n').forEach((l, i) => {
              re.lastIndex = 0;
              if (re.test(l) && out.length < 200)
                out.push(`${relative(this.sandbox.root, f)}:${i + 1}:${l}`);
            });
          } catch {}
        }
      }
    };
    await walk(root);
    return { content: clipped(out.join('\n'), this.limits.maxOutputChars), data: out };
  }
  private async write(a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.content !== 'string') throw new Error('content must be a string');
    if (Buffer.byteLength(a.content) > this.limits.maxFileBytes)
      throw new Error(`File exceeds safety limit of ${this.limits.maxFileBytes} bytes`);
    const path = await this.sandbox.path(a.path);
    if (!(await this.allowed('write_file', path)))
      return { content: 'Permission denied', isError: true };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, a.content);
    return { content: `Wrote ${String(a.path)}` };
  }
  private async patch(a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.search !== 'string' || typeof a.replace !== 'string')
      throw new Error('search and replace must be strings');
    const path = await this.sandbox.path(a.path);
    if (!(await this.allowed('apply_patch', path)))
      return { content: 'Permission denied', isError: true };
    if ((await stat(path)).size > this.limits.maxFileBytes)
      throw new Error(`File exceeds safety limit of ${this.limits.maxFileBytes} bytes`);
    const before = await readFile(path, 'utf8');
    if (!a.search || before.indexOf(a.search) !== before.lastIndexOf(a.search))
      return { content: 'Search text must occur exactly once', isError: true };
    const updated = before.replace(a.search, a.replace);
    if (Buffer.byteLength(updated) > this.limits.maxFileBytes)
      throw new Error(`File exceeds safety limit of ${this.limits.maxFileBytes} bytes`);
    await writeFile(path, updated);
    return { content: `Patched ${String(a.path)}` };
  }
  private async shell(a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.command !== 'string') throw new Error('command must be a string');
    if (!(await this.allowed('shell', a.command)))
      return { content: 'Permission denied', isError: true };
    const timeout = Math.min(
      Math.max(typeof a.timeoutMs === 'number' ? a.timeoutMs : 30000, 1000),
      this.limits.maxShellTimeoutMs,
    );
    const cmd = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
      args = process.platform === 'win32' ? ['/d', '/s', '/c', a.command] : ['-lc', a.command];
    try {
      const r = await run(cmd, args, {
        cwd: this.sandbox.root,
        timeout,
        maxBuffer: this.limits.maxOutputChars * 2,
      });
      return {
        content: clipped((r.stdout ?? '') + (r.stderr ?? ''), this.limits.maxOutputChars),
      };
    } catch (e: any) {
      return {
        content: clipped(
          `${e.stdout ?? ''}${e.stderr ?? ''}\nexit code: ${e.code ?? 'unknown'}`,
          this.limits.maxOutputChars,
        ),
        isError: true,
      };
    }
  }
  private async git(a: Record<string, unknown>): Promise<ToolResult> {
    if (
      !Array.isArray(a.args) ||
      !a.args.every((x) => typeof x === 'string') ||
      !['status', 'diff', 'log', 'show', 'branch'].includes(a.args[0])
    )
      return {
        content: 'Only read-only git status/diff/log/show/branch are allowed',
        isError: true,
      };
    const r = await run('git', a.args, {
      cwd: this.sandbox.root,
      timeout: 30000,
      maxBuffer: this.limits.maxOutputChars * 2,
    });
    return { content: clipped(r.stdout + r.stderr, this.limits.maxOutputChars) };
  }
  private async http(a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.url !== 'string') throw new Error('url must be a string');
    const url = new URL(a.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs allowed');
    if (this.limits.allowedHosts.length && !this.limits.allowedHosts.includes(url.hostname))
      throw new Error(`Network host is not allowed: ${url.hostname}`);
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    return {
      content: clipped(await r.text(), this.limits.maxOutputChars),
      isError: !r.ok,
    };
  }
}

export class CompositeTools implements ToolExecutor {
  constructor(private readonly executors: ToolExecutor[]) {}
  definitions(): ToolDefinition[] {
    return this.executors.flatMap((executor) => executor.definitions());
  }
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    for (const executor of this.executors) {
      if (executor.definitions().some((definition) => definition.function.name === name))
        return executor.execute(name, args);
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  }
  async close(): Promise<void> {
    await Promise.all(this.executors.map((executor) => executor.close?.()));
  }
}

class PluginTools implements ToolExecutor {
  constructor(private readonly plugin: KyokaoPlugin) {}
  definitions(): ToolDefinition[] {
    return this.plugin.tools;
  }
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (
      (await this.plugin.execute(name, args)) ?? {
        content: `Plugin ${this.plugin.name} does not implement ${name}`,
        isError: true,
      }
    );
  }
  async close(): Promise<void> {
    await this.plugin.close?.();
  }
}

function validToolDefinition(value: unknown): value is ToolDefinition {
  const definition = value as ToolDefinition;
  return (
    !!definition &&
    definition.type === 'function' &&
    typeof definition.function?.name === 'string' &&
    typeof definition.function?.description === 'string' &&
    !!definition.function.parameters &&
    typeof definition.function.parameters === 'object'
  );
}

export async function loadPlugins(paths: string[], cwd = process.cwd()): Promise<ToolExecutor[]> {
  const loaded: ToolExecutor[] = [];
  for (const rawPath of paths) {
    const path = resolve(cwd, rawPath);
    const module = await import(/* @vite-ignore */ pathToFileURL(path).href);
    const plugin = (module.default ?? module.plugin) as Partial<KyokaoPlugin> | undefined;
    if (
      !plugin ||
      typeof plugin.name !== 'string' ||
      !Array.isArray(plugin.tools) ||
      !plugin.tools.every(validToolDefinition) ||
      typeof plugin.execute !== 'function'
    )
      throw new Error(`Invalid Kyokao plugin: ${rawPath}`);
    loaded.push(new PluginTools(plugin as KyokaoPlugin));
  }
  return loaded;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class McpClient {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: JsonRpcMessage) => void; reject: (error: Error) => void }
  >();
  private buffer = Buffer.alloc(0);
  private initialized = false;
  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly root: string,
  ) {}
  async start(): Promise<void> {
    this.process = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd ? resolve(this.root, this.config.cwd) : this.root,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    this.process.on('error', (error) => this.rejectAll(error));
    this.process.on('exit', () => this.rejectAll(new Error(`MCP server ${this.name} exited`)));
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kyokao', version: '0.1.0' },
    });
    await this.notify('notifications/initialized', {});
    this.initialized = true;
  }
  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.request('tools/list', {});
    const tools = Array.isArray(result.result?.tools) ? result.result.tools : [];
    return tools
      .filter(
        (tool): tool is { name: string; description?: string; inputSchema?: object } =>
          !!tool &&
          typeof tool === 'object' &&
          typeof (tool as { name?: unknown }).name === 'string',
      )
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: `mcp_${this.name}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
          description: `[MCP ${this.name}] ${tool.description ?? tool.name}`,
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        },
      }));
  }
  async call(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.initialized) throw new Error(`MCP server ${this.name} is not initialized`);
    const rawName = toolName.replace(`mcp_${this.name}_`, '');
    const result = await this.request('tools/call', { name: rawName, arguments: args });
    const content = Array.isArray(result.result?.content)
      ? result.result.content
          .map((item) => (item && typeof item === 'object' && 'text' in item ? item.text : item))
          .join('\n')
      : JSON.stringify(result.result ?? {});
    return { content, isError: result.result?.isError === true };
  }
  async close(): Promise<void> {
    this.process?.kill();
    this.rejectAll(new Error(`MCP server ${this.name} closed`));
  }
  private async notify(method: string, params: Record<string, unknown>) {
    this.write({ jsonrpc: '2.0', method, params });
  }
  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  private write(message: JsonRpcMessage) {
    if (!this.process?.stdin.writable) throw new Error(`MCP server ${this.name} is unavailable`);
    const body = Buffer.from(JSON.stringify(message));
    this.process.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.process.stdin.write(body);
  }
  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headers = this.buffer.subarray(0, headerEnd).toString();
      const match = headers.match(/Content-Length:\s*(\d+)/i);
      if (!match) throw new Error(`Invalid MCP response from ${this.name}`);
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = JSON.parse(
        this.buffer.subarray(start, start + length).toString(),
      ) as JsonRpcMessage;
      this.buffer = this.buffer.subarray(start + length);
      if (body.id !== undefined) {
        const pending = this.pending.get(body.id);
        if (!pending) continue;
        this.pending.delete(body.id);
        if (body.error) pending.reject(new Error(body.error.message ?? 'MCP request failed'));
        else pending.resolve(body);
      }
    }
  }
  private rejectAll(error: Error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

class McpTools implements ToolExecutor {
  private definitionsByName = new Map<string, { client: McpClient; definition: ToolDefinition }>();
  constructor(private readonly clients: McpClient[]) {}
  async start(): Promise<void> {
    for (const client of this.clients) {
      await client.start();
      for (const definition of await client.listTools())
        this.definitionsByName.set(definition.function.name, { client, definition });
    }
  }
  definitions(): ToolDefinition[] {
    return [...this.definitionsByName.values()].map(({ definition }) => definition);
  }
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.definitionsByName.get(name);
    return entry
      ? entry.client.call(name, args)
      : { content: `Unknown MCP tool: ${name}`, isError: true };
  }
  async close(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.close()));
  }
}

export async function connectMcp(
  servers: Record<string, McpServerConfig>,
  cwd = process.cwd(),
): Promise<ToolExecutor | undefined> {
  const entries = Object.entries(servers);
  if (!entries.length) return undefined;
  const tools = new McpTools(entries.map(([name, config]) => new McpClient(name, config, cwd)));
  await tools.start();
  return tools;
}
