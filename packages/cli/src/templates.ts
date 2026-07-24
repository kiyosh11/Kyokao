// @ts-nocheck
import type { Command } from 'commander';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { kyokaoHome } from '@kyokao/config';
import { withGroup, type HelpGroup } from './help.js';
export interface AgentTemplate {
    name: string;
    description: string;
    body: string;
    flags?: string[];
    passthrough?: boolean;
}
export interface TemplateDeps {
    ask: (prompt: string) => Promise<unknown>;
    helpGroup: HelpGroup;
    commandsDir?: string;
}
const BUILTIN_TEMPLATES: AgentTemplate[] = [
    {
        name: 'commit',
        description: 'Review changes, run checks, then create a git commit if ready',
        flags: ['-m, --message <m>', '--no-verify'],
        body: `Review the working tree, run appropriate checks, then create a clear git commit if changes are ready.
{{#flags.message}}Use this commit message (still review it for accuracy): {{flags.message}}{{/flags.message}}
{{#flags.noVerify}}Skip pre-commit verification when committing.{{/flags.noVerify}}
{{args}}`,
    },
    {
        name: 'review',
        description: 'Review current changes for bugs, security risks, and missing tests',
        flags: ['-b, --base <ref>'],
        body: `Review the current changes for bugs, security risks, and missing tests.
{{#flags.base}}Diff against this base ref: {{flags.base}}{{/flags.base}}
{{args}}`,
    },
    {
        name: 'test',
        description: 'Run the most relevant tests and safely diagnose/fix failures',
        passthrough: true,
        body: `Run the most relevant tests, diagnose and fix failures if safe.
{{#passthrough}}Pass these test selector args to the test runner: {{passthrough}}{{/passthrough}}
{{args}}`,
    },
    {
        name: 'explain',
        description: 'Explain the repository structure and relevant implementation',
        body: `Explain the repository structure and the relevant implementation details.
{{args}}`,
    },
];
export const BUILTINS = BUILTIN_TEMPLATES;
export async function loadTemplates(dir?: string, builtins: AgentTemplate[] = BUILTIN_TEMPLATES): Promise<AgentTemplate[]> {
    const commandsDir = dir ?? join(kyokaoHome(), 'commands');
    const byName = new Map<string, AgentTemplate>(builtins.map((t) => [t.name, t]));
    try {
        const entries = await readdir(commandsDir);
        for (const entry of entries) {
            if (!entry.endsWith('.md'))
                continue;
            const name = entry.slice(0, -3);
            if (!/^[a-z][a-z0-9-]*$/.test(name))
                continue;
            const raw = await readFile(join(commandsDir, entry), 'utf8');
            const lines = raw.split('\n');
            const description = lines[0]?.trim() || `Agent-assisted ${name}`;
            const body = lines.slice(1).join('\n').trim();
            byName.set(name, { name, description, body });
        }
    }
    catch {
    }
    return [...byName.values()];
}
export function renderTemplate(template: AgentTemplate, args: string[], flags: Record<string, unknown>, passthrough?: string[]): string {
    let body = template.body;
    const argString = args.join(' ').trim();
    const passthroughString = (passthrough ?? []).join(' ').trim();
    body = renderConditionals(body, 'flags', flags);
    body = renderBareConditional(body, 'passthrough', Boolean(passthroughString));
    body = body.replace(/\{\{args\}\}/g, argString);
    body = body.replace(/\{\{passthrough\}\}/g, passthroughString);
    for (const [key, value] of Object.entries(flags))
        body = body.replace(new RegExp(`\\{\\{flags\\.${escapeRegex(key)}\\}\\}`, 'g'), String(value));
    return body.trim();
}
function renderBareConditional(body: string, name: string, present: boolean): string {
    return body.replace(new RegExp(`\\{\\{#${escapeRegex(name)}\\}\\}([\\s\\S]*?)\\{\\{/${escapeRegex(name)}\\}\\}`, 'g'), (_, inner: string) => (present ? inner : ''));
}
function renderConditionals(body: string, prefix: string, values: Record<string, unknown>): string {
    return body.replace(new RegExp(`\\{\\{#${prefix}\\.(\\w+)\\}\\}([\\s\\S]*?)\\{\\{/${prefix}\\.\\1\\}\\}`, 'g'), (_, key: string, inner: string) => values[key] !== undefined && values[key] !== false && values[key] !== null ? inner : '');
}
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function registerTemplates(program: Command, deps: TemplateDeps): void {
    for (const template of BUILTIN_TEMPLATES) {
        const cmd = program.command(`${template.name} [prompt...]`).description(template.description);
        for (const flag of template.flags ?? [])
            cmd.option(flag);
        if (template.passthrough)
            cmd.allowUnknownOption(true);
        cmd.action(async (args: string[], context: {
            opts?: () => Record<string, unknown>;
        }) => {
            const flagsData = context?.opts?.() ?? {};
            const effective = await resolveEffective(template, deps.commandsDir);
            const prompt = renderTemplate(effective, args ?? [], flagsData);
            await deps.ask(prompt);
        });
        withGroup(cmd, deps.helpGroup);
    }
}
async function resolveEffective(builtin: AgentTemplate, commandsDir?: string): Promise<AgentTemplate> {
    const loaded = await loadTemplates(commandsDir, [builtin]);
    return loaded.find((t) => t.name === builtin.name) ?? builtin;
}
