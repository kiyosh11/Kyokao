import { resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerConfig } from '@kyokao/config';
import type { ToolDefinition, ToolExecutor, ToolResult } from './types.js';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_START_TIMEOUT_MS = 10_000;

export class McpRequestTimeoutError extends Error {
  constructor(server: string, method: string, timeoutMs: number) {
    super(`MCP server ${server} did not respond to "${method}" within ${timeoutMs}ms`);
    this.name = 'McpRequestTimeoutError';
  }
}

export class McpStartupTimeoutError extends Error {
  constructor(server: string, timeoutMs: number) {
    super(`MCP server ${server} did not initialize within ${timeoutMs}ms`);
    this.name = 'McpStartupTimeoutError';
  }
}

class McpClient {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: JsonRpcMessage) => void;
      reject: (error: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = Buffer.alloc(0);
  private initialized = false;
  private readonly rawToolNames = new Map<string, string>();
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
    const startTimeoutMs = this.config.startTimeoutMs ?? MCP_START_TIMEOUT_MS;
    try {
      await this.handshake(startTimeoutMs);
    } catch (error) {

      this.process?.kill();
      throw error;
    }
    this.initialized = true;
  }
  private async handshake(startTimeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new McpStartupTimeoutError(this.name, startTimeoutMs)),
        startTimeoutMs,
      );
    });
    try {
      await Promise.race([
        (async () => {
          await this.request(
            'initialize',
            {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'kyokao', version: '0.1.0' },
            },
            startTimeoutMs,
          );
          await this.notify('notifications/initialized', {});
        })(),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.request('tools/list', {}, this.config.requestTimeoutMs);
    const tools = Array.isArray(result.result?.tools) ? result.result.tools : [];
    return tools
      .filter(
        (tool): tool is { name: string; description?: string; inputSchema?: object } =>
          !!tool &&
          typeof tool === 'object' &&
          typeof (tool as { name?: unknown }).name === 'string',
      )
      .map((tool) => {
        const exposedName = `mcp_${this.name}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const existing = this.rawToolNames.get(exposedName);
        if (existing && existing !== tool.name)
          throw new Error(
            `MCP server ${this.name} has colliding tool names "${existing}" and "${tool.name}"`,
          );
        this.rawToolNames.set(exposedName, tool.name);
        return {
          type: 'function' as const,
          function: {
            name: exposedName,
            description: `[MCP ${this.name}] ${tool.description ?? tool.name}`,
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
          },
        };
      });
  }
  async call(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.initialized) throw new Error(`MCP server ${this.name} is not initialized`);
    const rawName = this.rawToolNames.get(toolName);
    if (!rawName) throw new Error(`Unknown MCP tool: ${toolName}`);
    const result = await this.request(
      'tools/call',
      { name: rawName, arguments: args },
      this.config.requestTimeoutMs,
    );
    const content = Array.isArray(result.result?.content)
      ? result.result.content
          .map((item) =>
            item && typeof item === 'object' && 'text' in item
              ? String(item.text)
              : JSON.stringify(item),
          )
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
  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = MCP_REQUEST_TIMEOUT_MS,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined };

      entry.timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          entry.reject(new McpRequestTimeoutError(this.name, method, timeoutMs));
        }
      }, timeoutMs);
      this.pending.set(id, entry);
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
        if (pending.timer) clearTimeout(pending.timer);
        if (body.error) pending.reject(new Error(body.error.message ?? 'MCP request failed'));
        else pending.resolve(body);
      }
    }
  }
  private rejectAll(error: Error) {
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}

class McpTools implements ToolExecutor {
  private definitionsByName = new Map<string, { client: McpClient; definition: ToolDefinition }>();
  constructor(private readonly clients: McpClient[]) {}
  async start(): Promise<void> {
    try {
      for (const client of this.clients) {
        await client.start();
        for (const definition of await client.listTools()) {
          if (this.definitionsByName.has(definition.function.name))
            throw new Error(`Duplicate MCP tool name: ${definition.function.name}`);
          this.definitionsByName.set(definition.function.name, { client, definition });
        }
      }
    } catch (error) {
      await Promise.allSettled(this.clients.map((client) => client.close()));
      throw error;
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
