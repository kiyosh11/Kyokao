import { OpenAICompatibleProvider, type ChatMessage } from '@kyokao/providers';
import { CoreTools } from '@kyokao/tools';
import type { LocalStore, Session } from '@kyokao/memory';
export interface AgentOptions {
  provider: OpenAICompatibleProvider;
  tools: CoreTools;
  store: LocalStore;
  maxIterations: number;
  workspace: string;
  onEvent?: (kind: 'text' | 'tool' | 'assistant', text: string) => void;
  signal?: AbortSignal;
}
export const systemPrompt = (workspace: string) =>
  `You are Kyokao, a careful coding agent working only in repository ${workspace}. Inspect before changing. Make minimal safe changes, use tools for facts, run relevant checks, never expose secrets, and explain completed work concisely.`;
export class Agent {
  constructor(private options: AgentOptions) {}
  async run(prompt: string, session?: Session): Promise<Session> {
    const s = session ?? (await this.options.store.create(prompt));
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(this.options.workspace) },
      ...s.messages,
      { role: 'user', content: prompt },
    ];
    s.messages.push({ role: 'user', content: prompt });
    for (let i = 0; i < this.options.maxIterations; i++) {
      this.options.signal?.throwIfAborted();
      let response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await this.options.provider.chat(
            messages,
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
      const m = response!.message;
      messages.push(m);
      s.messages.push(m);
      if (m.content && this.options.provider.options.stream === false)
        this.options.onEvent?.('assistant', m.content);
      if (!m.tool_calls?.length) {
        s.checkpoint = 'completed';
        await this.options.store.saveSession(s);
        return s;
      }
      for (const call of m.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          args = {};
        }
        const result = await this.options.tools.execute(call.name, args);
        const toolMessage: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: result.content,
        };
        messages.push(toolMessage);
        s.messages.push(toolMessage);
      }
      s.checkpoint = `iteration ${i + 1}`;
      await this.options.store.saveSession(s);
    }
    throw new Error(`Agent reached iteration limit (${this.options.maxIterations})`);
  }
}
