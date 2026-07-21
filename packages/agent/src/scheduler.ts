import type { BackendEmit, PromptBackend } from './backends.js';

export type SchedulerPhase =
  'idle' | 'running' | 'stopping' | 'starting-replacement' | 'failed' | 'closed';

export interface SchedulerState {
  phase: SchedulerPhase;
  active?: string;
  queue: readonly string[];
  error?: string;
}

export interface PromptSchedulerOptions {
  backend: PromptBackend;
  emit: BackendEmit;
  onState?: (state: SchedulerState) => void;
  onRunStart?: (prompt: string, mode: 'replace' | 'queue') => Promise<void> | void;
  onQueueChange?: (queue: readonly string[]) => Promise<void> | void;
  initialQueue?: readonly string[];
}

interface PendingPrompt {
  prompt: string;
  mode: 'replace' | 'queue';
}

export class PromptScheduler {
  private queue: PendingPrompt[];
  private active?: string;
  private phase: SchedulerPhase = 'idle';
  private controller?: AbortController;
  private pumpPromise?: Promise<void>;
  private cancelled = false;
  private suspended = false;
  private replacement?: PendingPrompt;
  private closed = false;

  constructor(private readonly options: PromptSchedulerOptions) {
    this.queue = (options.initialQueue ?? []).map((prompt) => ({ prompt, mode: 'queue' }));
    if (this.queue.length) queueMicrotask(() => this.pump());
  }

  state(): SchedulerState {
    return { phase: this.phase, active: this.active, queue: this.pending() };
  }

  async submit(prompt: string, mode: 'replace' | 'queue' = 'replace'): Promise<void> {
    const value = prompt.trim();
    if (!value) return;
    if (this.closed) throw new Error('Scheduler is closed');
    if (mode === 'replace' && (this.active || this.pumpPromise || this.suspended)) {
      if (this.replacement && this.replacement.prompt !== value)
        this.queue.unshift(this.replacement);
      this.replacement = { prompt: value, mode };
      this.suspended = true;
      await this.changed();
      this.phase = 'stopping';
      this.notify();
      await this.cancelActive(true);
      return;
    }
    this.queue.push({ prompt: value, mode });
    await this.changed();
    this.pump();
  }

  async cancelActive(forReplacement = false): Promise<void> {
    if (!this.active && !this.pumpPromise) return;
    this.cancelled = true;
    this.phase = 'stopping';
    this.notify();
    let cancelError: unknown;
    try {
      await this.options.backend.cancel();
    } catch (error) {
      cancelError = error;
    } finally {
      this.controller?.abort();
    }
    await this.pumpPromise;
    if (cancelError) {
      if (this.replacement) this.queue.unshift(this.replacement);
      this.replacement = undefined;
      this.cancelled = false;
      this.suspended = false;
      await this.changed();
      this.phase = 'failed';
      const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
      this.notify(message);
      this.options.emit('error', `${message} · replacement remains queued; use /queue retry`);
      return;
    }
    if (forReplacement && this.replacement) {
      this.queue.unshift(this.replacement);
      this.replacement = undefined;
      await this.changed();
      this.phase = 'starting-replacement';
      this.notify();
    }
    this.cancelled = false;
    this.suspended = false;
    this.pump();
  }

  async clearQueue(): Promise<number> {
    const count = this.queue.length + (this.replacement ? 1 : 0);
    this.queue = [];
    this.replacement = undefined;
    await this.changed();
    return count;
  }

  async reset(): Promise<void> {
    await this.clearQueue();
    await this.cancelActive();
    await this.options.backend.reset();
    this.phase = 'idle';
    this.notify();
  }

  async retry(): Promise<void> {
    if (this.phase !== 'failed') return;
    this.phase = 'idle';
    this.notify();
    this.pump();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.cancelActive();
    await this.options.backend.close();
    this.phase = 'closed';
    this.notify();
  }

  async waitForIdle(): Promise<void> {
    while (this.phase !== 'failed' && (this.pumpPromise || this.queue.length)) {
      this.pump();
      await this.pumpPromise;
    }
  }

  private pump(): void {
    if (
      this.pumpPromise ||
      this.closed ||
      this.suspended ||
      !this.queue.length ||
      this.phase === 'failed'
    )
      return;
    this.pumpPromise = this.runOne().finally(() => {
      this.pumpPromise = undefined;
      if (
        !this.closed &&
        !this.suspended &&
        this.phase !== 'failed' &&
        this.queue.length &&
        !this.cancelled
      )
        this.pump();
    });
  }

  private async runOne(): Promise<void> {
    if (this.closed || !this.queue.length) return;
    const pending = this.queue.shift()!;
    const { prompt, mode } = pending;
    await this.changed();
    this.active = prompt;
    this.cancelled = false;
    this.controller = new AbortController();
    this.phase = this.phase === 'starting-replacement' ? 'starting-replacement' : 'running';
    this.notify();
    try {
      await this.options.onRunStart?.(prompt, mode);
      await this.options.backend.run(prompt, this.options.emit, this.controller.signal);
    } catch (error) {
      if (!this.cancelled && !(error instanceof Error && error.name === 'AbortError')) {
        this.queue.unshift(pending);
        await this.changed();
        this.phase = 'failed';
        this.notify(error instanceof Error ? error.message : String(error));
        this.options.emit(
          'error',
          `${error instanceof Error ? error.message : String(error)} · use /queue retry`,
        );
        return;
      }
    } finally {
      this.active = undefined;
      this.controller = undefined;
    }
    if (this.cancelled) this.options.emit('status', 'Request cancelled.');
    this.phase = 'idle';
    this.notify();
  }

  private async changed(): Promise<void> {
    try {
      await this.options.onQueueChange?.(this.pending());
    } catch (error) {
      this.options.emit(
        'error',
        `Unable to save queued prompts: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.notify();
  }

  private pending(): string[] {
    return [
      ...(this.replacement ? [this.replacement.prompt] : []),
      ...this.queue.map(({ prompt }) => prompt),
    ];
  }

  private notify(error?: string): void {
    this.options.onState?.({ ...this.state(), error });
  }
}
