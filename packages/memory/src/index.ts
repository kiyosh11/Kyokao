// @ts-nocheck
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    try {
      await rename(tmp, path);
    } catch (error) {
      const code = error.code;
      if (!['EACCES', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code ?? '')) throw error;
      let lastError = error;
      for (const delay of [0, 25, 75, 150, 300]) {
        if (delay) await sleep(delay);
        try {
          await copyFile(tmp, path);
          return;
        } catch (copyError) {
          lastError = copyError;
          const copyCode = copyError.code;
          if (!['EACCES', 'EBUSY', 'EPERM'].includes(copyCode ?? '')) throw copyError;
        }
      }
      throw lastError;
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
function safeId(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new Error('Invalid session id');
  return id;
}
export class LocalStore {
  root;
  constructor(root) {
    this.root = root;
  }
  sessions() {
    return join(this.root, 'sessions');
  }
  sessionPath(id) {
    return join(this.sessions(), `${safeId(id)}.json`);
  }
  memory() {
    return join(this.root, 'memory.json');
  }
  async saveSession(s) {
    safeId(s.id);
    s.updatedAt = new Date().toISOString();
    await atomicWrite(this.sessionPath(s.id), s);
  }
  async create(task, workspace) {
    const now = new Date().toISOString();
    const s = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      messages: [],
      task,
      workspace,
    };
    await this.saveSession(s);
    return s;
  }
  async loadSession(id) {
    try {
      const session = JSON.parse(await readFile(this.sessionPath(id), 'utf8'));
      if (!Array.isArray(session.messages) || session.id !== id)
        throw new Error('invalid session structure');
      return session;
    } catch (e) {
      throw new Error(
        e?.code === 'ENOENT'
          ? `Session not found: ${id}`
          : `Unable to read session ${id}: ${e.message}`,
      );
    }
  }
  async deleteSession(id) {
    safeId(id);
    await rm(this.sessionPath(id), { force: true });
  }
  async allSessions() {
    try {
      const loaded = await Promise.all(
        (await readdir(this.sessions()))
          .filter((n) => n.endsWith('.json'))
          .map(async (n) => {
            try {
              return await this.loadSession(n.slice(0, -5));
            } catch {
              return undefined;
            }
          }),
      );
      return loaded.filter((x) => !!x).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }
  async listSessions() {
    return (await this.allSessions()).filter((session) => session.archived !== true);
  }
  async listArchivedSessions() {
    return (await this.allSessions()).filter((session) => session.archived === true);
  }
  async archiveSession(id) {
    const session = await this.loadSession(id);
    session.archived = true;
    await this.saveSession(session);
    return session;
  }
  async restoreSession(id) {
    const session = await this.loadSession(id);
    session.archived = false;
    await this.saveSession(session);
    return session;
  }
  async forkSession(id) {
    const source = await this.loadSession(id);
    const now = new Date().toISOString();
    const fork = JSON.parse(JSON.stringify(source));
    fork.id = randomUUID();
    fork.createdAt = now;
    fork.updatedAt = now;
    fork.archived = false;
    fork.task = `${source.task?.trim() || 'Session'} (fork)`;
    delete fork.remote;
    delete fork.pendingPrompts;
    await this.saveSession(fork);
    return fork;
  }
  async getMemory() {
    try {
      const v = JSON.parse(await readFile(this.memory(), 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  async setMemory(key, value) {
    if (!key) throw new Error('Memory key is required');
    const all = await this.getMemory();
    all[key] = value;
    await atomicWrite(this.memory(), all);
  }
  async deleteMemory(key) {
    const all = await this.getMemory();
    delete all[key];
    await atomicWrite(this.memory(), all);
  }
}
