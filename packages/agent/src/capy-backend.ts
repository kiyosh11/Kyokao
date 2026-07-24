// @ts-nocheck
const activeStates = new Set(['running', 'stopping', 'queued', 'waiting', 'blocked']);
/**
 * Remote execution backend: drives a Capy thread through Capy's native API.
 * Creates (or continues) a thread, sends the prompt, then polls with jittered
 * exponential backoff until the thread reaches a terminal state, deduplicating
 * assistant messages by id along the way. Cancellation runs a bounded
 * stop-and-wait so a hung remote stop cannot block forever.
 */
export class CapyRemoteBackend {
  options;
  provider = 'capy';
  current;
  thread;
  stopping;
  seenMessages = new Set();
  constructor(options) {
    this.options = options;
  }
  async run(prompt, emit, signal) {
    this.current ??= await this.options.store.create(prompt, this.options.workspace);
    this.current.provider = 'capy';
    this.current.messages.push({ role: 'user', content: prompt });
    const directives = [
      this.current.goal ? `Active goal: ${this.current.goal}` : '',
      this.current.personality && this.current.personality !== 'default'
        ? `Response style: ${this.current.personality}.`
        : '',
    ].filter(Boolean);
    const remotePrompt = directives.length
      ? `${directives.join('\n')}\n\nUser request:\n${prompt}`
      : prompt;
    this.current.checkpoint = 'remote starting';
    await this.options.store.saveSession(this.current);
    if (this.current.remote) {
      if (this.current.remote.projectId !== this.options.projectId)
        throw new Error(
          `Session is bound to Capy project ${this.current.remote.projectId}; configured project is ${this.options.projectId}.`,
        );
      await this.options.client.sendMessage(
        this.current.remote.threadId,
        { message: remotePrompt, model: this.options.model },
        signal,
      );
    } else {
      // Merge the per-project execution overrides (speed, build model, repo
      // allowlist, default tags, attachments) into the createThread call.
      const input = {
        projectId: this.options.projectId,
        prompt: remotePrompt,
        model: this.options.model,
        ...this.options.threadDefaults,
      };
      this.thread = await this.options.client.createThread(input, signal);
      this.current.remote = {
        provider: 'capy',
        projectId: this.options.projectId,
        threadId: this.thread.id,
        runState: this.thread.runState,
      };
      await this.options.store.saveSession(this.current);
    }
    await this.poll(emit, signal);
  }
  async cancel() {
    const threadId = this.current?.remote?.threadId;
    if (!threadId || (this.thread && !activeStates.has(this.thread.runState))) return;
    this.stopping ??= this.stopAndWait(threadId).finally(() => {
      this.stopping = undefined;
    });
    await this.stopping;
  }
  async reset() {
    await this.cancel();
    this.current = undefined;
    this.thread = undefined;
    this.seenMessages.clear();
  }
  async resume(session) {
    if (!session.remote || session.remote.provider !== 'capy')
      throw new Error('This is a local session; switch to its local provider first.');
    if (session.remote.projectId !== this.options.projectId)
      throw new Error(
        `Session uses Capy project ${session.remote.projectId}; select that project before resuming.`,
      );
    this.current = session;
    this.thread = await this.options.client.getThread(session.remote.threadId);
    // Fetch the full remote history and seed dedup so poll() won't re-emit.
    const remote = await this.options.client.messages(session.remote.threadId);
    this.seenMessages.clear();
    for (const message of remote) this.seenMessages.add(message.id);
    // The remote thread is authoritative for the full conversation. Rebuild
    // the local transcript from it when the remote reports both sides of the
    // conversation — this recovers history even when the local session file is
    // missing or stale (e.g. resuming from just a thread id, or continuing a
    // thread that advanced outside this CLI). If the remote only carries
    // assistant messages (partial history or an older endpoint), keep the
    // local transcript which captured user prompts at send time.
    const sources = new Set(remote.map((message) => message.source));
    if (sources.has('user') && sources.has('assistant')) {
      const rebuilt = [];
      for (const message of remote) {
        if (message.source === 'user') rebuilt.push({ role: 'user', content: message.content });
        else if (message.source === 'assistant' && message.content)
          rebuilt.push({ role: 'assistant', content: message.content });
      }
      if (rebuilt.length) {
        session.messages = rebuilt;
        await this.options.store.saveSession(session);
      }
    }
  }
  status() {
    return {
      provider: this.provider,
      state: this.thread?.runState ?? this.current?.remote?.runState ?? 'ready',
      sessionId: this.current?.id,
      projectId: this.current?.remote?.projectId ?? this.options.projectId,
      threadId: this.current?.remote?.threadId,
      waitingOn: this.thread?.waitingOn,
      blockedOn: this.thread?.blockedOn,
      tasks: this.thread?.tasks,
      pullRequests: this.thread?.pullRequests,
    };
  }
  session() {
    return this.current;
  }
  async close() {
    await this.cancel();
  }
  async poll(emit, signal) {
    const threadId = this.current.remote.threadId;
    let delay = this.options.pollMinMs ?? 700;
    let previousStatus = '';
    while (true) {
      signal.throwIfAborted();
      this.thread = await this.options.client.getThread(threadId, signal);
      this.current.remote.runState = this.thread.runState;
      const status = this.describe(this.thread);
      if (status !== previousStatus) {
        emit('status', status);
        previousStatus = status;
      }
      for (const message of await this.options.client.messages(threadId, signal)) {
        if (this.seenMessages.has(message.id)) continue;
        this.seenMessages.add(message.id);
        if (message.source === 'assistant') {
          this.current.messages.push({ role: 'assistant', content: message.content });
          emit('assistant', message.content);
        }
      }
      this.current.checkpoint = `remote ${this.thread.runState}`;
      await this.options.store.saveSession(this.current);
      if (this.thread.runState === 'ready' || this.thread.runState === 'archived') return;
      await sleep(jitter(delay, this.options.random), signal);
      delay = Math.min(this.options.pollMaxMs ?? 5000, Math.ceil(delay * 1.5));
    }
  }
  async stopAndWait(threadId) {
    const controller = new AbortController();
    const timeoutMs = this.options.stopTimeoutMs ?? 8000;
    const deadline = Date.now() + timeoutMs;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new CapyStopTimeoutError(threadId, timeoutMs));
        controller.abort();
      }, timeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          await this.options.client.stopThread(threadId, controller.signal);
          while (true) {
            this.thread = await this.options.client.getThread(threadId, controller.signal);
            if (!activeStates.has(this.thread.runState)) return;
            await sleep(Math.min(500, Math.max(10, deadline - Date.now())), controller.signal);
          }
        })(),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  describe(thread) {
    const details = [
      thread.waitingOn.length ? `waiting on ${thread.waitingOn.join(', ')}` : '',
      thread.blockedOn.length ? `blocked on ${thread.blockedOn.join(', ')}` : '',
      thread.tasks.length
        ? `tasks ${thread.tasks.map((task) => `${task.identifier}:${task.status}`).join(', ')}`
        : '',
      thread.pullRequests.length
        ? `PRs ${thread.pullRequests.map((pull) => pull.url).join(', ')}`
        : '',
    ].filter(Boolean);
    return `Capy ${thread.runState}${details.length ? ` · ${details.join(' · ')}` : ''}`;
  }
}
export class CapyStopTimeoutError extends Error {
  constructor(threadId, timeoutMs) {
    super(`Capy thread ${threadId} stop timed out after ${timeoutMs}ms`);
    this.name = 'CapyStopTimeoutError';
  }
}
function jitter(delay, random = Math.random) {
  return Math.max(1, Math.round(delay * (0.85 + random() * 0.3)));
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(Object.assign(new Error('Request cancelled'), { name: 'AbortError' }));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
