const ansiPattern = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

export function graphemes(value: string): string[] {
  return segmenter
    ? Array.from(segmenter.segment(value), (entry) => entry.segment)
    : Array.from(value);
}

export function stripAnsi(value: string): string {
  return value.replace(ansiPattern, '');
}

export function graphemeWidth(value: string): number {
  if (!value || value === '\n' || value === '\r') return 0;
  if (/^\p{Mark}+$/u.test(value)) return 0;
  const code = value.codePointAt(0) ?? 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    /\p{Extended_Pictographic}/u.test(value) ||
    (code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6)))
  )
    return 2;
  return 1;
}

export function displayWidth(value: string): number {
  return graphemes(stripAnsi(value)).reduce((width, value) => width + graphemeWidth(value), 0);
}

export function truncateDisplay(value: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;
  const target = Math.max(0, width - displayWidth(ellipsis));
  let result = '';
  let used = 0;
  for (const character of graphemes(stripAnsi(value))) {
    const next = graphemeWidth(character);
    if (used + next > target) break;
    result += character;
    used += next;
  }
  return `${result}${ellipsis}`;
}

export function padDisplay(value: string, width: number): string {
  const fitted = truncateDisplay(value, width);
  return `${fitted}${' '.repeat(Math.max(0, width - displayWidth(fitted)))}`;
}

export type EditorKey =
  | 'backspace'
  | 'delete'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'ctrl-a'
  | 'ctrl-e'
  | 'ctrl-u'
  | 'ctrl-k'
  | 'ctrl-w'
  | 'alt-left'
  | 'alt-right'
  | 'enter'
  | 'newline'
  | 'queue'
  | 'tab'
  | 'escape'
  | 'page-up'
  | 'page-down'
  | 'interrupt';

export type InputEvent =
  | { type: 'key'; key: EditorKey }
  | { type: 'text'; text: string }
  | { type: 'paste'; text: string };

const sequences: Array<[string, EditorKey]> = [
  ['\x1b[27;2;13~', 'newline'],
  ['\x1b[27;3;13~', 'newline'],
  ['\x1b[27;5;13~', 'queue'],
  ['\x1b[13;2u', 'newline'],
  ['\x1b[13;3u', 'newline'],
  ['\x1b[13;5u', 'queue'],
  ['\x1b[27;5;97~', 'ctrl-a'],
  ['\x1b[27;5;99~', 'interrupt'],
  ['\x1b[27;5;101~', 'ctrl-e'],
  ['\x1b[27;5;106~', 'queue'],
  ['\x1b[27;5;107~', 'ctrl-k'],
  ['\x1b[27;5;117~', 'ctrl-u'],
  ['\x1b[27;5;119~', 'ctrl-w'],
  ['\x1b[97;5u', 'ctrl-a'],
  ['\x1b[99;5u', 'interrupt'],
  ['\x1b[101;5u', 'ctrl-e'],
  ['\x1b[106;5u', 'queue'],
  ['\x1b[107;5u', 'ctrl-k'],
  ['\x1b[117;5u', 'ctrl-u'],
  ['\x1b[119;5u', 'ctrl-w'],
  ['\x1b[1;3D', 'alt-left'],
  ['\x1b[1;3C', 'alt-right'],
  ['\x1b[3~', 'delete'],
  ['\x1b[5~', 'page-up'],
  ['\x1b[6~', 'page-down'],
  ['\x1b[4~', 'end'],
  ['\x1b[1~', 'home'],
  ['\x1b[A', 'up'],
  ['\x1b[B', 'down'],
  ['\x1b[C', 'right'],
  ['\x1b[D', 'left'],
  ['\x1b[H', 'home'],
  ['\x1b[F', 'end'],
  ['\x1bb', 'alt-left'],
  ['\x1bf', 'alt-right'],
  ['\x1b\r', 'newline'],
  ['\x1b\n', 'newline'],
];
const pasteStart = '\x1b[200~';
const pasteEnd = '\x1b[201~';

export class TerminalInputParser {
  private buffer = '';
  private pasted: string | undefined;

  feed(chunk: string): InputEvent[] {
    this.buffer += chunk;
    const events: InputEvent[] = [];
    while (this.buffer) {
      if (this.pasted !== undefined) {
        const end = this.buffer.indexOf(pasteEnd);
        if (end >= 0) {
          this.pasted += this.buffer.slice(0, end);
          events.push({ type: 'paste', text: this.pasted });
          this.pasted = undefined;
          this.buffer = this.buffer.slice(end + pasteEnd.length);
          continue;
        }
        const safe = Math.max(0, this.buffer.length - pasteEnd.length + 1);
        this.pasted += this.buffer.slice(0, safe);
        this.buffer = this.buffer.slice(safe);
        break;
      }
      if (this.buffer.startsWith(pasteStart)) {
        this.buffer = this.buffer.slice(pasteStart.length);
        this.pasted = '';
        continue;
      }
      if (pasteStart.startsWith(this.buffer)) break;
      if (this.buffer.startsWith('\x1b')) {
        const match = sequences.find(([sequence]) => this.buffer.startsWith(sequence));
        if (match) {
          this.buffer = this.buffer.slice(match[0].length);
          events.push({ type: 'key', key: match[1] });
          continue;
        }
        if (sequences.some(([sequence]) => sequence.startsWith(this.buffer))) break;
        const csi = this.buffer.match(/^\x1b\[[0-9;?]*[~A-Za-z]/)?.[0];
        if (csi) {
          this.buffer = this.buffer.slice(csi.length);
          continue;
        }
        if (this.buffer === '\x1b' || pasteStart.startsWith(this.buffer)) break;
        this.buffer = this.buffer.slice(1);
        events.push({ type: 'key', key: 'escape' });
        continue;
      }
      const character = Array.from(this.buffer)[0]!;
      this.buffer = this.buffer.slice(character.length);
      const key: EditorKey | undefined =
        character === '\r'
          ? 'enter'
          : character === '\n'
            ? 'queue'
            : character === '\x7f' || character === '\b'
              ? 'backspace'
              : character === '\t'
                ? 'tab'
                : character === '\x03'
                  ? 'interrupt'
                  : character === '\x01'
                    ? 'ctrl-a'
                    : character === '\x05'
                      ? 'ctrl-e'
                      : character === '\x15'
                        ? 'ctrl-u'
                        : character === '\x0b'
                          ? 'ctrl-k'
                          : character === '\x17'
                            ? 'ctrl-w'
                            : undefined;
      if (key) events.push({ type: 'key', key });
      else if (character >= ' ') events.push({ type: 'text', text: character });
    }
    return events;
  }

  flushEscape(): InputEvent[] {
    if (this.buffer === '\x1b') {
      this.buffer = '';
      return [{ type: 'key', key: 'escape' }];
    }
    return [];
  }
}

export class EditorState {
  private content: string[] = [];
  cursor = 0;
  private preferredColumn: number | undefined;

  constructor(value = '') {
    this.set(value);
  }

  get text(): string {
    return this.content.join('');
  }

  get multiline(): boolean {
    return this.content.includes('\n');
  }

  set(value: string, cursor = graphemes(value).length): void {
    this.content = graphemes(value);
    this.cursor = Math.max(0, Math.min(cursor, this.content.length));
    this.preferredColumn = undefined;
  }

  insert(value: string): void {
    const inserted = graphemes(value);
    this.content.splice(this.cursor, 0, ...inserted);
    this.cursor += inserted.length;
    this.preferredColumn = undefined;
  }

  backspace(): void {
    if (this.cursor > 0) this.content.splice(--this.cursor, 1);
    this.preferredColumn = undefined;
  }

  delete(): void {
    if (this.cursor < this.content.length) this.content.splice(this.cursor, 1);
    this.preferredColumn = undefined;
  }

  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
    this.preferredColumn = undefined;
  }

  right(): void {
    this.cursor = Math.min(this.content.length, this.cursor + 1);
    this.preferredColumn = undefined;
  }

  home(): void {
    this.cursor = this.lineStart();
    this.preferredColumn = undefined;
  }

  end(): void {
    this.cursor = this.lineEnd();
    this.preferredColumn = undefined;
  }

  start(): void {
    this.cursor = 0;
    this.preferredColumn = undefined;
  }

  finish(): void {
    this.cursor = this.content.length;
    this.preferredColumn = undefined;
  }

  killBefore(): void {
    const start = this.lineStart();
    this.content.splice(start, this.cursor - start);
    this.cursor = start;
  }

  killAfter(): void {
    this.content.splice(this.cursor, this.lineEnd() - this.cursor);
  }

  deleteWordBefore(): void {
    let start = this.cursor;
    while (start > 0 && /\s/u.test(this.content[start - 1]!)) start--;
    while (start > 0 && !/\s/u.test(this.content[start - 1]!)) start--;
    this.content.splice(start, this.cursor - start);
    this.cursor = start;
  }

  wordLeft(): void {
    while (this.cursor > 0 && /\s/u.test(this.content[this.cursor - 1]!)) this.cursor--;
    while (this.cursor > 0 && !/\s/u.test(this.content[this.cursor - 1]!)) this.cursor--;
  }

  wordRight(): void {
    while (this.cursor < this.content.length && !/\s/u.test(this.content[this.cursor]!))
      this.cursor++;
    while (this.cursor < this.content.length && /\s/u.test(this.content[this.cursor]!))
      this.cursor++;
  }

  vertical(delta: -1 | 1): void {
    const start = this.lineStart();
    const column = this.preferredColumn ?? this.cursor - start;
    this.preferredColumn = column;
    if (delta < 0) {
      if (start === 0) return;
      const previousEnd = start - 1;
      const previousStart = this.content.lastIndexOf('\n', previousEnd - 1) + 1;
      this.cursor = Math.min(previousStart + column, previousEnd);
    } else {
      const end = this.lineEnd();
      if (end === this.content.length) return;
      const nextStart = end + 1;
      const nextEnd = this.content.indexOf('\n', nextStart);
      this.cursor = Math.min(nextStart + column, nextEnd < 0 ? this.content.length : nextEnd);
    }
  }

  private lineStart(): number {
    return this.content.lastIndexOf('\n', this.cursor - 1) + 1;
  }

  private lineEnd(): number {
    const end = this.content.indexOf('\n', this.cursor);
    return end < 0 ? this.content.length : end;
  }
}

export function layoutEditor(
  value: string,
  cursor: number,
  width: number,
): { rows: string[]; cursor: { row: number; column: number } } {
  const safeWidth = Math.max(1, width);
  const values = graphemes(value);
  const rows = ['› '];
  let row = 0;
  let column = Math.min(2, safeWidth - 1);
  let cursorPosition = { row, column };
  const wrap = () => {
    rows.push('  ');
    row++;
    column = Math.min(2, safeWidth - 1);
  };
  for (let index = 0; index <= values.length; index++) {
    if (index === cursor) cursorPosition = { row, column };
    if (index === values.length) break;
    const value = values[index]!;
    if (value === '\n') {
      wrap();
      continue;
    }
    const cellWidth = Math.max(0, graphemeWidth(value));
    if (column + cellWidth > safeWidth) wrap();
    rows[row] += value;
    column += cellWidth;
    if (column >= safeWidth && index + 1 <= values.length) wrap();
  }
  if (cursor === values.length) cursorPosition = { row, column };
  return { rows, cursor: cursorPosition };
}
