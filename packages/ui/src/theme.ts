import {
  backgroundEscape,
  codeThemes,
  detectColorLevel,
  isCodeThemeName,
  isTuiThemeName,
  paintBackground,
  paintToken,
  tuiThemes,
  type CodeThemeName,
  type ColorLevel,
  type ColorToken,
  type TuiThemeName,
} from '@kyokao/themes';

export * from '@kyokao/themes';

export interface ThemeContextOptions {
  tuiTheme?: string;
  codeTheme?: string;
  colorLevel?: ColorLevel;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  forceColor?: boolean | ColorLevel;
}

export class ThemeContext {
  private tuiName: TuiThemeName;
  private codeName: CodeThemeName;
  readonly colorLevel: ColorLevel;

  constructor(options: ThemeContextOptions = {}) {
    const tuiName = options.tuiTheme ?? 'kyokao-dark';
    const codeName = options.codeTheme ?? 'kyokao';
    if (!isTuiThemeName(tuiName)) throw new Error(`Unknown TUI theme: ${tuiName}`);
    if (!isCodeThemeName(codeName)) throw new Error(`Unknown code theme: ${codeName}`);
    this.tuiName = tuiName;
    this.codeName = codeName;
    this.colorLevel =
      options.colorLevel ??
      detectColorLevel({
        env: options.env,
        isTTY: options.isTTY,
        forceColor: options.forceColor,
      });
  }

  get tuiTheme() {
    return tuiThemes[this.tuiName];
  }

  get codeTheme() {
    return codeThemes[this.codeName];
  }

  get names(): Readonly<{ tui: TuiThemeName; code: CodeThemeName }> {
    return Object.freeze({ tui: this.tuiName, code: this.codeName });
  }

  setTuiTheme(name: string): void {
    if (!isTuiThemeName(name)) throw new Error(`Unknown TUI theme: ${name}`);
    this.tuiName = name;
  }

  setCodeTheme(name: string): void {
    if (!isCodeThemeName(name)) throw new Error(`Unknown code theme: ${name}`);
    this.codeName = name;
  }

  paint(token: ColorToken, value: string): string {
    return paintToken(value, token, this.colorLevel);
  }

  background(value: string): string {
    const token =
      this.tuiTheme.background ??
      tuiThemes[this.tuiTheme.dark ? 'kyokao-dark' : 'kyokao-light'].background;
    return token ? paintBackground(value, token, this.colorLevel) : value;
  }

  backgroundEscape(): string {
    const token =
      this.tuiTheme.background ??
      tuiThemes[this.tuiTheme.dark ? 'kyokao-dark' : 'kyokao-light'].background;
    return token ? backgroundEscape(token, this.colorLevel) : '';
  }

  tui(token: Exclude<keyof typeof this.tuiTheme, 'name' | 'dark' | 'background'>, value: string) {
    return this.paint(this.tuiTheme[token], value);
  }

  code(token: Exclude<keyof typeof this.codeTheme, 'name' | 'dark'>, value: string) {
    return this.paint(this.codeTheme[token], value);
  }
}

export function createThemeContext(options: ThemeContextOptions = {}): ThemeContext {
  return new ThemeContext(options);
}
