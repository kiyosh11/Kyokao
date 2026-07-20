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
type TranscriptEntry = { role: 'system' | 'user' | 'assistant'; text: string };
const commands = [
  ['/help', 'Show keyboard shortcuts and commands'],
  ['/clear', 'Clear the visible transcript'],
  ['/exit', 'Exit the terminal interface'],
] as const;
const wrapText = (value: string, width: number): string[] => {
  const lines: string[] = [];
  for (const source of value.split('\n')) {
    if (!source) {
      lines.push('');
      continue;
    }
    let line = source;
    while (line.length > width) {
      const split = line.lastIndexOf(' ', width);
      const at = split > 0 ? split : width;
      lines.push(line.slice(0, at));
      line = line.slice(at).trimStart();
    }
    lines.push(line);
  }
  return lines;
};
export async function fullscreenChat(
  onPrompt: (prompt: string) => Promise<string | undefined>,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<void> {
  if (!input.isTTY || !output.isTTY) throw new Error('tui requires an interactive terminal');
  const previousRaw = input.isRaw;
  const previousEncoding = input.readableEncoding;
  let buffer = '';
  let busy = false;
  let scrollOffset = 0;
  let commandIndex = 0;
  let transcript: TranscriptEntry[] = [
    { role: 'system', text: 'Welcome to Kyokao. Type a task to begin.' },
    { role: 'system', text: 'Type / to browse commands.' },
  ];
  const matches = () =>
    buffer.startsWith('/')
      ? commands.filter(([command]) => command.startsWith(buffer.toLowerCase()))
      : [];
  const moveScroll = (amount: number) => {
    scrollOffset = Math.max(0, scrollOffset + amount);
    draw();
  };
  const draw = () => {
    output.write('\x1b[2J\x1b[H');
    const height = output.rows ?? 24;
    const width = Math.max(32, output.columns ?? 80);
    const contentWidth = Math.max(20, width - 9);
    const suggestions = matches();
    commandIndex = Math.min(commandIndex, Math.max(0, suggestions.length - 1));
    const suggestionLines = suggestions.length ? Math.min(5, suggestions.length) + 1 : 0;
    const contentHeight = Math.max(3, height - 8 - suggestionLines);
    const title = ' KYOKAO · local coding workspace';
    output.write(`${pc.dim('╭' + '─'.repeat(Math.max(0, width - 2)) + '╮')}\n`);
    output.write(
      `│${pc.bold(pc.cyan(title))}${' '.repeat(Math.max(0, width - 2 - title.length))}│\n`,
    );
    output.write(`${pc.dim('├' + '─'.repeat(Math.max(0, width - 2)) + '┤')}\n`);
    const rendered = transcript.flatMap((entry) => {
      const label =
        entry.role === 'user'
          ? pc.cyan('› ')
          : entry.role === 'assistant'
            ? pc.green('  ')
            : pc.dim('· ');
      return wrapText(entry.text, contentWidth).map(
        (line, index) => `${index === 0 ? label : '  '}${renderMarkdown(line)}`,
      );
    });
    const maxScroll = Math.max(0, rendered.length - contentHeight);
    scrollOffset = Math.min(scrollOffset, maxScroll);
    const end = rendered.length - scrollOffset;
    const start = Math.max(0, end - contentHeight);
    const visible = rendered.slice(start, end);
    if (scrollOffset > 0)
      visible.unshift(pc.dim(`↑ ${scrollOffset} lines older · PgUp/PgDn scroll`));
    output.write(`${visible.join('\n')}\n`);
    output.write(`${pc.dim('├' + '─'.repeat(Math.max(0, width - 2)) + '┤')}\n`);
    const statusText = busy
      ? 'thinking…'
      : scrollOffset > 0
        ? 'scrolled view · press End to return'
        : 'ready';
    const status = busy ? pc.yellow(statusText) : pc.dim(statusText);
    output.write(`│ ${status}${' '.repeat(Math.max(0, width - 3 - statusText.length))}│\n`);
    output.write(`${pc.dim('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯')}\n`);
    if (suggestions.length) {
      output.write(`${pc.dim('Commands')}\n`);
      for (const [[command, description], index] of suggestions
        .slice(0, 5)
        .map((item, index) => [item, index] as const)) {
        const marker = index === commandIndex ? pc.cyan('›') : ' ';
        output.write(`${marker} ${pc.cyan(command)} ${pc.dim(description)}\n`);
      }
    }
    output.write(
      `${pc.dim('Enter')} send  ${pc.dim('PgUp/PgDn')} scroll  ${pc.dim('Ctrl+C')} exit\n`,
    );
    output.write(`${pc.cyan('›')} ${buffer}`);
  };
  output.write('\x1b[?1049h\x1b[?25l');
  output.write('\x1b[?1000h\x1b[?1006h');
  input.setRawMode(true);
  input.setEncoding('utf8');
  const onResize = () => draw();
  output.on('resize', onResize);
  draw();
  try {
    await new Promise<void>((resolve) => {
      const onData = async (chunk: string) => {
        if (chunk === '\u0003') return resolve();
        if (chunk === '\u001b') return resolve();
        if (chunk.startsWith('\u001b[<')) {
          const mouse = chunk.match(/\u001b\[<(\d+);\d+;\d+[mM]/);
          if (mouse) moveScroll(Number(mouse[1]) === 64 ? 3 : -3);
          return;
        }
        if (chunk === '\u001b[A') {
          const options = matches();
          if (options.length) {
            commandIndex = Math.max(0, commandIndex - 1);
            return draw();
          }
          return moveScroll(4);
        }
        if (chunk === '\u001b[B') {
          const options = matches();
          if (options.length) {
            commandIndex = Math.min(options.length - 1, commandIndex + 1);
            return draw();
          }
          return moveScroll(-4);
        }
        if (chunk === '\u001b[5~') return moveScroll(4);
        if (chunk === '\u001b[6~') return moveScroll(-4);
        if (chunk === '\u001b[H' || chunk === '\u001b[1~') return moveScroll(10_000);
        if (chunk === '\u001b[F' || chunk === '\u001b[4~') {
          scrollOffset = 0;
          return draw();
        }
        if (chunk === '\u001b[C' || chunk === '\u001b[D' || chunk.startsWith('\u001b['))
          return draw();
        if (busy) return draw();
        if (chunk === '\u007f') buffer = buffer.slice(0, -1);
        else if (chunk === '\t') {
          const options = matches();
          if (options.length) buffer = options[commandIndex][0];
        } else if (chunk === '\r' || chunk === '\n') {
          const prompt = buffer.trim();
          if (prompt) {
            if (prompt === '/exit' || prompt === '/quit') return resolve();
            if (prompt === '/help') {
              transcript.push({
                role: 'system',
                text: 'Commands: /help shows this message, /clear clears the transcript, /exit closes Kyokao. Use PgUp/PgDn or the mouse wheel to scroll the transcript.',
              });
              buffer = '';
              scrollOffset = 0;
              return draw();
            }
            if (prompt === '/clear') {
              transcript = [];
              buffer = '';
              scrollOffset = 0;
              return draw();
            }
            transcript.push({ role: 'user', text: prompt });
            buffer = '';
            scrollOffset = 0;
            busy = true;
            draw();
            try {
              const answer = await onPrompt(prompt);
              if (answer) transcript.push({ role: 'assistant', text: answer });
            } catch (error) {
              transcript.push({
                role: 'system',
                text: error instanceof Error ? error.message : String(error),
              });
            } finally {
              busy = false;
            }
          }
        } else if (chunk >= ' ' && chunk !== '\u001b') {
          buffer += chunk;
          commandIndex = 0;
        }
        draw();
      };
      input.on('data', onData);
      input.once('close', resolve);
      input.once('error', resolve);
    });
  } finally {
    input.removeAllListeners('data');
    output.removeListener('resize', onResize);
    input.setRawMode(previousRaw ?? false);
    if (previousEncoding) input.setEncoding(previousEncoding);
    output.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
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
