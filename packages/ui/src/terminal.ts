import type { ReadStream, WriteStream } from 'node:tty';
export const ALT_SCREEN_ENTER = '\x1b[?1049h';
export const ALT_SCREEN_LEAVE = '\x1b[?1049l';
export const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
export const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';
export const AUTOWRAP_DISABLE = '\x1b[?7l';
export const AUTOWRAP_ENABLE = '\x1b[?7h';
export const CURSOR_HIDE = '\x1b[?25l';
export const CURSOR_SHOW = '\x1b[?25h';
export const ENHANCED_KEYBOARD_ENABLE = '\x1b[>1u';
export const ENHANCED_KEYBOARD_DISABLE = '\x1b[<u';
export const MODIFY_OTHER_KEYS_ENABLE = '\x1b[>4;2m';
export const MODIFY_OTHER_KEYS_DISABLE = '\x1b[>4;0m';
export const MOUSE_TRACKING_ENABLE = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_TRACKING_DISABLE = '\x1b[?1006l\x1b[?1000l';
export interface ScreenFrame {
  lines: string[];
  /** ANSI SGR sequence used while clearing the viewport behind the rendered frame. */
  background?: string;
  cursor?: {
    row: number;
    column: number;
  };
}
export interface InteractiveScreenOptions {
  input?: ReadStream;
  output?: WriteStream;
  alternate?: boolean;
}
export class InteractiveScreen {
  readonly input: ReadStream;
  readonly output: WriteStream;
  readonly alternate: boolean;
  private entered = false;
  private previousRaw = false;
  private previousEncoding: BufferEncoding | null = null;
  private enhancedKeyboard = false;
  private suspended = false;
  private readonly onProcessExit = () => this.leave();
  constructor(options: InteractiveScreenOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.alternate =
      options.alternate ??
      (this.input.isTTY === true && this.output.isTTY === true && process.env.TERM !== 'dumb');
  }
  enter(): void {
    if (this.entered) return;
    if (!this.input.isTTY || !this.output.isTTY)
      throw new Error('interactive screen requires a TTY');
    this.entered = true;
    this.previousRaw = this.input.isRaw ?? false;
    this.previousEncoding = this.input.readableEncoding;
    this.input.setRawMode(true);
    this.input.setEncoding('utf8');
    this.input.resume();
    this.enhancedKeyboard = process.env.TERM !== 'dumb';
    process.once('exit', this.onProcessExit);
    this.output.write(
      `${this.alternate ? ALT_SCREEN_ENTER : ''}${BRACKETED_PASTE_ENABLE}${MOUSE_TRACKING_ENABLE}${this.enhancedKeyboard ? `${ENHANCED_KEYBOARD_ENABLE}${MODIFY_OTHER_KEYS_ENABLE}` : ''}${CURSOR_SHOW}`,
    );
  }
  draw(frame: ScreenFrame): void {
    if (!this.entered) throw new Error('interactive screen is not active');
    if (this.suspended) return;
    const height = Math.max(1, this.output.rows ?? 24);
    const lines = frame.lines.slice(0, height);
    while (lines.length < height) lines.push('');
    // Disable autowrap while painting a frame. Writing the last terminal
    // column otherwise advances to the next physical row on common Windows
    // terminals, which shifts every row that follows. CRLF also guarantees
    // that each logical line starts at column one.
    const clearViewport = frame.background
      ? `${frame.background}\x1b[H\x1b[2J\x1b[0m`
      : '\x1b[H\x1b[2J';
    this.output.write(
      `${CURSOR_HIDE}${AUTOWRAP_DISABLE}${clearViewport}${lines.join('\r\n')}${AUTOWRAP_ENABLE}`,
    );
    if (frame.cursor) {
      const row = Math.max(0, Math.min(height - 1, frame.cursor.row));
      const width = Math.max(1, this.output.columns ?? 80);
      const column = Math.max(0, Math.min(width - 1, frame.cursor.column));
      this.output.write(`\x1b[${row + 1};${column + 1}H${CURSOR_SHOW}`);
    }
  }
  suspend(): void {
    if (!this.entered || this.suspended) return;
    this.suspended = true;
    this.input.pause();
    this.input.setRawMode(false);
    this.output.write(
      `${AUTOWRAP_ENABLE}${CURSOR_SHOW}${MOUSE_TRACKING_DISABLE}${this.enhancedKeyboard ? `${MODIFY_OTHER_KEYS_DISABLE}${ENHANCED_KEYBOARD_DISABLE}` : ''}${BRACKETED_PASTE_DISABLE}${this.alternate ? ALT_SCREEN_LEAVE : ''}`,
    );
  }
  resume(): void {
    if (!this.entered || !this.suspended) return;
    this.input.setRawMode(true);
    this.input.resume();
    this.output.write(
      `${this.alternate ? ALT_SCREEN_ENTER : ''}${BRACKETED_PASTE_ENABLE}${MOUSE_TRACKING_ENABLE}${this.enhancedKeyboard ? `${ENHANCED_KEYBOARD_ENABLE}${MODIFY_OTHER_KEYS_ENABLE}` : ''}${CURSOR_SHOW}`,
    );
    this.suspended = false;
  }
  leave(): void {
    if (!this.entered) return;
    this.entered = false;
    process.removeListener('exit', this.onProcessExit);
    try {
      if (!this.suspended)
        this.output.write(
          `${AUTOWRAP_ENABLE}${CURSOR_SHOW}${MOUSE_TRACKING_DISABLE}${this.enhancedKeyboard ? `${MODIFY_OTHER_KEYS_DISABLE}${ENHANCED_KEYBOARD_DISABLE}` : ''}${BRACKETED_PASTE_DISABLE}${this.alternate ? ALT_SCREEN_LEAVE : '\x1b[H\x1b[2J'}`,
        );
    } catch {}
    this.suspended = false;
    try {
      this.input.setRawMode(this.previousRaw);
      if (this.previousEncoding) this.input.setEncoding(this.previousEncoding);
      this.input.pause();
    } catch {}
  }
}
export async function withInteractiveScreen<T>(
  options: InteractiveScreenOptions,
  run: (screen: InteractiveScreen) => Promise<T>,
): Promise<T> {
  const screen = new InteractiveScreen(options);
  try {
    screen.enter();
    return await run(screen);
  } finally {
    screen.leave();
  }
}
