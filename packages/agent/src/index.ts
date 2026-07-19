import {
  OpenAICompatibleProvider,
  modelCatalog,
  type ChatMessage,
  type ModelInfo,
  type TokenUsage,
} from '@kyokao/providers';
import type { ToolExecutor } from '@kyokao/tools';
import type { LocalStore, Session } from '@kyokao/memory';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AgentOptions {
  provider: OpenAICompatibleProvider;
  tools: ToolExecutor;
  store: LocalStore;
  maxIterations: number;
  workspace: string;
  contextWindow?: number;
  compressionThreshold?: number;
  modelInfo?: ModelInfo;
  instructions?: string;
  maxToolCalls?: number;
  maxCostUsd?: number;
  maxOutputChars?: number;
  onEvent?: (kind: 'text' | 'tool' | 'assistant' | 'usage', text: string) => void;
  signal?: AbortSignal;
}

export const systemPrompt = (workspace: string, instructions = '') =>
  `You are Kyokao, a careful coding agent working only in repository ${workspace}. Inspect before changing. Make minimal safe changes, use tools for facts, run relevant checks, never expose secrets, and explain completed work concisely.${instructions ? `\n\nRepository instructions:\n${instructions}` : ''}`;

export async function loadInstructionFiles(workspace: string): Promise<string> {
  const names = ['SOUL.md', 'soul.md', 'CLAUDE.md', 'claude.md', 'AGENTS.md', 'KYOKAO.md'];
  const loaded: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const path = join(workspace, name);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    try {
      const content = await readFile(path, 'utf8');
      if (content.trim()) {
        loaded.push(`### ${name}\n${content.slice(0, 20_000)}`);
        seen.add(key);
      }
    } catch {}
  }
  try {
    for (const entry of await readdir(join(workspace, '.kyokao'))) {
      if (!/^(instructions|soul)\.md$/i.test(entry)) continue;
      const content = await readFile(join(workspace, '.kyokao', entry), 'utf8');
      if (content.trim()) loaded.push(`### .kyokao/${entry}\n${content.slice(0, 20_000)}`);
    }
  } catch {}
  return loaded.join('\n\n').slice(0, 60_000);
}

export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(
    messages.reduce((total, message) => {
      const toolCalls =
        message.role === 'assistant' ? JSON.stringify(message.tool_calls ?? []) : '';
      return total + (message.content?.length ?? 0) + toolCalls.length + message.role.length + 8;
    }, 0) / 4,
  );
}

export function compressMessages(
  messages: ChatMessage[],
  maxTokens: number,
): { messages: ChatMessage[]; summary?: string; removed: number } {
  if (estimateTokens(messages) <= maxTokens || messages.length <= 3)
    return { messages, removed: 0 };
  const first = messages[0]?.role === 'system' ? [messages[0]] : [];
  const tail: ChatMessage[] = [];
  let tailTokens = 0;
  for (let i = messages.length - 1; i >= first.length; i--) {
    const message = messages[i];
    const tokens = estimateTokens([message]);
    if (tail.length >= 8 || tailTokens + tokens > Math.floor(maxTokens * 0.7)) break;
    tail.unshift(message);
    tailTokens += tokens;
  }
  const removedMessages = messages.slice(first.length, messages.length - tail.length);
  const summary = removedMessages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')
    .slice(0, Math.max(256, Math.floor(maxTokens * 4 * 0.25)));
  const compacted: ChatMessage[] = [
    ...first,
    ...(summary ? [{ role: 'system' as const, content: `Context summary:\n${summary}` }] : []),
    ...tail,
  ];
  return { messages: compacted, summary, removed: removedMessages.length };
}

function addUsage(session: Session, usage: TokenUsage, model?: ModelInfo) {
  const current = session.usage ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
    estimatedCostUsd: 0,
    compressedMessages: 0,
  };
  current.promptTokens += usage.promptTokens;
  current.completionTokens += usage.completionTokens;
  current.totalTokens += usage.totalTokens;
  current.requests += 1;
  current.estimatedCostUsd +=
    (usage.promptTokens * (model?.inputCostPerMillion ?? 0)) / 1_000_000 +
    (usage.completionTokens * (model?.outputCostPerMillion ?? 0)) / 1_000_000;
  session.usage = current;
}

export class Agent {
  constructor(private options: AgentOptions) {}
  async run(prompt: string, session?: Session): Promise<Session> {
    const s = session ?? (await this.options.store.create(prompt));
    const fullMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(this.options.workspace, this.options.instructions) },
      ...s.messages,
      { role: 'user', content: prompt },
    ];
    s.messages.push({ role: 'user', content: prompt });
    const maxContext = this.options.contextWindow ?? 16_000;
    const threshold = Math.floor(maxContext * (this.options.compressionThreshold ?? 0.8));
    let toolCalls = 0;
    for (let i = 0; i < this.options.maxIterations; i++) {
      this.options.signal?.throwIfAborted();
      if (
        this.options.maxCostUsd &&
        this.options.maxCostUsd > 0 &&
        (s.usage?.estimatedCostUsd ?? 0) >= this.options.maxCostUsd
      )
        throw new Error(
          `Safety limit reached: estimated cost exceeded $${this.options.maxCostUsd}`,
        );
      const compacted = compressMessages(fullMessages, threshold);
      if (compacted.summary) {
        s.contextSummary = compacted.summary;
        s.usage ??= {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          requests: 0,
          estimatedCostUsd: 0,
          compressedMessages: 0,
        };
        s.usage.compressedMessages += compacted.removed;
        this.options.onEvent?.(
          'usage',
          `compressed ${compacted.removed} messages (${estimateTokens(fullMessages)} → ${estimateTokens(compacted.messages)} tokens)`,
        );
      }
      let response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await this.options.provider.chat(
            compacted.messages,
            this.options.tools.definitions(),
            {
              onText: (t) => this.options.onEvent?.('text', t),
              onToolCall: (c) => this.options.onEvent?.('tool', `${c.name} ${c.arguments}`),
            },
            this.options.signal,
          );
          break;
        } catch (e) {
          if (
            attempt >= 2 ||
            (e instanceof Error &&
              (e.name === 'AbortError' ||
                /^(4\d\d|Invalid|Unknown|Provider baseURL)/.test(e.message)))
          )
            throw e;
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        }
      }
      const observedUsage = response!.usage ?? {
        promptTokens: estimateTokens(compacted.messages),
        completionTokens: estimateTokens([response!.message]),
        totalTokens: estimateTokens(compacted.messages) + estimateTokens([response!.message]),
      };
      if (observedUsage) {
        addUsage(
          s,
          observedUsage,
          this.options.modelInfo ??
            modelCatalog.find((model) => model.id === this.options.provider.options.model),
        );
        this.options.onEvent?.(
          'usage',
          `${observedUsage.totalTokens.toLocaleString()} tokens · $${s.usage!.estimatedCostUsd.toFixed(4)} estimated`,
        );
      }
      const m = response!.message;
      fullMessages.push(m);
      s.messages.push(m);
      if (m.content && this.options.provider.options.stream === false)
        this.options.onEvent?.('assistant', m.content);
      if (!m.tool_calls?.length) {
        s.checkpoint = 'completed';
        await this.options.store.saveSession(s);
        return s;
      }
      for (const call of m.tool_calls) {
        toolCalls += 1;
        if (toolCalls > (this.options.maxToolCalls ?? 100))
          throw new Error(
            `Safety limit reached: maximum tool calls (${this.options.maxToolCalls ?? 100})`,
          );
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          args = {};
        }
        const result = await this.options.tools.execute(call.name, args);
        const content =
          result.content.length > (this.options.maxOutputChars ?? 30_000)
            ? `${result.content.slice(0, this.options.maxOutputChars ?? 30_000)}\n…truncated…`
            : result.content;
        const toolMessage: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content,
        };
        fullMessages.push(toolMessage);
        s.messages.push(toolMessage);
      }
      s.checkpoint = `iteration ${i + 1}`;
      await this.options.store.saveSession(s);
    }
    throw new Error(`Agent reached iteration limit (${this.options.maxIterations})`);
  }
}
