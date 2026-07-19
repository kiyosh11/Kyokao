import pc from 'picocolors';
import { createInterface } from 'node:readline/promises';
import type { ReadStream, WriteStream } from 'node:tty';

const keywords =
  /\b(const|let|var|function|return|if|else|for|while|class|interface|type|import|from|export|async|await|new|true|false|null|undefined)\b/g;
export function highlightCode(source: string, language = ''): string {
  const color = (value: string) =>
    language.toLowerCase().includes('json') ? pc.yellow(value) : pc.cyan(value);
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) return pc.dim(line);
      return line
        .replace(keywords, (keyword) => pc.magenta(keyword))
        .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (value) => color(value));
    })
    .join('\n');
}
export function renderMarkdown(value: string): string {
  return value.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, language: string, code: string) =>
      `\n${highlightCode(code.replace(/\n$/, ''), language)}\n`,
  );
}
export async function fullscreenChat(
  onPrompt: (prompt: string) => Promise<string | undefined>,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<void> {
  if (!input.isTTY || !output.isTTY) throw new Error('tui requires an interactive terminal');
  const previousRaw = input.isRaw;
  const previousEncoding = input.readableEncoding;
  let buffer = '';
  let transcript: string[] = ['Kyokao full-screen chat', 'Enter sends · Ctrl+C exits', ''];
  const draw = () => {
    output.write('\x1b[2J\x1b[H');
    const height = output.rows ?? 24;
    output.write(transcript.slice(-Math.max(3, height - 2)).join('\n'));
    output.write(`\n\n> ${buffer}`);
  };
  output.write('\x1b[?1049h\x1b[?25l');
  input.setRawMode(true);
  input.setEncoding('utf8');
  draw();
  try {
    await new Promise<void>((resolve) => {
      const onData = async (chunk: string) => {
        if (chunk === '\u0003' || chunk === '\u001b') return resolve();
        if (chunk === '\u007f') buffer = buffer.slice(0, -1);
        else if (chunk === '\r' || chunk === '\n') {
          const prompt = buffer.trim();
          if (prompt) {
            transcript.push(`> ${prompt}`);
            buffer = '';
            draw();
            const answer = await onPrompt(prompt);
            if (answer) transcript.push(renderMarkdown(answer));
          }
        } else if (chunk >= ' ' && chunk !== '\u001b') buffer += chunk;
        draw();
      };
      input.on('data', onData);
      input.once('close', resolve);
      input.once('error', resolve);
    });
  } finally {
    input.removeAllListeners('data');
    input.setRawMode(previousRaw ?? false);
    if (previousEncoding) input.setEncoding(previousEncoding);
    output.write('\x1b[?25h\x1b[?1049l');
  }
}
export const ui = {
  info: (s: string) => console.log(pc.cyan(s)),
  error: (s: string) => console.error(pc.red(s)),
  assistant: (s: string) => console.log(pc.green(renderMarkdown(s))),
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
