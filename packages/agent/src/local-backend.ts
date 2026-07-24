// @ts-nocheck
/**
 * Local execution backend: drives an in-process agent loop against an
 * OpenAI-compatible provider. Persists session checkpoints at each turn,
 * including interrupted and failed states, so a crashed run can be resumed.
 */
export class LocalAgentBackend {
    options;
    provider = 'local';
    current;
    controller;
    constructor(options) {
        this.options = options;
    }
    async run(prompt, emit, signal) {
        this.current ??= await this.options.store.create(prompt, this.options.workspace);
        this.current.provider = 'local';
        this.current.checkpoint = 'starting';
        await this.options.store.saveSession(this.current);
        const controller = new AbortController();
        this.controller = controller;
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            controller.abort(signal.reason);
        try {
            if (controller.signal.aborted) {
                this.current.messages.push({ role: 'user', content: prompt });
                this.current.checkpoint = 'interrupted';
                await this.options.store.saveSession(this.current);
                throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
            }
            this.current = await this.options
                .createAgent(controller.signal, emit)
                .run(prompt, this.current);
        }
        catch (error) {
            if (controller.signal.aborted) {
                this.current.checkpoint = 'interrupted';
                await this.options.store.saveSession(this.current);
                throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
            }
            this.current.checkpoint = `failed: ${error instanceof Error ? error.message : String(error)}`;
            await this.options.store.saveSession(this.current);
            throw error;
        }
        finally {
            signal.removeEventListener('abort', abort);
            this.controller = undefined;
        }
    }
    async cancel() {
        this.controller?.abort();
    }
    async reset() {
        this.current = undefined;
    }
    async resume(session) {
        if (session.remote)
            throw new Error('This is a Capy session; switch to the Capy provider first.');
        this.current = session;
    }
    status() {
        return {
            provider: this.provider,
            state: this.controller ? 'running' : 'ready',
            sessionId: this.current?.id,
        };
    }
    session() {
        return this.current;
    }
    async close() {
        await this.cancel();
    }
}
