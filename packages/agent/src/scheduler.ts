// @ts-nocheck
export type SchedulerPhase =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'starting-replacement'
  | 'failed'
  | 'closed';

export interface SchedulerState {
  phase: SchedulerPhase;
  active?: string;
  queue: string[];
  error?: string;
}

export class PromptScheduler {
    options;
    queue;
    active;
    phase = 'idle';
    controller;
    pumpPromise;
    cancelled = false;
    suspended = false;
    replacement;
    closed = false;
    constructor(options) {
        this.options = options;
        this.queue = (options.initialQueue ?? []).map((prompt) => ({ prompt, mode: 'queue' }));
        if (this.queue.length)
            queueMicrotask(() => this.pump());
    }
    state() {
        return { phase: this.phase, active: this.active, queue: this.pending() };
    }
    async submit(prompt, mode = 'replace') {
        const value = prompt.trim();
        if (!value)
            return;
        if (this.closed)
            throw new Error('Scheduler is closed');
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
    async cancelActive(forReplacement = false) {
        if (!this.active && !this.pumpPromise)
            return;
        this.cancelled = true;
        this.phase = 'stopping';
        this.notify();
        let cancelError;
        try {
            await this.options.backend.cancel();
        }
        catch (error) {
            cancelError = error;
        }
        finally {
            this.controller?.abort();
        }
        await this.pumpPromise;
        if (cancelError) {
            if (this.replacement)
                this.queue.unshift(this.replacement);
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
    async clearQueue() {
        const count = this.queue.length + (this.replacement ? 1 : 0);
        this.queue = [];
        this.replacement = undefined;
        await this.changed();
        return count;
    }
    async reset() {
        await this.clearQueue();
        await this.cancelActive();
        await this.options.backend.reset();
        this.phase = 'idle';
        this.notify();
    }
    async retry() {
        if (this.phase !== 'failed')
            return;
        this.phase = 'idle';
        this.notify();
        this.pump();
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await this.cancelActive();
        await this.options.backend.close();
        this.phase = 'closed';
        this.notify();
    }
    async waitForIdle() {
        while (this.phase !== 'failed' && (this.pumpPromise || this.queue.length)) {
            this.pump();
            await this.pumpPromise;
        }
    }
    pump() {
        if (this.pumpPromise ||
            this.closed ||
            this.suspended ||
            !this.queue.length ||
            this.phase === 'failed')
            return;
        this.pumpPromise = this.runOne().finally(() => {
            this.pumpPromise = undefined;
            if (!this.closed &&
                !this.suspended &&
                this.phase !== 'failed' &&
                this.queue.length &&
                !this.cancelled)
                this.pump();
        });
    }
    async runOne() {
        if (this.closed || !this.queue.length)
            return;
        const pending = this.queue.shift();
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
        }
        catch (error) {
            if (!this.cancelled && !(error instanceof Error && error.name === 'AbortError')) {
                this.queue.unshift(pending);
                await this.changed();
                this.phase = 'failed';
                this.notify(error instanceof Error ? error.message : String(error));
                this.options.emit('error', `${error instanceof Error ? error.message : String(error)} · use /queue retry`);
                return;
            }
        }
        finally {
            this.active = undefined;
            this.controller = undefined;
        }
        if (this.cancelled)
            this.options.emit('status', 'Request cancelled.');
        this.phase = 'idle';
        this.notify();
    }
    async changed() {
        try {
            await this.options.onQueueChange?.(this.pending());
        }
        catch (error) {
            this.options.emit('error', `Unable to save queued prompts: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.notify();
    }
    pending() {
        return [
            ...(this.replacement ? [this.replacement.prompt] : []),
            ...this.queue.map(({ prompt }) => prompt),
        ];
    }
    notify(error) {
        this.options.onState?.({ ...this.state(), error });
    }
}
