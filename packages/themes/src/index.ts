export type ColorLevel = 0 | 1 | 2 | 3;
export type ColorModifier = 'bold' | 'dim' | 'italic' | 'underline';

export interface ColorToken {
  readonly ansi16: number;
  readonly ansi256: number;
  readonly rgb: readonly [number, number, number];
  readonly modifiers?: readonly ColorModifier[];
}

export interface TuiTheme {
  readonly name: string;
  readonly dark: boolean;
  readonly brand: ColorToken;
  readonly border: ColorToken;
  readonly primary: ColorToken;
  readonly muted: ColorToken;
  readonly user: ColorToken;
  readonly assistant: ColorToken;
  readonly tool: ColorToken;
  readonly status: ColorToken;
  readonly warning: ColorToken;
  readonly error: ColorToken;
  readonly selected: ColorToken;
  readonly inputAccent: ColorToken;
  readonly cursorAccent: ColorToken;
  readonly background?: ColorToken;
}

export interface CodeTheme {
  readonly name: string;
  readonly dark: boolean;
  readonly plain: ColorToken;
  readonly keyword: ColorToken;
  readonly string: ColorToken;
  readonly number: ColorToken;
  readonly booleanNull: ColorToken;
  readonly comment: ColorToken;
  readonly functionType: ColorToken;
  readonly property: ColorToken;
  readonly punctuation: ColorToken;
  readonly diffAdd: ColorToken;
  readonly diffRemove: ColorToken;
  readonly diffContext: ColorToken;
  readonly fenceLabel: ColorToken;
}

const token = (
  ansi16: number,
  ansi256: number,
  rgb: readonly [number, number, number],
  ...modifiers: ColorModifier[]
): ColorToken => Object.freeze({ ansi16, ansi256, rgb: Object.freeze(rgb), modifiers });

const palettes = {
  cyan: token(96, 81, [88, 214, 255]),
  blue: token(94, 75, [97, 175, 239]),
  green: token(92, 84, [80, 250, 123]),
  yellow: token(93, 228, [241, 250, 140]),
  red: token(91, 203, [255, 85, 85]),
  magenta: token(95, 212, [255, 121, 198]),
  accentMagenta: token(95, 177, [199, 125, 255]),
  white: token(97, 255, [248, 248, 242]),
  gray: token(90, 102, [98, 114, 164]),
  black: token(30, 234, [40, 42, 54]),
} as const;

function tui(
  name: string,
  dark: boolean,
  colors: {
    brand: ColorToken;
    border: ColorToken;
    primary: ColorToken;
    muted: ColorToken;
    user: ColorToken;
    assistant: ColorToken;
    tool: ColorToken;
    status: ColorToken;
    warning: ColorToken;
    error: ColorToken;
    selected: ColorToken;
    inputAccent: ColorToken;
    cursorAccent: ColorToken;
    background?: ColorToken;
  },
): TuiTheme {
  return Object.freeze({ name, dark, ...colors });
}

function code(name: string, dark: boolean, colors: Omit<CodeTheme, 'name' | 'dark'>): CodeTheme {
  return Object.freeze({ name, dark, ...colors });
}

const darkBase = {
  border: token(90, 60, [72, 76, 88]),
  primary: token(97, 255, [232, 230, 227]),
  muted: token(90, 102, [138, 142, 152], 'dim'),
  status: token(94, 111, [130, 170, 255]),
  warning: token(93, 221, [232, 196, 104]),
  error: token(91, 203, [255, 107, 122]),
  inputAccent: palettes.accentMagenta,
  cursorAccent: palettes.accentMagenta,
};

const lightBase = {
  border: token(90, 245, [140, 140, 148]),
  primary: token(30, 235, [28, 28, 34]),
  muted: token(90, 242, [96, 100, 112]),
  status: token(35, 98, [124, 58, 237]),
  warning: token(33, 136, [154, 103, 0]),
  error: token(31, 160, [207, 34, 46]),
  inputAccent: token(35, 98, [124, 58, 237]),
  cursorAccent: token(35, 98, [124, 58, 237]),
};

export const TUI_THEME_NAMES = [
  'kyokao-dark',
  'kyokao-light',
  'dracula',
  'nord',
  'solarized-dark',
  'solarized-light',
  'monokai',
  'high-contrast',
] as const;
export type TuiThemeName = (typeof TUI_THEME_NAMES)[number];

export const CODE_THEME_NAMES = [
  'kyokao',
  'dracula',
  'nord',
  'solarized-dark',
  'solarized-light',
  'monokai',
  'github-light',
] as const;
export type CodeThemeName = (typeof CODE_THEME_NAMES)[number];

export const tuiThemes: Readonly<Record<TuiThemeName, TuiTheme>> = Object.freeze({
  'kyokao-dark': tui('kyokao-dark', true, {
    brand: token(95, 141, [187, 154, 247], 'bold'),
    border: token(90, 239, [80, 80, 88]),
    primary: token(97, 254, [225, 225, 225]),
    muted: token(90, 242, [108, 108, 108]),
    user: token(97, 251, [200, 200, 200]),
    assistant: token(97, 254, [225, 225, 225]),
    tool: token(90, 243, [120, 120, 120]),
    status: token(97, 251, [200, 200, 200]),
    warning: token(93, 179, [224, 175, 104]),
    error: token(91, 210, [247, 118, 142]),
    selected: token(95, 141, [187, 154, 247], 'bold'),
    inputAccent: token(97, 251, [200, 200, 200]),
    cursorAccent: token(97, 251, [200, 200, 200]),
    background: token(30, 234, [20, 20, 20]),
  }),
  'kyokao-light': tui('kyokao-light', false, {
    ...lightBase,
    brand: token(35, 98, [124, 58, 237], 'bold'),
    user: token(35, 98, [124, 58, 237]),
    assistant: token(30, 235, [40, 40, 48]),
    tool: token(35, 97, [112, 72, 180]),
    selected: token(35, 98, [124, 58, 237], 'bold'),
    background: token(97, 255, [250, 249, 247]),
  }),
  dracula: tui('dracula', true, {
    ...darkBase,
    brand: token(95, 212, [255, 121, 198], 'bold'),
    border: token(95, 103, [98, 114, 164]),
    user: token(96, 117, [139, 233, 253]),
    assistant: token(92, 84, [80, 250, 123]),
    tool: token(93, 228, [241, 250, 140]),
    selected: token(95, 212, [255, 121, 198], 'bold'),
  }),
  nord: tui('nord', true, {
    ...darkBase,
    brand: token(96, 110, [136, 192, 208], 'bold'),
    border: token(94, 67, [76, 86, 106]),
    primary: token(97, 253, [236, 239, 244]),
    muted: token(90, 145, [129, 161, 193]),
    user: token(96, 109, [143, 188, 187]),
    assistant: token(92, 108, [163, 190, 140]),
    tool: token(93, 222, [235, 203, 139]),
    error: token(91, 174, [191, 97, 106]),
    selected: token(96, 110, [136, 192, 208], 'bold'),
  }),
  'solarized-dark': tui('solarized-dark', true, {
    ...darkBase,
    brand: token(96, 37, [42, 161, 152], 'bold'),
    border: token(90, 240, [88, 110, 117]),
    primary: token(97, 254, [238, 232, 213]),
    muted: token(90, 244, [131, 148, 150]),
    user: token(96, 37, [42, 161, 152]),
    assistant: token(92, 64, [133, 153, 0]),
    tool: token(93, 136, [181, 137, 0]),
    error: token(91, 160, [220, 50, 47]),
    selected: token(96, 37, [42, 161, 152], 'bold'),
  }),
  'solarized-light': tui('solarized-light', false, {
    ...lightBase,
    brand: token(36, 37, [42, 161, 152], 'bold'),
    border: token(90, 244, [101, 123, 131]),
    primary: token(30, 240, [7, 54, 66]),
    muted: token(90, 242, [88, 110, 117]),
    user: token(36, 37, [42, 161, 152]),
    assistant: token(32, 64, [88, 110, 0]),
    tool: token(33, 136, [145, 110, 0]),
    error: token(31, 160, [200, 40, 38]),
    selected: token(36, 37, [42, 161, 152], 'bold'),
  }),
  monokai: tui('monokai', true, {
    ...darkBase,
    brand: token(95, 197, [249, 38, 114], 'bold'),
    user: token(96, 81, [102, 217, 239]),
    assistant: token(92, 148, [166, 226, 46]),
    tool: token(93, 186, [230, 219, 116]),
    selected: token(95, 197, [249, 38, 114], 'bold'),
  }),
  'high-contrast': tui('high-contrast', true, {
    ...darkBase,
    brand: token(97, 15, [255, 255, 255], 'bold'),
    border: token(97, 15, [255, 255, 255]),
    primary: token(97, 15, [255, 255, 255]),
    muted: token(96, 14, [0, 255, 255]),
    user: token(96, 14, [0, 255, 255], 'bold'),
    assistant: token(92, 10, [0, 255, 0]),
    tool: token(93, 11, [255, 255, 0]),
    status: token(96, 14, [0, 255, 255]),
    warning: token(93, 11, [255, 255, 0], 'bold'),
    error: token(91, 9, [255, 0, 0], 'bold'),
    selected: token(97, 15, [255, 255, 255], 'bold', 'underline'),
    inputAccent: token(96, 14, [0, 255, 255]),
    cursorAccent: token(97, 15, [255, 255, 255]),
  }),
});

const kyokaoCode = {
  plain: token(97, 255, [232, 230, 227]),
  keyword: palettes.accentMagenta,
  string: token(92, 114, [156, 220, 180]),
  number: token(93, 221, [232, 196, 104]),
  booleanNull: palettes.accentMagenta,
  comment: token(90, 102, [120, 124, 136], 'italic'),
  functionType: token(94, 111, [130, 170, 255]),
  property: token(96, 117, [148, 196, 220]),
  punctuation: token(97, 250, [200, 198, 194]),
  diffAdd: token(92, 114, [120, 200, 150]),
  diffRemove: token(91, 203, [255, 107, 122]),
  diffContext: token(90, 102, [138, 142, 152]),
  fenceLabel: token(95, 177, [199, 125, 255], 'bold'),
};

export const codeThemes: Readonly<Record<CodeThemeName, CodeTheme>> = Object.freeze({
  kyokao: code('kyokao', true, kyokaoCode),
  dracula: code('dracula', true, {
    ...kyokaoCode,
    keyword: palettes.magenta,
    string: palettes.yellow,
    number: token(95, 141, [189, 147, 249]),
    booleanNull: token(95, 141, [189, 147, 249]),
    comment: token(90, 103, [98, 114, 164], 'italic'),
    functionType: palettes.green,
    property: palettes.cyan,
    fenceLabel: palettes.magenta,
  }),
  nord: code('nord', true, {
    ...kyokaoCode,
    plain: token(97, 253, [216, 222, 233]),
    keyword: token(95, 139, [180, 142, 173]),
    string: token(92, 108, [163, 190, 140]),
    number: token(95, 110, [180, 142, 173]),
    booleanNull: token(95, 139, [180, 142, 173]),
    comment: token(90, 67, [97, 110, 136], 'italic'),
    functionType: token(96, 110, [136, 192, 208]),
    property: token(94, 109, [129, 161, 193]),
    punctuation: token(97, 253, [216, 222, 233]),
    diffAdd: token(92, 108, [163, 190, 140]),
    diffRemove: token(91, 174, [191, 97, 106]),
    fenceLabel: token(96, 110, [136, 192, 208], 'bold'),
  }),
  'solarized-dark': code('solarized-dark', true, {
    ...kyokaoCode,
    plain: token(97, 254, [238, 232, 213]),
    keyword: token(32, 64, [133, 153, 0]),
    string: token(36, 37, [42, 161, 152]),
    number: token(33, 136, [181, 137, 0]),
    booleanNull: token(35, 125, [211, 54, 130]),
    comment: token(90, 244, [131, 148, 150], 'italic'),
    functionType: token(34, 33, [38, 139, 210]),
    property: token(36, 37, [42, 161, 152]),
    punctuation: token(90, 245, [147, 161, 161]),
    fenceLabel: token(36, 37, [42, 161, 152], 'bold'),
  }),
  'solarized-light': code('solarized-light', false, {
    ...kyokaoCode,
    plain: token(30, 240, [7, 54, 66]),
    keyword: token(32, 64, [88, 110, 0]),
    string: token(36, 30, [0, 119, 128]),
    number: token(33, 136, [145, 110, 0]),
    booleanNull: token(35, 125, [180, 38, 110]),
    comment: token(90, 242, [88, 110, 117], 'italic'),
    functionType: token(34, 25, [24, 95, 145]),
    property: token(36, 30, [0, 119, 128]),
    punctuation: token(30, 240, [7, 54, 66]),
    diffAdd: token(32, 64, [88, 110, 0]),
    diffRemove: token(31, 160, [200, 40, 38]),
    diffContext: token(90, 242, [88, 110, 117]),
    fenceLabel: token(36, 30, [0, 119, 128], 'bold'),
  }),
  monokai: code('monokai', true, {
    ...kyokaoCode,
    keyword: token(95, 197, [249, 38, 114]),
    string: token(93, 186, [230, 219, 116]),
    number: token(95, 141, [174, 129, 255]),
    booleanNull: token(95, 141, [174, 129, 255]),
    comment: token(90, 102, [117, 113, 94], 'italic'),
    functionType: token(92, 148, [166, 226, 46]),
    property: token(96, 81, [102, 217, 239]),
    fenceLabel: token(95, 197, [249, 38, 114], 'bold'),
  }),
  'github-light': code('github-light', false, {
    ...kyokaoCode,
    plain: token(30, 235, [31, 35, 40]),
    keyword: token(35, 127, [207, 34, 134]),
    string: token(34, 25, [10, 72, 150]),
    number: token(34, 25, [5, 80, 174]),
    booleanNull: token(34, 25, [5, 80, 174]),
    comment: token(90, 242, [87, 96, 106], 'italic'),
    functionType: token(35, 91, [130, 80, 223]),
    property: token(31, 124, [149, 56, 0]),
    punctuation: token(30, 235, [31, 35, 40]),
    diffAdd: token(32, 28, [17, 99, 41]),
    diffRemove: token(31, 160, [207, 34, 46]),
    diffContext: token(90, 242, [87, 96, 106]),
    fenceLabel: token(34, 25, [9, 105, 218], 'bold'),
  }),
});

export function isTuiThemeName(value: string): value is TuiThemeName {
  return Object.hasOwn(tuiThemes, value);
}

export function isCodeThemeName(value: string): value is CodeThemeName {
  return Object.hasOwn(codeThemes, value);
}

export function detectColorLevel(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly isTTY?: boolean;
    readonly forceColor?: boolean | ColorLevel;
  } = {},
): ColorLevel {
  const env = options.env ?? process.env;
  if (Object.hasOwn(env, 'NO_COLOR')) return 0;
  const forced = options.forceColor ?? env.FORCE_COLOR ?? env.CLICOLOR_FORCE;
  if (forced !== undefined && forced !== false && forced !== '0') {
    if (typeof forced === 'number') return forced;
    const level = Number(forced);
    return level === 1 || level === 2 || level === 3 ? level : 1;
  }
  if (options.isTTY === false || env.TERM === 'dumb') return 0;
  if (!options.isTTY) return 0;
  if (/truecolor|24bit/i.test(env.COLORTERM ?? '')) return 3;
  if (env.WT_SESSION) return 3;
  if (/256color/i.test(env.TERM ?? '')) return 2;
  return 1;
}

const modifierCodes: Record<ColorModifier, number> = {
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
};

export function paintToken(
  value: string,
  token: ColorToken,
  level: ColorLevel,
  background = false,
): string {
  if (!value || level === 0) return value;
  const prefix = (token.modifiers ?? []).map((item) => `\x1b[${modifierCodes[item]}m`).join('');
  const color = tokenColor(token, level, background);
  return `${prefix}${color}${value}\x1b[0m`;
}

function tokenColor(token: ColorToken, level: ColorLevel, background: boolean): string {
  return level === 3
    ? `\x1b[${background ? 48 : 38};2;${token.rgb.join(';')}m`
    : level === 2
      ? `\x1b[${background ? 48 : 38};5;${token.ansi256}m`
      : `\x1b[${background ? token.ansi16 + 10 : token.ansi16}m`;
}

export function paintBackground(value: string, token: ColorToken, level: ColorLevel): string {
  if (!value || level === 0) return value;
  const color = backgroundEscape(token, level);
  return `${color}${value.replaceAll('\x1b[0m', `\x1b[0m${color}`)}\x1b[0m`;
}

export function backgroundEscape(token: ColorToken, level: ColorLevel): string {
  return level === 0 ? '' : tokenColor(token, level, true);
}

export function suggestName(value: string, names: readonly string[]): string[] {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const old = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = old;
      }
    }
    return row[b.length]!;
  };
  return [...names]
    .map((name) => ({ name, score: distance(value.toLowerCase(), name.toLowerCase()) }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(({ name }) => name);
}
