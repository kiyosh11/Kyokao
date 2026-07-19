import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
const run = promisify(execFile);
const MAX = 30_000;
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
const clipped = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}\n…truncated…` : s);
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
export class CoreTools {
  constructor(
    private sandbox: WorkspaceSandbox,
    private approval: ApprovalMode,
    private approve: Approve = async () => false,
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
    const text = await readFile(await this.sandbox.path(a.path), 'utf8');
    const start = typeof a.startLine === 'number' ? a.startLine : 1,
      end = typeof a.endLine === 'number' ? a.endLine : undefined;
    const out = text
      .split('\n')
      .slice(start - 1, end)
      .map((l, i) => `${start + i}: ${l}`)
      .join('\n');
    return { content: clipped(out) };
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
    return { content: clipped(out.join('\n')), data: out };
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
    return { content: found.join('\n'), data: found };
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
    return { content: clipped(out.join('\n')), data: out };
  }
  private async write(a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.content !== 'string') throw new Error('content must be a string');
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
    const before = await readFile(path, 'utf8');
    if (!a.search || before.indexOf(a.search) !== before.lastIndexOf(a.search))
      return { content: 'Search text must occur exactly once', isError: true };
    await writeFile(path, before.replace(a.search, a.replace));
    return { content: `Patched ${String(a.path)}` };
  }
  private async shell(a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.command !== 'string') throw new Error('command must be a string');
    if (!(await this.allowed('shell', a.command)))
      return { content: 'Permission denied', isError: true };
    const timeout = Math.min(
      Math.max(typeof a.timeoutMs === 'number' ? a.timeoutMs : 30000, 1000),
      120000,
    );
    const cmd = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
      args = process.platform === 'win32' ? ['/d', '/s', '/c', a.command] : ['-lc', a.command];
    try {
      const r = await run(cmd, args, { cwd: this.sandbox.root, timeout, maxBuffer: MAX });
      return { content: clipped((r.stdout ?? '') + (r.stderr ?? '')) };
    } catch (e: any) {
      return {
        content: clipped(`${e.stdout ?? ''}${e.stderr ?? ''}\nexit code: ${e.code ?? 'unknown'}`),
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
    const r = await run('git', a.args, { cwd: this.sandbox.root, timeout: 30000, maxBuffer: MAX });
    return { content: clipped(r.stdout + r.stderr) };
  }
  private async http(a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.url !== 'string') throw new Error('url must be a string');
    const url = new URL(a.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs allowed');
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    return { content: clipped(await r.text()), isError: !r.ok };
  }
}
