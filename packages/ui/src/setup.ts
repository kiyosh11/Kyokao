import type { ReadStream, WriteStream } from 'node:tty';
import { theme } from './theme.js';

export type SetupStep =
  'confirm' | 'provider' | 'name' | 'url' | 'key' | 'model' | 'approval' | 'review';
export type KeySource = 'environment' | 'saved' | 'not configured' | 'local';
export interface SetupProvider {
  name: string;
  description: string;
  baseURL?: string;
  local?: boolean;
  env?: string;
}
export interface SetupResult {
  provider: string;
  baseURL?: string;
  model: string;
  approval: 'suggest' | 'auto-edit' | 'full-auto';
  apiKey?: string;
  keySource: KeySource;
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
  confirmReplace?: boolean;
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
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
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
export function renderSetupScreen(input: {
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
}): string {
  const width = Math.max(24, input.width);
  const inner = width - 4;
  const height = Math.max(12, input.height ?? 28);
  const line = '─'.repeat(width - 2);
  const rows = [...setupWordmark(width - 4), '', input.title];
  if (input.items) {
    const window = visibleSetupItems(input.items, input.selected ?? 0, height, rows.length + 5);
    if (window.before) rows.push(theme.muted('  ↑ more'));
    window.items.forEach((item, offset) => {
      const index = window.start + offset;
      const text = `${index === input.selected ? '›' : ' '} ${fit(item.name, Math.max(8, inner - 2))}${item.description ? ` — ${fit(item.description, Math.max(6, inner - item.name.length - 6))}` : ''}`;
      rows.push(
        item.danger ? theme.error(text) : index === input.selected ? theme.user(text) : text,
      );
    });
    if (window.after) rows.push(theme.muted('  ↓ more'));
  }
  if (input.value !== undefined)
    rows.push('', `› ${input.secret ? maskSecret(input.value) : fit(input.value, inner - 2)}`);
  if (input.review) rows.push('', ...input.review.map((row) => fit(row, inner)));
  if (input.message) rows.push('', input.message);
  const controls = input.busy
    ? 'Checking models… Ctrl-C cancels'
    : input.step === 'review'
      ? 'Enter save · Esc back · Ctrl-C cancel'
      : input.items
        ? '↑/↓ or j/k move · Enter choose · Esc back · Ctrl-C cancel'
        : 'Enter continue · Esc back · Ctrl-C cancel';
  return [
    `\x1b[?25l\x1b[H\x1b[2J${theme.muted(`╭${line}╮`)}`,
    ...rows.map(
      (row) =>
        `│ ${row}${' '.repeat(Math.max(0, inner - row.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').length))} │`,
    ),
    theme.muted(`├${line}┤`),
    `│ ${theme.muted(fit(controls, inner)).padEnd(inner)} │`,
    theme.muted(`╰${line}╯`),
  ].join('\n');
}
export async function setupWizard(options: SetupWizardOptions): Promise<SetupResult | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      'interactive setup requires a TTY; set KYOKAO_PROVIDER and provider settings, or run `kyokao config setup` in a terminal',
    );
  const previousRaw = input.isRaw;
  const previousEncoding = input.readableEncoding;
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
  const draw = () => {
    const width = output.columns ?? 80;
    const height = output.rows ?? 28;
    const screen = (title: string, extra: Partial<Parameters<typeof renderSetupScreen>[0]>) =>
      output.write(renderSetupScreen({ width, height, step, title, message, busy, ...extra }));
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
    if (step === 'review')
      return screen('Review setup', {
        review: [
          `Provider: ${providerName}`,
          `Model: ${model}`,
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
    };
    return screen(labels[step], { value, secret: step === 'key' });
  };
  const fetchWithTimeout = async () => {
    if (!options.fetchModels) return [];
    fetchController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const models = options.fetchModels({
        provider: providerName,
        baseURL,
        apiKey,
        local: provider.local,
        signal: fetchController.signal,
      });
      const timedOut = new Promise<string[]>((resolve) => {
        timeout = setTimeout(() => {
          fetchController?.abort();
          resolve([]);
        }, 4000);
      });
      return await Promise.race([models, timedOut]);
    } catch {
      return [];
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
      models = await fetchWithTimeout();
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
        step = 'approval';
      } else {
        value = '';
        models = [];
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
    else if (step === 'approval') step = 'model';
    else step = 'approval';
    selected = 0;
    value = '';
    return true;
  };
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  draw();
  let dataListener: ((chunk: string) => void) | undefined;
  try {
    return await new Promise<SetupResult | undefined>((resolve) => {
      const finish = (result?: SetupResult) => {
        if (closed) return;
        closed = true;
        fetchController?.abort();
        resolve(result);
      };
      const onData = (chunk: string) => {
        const keys = chunk === '\u001b[A' || chunk === '\u001b[B' ? [chunk] : Array.from(chunk);
        for (const char of keys) {
          if (char === '\u0003') return finish();
          if (busy) continue;
          if (char === '\u001b') {
            if (!back()) finish();
            else draw();
            continue;
          }
          if (step === 'review' && (char === '\r' || char === '\n'))
            return finish({ provider: providerName, baseURL, model, approval, apiKey, keySource });
          const listLength =
            step === 'confirm'
              ? 2
              : step === 'provider'
                ? options.providers.length
                : step === 'approval'
                  ? approvalChoices.length
                  : step === 'model' && models.length
                    ? models.length + 1
                    : 0;
          if (
            listLength &&
            (char === '\u001b[A' || char === 'k' || char === '\u001b[B' || char === 'j')
          ) {
            selected = setupSelect(
              selected,
              char === '\u001b[A' || char === 'k' ? -1 : 1,
              listLength,
            );
            draw();
            continue;
          }
          if (char === '\r' || char === '\n') {
            if (step === 'model' && !models.length) {
              if (!value.trim()) {
                message = 'Enter a model ID.';
                draw();
                continue;
              }
              model = value.trim();
              value = '';
              selected = 0;
              step = 'approval';
              draw();
              continue;
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
            continue;
          }
          if (!listLength) {
            if (char === '\u007f') value = value.slice(0, -1);
            else if (char >= ' ') value += char;
            draw();
          }
        }
      };
      dataListener = onData;
      input.on('data', onData);
      input.once('close', () => finish());
      input.once('error', () => finish());
    });
  } finally {
    if (dataListener) input.removeListener('data', dataListener);
    input.setRawMode(previousRaw ?? false);
    if (previousEncoding) input.setEncoding(previousEncoding);
    input.pause();
    output.write('\x1b[?25h\n');
  }
}
