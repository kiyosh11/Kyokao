// @ts-nocheck
import type { ReadStream, WriteStream } from 'node:tty';
import { EditorState, TerminalInputParser, graphemes } from './editor.js';
import { withInteractiveScreen, type InteractiveScreen } from './terminal.js';
import { createThemeContext, type ThemeContext } from './theme.js';
import { PromptScheduler, type PromptBackend, type SchedulerState } from '@kyokao/agent';
import {
  filterWorkspaceCommands,
  parseWorkspaceCommand,
  selectPalette,
  type CommandDefinition,
  type ParsedCommand,
} from './palette.js';
import type { TranscriptEntry } from './transcript.js';
import { renderWorkspaceScreen, type WorkspaceHeader, type WorkspaceUsage } from './screen.js';
export type { WorkspaceHeader, WorkspaceUsage } from './screen.js';
export {
  formatWorkspaceUsage,
  renderWorkspaceFooter,
  renderWorkspaceScreen,
  type WorkspaceRenderState,
} from './screen.js';

export type WorkspaceEventKind = TranscriptEntry['kind'];
export interface WorkspaceEmit {
  (kind: WorkspaceEventKind, text: string): void;
  (kind: 'usage', usage: WorkspaceUsage | undefined): void;
}
export interface WorkspaceCommandResult {
  close?: boolean;
  clear?: boolean;
  messages?: Array<{ kind?: WorkspaceEventKind; text: string }>;
  prefill?: string;
  overlay?: 'transcript' | 'shortcuts' | 'raw';
}
export interface TerminalWorkspaceOptions {
  input?: ReadStream;
  output?: WriteStream;
  screen?: InteractiveScreen;
  themeContext?: ThemeContext;
  header: () => WorkspaceHeader;
  backend?: PromptBackend;
  onQueueChange?: (queue: readonly string[]) => Promise<void> | void;
  onSessionChange?: () => Promise<void> | void;
  commandPalette?: (value: string) => CommandDefinition[] | undefined;
  onApprovalHandler?: (approve: (action: string, detail: string) => Promise<boolean>) => void;
  onPrompt?: (
    prompt: string,
    emit: WorkspaceEmit,
    signal: AbortSignal,
    approve: (action: string, detail: string) => Promise<boolean>,
  ) => Promise<void>;
  onCommand: (
    command: ParsedCommand,
    emit: WorkspaceEmit,
    control: WorkspaceControl,
  ) => Promise<WorkspaceCommandResult | void>;
  sessionTitle?: () => string;
  sessionPlan?: () => string[];
  contextWindow?: () => number;
  contextTokens?: () => number;
  showThinking?: () => boolean;
  deleteSession?: (id: string) => Promise<boolean | void>;
  openExternalEditor?: (draft: string) => Promise<string | undefined>;
}
export interface WorkspaceControl {
  scheduler: () => SchedulerState;
  clearQueue: () => Promise<number>;
  retryQueue: () => Promise<void>;
  reset: () => Promise<void>;
  cancelActive: () => Promise<void>;
  enqueue: (prompt: string) => Promise<void>;
  promptSecret: (label: string) => Promise<string | undefined>;
  showOverlay: (value?: 'transcript' | 'shortcuts' | 'raw') => void;
  requestApproval: (action: string, detail: string) => Promise<boolean>;
  deleteSession?: (id: string) => Promise<boolean | void>;
}
class PromptHistory {
  entries = [];
  index;
  draft = '';
  get browsing() {
    return this.index !== undefined;
  }
  add(value) {
    if (value && this.entries.at(-1) !== value) this.entries.push(value);
    this.index = undefined;
    this.draft = '';
  }
  browse(delta, current) {
    if (!this.entries.length) return current;
    if (this.index === undefined) {
      if (delta > 0) return current;
      this.draft = current;
      this.index = this.entries.length - 1;
    } else {
      const next = this.index + delta;
      if (next >= this.entries.length) {
        this.index = undefined;
        return this.draft;
      }
      this.index = Math.max(0, next);
    }
    return this.entries[this.index];
  }
  detach() {
    this.index = undefined;
  }
}
export async function runTerminalWorkspace(options, screen) {
  const input = screen.input;
  const output = screen.output;
  const context =
    options.themeContext ?? createThemeContext({ isTTY: output.isTTY, env: process.env });
  const editor = new EditorState();
  const secretEditor = new EditorState();
  const history = new PromptHistory();
  const parser = new TerminalInputParser();
  let busy = false;
  let busyKind;
  let activityStartedAt;
  let scrollOffset = 0;
  let paletteIndex = 0;
  let closed = false;
  let approval;
  let secretPrompt;
  let transcript = [];
  let usage;
  let overlay;
  let killBuffer = '';
  let externalEditorActive = false;
  let schedulerState = { phase: 'idle', queue: [] };
  let dirty = false;
  const markDirty = () => {
    dirty = true;
  };
  const emit = (kind, value) => {
    if (kind === 'usage') {
      usage = value;
      draw();
      return;
    }
    const text = value;
    const previous = transcript.at(-1);
    if ((kind === 'assistant' || kind === 'reasoning') && previous?.kind === kind)
      previous.text += text;
    else transcript.push({ kind, text, timestamp: Date.now() });
    scrollOffset = 0;
    if (kind === 'assistant' || kind === 'reasoning') markDirty();
    else draw();
  };
  const legacyBackend = {
    provider: options.header().provider,
    async run(prompt, backendEmit, signal) {
      if (!options.onPrompt) throw new Error('No prompt backend configured');
      await options.onPrompt(
        prompt,
        (kind, value) => backendEmit(kind, value),
        signal,
        askApproval,
      );
    },
    async cancel() {},
    async reset() {},
    async resume() {
      throw new Error('Resume is not supported by this workspace backend');
    },
    status: () => ({ provider: options.header().provider, state: schedulerState.phase }),
    session: () => undefined,
    async close() {},
  };
  const scheduler = new PromptScheduler({
    backend: options.backend ?? legacyBackend,
    emit: (kind, value) => {
      if (kind === 'usage') emit('usage', value);
      else emit(kind, String(value));
    },
    onState: (state) => {
      schedulerState = state;
      const wasBusy = busy;
      busy = Boolean(state.active) || ['stopping', 'starting-replacement'].includes(state.phase);
      busyKind = busy ? 'prompt' : undefined;
      if (busy && !wasBusy) activityStartedAt = Date.now();
      else if (!busy) activityStartedAt = undefined;
      if (state.phase === 'idle' && !state.active) void options.onSessionChange?.();
      draw();
    },
    onRunStart: (prompt) => emit('user', prompt),
    onQueueChange: options.onQueueChange,
  });
  const control = {
    scheduler: () => scheduler.state(),
    clearQueue: () => scheduler.clearQueue(),
    retryQueue: () => scheduler.retry(),
    reset: () => scheduler.reset(),
    cancelActive: () => scheduler.cancelActive(),
    enqueue: (prompt) => scheduler.submit(prompt, 'queue'),
    promptSecret: (label) =>
      new Promise((resolve) => {
        if (secretPrompt) throw new Error('A secure input prompt is already active');
        secretEditor.set('');
        secretPrompt = { label, resolve };
        draw();
      }),
    showOverlay: (value) => {
      overlay = value;
      draw();
    },
    requestApproval: (action, detail) => askApproval(action, detail),
    deleteSession: options.deleteSession,
  };
  const palette = () =>
    !secretPrompt && editor.text.startsWith('/') && busyKind !== 'command'
      ? (options.commandPalette?.(editor.text) ?? filterWorkspaceCommands(editor.text, context))
      : [];
  const draw = () => {
    if (closed) return;
    const visibleTranscript =
      options.showThinking?.() === false
        ? transcript.filter((entry) => entry.kind !== 'reasoning')
        : transcript;
    const matches = palette();
    paletteIndex = selectPalette(paletteIndex, 0, matches.length);
    const displayedEditor = secretPrompt
      ? new EditorState('•'.repeat(graphemes(secretEditor.text).length))
      : editor;
    if (secretPrompt) displayedEditor.cursor = secretEditor.cursor;
    const contextWindow = options.contextWindow?.();
    const contextTokens = options.contextTokens?.();
    const renderedUsage =
      usage || contextWindow != null || contextTokens != null
        ? {
            totalTokens: usage?.totalTokens ?? 0,
            estimatedCostUsd: usage?.estimatedCostUsd ?? 0,
            ...usage,
            contextTokens,
            contextWindow,
          }
        : undefined;
    const requestedScrollOffset = scrollOffset;
    let frame = renderWorkspaceScreen({
      width: output.columns ?? 80,
      height: output.rows ?? 24,
      header: options.header(),
      transcript: visibleTranscript,
      editor: displayedEditor,
      busy,
      busyKind,
      approval,
      scrollOffset,
      paletteIndex,
      animationFrame: Math.floor(Date.now() / 100),
      activityStartedAt,
      usage: renderedUsage,
      scheduler: schedulerState,
      themeContext: context,
      paletteCommands: matches,
      secretLabel: secretPrompt?.label,
      sessionTitle: options.sessionTitle?.(),
      sessionPlan: options.sessionPlan?.(),
      overlay,
    });
    const maxScroll = Math.max(0, frame.transcriptLength - frame.transcriptHeight);
    scrollOffset = Math.min(scrollOffset, maxScroll);
    if (scrollOffset !== requestedScrollOffset)
      frame = renderWorkspaceScreen({
        width: output.columns ?? 80,
        height: output.rows ?? 24,
        header: options.header(),
        transcript: visibleTranscript,
        editor: displayedEditor,
        busy,
        busyKind,
        approval,
        scrollOffset,
        paletteIndex,
        animationFrame: Math.floor(Date.now() / 100),
        activityStartedAt,
        usage: renderedUsage,
        scheduler: schedulerState,
        themeContext: context,
        paletteCommands: matches,
        secretLabel: secretPrompt?.label,
        sessionTitle: options.sessionTitle?.(),
        sessionPlan: options.sessionPlan?.(),
        overlay,
      });
    screen.draw(frame);
  };
  const askApproval = (action, detail) =>
    new Promise((resolve) => {
      approval = { action, detail, resolve };
      draw();
    });
  options.onApprovalHandler?.(askApproval);
  const settleApproval = (allowed, message) => {
    if (!approval) return;
    approval.resolve(allowed);
    approval = undefined;
    if (message) transcript.push({ kind: 'status', text: message, timestamp: Date.now() });
  };
  const settleSecret = (value) => {
    if (!secretPrompt) return;
    const { resolve } = secretPrompt;
    secretPrompt = undefined;
    secretEditor.set('');
    resolve(value);
  };
  const runPrompt = async (prompt, mode) => {
    await scheduler.submit(prompt, mode);
  };
  const runCommand = async (raw) => {
    const parsed = parseWorkspaceCommand(raw);
    if (!parsed.name) {
      emit('error', `Unknown command "${raw}". Type / to browse commands.`);
      return;
    }
    if (!busy) activityStartedAt = Date.now();
    busy = true;
    busyKind = 'command';
    draw();
    let close = false;
    try {
      const result = await options.onCommand(parsed, emit, control);
      if (result?.clear) transcript = [];
      for (const message of result?.messages ?? []) emit(message.kind ?? 'system', message.text);
      if (result?.prefill) {
        editor.set(result.prefill);
        paletteIndex = 0;
      }
      if (result?.overlay) overlay = result.overlay;
      close = result?.close === true;
      return close;
    } catch (error) {
      emit('error', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      busy = Boolean(schedulerState.active);
      busyKind = busy ? 'prompt' : undefined;
      if (!busy) activityStartedAt = undefined;
      if (!close) draw();
    }
  };
  const onResize = () => draw();
  output.on('resize', onResize);
  const ticker = setInterval(() => {
    if (closed) return;
    if (dirty || busy) {
      dirty = false;
      draw();
    }
  }, 30);
  let dataListener;
  let streamFinish;
  let escapeTimer;
  try {
    draw();
    await new Promise((resolve) => {
      const finish = () => resolve();
      streamFinish = finish;
      const handleEvent = (event) => {
        if (approval) {
          if (event.type === 'text' && /^[yY]/.test(event.text)) settleApproval(true);
          else if (
            (event.type === 'key' &&
              ['interrupt', 'escape', 'enter', 'newline'].includes(event.key)) ||
            (event.type === 'text' && /^[nN]/.test(event.text))
          )
            settleApproval(false, 'Approval denied.');
          else return;
          draw();
          return;
        }
        if (secretPrompt) {
          if (event.type === 'paste') secretEditor.insert(event.text.replace(/\r?\n/g, ''));
          else if (event.type === 'text') secretEditor.insert(event.text);
          else if (event.key === 'enter') {
            settleSecret(secretEditor.text.trim());
            draw();
            return;
          } else if (event.key === 'escape' || event.key === 'interrupt') {
            settleSecret();
            draw();
            return;
          } else if (event.key === 'backspace') secretEditor.backspace();
          else if (event.key === 'delete') secretEditor.delete();
          else if (event.key === 'left') secretEditor.left();
          else if (event.key === 'right') secretEditor.right();
          else if (event.key === 'home' || event.key === 'ctrl-a') secretEditor.start();
          else if (event.key === 'end' || event.key === 'ctrl-e') secretEditor.finish();
          else if (event.key === 'ctrl-u') secretEditor.killBefore();
          else if (event.key === 'ctrl-k') secretEditor.killAfter();
          else if (event.key === 'ctrl-w') secretEditor.deleteWordBefore();
          else if (event.key === 'alt-left') secretEditor.wordLeft();
          else if (event.key === 'alt-right') secretEditor.wordRight();
          draw();
          return;
        }
        if (event.type === 'key' && event.key === 'ctrl-t') {
          overlay = overlay === 'transcript' ? undefined : 'transcript';
          scrollOffset = 0;
          draw();
          return;
        }
        if (event.type === 'text' && event.text === '?' && !editor.text) {
          overlay = overlay === 'shortcuts' ? undefined : 'shortcuts';
          scrollOffset = 0;
          draw();
          return;
        }
        if (overlay) {
          if (event.type === 'key' && event.key === 'escape') {
            overlay = undefined;
            scrollOffset = 0;
          } else if (event.type === 'key' && ['page-up', 'up', 'ctrl-p'].includes(event.key)) {
            scrollOffset += event.key === 'page-up' ? Math.max(1, (output.rows ?? 24) - 6) : 1;
          } else if (event.type === 'key' && ['page-down', 'down', 'ctrl-n'].includes(event.key)) {
            scrollOffset = Math.max(
              0,
              scrollOffset - (event.key === 'page-down' ? Math.max(1, (output.rows ?? 24) - 6) : 1),
            );
          }
          draw();
          return;
        }
        if (event.type === 'key' && event.key === 'interrupt') {
          if (busyKind === 'command') emit('status', 'Command is running and cannot be cancelled.');
          else if (busyKind === 'prompt') void scheduler.cancelActive();
          else resolve();
          return;
        }
        if (event.type === 'key' && event.key === 'escape') {
          if (busyKind === 'prompt') {
            void scheduler.cancelActive();
          } else if (editor.text.startsWith('/')) {
            editor.set('');
            paletteIndex = 0;
            draw();
          }
          return;
        }
        if (busyKind === 'command') return;
        if (externalEditorActive) return;
        if (event.type === 'key' && event.key === 'ctrl-l') {
          transcript = [];
          scrollOffset = 0;
          draw();
          return;
        }
        if (event.type === 'key' && event.key === 'ctrl-o') {
          void runCommand('/copy');
          return;
        }
        if (event.type === 'key' && event.key === 'ctrl-g') {
          if (!options.openExternalEditor) {
            emit('error', 'No external editor is configured.');
            return;
          }
          externalEditorActive = true;
          screen.suspend();
          void options
            .openExternalEditor(editor.text)
            .then((draft) => {
              if (draft !== undefined) {
                editor.set(draft.replace(/\r\n?/g, '\n'));
                history.detach();
                paletteIndex = 0;
              }
            })
            .catch((error) => emit('error', error instanceof Error ? error.message : String(error)))
            .finally(() => {
              externalEditorActive = false;
              screen.resume();
              draw();
            });
          return;
        }
        if (event.type === 'paste') {
          history.detach();
          editor.insert(event.text.replace(/\r\n?/g, '\n'));
          paletteIndex = 0;
          draw();
          return;
        }
        if (event.type === 'text') {
          history.detach();
          editor.insert(event.text);
          paletteIndex = 0;
          draw();
          return;
        }
        const key = event.key === 'ctrl-p' ? 'up' : event.key === 'ctrl-n' ? 'down' : event.key;
        if (key === 'up' || key === 'down') {
          const matches = palette();
          if (matches.length && !history.browsing) {
            paletteIndex = selectPalette(paletteIndex, key === 'up' ? -1 : 1, matches.length);
          } else if (editor.multiline) editor.vertical(key === 'up' ? -1 : 1);
          else editor.set(history.browse(key === 'up' ? -1 : 1, editor.text));
          draw();
          return;
        }
        if (key === 'page-up') scrollOffset += Math.max(1, (output.rows ?? 24) - 10);
        else if (key === 'page-down')
          scrollOffset = Math.max(0, scrollOffset - Math.max(1, (output.rows ?? 24) - 10));
        else if (key === 'backspace' || key === 'ctrl-h') editor.backspace();
        else if (
          key === 'ctrl-d' &&
          !busy &&
          editor.text.startsWith('/sessions') &&
          palette().length
        ) {
          const selected = palette()[paletteIndex];
          if (selected && control.deleteSession) {
            const sessionId = selected.completion?.match(/\s(\S+)$/)?.[1];
            if (sessionId) {
              void control
                .deleteSession(sessionId)
                .then((clearTranscript) => {
                  if (clearTranscript) {
                    transcript = [];
                    usage = undefined;
                    scrollOffset = 0;
                  }
                  paletteIndex = Math.max(0, paletteIndex - 1);
                  void options.onSessionChange?.();
                  draw();
                })
                .catch((error) =>
                  emit('error', error instanceof Error ? error.message : String(error)),
                );
              return;
            }
          }
          draw();
          return;
        } else if (key === 'delete' || key === 'ctrl-d') editor.delete();
        else if (key === 'left' || key === 'ctrl-b') editor.left();
        else if (key === 'right' || key === 'ctrl-f') editor.right();
        else if (key === 'home') editor.home();
        else if (key === 'end') {
          if (scrollOffset) scrollOffset = 0;
          else editor.end();
        } else if (key === 'ctrl-a') editor.start();
        else if (key === 'ctrl-e') editor.finish();
        else if (key === 'ctrl-u') killBuffer = editor.killBefore();
        else if (key === 'ctrl-k') killBuffer = editor.killAfter();
        else if (key === 'ctrl-w') killBuffer = editor.deleteWordBefore();
        else if (key === 'alt-delete') killBuffer = editor.deleteWordAfter();
        else if (key === 'ctrl-y' && killBuffer) editor.insert(killBuffer);
        else if (key === 'ctrl-r' || key === 'ctrl-s') {
          editor.set(history.browse(key === 'ctrl-r' ? -1 : 1, editor.text));
        } else if (key === 'alt-left') editor.wordLeft();
        else if (key === 'alt-right') editor.wordRight();
        else if (key === 'newline') editor.insert('\n');
        else if (key === 'queue') {
          const prompt = editor.text.trim();
          if (prompt && !prompt.startsWith('/')) {
            history.add(prompt);
            editor.set('');
            paletteIndex = 0;
            void runPrompt(prompt, 'queue');
          }
        } else if (key === 'tab') {
          if (palette().length) {
            const selected = palette()[paletteIndex];
            editor.set(selected.completion ?? `/${selected.name} `);
            history.detach();
            paletteIndex = 0;
          } else if (busyKind === 'prompt') {
            const prompt = editor.text.trim();
            if (prompt && !prompt.startsWith('/')) {
              history.add(prompt);
              editor.set('');
              paletteIndex = 0;
              void runPrompt(prompt, 'queue');
            }
          }
        } else if (key === 'enter') {
          let prompt = editor.text.trim();
          if (prompt) {
            const selected = palette()[paletteIndex];
            if (selected?.completion && selected.completion.trim() !== prompt) {
              if (!selected.submit) {
                editor.set(selected.completion);
                history.detach();
                paletteIndex = 0;
                draw();
                return;
              }
              prompt = selected.completion.trim();
            }
            if (
              prompt.startsWith('/') &&
              palette().length &&
              !parseWorkspaceCommand(prompt)?.name
            ) {
              editor.set(`/${palette()[paletteIndex].name} `);
              draw();
              return;
            }
            history.add(prompt);
            editor.set('');
            paletteIndex = 0;
            if (prompt.startsWith('/')) {
              void runCommand(prompt).then((close) => close && resolve());
            } else void runPrompt(prompt, 'replace');
          }
        }
        draw();
      };
      const onData = (chunk) => {
        if (escapeTimer) clearTimeout(escapeTimer);
        for (const event of parser.feed(chunk)) handleEvent(event);
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined;
          for (const event of parser.flushEscape()) handleEvent(event);
        }, 25);
      };
      dataListener = onData;
      input.on('data', dataListener);
      input.once('close', finish);
      input.once('error', finish);
      output.once('close', finish);
      output.once('error', finish);
    });
  } finally {
    closed = true;
    if (escapeTimer) clearTimeout(escapeTimer);
    clearInterval(ticker);
    settleApproval(false);
    settleSecret();
    await scheduler.close();
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
export async function terminalWorkspace(options) {
  if (options.screen) return await runTerminalWorkspace(options, options.screen);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('interactive workspace requires a TTY');
  return await withInteractiveScreen({ input, output }, async (screen) => {
    await runTerminalWorkspace(options, screen);
  });
}
