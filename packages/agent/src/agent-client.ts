// @ts-nocheck
import { randomUUID } from 'node:crypto';
const PROTOCOL_VERSION = 'kyokao-agent-client-1';
/** Error codes aligned with JSON-RPC conventions. */
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INTERNAL = -32603;
/**
 * Reads newline-delimited JSON from `input`, dispatches requests against
 * `backend`, and writes responses + notifications to `output`. Returns when
 * the input stream ends. Safe to drive from a duplex pair in tests.
 *
 * The backend's existing `BackendEmit` events are translated 1:1 into
 * `item/*` notifications so this is a thin envelope over what the agent loop
 * already produces.
 */
export async function runAgentClient(input, output, backend, options = {}) {
  const server = new AgentClientServer(backend, output, options.serverInfo);
  await server.run(input);
}
/**
 * Stateful dispatcher behind {@link runAgentClient}. Exposed as a class so
 * tests can drive individual requests and inspect emitted messages without
 * going through streams.
 */
export class AgentClientServer {
  backend;
  serverInfo;
  initialized = false;
  approvalPolicy = 'never';
  write;
  pendingApprovals = new Map();
  constructor(
    backend,
    output,
    serverInfo = {
      name: 'kyokao',
      version: '0.5.5',
    },
  ) {
    this.backend = backend;
    this.serverInfo = serverInfo;
    this.write = (message) => {
      if (output.writable) output.write(`${JSON.stringify(message)}\n`);
    };
  }
  async run(input) {
    let buffer = '';
    for await (const chunk of input) {
      buffer += String(chunk);
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        await this.handleLine(line);
      }
    }
  }
  async handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'Parse error' } });
      return;
    }
    if (!message || message.jsonrpc !== '2.0') {
      this.write({
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: ERR_INVALID_REQUEST, message: 'Invalid Request' },
      });
      return;
    }
    // Notifications (no id) are fire-and-forget; we acknowledge by acting.
    if (message.id === undefined) {
      if (message.method === 'initialized') return; // handshake ack
      return;
    }
    try {
      const result = await this.dispatch(message.method, message.params ?? {});
      this.write({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      const isRpc = error instanceof RpcError;
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: isRpc
          ? { code: error.code, message: error.message }
          : {
              code: ERR_INTERNAL,
              message: error instanceof Error ? error.message : String(error),
            },
      });
    }
  }
  async dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return this.handleInitialize();
      case 'session/start':
        this.requireInit();
        return this.handleSessionStart(params);
      case 'session/resume':
        this.requireInit();
        return this.handleSessionResume(params);
      case 'turn/run':
        this.requireInit();
        return this.handleTurnRun(params);
      case 'turn/interrupt':
        this.requireInit();
        await this.backend.cancel();
        return {};
      default:
        throw new RpcError(ERR_METHOD_NOT_FOUND, `Method not found: ${method ?? '(none)'}`);
    }
  }
  handleInitialize() {
    this.initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: this.serverInfo,
      capabilities: {
        approvalPolicy: true,
        streaming: true,
      },
    };
  }
  async handleSessionStart(params) {
    if (params.approvalPolicy === 'client' || params.approvalPolicy === 'never')
      this.approvalPolicy = params.approvalPolicy;
    await this.backend.reset();
    const session = this.backend.session();
    return { sessionId: session?.id ?? null };
  }
  async handleSessionResume(params) {
    // Resume is best-effort: the backend keeps the current session across
    // turns, so clients typically just call turn/run again. A real resume
    // path would load by id via the store; left as a future extension.
    return { sessionId: params.sessionId ?? this.backend.session()?.id ?? null };
  }
  async handleTurnRun(params) {
    const prompt = params.prompt;
    if (typeof prompt !== 'string' || !prompt.trim())
      throw new RpcError(ERR_INVALID_REQUEST, 'turn/run requires a non-empty "prompt"');
    const turnId = randomUUID();
    // Respond immediately so the client can correlate; completion arrives via
    // notifications. This mirrors Codex's turn/start → stream → completed flow.
    this.write({ jsonrpc: '2.0', method: 'turn/started', params: { turnId } });
    const emit = (kind, value) => {
      this.emitItem(turnId, kind, value);
    };
    const controller = new AbortController();
    try {
      await this.backend.run(prompt, emit, controller.signal);
      this.write({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { turnId, status: 'completed' },
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      this.write({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          turnId,
          status: aborted ? 'interrupted' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return { turnId };
  }
  /**
   * Translate a {@link BackendEmit} event into an `item/*` notification. The
   * backend's existing event kinds map directly onto the protocol's item
   * taxonomy: assistant text, tool invocations, tool results, usage,
   * status, errors.
   */
  emitItem(turnId, kind, value) {
    const params = { turnId };
    switch (kind) {
      case 'assistant':
        this.write({
          jsonrpc: '2.0',
          method: 'item/assistant',
          params: { ...params, text: String(value) },
        });
        break;
      case 'tool':
        this.write({
          jsonrpc: '2.0',
          method: 'item/tool',
          params: { ...params, text: String(value) },
        });
        break;
      case 'tool-result':
        this.write({
          jsonrpc: '2.0',
          method: 'item/toolResult',
          params: { ...params, text: String(value) },
        });
        break;
      case 'usage':
        this.write({ jsonrpc: '2.0', method: 'item/usage', params: { ...params, usage: value } });
        break;
      case 'status':
        this.write({
          jsonrpc: '2.0',
          method: 'item/status',
          params: { ...params, state: String(value) },
        });
        break;
      case 'error':
        this.write({
          jsonrpc: '2.0',
          method: 'item/error',
          params: { ...params, message: String(value) },
        });
        break;
      default:
        this.write({ jsonrpc: '2.0', method: `item/${kind}`, params: { ...params, value } });
    }
  }
  requireInit() {
    if (!this.initialized) throw new RpcError(ERR_INVALID_REQUEST, 'Server not initialized');
  }
}
class RpcError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'RpcError';
  }
}
