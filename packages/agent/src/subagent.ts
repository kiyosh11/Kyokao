// @ts-nocheck
import { Agent } from './index.js';
/**
 * Tools a sub-agent is allowed to use. The default is a read-only set so a
 * delegated investigation cannot mutate the workspace. The parent must
 * explicitly opt in to write/shell/http access per spawn.
 */
export const SUBAGENT_DEFAULT_TOOLS = ['read_file', 'list_files', 'glob', 'grep', 'git'];
/** All tool names a sub-agent may be granted. */
export const SUBAGENT_ALLOWED_TOOLS = new Set([
  'read_file',
  'list_files',
  'glob',
  'grep',
  'write_file',
  'apply_patch',
  'shell',
  'git',
  'http_get',
]);
const spec = (name, description, properties, required = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
});
/**
 * Wraps a {@link ToolExecutor} and exposes only the named subset of its tool
 * definitions. Execution of a tool outside the subset returns an error result
 * rather than forwarding, so a restricted sub-agent cannot escape its grant.
 */
export class ToolSubset {
  inner;
  allowed;
  constructor(inner, names) {
    this.inner = inner;
    this.allowed = new Set(names);
  }
  definitions() {
    return this.inner
      .definitions()
      .filter((definition) => this.allowed.has(definition.function.name));
  }
  async execute(name, args) {
    if (!this.allowed.has(name))
      return {
        content: `Sub-agent is not permitted to use tool "${name}"`,
        isError: true,
      };
    return this.inner.execute(name, args);
  }
}
/**
 * A {@link ToolExecutor} that exposes a single `spawn_subagent` tool. When
 * invoked, it runs a fresh, scoped {@link Agent} against a restricted tool
 * subset and returns the sub-agent's final assistant message as the tool
 * result. Default tool grant is read-only; write/shell/http access requires
 * explicit per-spawn opt-in.
 *
 * The sub-agent shares the parent's provider, store, and workspace, but runs
 * in its own ephemeral session with its own iteration and cost budgets. It is
 * isolated from the parent's transcript — only its final answer is returned.
 */
export class SubAgentTools {
  context;
  constructor(context) {
    this.context = context;
  }
  definitions() {
    return [
      spec(
        'spawn_subagent',
        'Delegate a scoped sub-task to a fresh sub-agent with a restricted tool set. The sub-agent investigates and returns its final answer; it does not see this conversation. Use for focused exploration (e.g. "find every caller of X") that would otherwise pollute the main transcript. By default the sub-agent can only read files and run read-only git; grant write/shell/http only when the sub-task needs them.',
        {
          prompt: {
            type: 'string',
            description: 'The self-contained task for the sub-agent.',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional subset of tool names to grant beyond the read-only default (read_file, list_files, glob, grep, git). Allowed additions: write_file, apply_patch, shell, http_get. Omit to keep the sub-agent read-only.',
          },
          maxIterations: {
            type: 'integer',
            description: 'Optional iteration cap for this sub-agent. Defaults to 8.',
          },
          maxCostUsd: {
            type: 'number',
            description:
              'Optional cost cap for this sub-agent in USD. Defaults to the smaller of 0.25 and the parent remaining budget.',
          },
        },
        ['prompt'],
      ),
    ];
  }
  async execute(name, args) {
    if (name !== 'spawn_subagent') return { content: `Unknown tool: ${name}`, isError: true };
    return this.spawn(args);
  }
  async spawn(args) {
    if (typeof args.prompt !== 'string' || !args.prompt.trim())
      return { content: 'spawn_subagent requires a non-empty "prompt"', isError: true };
    // Resolve the granted tool set: read-only default plus any explicitly
    // requested (and allowed) additions. Unknown names are rejected so a
    // hallucinated tool name doesn't silently widen access.
    const requested = Array.isArray(args.tools) ? args.tools : [];
    const granted = new Set(SUBAGENT_DEFAULT_TOOLS);
    for (const raw of requested) {
      if (typeof raw !== 'string')
        return { content: `Invalid tool name in "tools": ${String(raw)}`, isError: true };
      if (!SUBAGENT_ALLOWED_TOOLS.has(raw))
        return { content: `Sub-agent cannot be granted unknown tool "${raw}"`, isError: true };
      granted.add(raw);
    }
    const maxIterations =
      typeof args.maxIterations === 'number' && args.maxIterations > 0
        ? Math.min(Math.floor(args.maxIterations), 50)
        : 8;
    // Cost cap: caller-provided, else a conservative default bounded by the
    // parent's remaining budget so a sub-agent can never overshoot the parent.
    const remaining = this.context.remainingCostUsd?.() ?? Infinity;
    const maxCostUsd =
      typeof args.maxCostUsd === 'number' && args.maxCostUsd > 0
        ? Math.min(args.maxCostUsd, remaining)
        : Math.min(0.25, remaining);
    if (maxCostUsd <= 0)
      return {
        content: 'Sub-agent cost budget exhausted; cannot spawn',
        isError: true,
      };
    const subTools = new ToolSubset(this.context.tools, granted);
    let finalAnswer = '';
    const agent = new Agent({
      provider: this.context.provider,
      tools: subTools,
      store: this.context.store,
      maxIterations,
      workspace: this.context.workspace,
      modelInfo: this.context.modelInfo,
      instructions: this.context.instructions,
      maxCostUsd,
      maxToolCalls: 50,
      onEvent: (kind, text) => {
        // Capture the last assistant message as the sub-agent's answer.
        if (kind === 'assistant') finalAnswer = text;
        if (kind === 'text') finalAnswer += text;
      },
    });
    try {
      const session = await agent.run(args.prompt);
      // Prefer the captured streamed text; fall back to the last assistant
      // message in the session if streaming was off.
      const answer =
        finalAnswer.trim() ||
        session.messages
          .filter((message) => (message.role === 'assistant' ? Boolean(message.content) : false))
          .at(-1)?.content ||
        '(sub-agent produced no answer)';
      return {
        content: answer,
        data: {
          sessionId: session.id,
          toolCalls: session.usage?.requests ?? 0,
          costUsd: session.usage?.estimatedCostUsd ?? 0,
        },
      };
    } catch (error) {
      return {
        content: `Sub-agent failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}
