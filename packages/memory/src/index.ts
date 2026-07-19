import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@kyokao/providers';
import type { TokenUsage } from '@kyokao/providers';
export interface SessionUsage extends TokenUsage {
  requests: number;
  estimatedCostUsd: number;
  compressedMessages: number;
}
export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  task?: string;
  checkpoint?: string;
  usage?: SessionUsage;
  contextSummary?: string;
}
async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}
function safeId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new Error('Invalid session id');
  return id;
}
export class LocalStore {
  constructor(readonly root: string) {}
  private sessions() {
    return join(this.root, 'sessions');
  }
  private memory() {
    return join(this.root, 'memory.json');
  }
  async saveSession(s: Session) {
    safeId(s.id);
    s.updatedAt = new Date().toISOString();
    await atomicWrite(join(this.sessions(), `${s.id}.json`), s);
  }
  async create(task?: string): Promise<Session> {
    const now = new Date().toISOString();
    const s: Session = { id: randomUUID(), createdAt: now, updatedAt: now, messages: [], task };
    await this.saveSession(s);
    return s;
  }
  async loadSession(id: string): Promise<Session> {
    try {
      const session = JSON.parse(
        await readFile(join(this.sessions(), `${safeId(id)}.json`), 'utf8'),
      ) as Session;
      if (!Array.isArray(session.messages) || session.id !== id)
        throw new Error('invalid session structure');
      return session;
    } catch (e: any) {
      throw new Error(
        e?.code === 'ENOENT'
          ? `Session not found: ${id}`
          : `Unable to read session ${id}: ${e.message}`,
      );
    }
  }
  async listSessions(): Promise<Session[]> {
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
      return loaded
        .filter((x): x is Session => !!x)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }
  async getMemory(): Promise<Record<string, string>> {
    try {
      const v = JSON.parse(await readFile(this.memory(), 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  async setMemory(key: string, value: string) {
    if (!key) throw new Error('Memory key is required');
    const all = await this.getMemory();
    all[key] = value;
    await atomicWrite(this.memory(), all);
  }
  async deleteMemory(key: string) {
    const all = await this.getMemory();
    delete all[key];
    await atomicWrite(this.memory(), all);
  }
}
