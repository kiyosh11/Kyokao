// @ts-nocheck
import { createInterface } from 'node:readline/promises';
import { createThemeContext } from './theme.js';
import { CodeRenderer, MarkdownRenderer } from './markdown.js';
export function createUi(context = createThemeContext({ isTTY: process.stdout.isTTY, env: process.env }), streams = {}) {
    const stdout = streams.stdout ?? process.stdout;
    const stderr = streams.stderr ?? process.stderr;
    const markdown = new MarkdownRenderer(context);
    const code = new CodeRenderer(context);
    return {
        info: (value) => stdout.write(`${context.tui('status', value)}\n`),
        error: (value) => stderr.write(`${context.tui('error', value)}\n`),
        assistant: (value) => stdout.write(`${context.tui('assistant', markdown.render(value))}\n`),
        tool: (value) => stderr.write(`${context.tui('tool', `• ${value}`)}\n`),
        diff: (value) => stdout.write(`${code.render(value, 'diff')}\n`),
        async approve(action, detail) {
            if (!process.stdin.isTTY)
                return false;
            const r = createInterface({ input: process.stdin, output: stdout });
            const a = await r.question(`${context.tui('warning', `Allow ${action}`)} ${detail}? [y/N] `);
            r.close();
            return /^y(es)?$/i.test(a);
        },
    };
}
export const ui = createUi();
