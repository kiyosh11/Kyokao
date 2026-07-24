// @ts-nocheck

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PromptBackend } from '@kyokao/agent';
import type { KyokaoConfig } from '@kyokao/config';
import type { Session } from '@kyokao/memory';
import type { CapyThreadListItem } from '@kyokao/providers';
import type { CommandDefinition, ThemeContext } from '@kyokao/ui';
import { workspaceCommands } from '@kyokao/ui';
import type { Runtime } from './runtime.js';

export interface ReplaceRuntimeOptions {
  preserveCompatibleSession?: boolean;
  beforeSwap?: () => Promise<void>;
}

export interface TuiContext {
  r: Runtime;

  backend: PromptBackend;
  themeContext: ThemeContext;
  sessionChoices: Session[];
  memoryChoices: Record<string, string>;
  providerModels: string[];
  modelContextWindow?: number;

  projectChoices: Array<{ id: string; name: string; description?: string }>;
  capyModelChoices: Array<{ id: string; name: string; description?: string }>;
  capyAvailableModels: Array<{
    id: string;
    name: string;
    provider: string;
    captainEligible: boolean;
  }>;
  capyModelRole?: 'captain' | 'build';
  capyThreadChoices: CapyThreadListItem[];
  capySpending?: {
    totalDollars: number;
    llmDollars: number;
    vmDollars: number;
    from: string;
    to: string;
  };
  capySpendingError?: string;

  replaceRuntime: (
    overrides: Partial<KyokaoConfig>,
    options?: ReplaceRuntimeOptions,
  ) => Promise<void>;

  refreshProviderModels: () => Promise<void>;
  refreshCapyThreads: () => Promise<void>;
  refreshCapySpending: (force?: boolean) => Promise<void>;

  skipModelCheck: boolean;
}

export function choicePalette(
  value: string,
  command: CommandDefinition['name'],
  choices: Array<{
    value: string;
    label?: string;
    description: string;
    completion?: string;
    submit?: boolean;
  }>,
): CommandDefinition[] | undefined {
  const group = workspaceCommands.find((entry) => entry.name === command)?.group ?? 'setup';
  const match = value.match(new RegExp(`^/${command}(?:\\s+(.*))?$`, 'i'));
  if (!match) return undefined;
  const query = (match[1] ?? '').trimStart().toLowerCase();
  return choices
    .filter((choice) => choice.value.toLowerCase().startsWith(query))
    .map((choice) => ({
      name: command,
      group,
      syntax: `/${command} ${choice.value}`,
      label: choice.label ?? choice.value,
      description: choice.description,
      completion: choice.completion ?? `/${command} ${choice.value}`,
      submit: choice.submit ?? true,
    }));
}

export function copyToClipboard(text: string): boolean {
  const command =
    process.platform === 'win32'
      ? { cmd: 'clip', args: [] }
      : process.platform === 'darwin'
        ? { cmd: 'pbcopy', args: [] }
        : { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  try {
    const result = spawnSync(command.cmd, command.args, { input: text });
    return result.status === 0;
  } catch {
    return false;
  }
}

export async function editDraftInExternalEditor(
  config: Pick<KyokaoConfig, 'editor' | 'editorArgs'>,
  draft: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kyokao-draft-'));
  const file = join(directory, 'prompt.md');
  try {
    await writeFile(file, draft, 'utf8');
    const configured = config.editor || process.env.VISUAL || process.env.EDITOR;
    const command = configured || (process.platform === 'win32' ? 'notepad' : 'vi');
    const parts =
      command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^(['"])|(['"])$/g, '')) ??
      [];
    const executable = parts.shift();
    if (!executable) throw new Error('Editor command is empty');
    const args = [...parts, ...config.editorArgs];
    if (args.includes('{file}')) {
      for (let index = 0; index < args.length; index++)
        if (args[index] === '{file}') args[index] = file;
    } else args.push(file);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: 'inherit', cwd: process.cwd() });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code ?? 'unknown'}`)),
      );
    });
    return (await readFile(file, 'utf8')).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
