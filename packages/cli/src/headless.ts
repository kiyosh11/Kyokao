// @ts-nocheck
import type { Runtime } from './runtime.js';
import { runPrompt } from './runtime.js';
import type { Session } from '@kyokao/memory';
import type { WorkspaceEmit } from '@kyokao/ui';

export type OutputFormat = 'plain' | 'json' | 'streaming-json';

export function resolveOutputFormat(
  explicit: OutputFormat | undefined,
  stdinIsTTY: boolean,
): OutputFormat {
  return explicit ?? (stdinIsTTY ? 'plain' : 'streaming-json');
}

export async function runHeadless(
  r: Runtime,
  prompt: string,
  existing: Session | undefined,
  format: OutputFormat,
  skipModelCheck: boolean,
  signal: AbortSignal | undefined,
): Promise<Session | undefined> {
  const events: RecordedEvent[] = [];
  const emit: WorkspaceEmit = (kind, value) => {
    const record = { kind, value, ts: Date.now() };
    events.push(record);
    if (format === 'streaming-json') {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  };
  try {
    const session = await runPrompt(r, prompt, existing, false, emit, signal, skipModelCheck);
    if (format === 'json') {
      const answer =
        typeof (session as unknown as { __answer?: string })?.__answer === 'string'
          ? (session as unknown as { __answer: string }).__answer
          : undefined;
      process.stdout.write(
        `${JSON.stringify({ events, session: session ? serializeSession(session) : null, answer })}\n`,
      );
    }
    return session;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = { kind: 'error', value: message, ts: Date.now() };
    if (format === 'streaming-json') {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    } else if (format === 'json') {
      process.stdout.write(
        `${JSON.stringify({ events, session: null, answer: null, error: message })}\n`,
      );
    }
    throw error;
  } finally {
    await r.tools.close?.();
  }
}

export interface RecordedEvent {
  kind: string;
  value: unknown;
  ts: number;
}

function serializeSession(session: Session) {
  return {
    id: session.id,
    checkpoint: session.checkpoint,
    provider: session.provider,
    usage: session.usage,
  };
}
