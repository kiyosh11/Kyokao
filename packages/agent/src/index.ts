// @ts-nocheck
import { modelCatalog } from '@kyokao/providers';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export const systemPrompt = (workspace, instructions = '') =>
  `You are Kyokao, a careful coding agent working only in repository ${workspace}. Inspect before changing. Treat @relative/path tokens as workspace file references and inspect those paths with tools when relevant. Make minimal safe changes, use tools for facts, run relevant checks, never expose secrets, and explain completed work concisely. When the user requests a repository change, do not stop after describing future work ("I'll create", "let me update", or similar): invoke the appropriate write/patch tools, inspect the result, and verify it before giving a finished answer. For explanation-only questions, answer directly and do not force a mutation tool.${instructions ? `\n\nRepository instructions:\n${instructions}` : ''}`;
const changeVerb =
  '(?:create|write|edit|modify|update|patch|implement|add|remove|delete|fix|refactor|rename|build|make|generate|migrate|upgrade|optimize)';
const explanationLead =
  /^\s*(?:explain|describe|summarize|review|analy[sz]e|what|why|how|where|list|show|tell)\b/i;
const futureIntent = new RegExp(
  `\\b(?:I(?:'ll| will| am going to)|Let me|I need to|I should|Next,? I(?:'ll| will))\\s+(?:now\\s+)?${changeVerb}\\b`,
  'i',
);
const explicitFollowupChange = new RegExp(`\\b(?:and|then|also)\\s+${changeVerb}\\b`, 'i');
const requestedChange = new RegExp(`\\b${changeVerb}\\b`, 'i');
export function isFutureIntentOnly(content, prompt) {
  if (!content?.trim() || !futureIntent.test(content)) return false;
  if (explanationLead.test(prompt) && !explicitFollowupChange.test(prompt)) return false;
  return requestedChange.test(prompt);
}
const intentContinuation =
  'The previous response only stated future intent and did not complete the requested repository change. Continue now: invoke the appropriate write_file/apply_patch (or other required) tools, inspect the result, run a relevant verification, and only then report completed work. Do not reply with another plan.';
const maxIntentContinuations = 2;
/**
 * Loads repository and user-level instruction files.
 *
 * Repo conventions (`SOUL.md`, `CLAUDE.md`, `AGENTS.md`, `KYOKAO.md`) are
 * read from the workspace root — these are community standards Codex and
 * Claude Code also honor, so they stay per-repo.
 *
 * Kyokao-specific user instructions (`instructions.md`, `soul.md`) are read
 * from `home` (`~/.kyokao/`) — these are user-level overrides, not repo
 * conventions, so they moved out of the workspace in 0.7.0.
 */
export async function loadInstructionFiles(workspace, home) {
  const names = ['SOUL.md', 'soul.md', 'CLAUDE.md', 'claude.md', 'AGENTS.md', 'KYOKAO.md'];
  const loaded = [];
  const seen = new Set();
  const seenContent = new Set();
  for (const name of names) {
    const path = join(workspace, name);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    try {
      const content = await readFile(path, 'utf8');
      const normalized = content.trim();
      if (normalized && !seenContent.has(normalized)) {
        loaded.push(`### ${name}\n${content.slice(0, 20_000)}`);
        seen.add(key);
        seenContent.add(normalized);
      }
    } catch {}
  }
  // User-level Kyokao instructions live in ~/.kyokao/ (not the workspace).
  if (home) {
    for (const entry of ['instructions.md', 'soul.md']) {
      try {
        const content = await readFile(join(home, entry), 'utf8');
        const normalized = content.trim();
        if (normalized && !seenContent.has(normalized)) {
          loaded.push(`### ~/.kyokao/${entry}\n${content.slice(0, 20_000)}`);
          seenContent.add(normalized);
        }
      } catch {}
    }
  }
  return loaded.join('\n\n').slice(0, 60_000);
}
export function estimateTokens(messages) {
  return Math.ceil(
    messages.reduce((total, message) => {
      const toolCalls =
        message.role === 'assistant' ? JSON.stringify(message.tool_calls ?? []) : '';
      const reasoning = message.role === 'assistant' ? (message.reasoning_content?.length ?? 0) : 0;
      return (
        total +
        (message.content?.length ?? 0) +
        reasoning +
        toolCalls.length +
        message.role.length +
        8
      );
    }, 0) / 4,
  );
}
export function compressMessages(messages, maxTokens) {
  if (estimateTokens(messages) <= maxTokens || messages.length <= 3)
    return { messages, removed: 0 };
  const first = messages[0]?.role === 'system' ? [messages[0]] : [];
  const tail = [];
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
  const compacted = [
    ...first,
    ...(summary ? [{ role: 'system', content: `Context summary:\n${summary}` }] : []),
    ...tail,
  ];
  return { messages: compacted, summary, removed: removedMessages.length };
}
function addUsage(session, usage, model) {
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

export function providerRetryLimit(error) {
  if (!(error instanceof Error)) return 2;
  if (error.name === 'AbortError') return 0;
  if (/timeout/i.test(error.name) || /timed?\s*out/i.test(error.message)) return 1;
  const explicitStatus =
    typeof error.status === 'number'
      ? error.status
      : Number(error.message.match(/\b([45]\d\d)\b/)?.[1] ?? 0);
  if (explicitStatus >= 400 && explicitStatus < 500 && ![408, 409, 429].includes(explicitStatus))
    return 0;
  if (/^(Invalid|Unknown|Provider baseURL)/.test(error.message)) return 0;
  return 2;
}

export class Agent {
  options;
  constructor(options) {
    this.options = options;
  }
  async run(prompt, session) {
    const s = session ?? (await this.options.store.create(prompt));
    s.messages.push({ role: 'user', content: prompt });
    const maxContext = this.options.contextWindow ?? 16_000;
    const threshold = Math.floor(maxContext * (this.options.compressionThreshold ?? 0.8));
    let toolCalls = 0;
    let intentContinuations = 0;
    // messagesForProvider is the working transcript sent to the provider. When
    // compression fires it is replaced with the compacted array so subsequent
    // iterations benefit from the smaller transcript. s.messages keeps the full
    // history for persistence. (Previously the working set grew unbounded
    // across iterations and the summary was recomputed from scratch each time.)
    const sessionDirectives = [
      s.goal ? `Active goal: ${s.goal}` : '',
      s.personality && s.personality !== 'default'
        ? `Response style: ${s.personality}. Follow this style without weakening correctness or safety.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    let messagesForProvider = [
      {
        role: 'system',
        content: systemPrompt(
          this.options.workspace,
          [this.options.instructions, sessionDirectives].filter(Boolean).join('\n\n'),
        ),
      },
      ...s.messages,
    ];
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
      const compacted = compressMessages(messagesForProvider, threshold);
      if (compacted.summary) {
        const beforeTokens = estimateTokens(messagesForProvider);
        messagesForProvider = compacted.messages;
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
          'compression',
          `compressed ${compacted.removed} messages (${beforeTokens} → ${estimateTokens(compacted.messages)} tokens)`,
        );
      }
      let response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await this.options.provider.chat(
            messagesForProvider,
            this.options.tools.definitions(),
            {
              onText: (t) => this.options.onEvent?.('text', t),
              onReasoning: (t) => this.options.onEvent?.('reasoning', t),
              onToolCall: (c) => this.options.onEvent?.('tool', `${c.name} ${c.arguments}`),
            },
            this.options.signal,
          );
          break;
        } catch (e) {
          const retryLimit = providerRetryLimit(e);
          if (attempt >= retryLimit) throw e;
          const timeout =
            e instanceof Error && (/timeout/i.test(e.name) || /timed?\s*out/i.test(e.message));
          this.options.onEvent?.(
            'status',
            timeout
              ? `Provider timed out; retrying (${attempt + 1}/${retryLimit})…`
              : `Provider request failed; retrying (${attempt + 1}/${retryLimit})…`,
          );
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        }
      }
      const observedUsage = response.usage ?? {
        promptTokens: estimateTokens(messagesForProvider),
        completionTokens: estimateTokens([response.message]),
        totalTokens: estimateTokens(messagesForProvider) + estimateTokens([response.message]),
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
          `${s.usage.totalTokens.toLocaleString()} tokens · $${s.usage.estimatedCostUsd.toFixed(4)} estimated`,
          s.usage,
        );
      }
      const m = response.message;
      messagesForProvider.push(m);
      s.messages.push(m);
      if (m.content && this.options.provider.options.stream === false)
        this.options.onEvent?.('assistant', m.content);
      if (!m.tool_calls?.length) {
        if (isFutureIntentOnly(m.content, prompt)) {
          if (intentContinuations >= maxIntentContinuations)
            throw new Error(
              `Model returned future intent without completing the requested change after ${maxIntentContinuations} continuations`,
            );
          intentContinuations += 1;
          const continuation = { role: 'system', content: intentContinuation };
          messagesForProvider.push(continuation);
          s.messages.push(continuation);
          s.checkpoint = `intent continuation ${intentContinuations}`;
          await this.options.store.saveSession(s);
          continue;
        }
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
        let args;
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
        const toolMessage = {
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content,
        };
        this.options.onEvent?.(
          'tool-result',
          `${call.name}: ${result.isError ? 'failed' : 'completed'}\n${content}`,
        );
        messagesForProvider.push(toolMessage);
        s.messages.push(toolMessage);
      }
      s.checkpoint = `iteration ${i + 1}`;
      await this.options.store.saveSession(s);
    }
    throw new Error(`Agent reached iteration limit (${this.options.maxIterations})`);
  }
}
export * from './backend-types.js';
export * from './local-backend.js';
export * from './capy-backend.js';
export * from './scheduler.js';
export * from './subagent.js';
export * from './agent-client.js';
