import type { ReadStream, WriteStream } from 'node:tty';
import {
  displayWidth,
  graphemes,
  graphemeWidth,
  padDisplay,
  TerminalInputParser,
  truncateDisplay,
  type InputEvent,
} from './editor.js';
import { InteractiveScreen, withInteractiveScreen, type ScreenFrame } from './terminal.js';
import { createThemeContext, type ThemeContext } from './theme.js';

export type SetupStep =
  'confirm' | 'provider' | 'name' | 'url' | 'key' | 'model' | 'project' | 'approval' | 'review';
export type KeySource = 'environment' | 'saved' | 'not configured' | 'local';
export interface SetupProvider {
  name: string;
  description: string;
  baseURL?: string;
  local?: boolean;
  env?: string;
  remote?: boolean;
}
export interface SetupResult {
  provider: string;
  baseURL?: string;
  model: string;
  approval: 'suggest' | 'auto-edit' | 'full-auto';
  apiKey?: string;
  keySource: KeySource;
  projectId?: string;
}
export interface SetupWizardOptions {
  input?: ReadStream;
  output?: WriteStream;
  providers: SetupProvider[];
  configPath: string;
  keySource?: (provider: SetupProvider) => KeySource;
  fetchModels?: (choice: {
    provider: string;
    baseURL?: string;
    apiKey?: string;
    local?: boolean;
    signal: AbortSignal;
  }) => Promise<string[]>;
  fetchProjects?: (choice: {
    provider: string;
    baseURL?: string;
    apiKey?: string;
    signal: AbortSignal;
  }) => Promise<Array<{ id: string; name: string; description?: string }>>;
  confirmReplace?: boolean;
  screen?: InteractiveScreen;
  themeContext?: ThemeContext;
}
export const approvalChoices = [
  { value: 'suggest', description: 'Propose changes; ask before every edit or command.' },
  { value: 'auto-edit', description: 'Apply file edits automatically; ask before commands.' },
  {
    value: 'full-auto',
    description: 'Run edits and commands without approval. Use only in a trusted workspace.',
  },
] as const;
export function validateProviderName(value: string): string | undefined {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) ? undefined : 'Use letters, numbers, _ or -.';
}
export function validateBaseURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? undefined : 'Use an http(s) URL.';
  } catch {
    return 'Enter a valid http(s) URL.';
  }
}
export function setupSelect(index: number, delta: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index + delta));
}
export function maskSecret(value: string): string {
  return value ? '•'.repeat(Math.min(value.length, 24)) : '';
}
export function setupWordmark(width: number): string[] {
  return width < 36
    ? ['KYOKAO', 'Local-first coding agent']
    : [
        ' _  ___   _____  _  __   _    ___ ',
        '| |/ / | |/ _ \\| |/ /  /_\\  / _ \\',
        "| ' <| |_| | (_) | ' <  / _ \\| (_) |",
        '|_|\\_\\___/ \\___/|_|\\_\\/_/ \\_\\___/ ',
        'Local-first coding agent',
      ];
}
function fit(value: string, width: number) {
  return truncateDisplay(value, width);
}
export function visibleSetupItems<T>(
  items: readonly T[],
  selected: number,
  height: number,
  chromeRows = 10,
) {
  const size = Math.max(1, Math.min(items.length, Math.max(1, height - chromeRows)));
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
  return {
    items: items.slice(start, start + size),
    start,
    before: start > 0,
    after: start + size < items.length,
  };
}
export function renderSetupFrame(input: {
  width: number;
  height?: number;
  step: SetupStep;
  title: string;
  items?: Array<{ name: string; description: string; danger?: boolean }>;
  selected?: number;
  value?: string;
  secret?: boolean;
  message?: string;
  review?: string[];
  busy?: boolean;
  themeContext?: ThemeContext;
}): ScreenFrame {
  const context = input.themeContext ?? createThemeContext({ colorLevel: 0 });
  const width = Math.max(12, input.width);
  const inner = width - 4;
  const height = Math.max(8, input.height ?? 28);
  const line = '─'.repeat(width - 2);
  const rows = [...setupWordmark(width - 4), '', input.title];
  if (input.items) {
    const window = visibleSetupItems(input.items, input.selected ?? 0, height, rows.length + 6);
    if (window.before) rows.push(context.tui('muted', '  ↑ more'));
    window.items.forEach((item, offset) => {
      const index = window.start + offset;
      const nameWidth = Math.max(4, Math.min(inner - 2, Math.floor(inner * 0.42)));
      const text = `${index === input.selected ? '›' : ' '} ${padDisplay(item.name, nameWidth)}${item.description ? ` — ${fit(item.description, Math.max(1, inner - nameWidth - 5))}` : ''}`;
      rows.push(
        item.danger
          ? context.tui('error', text)
          : index === input.selected
            ? context.tui('selected', text)
            : text,
      );
    });
    if (window.after) rows.push(context.tui('muted', '  ↓ more'));
  }
  let inputRow: number | undefined;
  if (input.value !== undefined) {
    rows.push('');
    inputRow = rows.length;
    rows.push(`› ${input.secret ? maskSecret(input.value) : fit(input.value, inner - 2)}`);
  }
  if (input.review) rows.push('', ...input.review.map((row) => fit(row, inner)));
  if (input.message) rows.push('', input.message);
  const controls = input.busy
    ? 'Checking models… Ctrl-C cancels'
    : input.step === 'review'
      ? 'Enter save · Esc back · Ctrl-C cancel'
      : input.items
        ? '↑/↓ or j/k move · Enter choose · Esc back · Ctrl-C cancel'
        : 'Enter continue · Esc back · Ctrl-C cancel';
  const contentRows = Math.max(1, height - 4);
  const visibleRows = rows.slice(0, contentRows);
  while (visibleRows.length < contentRows) visibleRows.push('');
  const lines = [
    context.tui('border', `╭${line}╮`),
    ...visibleRows.map((row) => `│ ${padDisplay(row, inner)} │`),
    context.tui('border', `├${line}┤`),
    `│ ${context.tui('muted', padDisplay(controls, inner))} │`,
    context.tui('border', `╰${line}╯`),
  ];
  if (lines.length > height) lines.splice(1 + contentRows, lines.length - height);
  const cursor =
    inputRow === undefined || input.busy
      ? undefined
      : {
          row: Math.min(height - 3, 1 + inputRow),
          column: Math.min(
            width - 3,
            2 +
              displayWidth('› ') +
              (input.secret
                ? displayWidth(maskSecret(input.value ?? ''))
                : graphemes(input.value ?? '').reduce(
                    (sum, value) => sum + graphemeWidth(value),
                    0,
                  )),
          ),
        };
  return { lines, cursor };
}

export function renderSetupScreen(input: Parameters<typeof renderSetupFrame>[0]): string {
  return renderSetupFrame(input).lines.join('\n');
}

async function runSetupWizard(
  options: SetupWizardOptions,
  screen: InteractiveScreen,
): Promise<SetupResult | undefined> {
  const input = screen.input;
  const output = screen.output;
  const context =
    options.themeContext ?? createThemeContext({ isTTY: output.isTTY, env: process.env });
  let step: SetupStep = options.confirmReplace ? 'confirm' : 'provider';
  let selected = options.confirmReplace ? 1 : 0;
  let value = '';
  let message = '';
  let busy = false;
  let closed = false;
  let fetchController: AbortController | undefined;
  let provider = options.providers[0]!;
  let providerName = provider.name;
  let baseURL = provider.baseURL;
  let apiKey: string | undefined;
  let keySource: KeySource = provider.local ? 'local' : 'not configured';
  let model = '';
  let approval: SetupResult['approval'] = 'suggest';
  let models: string[] = [];
  let projects: Array<{ id: string; name: string; description?: string }> = [];
  let projectId = '';
  const draw = () => {
    const width = output.columns ?? 80;
    const height = output.rows ?? 28;
    const screen = (title: string, extra: Partial<Parameters<typeof renderSetupScreen>[0]>) =>
      screenOutput.draw(
        renderSetupFrame({
          width,
          height,
          step,
          title,
          message,
          busy,
          themeContext: context,
          ...extra,
        }),
      );
    if (step === 'confirm')
      return screen('Replace active provider settings?', {
        items: [
          { name: 'Continue', description: 'Review and replace active provider settings' },
          { name: 'Cancel', description: 'Leave current settings unchanged' },
        ],
        selected,
      });
    if (step === 'provider')
      return screen('Choose a provider', {
        items: options.providers.map((p) => ({
          name: p.name === '__custom__' ? 'Custom OpenAI-compatible' : p.name,
          description: p.description,
        })),
        selected,
      });
    if (step === 'approval')
      return screen('Choose approval mode', {
        items: approvalChoices.map((p) => ({
          name: p.value,
          description: p.description,
          danger: p.value === 'full-auto',
        })),
        selected,
      });
    if (step === 'model' && models.length)
      return screen('Choose a model (or select Manual entry)', {
        items: [
          ...models.map((name) => ({ name, description: '' })),
          { name: 'Manual entry', description: 'Enter any model ID' },
        ],
        selected,
      });
    if (step === 'project' && projects.length)
      return screen('Choose a Capy project (remote repositories/VMs)', {
        items: [
          ...projects.map((project) => ({
            name: project.name,
            description: `${project.id}${project.description ? ` · ${project.description}` : ''}`,
          })),
          {
            name: 'Manual project ID',
            description: 'Explicit fallback when discovery is unavailable',
          },
        ],
        selected,
      });
    if (step === 'review')
      return screen('Review setup', {
        review: [
          `Provider: ${providerName}`,
          `Model: ${model}`,
          ...(projectId ? [`Capy project: ${projectId} (remote connected repositories)`] : []),
          `Base URL: ${baseURL ?? 'preset'}`,
          `Key: ${keySource === 'local' ? 'not configured' : keySource}`,
          `Approval: ${approval}`,
          `Config: ${options.configPath}`,
          ...(apiKey ? ['A key will be stored locally (0600).'] : []),
        ],
      });
    const labels: Record<string, string> = {
      name: 'Name your OpenAI-compatible provider',
      url: 'Enter its base URL (usually ending in /v1)',
      key: provider.env
        ? `${provider.env} API key (optional; input is hidden)`
        : 'API key (optional; input is hidden)',
      model: 'Enter a model ID',
      project: 'Enter a Capy project ID',
    };
    return screen(labels[step], { value, secret: step === 'key' });
  };
  const fetchWithTimeout = async <T>(request: (() => Promise<T>) | undefined, fallback: T) => {
    if (!request) return fallback;
    fetchController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = request();
      const timedOut = new Promise<T>((resolve) => {
        timeout = setTimeout(() => {
          fetchController?.abort();
          resolve(fallback);
        }, 4000);
      });
      return await Promise.race([pending, timedOut]);
    } catch {
      return fallback;
    } finally {
      if (timeout) clearTimeout(timeout);
      fetchController = undefined;
    }
  };
  const advance = async () => {
    message = '';
    if (step === 'confirm') {
      if (selected !== 0) return false;
      step = 'provider';
      selected = 0;
      return true;
    }
    if (step === 'provider') {
      provider = options.providers[selected]!;
      providerName = provider.name;
      baseURL = provider.baseURL;
      keySource = provider.local ? 'local' : (options.keySource?.(provider) ?? 'not configured');
      step = provider.name === '__custom__' ? 'name' : provider.local ? 'model' : 'key';
      value = '';
      return true;
    }
    if (step === 'name') {
      const err = validateProviderName(value);
      if (err) {
        message = err;
        return true;
      }
      providerName = value;
      value = '';
      step = 'url';
      return true;
    }
    if (step === 'url') {
      const err = validateBaseURL(value);
      if (err) {
        message = err;
        return true;
      }
      baseURL = value;
      value = '';
      step = 'key';
      return true;
    }
    if (step === 'key') {
      if (value) {
        apiKey = value;
        keySource = 'saved';
      }
      value = '';
      busy = true;
      draw();
      models = await fetchWithTimeout(
        options.fetchModels
          ? () =>
              options.fetchModels!({
                provider: providerName,
                baseURL,
                apiKey,
                local: provider.local,
                signal: fetchController!.signal,
              })
          : undefined,
        [],
      );
      if (provider.remote)
        projects = await fetchWithTimeout(
          options.fetchProjects
            ? () =>
                options.fetchProjects!({
                  provider: providerName,
                  baseURL,
                  apiKey,
                  signal: fetchController!.signal,
                })
            : undefined,
          [],
        );
      if (closed) return false;
      busy = false;
      step = 'model';
      selected = 0;
      return true;
    }
    if (step === 'model') {
      if (models.length && selected < models.length) {
        model = models[selected]!;
        selected = 0;
        step = provider.remote ? 'project' : 'approval';
      } else {
        value = '';
        models = [];
      }
      return true;
    }
    if (step === 'project') {
      if (projects.length && selected < projects.length) {
        projectId = projects[selected]!.id;
        selected = 0;
        step = 'approval';
      } else {
        value = '';
        projects = [];
      }
      return true;
    }
    if (step === 'approval') {
      approval = approvalChoices[selected]!.value;
      step = 'review';
      return true;
    }
    return true;
  };
  const back = () => {
    message = '';
    if (step === 'confirm' || step === 'provider') return false;
    if (step === 'name') step = 'provider';
    else if (step === 'url') step = 'name';
    else if (step === 'key') step = provider.name === '__custom__' ? 'url' : 'provider';
    else if (step === 'model') step = provider.local ? 'provider' : 'key';
    else if (step === 'project') step = 'model';
    else if (step === 'approval') step = provider.remote ? 'project' : 'model';
    else step = 'approval';
    selected = 0;
    value = '';
    return true;
  };
  const screenOutput = screen;
  const onResize = () => draw();
  output.on('resize', onResize);
  let dataListener: ((chunk: string) => void) | undefined;
  let streamFinish: (() => void) | undefined;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const parser = new TerminalInputParser();
  try {
    draw();
    return await new Promise<SetupResult | undefined>((resolve) => {
      const finish = (result?: SetupResult) => {
        if (closed) return;
        closed = true;
        fetchController?.abort();
        resolve(result);
      };
      streamFinish = () => finish();
      const handleEvent = (event: InputEvent) => {
        if (event.type === 'key' && event.key === 'interrupt') return finish();
        if (busy) return;
        if (event.type === 'key' && event.key === 'escape') {
          if (!back()) finish();
          else draw();
          return;
        }
        if (
          step === 'review' &&
          event.type === 'key' &&
          (event.key === 'enter' || event.key === 'newline' || event.key === 'queue')
        )
          return finish({
            provider: providerName,
            baseURL,
            model,
            approval,
            apiKey,
            keySource,
            projectId: projectId || undefined,
          });
        const listLength =
          step === 'confirm'
            ? 2
            : step === 'provider'
              ? options.providers.length
              : step === 'approval'
                ? approvalChoices.length
                : step === 'model' && models.length
                  ? models.length + 1
                  : step === 'project' && projects.length
                    ? projects.length + 1
                    : 0;
        const listDelta =
          event.type === 'key' && event.key === 'up'
            ? -1
            : event.type === 'key' && event.key === 'down'
              ? 1
              : event.type === 'text' && event.text === 'k'
                ? -1
                : event.type === 'text' && event.text === 'j'
                  ? 1
                  : 0;
        if (listLength && listDelta) {
          selected = setupSelect(selected, listDelta, listLength);
          draw();
          return;
        }
        if (
          event.type === 'key' &&
          (event.key === 'enter' || event.key === 'newline' || event.key === 'queue')
        ) {
          if (step === 'model' && !models.length) {
            if (!value.trim()) {
              message = 'Enter a model ID.';
              draw();
              return;
            }
            model = value.trim();
            value = '';
            selected = 0;
            step = provider.remote ? 'project' : 'approval';
            draw();
            return;
          }
          if (step === 'project' && !projects.length) {
            if (!value.trim()) {
              message = 'Enter a project ID.';
              draw();
              return;
            }
            projectId = value.trim();
            value = '';
            selected = 0;
            step = 'approval';
            draw();
            return;
          }
          busy = true;
          void advance().then((keep) => {
            if (!closed) {
              busy = false;
              if (keep === false) finish();
              else draw();
            }
          });
          draw();
          return;
        }
        if (!listLength) {
          if (event.type === 'key' && event.key === 'backspace')
            value = graphemes(value).slice(0, -1).join('');
          else if (event.type === 'text') value += event.text;
          else if (event.type === 'paste') value += event.text.replace(/[\r\n]/g, '');
          draw();
        }
      };
      const onData = (chunk: string) => {
        if (escapeTimer) clearTimeout(escapeTimer);
        for (const event of parser.feed(chunk)) handleEvent(event);
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined;
          for (const event of parser.flushEscape()) handleEvent(event);
        }, 25);
      };
      dataListener = onData;
      input.on('data', onData);
      input.once('close', streamFinish);
      input.once('error', streamFinish);
      output.once('close', streamFinish);
      output.once('error', streamFinish);
    });
  } finally {
    if (escapeTimer) clearTimeout(escapeTimer);
    if (dataListener) input.removeListener('data', dataListener);
    if (streamFinish) {
      input.removeListener('close', streamFinish);
      input.removeListener('error', streamFinish);
      output.removeListener('close', streamFinish);
      output.removeListener('error', streamFinish);
    }
    output.removeListener('resize', onResize);
  }
}

export async function setupWizard(options: SetupWizardOptions): Promise<SetupResult | undefined> {
  if (options.screen) return await runSetupWizard(options, options.screen);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      'interactive setup requires a TTY; set KYOKAO_PROVIDER and provider settings, or run `kyokao config setup` in a terminal',
    );
  return await withInteractiveScreen({ input, output }, async (screen) => {
    return await runSetupWizard(options, screen);
  });
}
