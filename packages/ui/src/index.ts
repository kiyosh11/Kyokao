import pc from 'picocolors';
import { createInterface } from 'node:readline/promises';
export const ui = {
  info: (s: string) => console.log(pc.cyan(s)),
  error: (s: string) => console.error(pc.red(s)),
  assistant: (s: string) => console.log(pc.green(s)),
  tool: (s: string) => console.error(pc.dim(`• ${s}`)),
  diff: (s: string) =>
    console.log(
      s
        .split('\n')
        .map((l) => (l.startsWith('+') ? pc.green(l) : l.startsWith('-') ? pc.red(l) : l))
        .join('\n'),
    ),
  async approve(action: string, detail: string) {
    if (!process.stdin.isTTY) return false;
    const r = createInterface({ input: process.stdin, output: process.stdout });
    const a = await r.question(`${pc.yellow(`Allow ${action}`)} ${detail}? [y/N] `);
    r.close();
    return /^y(es)?$/i.test(a);
  },
};
