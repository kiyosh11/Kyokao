import { type CodeTheme } from '@kyokao/themes';
import type { ThemeContext } from './theme.js';
type CodeToken = Exclude<keyof CodeTheme, 'name' | 'dark'>;
interface LanguageDefinition {
    keywords: ReadonlySet<string>;
    lineComments: readonly string[];
    blockComments: readonly [
        string,
        string
    ][];
    quotes: readonly string[];
}
const words = (value: string) => new Set(value.split(/\s+/).filter(Boolean));
const common = words('break case catch class const continue default delete do else export extends finally for function if import in instanceof let new return static super switch this throw try typeof var while with yield async await interface type enum implements private protected public readonly abstract namespace declare module from as of');
const definitions: Record<string, LanguageDefinition> = {
    javascript: {
        keywords: common,
        lineComments: ['//'],
        blockComments: [['/*', '*/']],
        quotes: ["'", '"', '`'],
    },
    typescript: {
        keywords: common,
        lineComments: ['//'],
        blockComments: [['/*', '*/']],
        quotes: ["'", '"', '`'],
    },
    python: {
        keywords: words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case'),
        lineComments: ['#'],
        blockComments: [],
        quotes: ['"""', "'''", "'", '"'],
    },
    json: {
        keywords: words('true false null'),
        lineComments: [],
        blockComments: [],
        quotes: ['"'],
    },
    bash: {
        keywords: words('if then else elif fi for while until do done case esac function in select time coproc local readonly declare export source'),
        lineComments: ['#'],
        blockComments: [],
        quotes: ["'", '"', '`'],
    },
    go: {
        keywords: words('break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var'),
        lineComments: ['//'],
        blockComments: [['/*', '*/']],
        quotes: ["'", '"', '`'],
    },
    rust: {
        keywords: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
        lineComments: ['//'],
        blockComments: [['/*', '*/']],
        quotes: ["'", '"'],
    },
    java: {
        keywords: words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null'),
        lineComments: ['//'],
        blockComments: [['/*', '*/']],
        quotes: ["'", '"'],
    },
    c: {
        keywords: words('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace public private protected template true false null nullptr'),
        lineComments: ['//'],
        blockComments: [['/*', '*/']],
        quotes: ["'", '"'],
    },
    html: {
        keywords: words('html head body script style div span main section article nav a p h1 h2 h3 ul ol li'),
        lineComments: [],
        blockComments: [['<!--', '-->']],
        quotes: ["'", '"'],
    },
    css: {
        keywords: words('important inherit initial unset revert none block inline flex grid relative absolute fixed sticky auto solid transparent'),
        lineComments: ['//'],
        blockComments: [['/*', '*/']],
        quotes: ["'", '"'],
    },
    yaml: {
        keywords: words('true false null yes no on off'),
        lineComments: ['#'],
        blockComments: [],
        quotes: ["'", '"'],
    },
    sql: {
        keywords: words('select from where join inner left right full on group by order having limit offset insert into values update set delete create alter drop table index view distinct union all as and or not null is in exists between like case when then else end primary key foreign references'),
        lineComments: ['--'],
        blockComments: [['/*', '*/']],
        quotes: ["'", '"', '`'],
    },
    markdown: {
        keywords: new Set(),
        lineComments: [],
        blockComments: [['<!--', '-->']],
        quotes: ['`'],
    },
};
const aliases: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    md: 'markdown',
    xml: 'html',
    'c++': 'c',
    cpp: 'c',
    h: 'c',
    hpp: 'c',
};
const generic: LanguageDefinition = {
    keywords: common,
    lineComments: ['//', '#'],
    blockComments: [
        ['/*', '*/'],
        ['<!--', '-->'],
    ],
    quotes: ['"""', "'''", "'", '"', '`'],
};
function languageName(language: string): string {
    const normalized = language
        .trim()
        .toLowerCase()
        .replace(/^language-/, '');
    return aliases[normalized] ?? normalized;
}
function isIdentifierStart(value: string): boolean {
    return /[A-Za-z_$@]/.test(value);
}
function isIdentifierPart(value: string): boolean {
    return /[\w$@-]/.test(value);
}
function isCommentStart(source: string, index: number, marker: string): boolean {
    if (!source.startsWith(marker, index))
        return false;
    if (marker !== '#')
        return true;
    return index === 0 || source[index - 1] === '\n' || /\s/.test(source[index - 1]!);
}
export class CodeRenderer {
    constructor(private readonly context: ThemeContext) { }
    render(source: string, language = ''): string {
        const name = languageName(language);
        if (name === 'diff' || name === 'patch')
            return this.diff(source);
        const definition = definitions[name] ?? generic;
        let result = '';
        let index = 0;
        const add = (token: CodeToken, value: string) => {
            result += this.context.code(token, value);
        };
        while (index < source.length) {
            const block = definition.blockComments.find(([start]) => source.startsWith(start, index));
            if (block) {
                const end = source.indexOf(block[1], index + block[0].length);
                const next = end < 0 ? source.length : end + block[1].length;
                add('comment', source.slice(index, next));
                index = next;
                continue;
            }
            const line = definition.lineComments.find((marker) => isCommentStart(source, index, marker));
            if (line) {
                const end = source.indexOf('\n', index);
                const next = end < 0 ? source.length : end;
                add('comment', source.slice(index, next));
                index = next;
                continue;
            }
            const quote = definition.quotes.find((candidate) => source.startsWith(candidate, index));
            if (quote) {
                let next = index + quote.length;
                while (next < source.length) {
                    if (source[next] === '\\') {
                        next += 2;
                        continue;
                    }
                    if (source.startsWith(quote, next)) {
                        next += quote.length;
                        break;
                    }
                    next++;
                }
                const value = source.slice(index, Math.min(next, source.length));
                const after = source.slice(Math.min(next, source.length)).match(/^\s*(.)/)?.[1];
                add(name === 'json' && after === ':' ? 'property' : 'string', value);
                index = Math.min(next, source.length);
                continue;
            }
            if (/\d/.test(source[index]!) && (index === 0 || !isIdentifierPart(source[index - 1]!))) {
                const match = source
                    .slice(index)
                    .match(/^(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)?.[0];
                if (match) {
                    add('number', match);
                    index += match.length;
                    continue;
                }
            }
            if (isIdentifierStart(source[index]!)) {
                let next = index + 1;
                while (next < source.length && isIdentifierPart(source[next]!))
                    next++;
                const value = source.slice(index, next);
                const lower = value.toLowerCase();
                const after = source.slice(next).match(/^\s*(.)/)?.[1];
                const token: CodeToken = ['true', 'false', 'null', 'none', 'nil', 'undefined'].includes(lower)
                    ? 'booleanNull'
                    : definition.keywords.has(value) || definition.keywords.has(lower)
                        ? 'keyword'
                        : after === '(' ||
                            /^(?:class|interface|type|struct|enum)$/.test(source.slice(0, index).trim().split(/\s+/).at(-1) ?? '')
                            ? 'functionType'
                            : after === ':' || (name === 'html' && source[index - 1] === '<')
                                ? 'property'
                                : 'plain';
                add(token, value);
                index = next;
                continue;
            }
            if (/[[\]{}()<>=:;,.+\-*/%!&|^~?]/.test(source[index]!)) {
                add('punctuation', source[index]!);
                index++;
                continue;
            }
            let next = index + 1;
            while (next < source.length &&
                !isIdentifierStart(source[next]!) &&
                !/\d/.test(source[next]!) &&
                !/[[\]{}()<>=:;,.+\-*/%!&|^~?'"`#]/.test(source[next]!))
                next++;
            add('plain', source.slice(index, next));
            index = next;
        }
        return result;
    }
    private diff(source: string): string {
        return source
            .split(/(?<=\n)/)
            .map((line) => {
            const token: CodeToken = line.startsWith('+') && !line.startsWith('+++')
                ? 'diffAdd'
                : line.startsWith('-') && !line.startsWith('---')
                    ? 'diffRemove'
                    : 'diffContext';
            return this.context.code(token, line);
        })
            .join('');
    }
}
export class MarkdownRenderer {
    readonly code: CodeRenderer;
    constructor(private readonly context: ThemeContext) {
        this.code = new CodeRenderer(context);
    }
    render(source: string): string {
        let result = '';
        const lines = source.split(/(?<=\n)/);
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index]!;
            const open = line.match(/^(\s*)(`{3,}|~{3,})([^`\n~]*)/);
            if (open) {
                result += this.context.code('fenceLabel', line);
                const marker = open[2]![0]!;
                const size = open[2]!.length;
                const language = open[3]!.trim().split(/\s+/, 1)[0] ?? '';
                let content = '';
                let closed: string | undefined;
                while (++index < lines.length) {
                    const candidate = lines[index]!;
                    if (new RegExp(`^\\s*${marker}{${size},}\\s*(?:\\n)?$`).test(candidate)) {
                        closed = candidate;
                        break;
                    }
                    content += candidate;
                }
                result += this.code.render(content, language);
                if (closed !== undefined)
                    result += this.context.code('fenceLabel', closed);
                continue;
            }
            result += this.markdownLine(line);
        }
        return result;
    }
    private markdownLine(line: string): string {
        if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*(?:\n)?$/.test(line))
            return this.context.tui('border', line);
        const heading = line.match(/^(\s{0,3}#{1,6}\s+)(.*)$/s);
        if (heading) {
            const level = (heading[1]!.match(/#/g) ?? []).length;
            const token = level <= 1 ? 'status' : level === 2 ? 'brand' : 'user';
            return (
              this.context.tui(token, heading[1]!) + this.context.tui(token, this.inline(heading[2]!))
            );
          }
        const quote = line.match(/^(\s*>+\s?)(.*)$/s);
        if (quote)
            return (this.context.tui('border', quote[1]!) + this.context.tui('muted', this.inline(quote[2]!)));
        const list = line.match(/^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/s);
        if (list)
            return (list[1]! + this.context.tui('inputAccent', list[2]!) + list[3]! + this.inline(list[4]!));
        return this.inline(line);
    }
    private inline(source: string): string {
        let result = '';
        let index = 0;
        while (index < source.length) {
            const marker = source.startsWith('**', index) || source.startsWith('__', index)
                ? source.slice(index, index + 2)
                : source[index] === '*' || source[index] === '_'
                    ? source[index]!
                    : undefined;
            if (marker) {
                const end = source.indexOf(marker, index + marker.length);
                if (end >= 0) {
                    const value = source.slice(index, end + marker.length);
                    const prefix = marker.length === 2 ? '\x1b[1m' : '\x1b[3m';
                    result +=
                        this.context.colorLevel === 0
                            ? value
                            : `${prefix}${this.context.tui('primary', value)}\x1b[0m`;
                    index = end + marker.length;
                    continue;
                }
            }
            if (source[index] === '`') {
                const end = source.indexOf('`', index + 1);
                if (end >= 0) {
                    result += this.context.code('string', source.slice(index, end + 1));
                    index = end + 1;
                    continue;
                }
            }
            if (source[index] === '[') {
                const labelEnd = source.indexOf('](', index + 1);
                const end = labelEnd >= 0 ? source.indexOf(')', labelEnd + 2) : -1;
                if (end >= 0) {
                    result += this.context.tui('inputAccent', source.slice(index, end + 1));
                    index = end + 1;
                    continue;
                }
            }
            let next = index + 1;
            while (next < source.length && !'`[*_'.includes(source[next]!))
                next++;
            result += source.slice(index, next);
            index = next;
        }
        return result;
    }
}
export class MarkdownStreamRenderer {
    private pending = '';
    private fence?: {
        marker: string;
        size: number;
        language: string;
    };
    private readonly markdown: MarkdownRenderer;
    private readonly code: CodeRenderer;
    constructor(private readonly context: ThemeContext) {
        this.markdown = new MarkdownRenderer(context);
        this.code = this.markdown.code;
    }
    write(chunk: string): string {
        this.pending += chunk;
        let rendered = '';
        for (;;) {
            const newline = this.pending.indexOf('\n');
            if (newline < 0)
                break;
            const line = this.pending.slice(0, newline + 1);
            this.pending = this.pending.slice(newline + 1);
            rendered += this.line(line);
        }
        return rendered;
    }
    end(): string {
        const rendered = this.pending ? this.line(this.pending) : '';
        this.pending = '';
        return rendered;
    }
    private line(line: string): string {
        if (this.fence) {
            const close = new RegExp(`^\\s*${this.fence.marker}{${this.fence.size},}\\s*(?:\\n)?$`);
            if (close.test(line)) {
                this.fence = undefined;
                return this.context.code('fenceLabel', line);
            }
            return this.code.render(line, this.fence.language);
        }
        const open = line.match(/^(\s*)(`{3,}|~{3,})([^`\n~]*)/);
        if (!open)
            return this.markdown.render(line);
        this.fence = {
            marker: open[2]![0]!,
            size: open[2]!.length,
            language: open[3]!.trim().split(/\s+/, 1)[0] ?? '',
        };
        return this.context.code('fenceLabel', line);
    }
}
export function highlightCode(source: string, language = '', context: ThemeContext): string {
    return new CodeRenderer(context).render(source, language);
}
export function renderMarkdown(source: string, context: ThemeContext): string {
    return new MarkdownRenderer(context).render(source);
}
