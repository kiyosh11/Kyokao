// @ts-nocheck
export type WorkspaceCommand =
  | 'new'
  | 'resume'
  | 'fork'
  | 'rollout'
  | 'archive'
  | 'delete'
  | 'sessions'
  | 'rename'
  | 'clear'
  | 'exit'
  | 'quit'
  | 'model'
  | 'provider'
  | 'approval'
  | 'permissions'
  | 'personality'
  | 'context'
  | 'status'
  | 'compact'
  | 'rewind'
  | 'plan'
  | 'goal'
  | 'view-plan'
  | 'diff'
  | 'review'
  | 'doctor'
  | 'queue'
  | 'memory'
  | 'memories'
  | 'skills'
  | 'import'
  | 'init'
  | 'mention'
  | 'raw'
  | 'ps'
  | 'stop'
  | 'test-approval'
  | 'experimental'
  | 'subagents'
  | 'agent'
  | 'apps'
  | 'logout'
  | 'feedback'
  | 'debug-config'
  | 'ide'
  | 'vim'
  | 'setup-default-sandbox'
  | 'sandbox-add-read-dir'
  | 'approve'
  | 'hooks'
  | 'app'
  | 'side'
  | 'btw'
  | 'title'
  | 'statusline'
  | 'capy'
  | 'threads'
  | 'task'
  | 'tags'
  | 'usage'
  | 'settings'
  | 'copy'
  | 'mcp'
  | 'plugins'
  | 'keymap'
  | 'help';
export type CommandGroup = 'session' | 'model' | 'context' | 'planning' | 'workspace' | 'setup';
export interface CommandDefinition {
  name: WorkspaceCommand;
  group: CommandGroup;
  syntax: string;
  label?: string;
  description: string;
  completion?: string;
  submit?: boolean;
}
export interface ParsedCommand {
  name: WorkspaceCommand | undefined;
  args: string[];
  raw: string;
}

export const COMMAND_GROUP_ORDER = [
  'session',
  'model',
  'context',
  'planning',
  'workspace',
  'setup',
];
export const COMMAND_GROUP_LABELS = {
  session: 'Session',
  model: 'Model',
  context: 'Context',
  planning: 'Planning',
  workspace: 'Workspace',
  setup: 'Setup',
};
export const workspaceCommands = [
  { name: 'new', group: 'session', syntax: '/new', description: 'start a new session' },
  { name: 'resume', group: 'session', syntax: '/resume', description: 'resume a saved session' },
  {
    name: 'fork',
    group: 'session',
    syntax: '/fork [session]',
    description: 'fork a saved or active session',
  },
  {
    name: 'rollout',
    group: 'session',
    syntax: '/rollout [session]',
    description: 'show the saved session file',
  },
  {
    name: 'archive',
    group: 'session',
    syntax: '/archive [session|list|restore <session>]',
    description: 'archive, list, or restore saved sessions',
  },
  {
    name: 'delete',
    group: 'session',
    syntax: '/delete [session]',
    description: 'delete a saved session after confirmation',
  },
  {
    name: 'sessions',
    group: 'session',
    syntax: '/sessions',
    description: 'browse, open, and delete saved sessions',
  },
  {
    name: 'rename',
    group: 'session',
    syntax: '/rename <title>',
    description: 'set the session title shown on the prompt box',
  },
  {
    name: 'clear',
    group: 'session',
    syntax: '/clear',
    description: 'clear the visible transcript',
  },
  { name: 'exit', group: 'session', syntax: '/exit', description: 'exit kyokao' },
  { name: 'quit', group: 'session', syntax: '/quit', description: 'exit kyokao' },
  {
    name: 'model',
    group: 'model',
    syntax: '/model [id]',
    description: 'show or change the active model',
  },
  {
    name: 'provider',
    group: 'model',
    syntax: '/provider [name [model]|key|capy <project> <captain> <build>]',
    description: 'show or change provider configuration or replace its saved key',
  },
  {
    name: 'approval',
    group: 'model',
    syntax: '/approval [suggest|auto-edit|full-auto]',
    description: 'show or change approval mode',
  },
  {
    name: 'permissions',
    group: 'model',
    syntax: '/permissions [suggest|auto-edit|full-auto]',
    description: 'choose what kyokao is allowed to do',
  },
  {
    name: 'personality',
    group: 'model',
    syntax: '/personality [default|concise|friendly|technical]',
    description: 'set the response style for this session',
  },
  {
    name: 'context',
    group: 'context',
    syntax: '/context',
    description: 'show token usage and context budget',
  },
  {
    name: 'status',
    group: 'context',
    syntax: '/status',
    description: 'show session configuration and token usage',
  },
  {
    name: 'compact',
    group: 'context',
    syntax: '/compact',
    description: 'manually compress the transcript',
  },
  {
    name: 'rewind',
    group: 'context',
    syntax: '/rewind',
    description: 'drop the last conversation turn',
  },
  {
    name: 'plan',
    group: 'planning',
    syntax: '/plan [step|run|clear]',
    description: 'build, run, or clear a plan',
  },
  {
    name: 'goal',
    group: 'planning',
    syntax: '/goal [text|clear]',
    description: 'show, set, or clear the active session goal',
  },
  {
    name: 'view-plan',
    group: 'planning',
    syntax: '/view-plan',
    description: 'show the current plan',
  },
  {
    name: 'diff',
    group: 'workspace',
    syntax: '/diff [taskId]',
    description: 'show the working-tree diff, or a Capy task diff',
  },
  {
    name: 'review',
    group: 'workspace',
    syntax: '/review [instructions]',
    description: 'review current changes and find issues',
  },
  {
    name: 'doctor',
    group: 'workspace',
    syntax: '/doctor',
    description: 'check local provider setup',
  },
  {
    name: 'queue',
    group: 'workspace',
    syntax: '/queue [clear|retry]',
    description: 'list or manage queued prompts',
  },
  {
    name: 'memory',
    group: 'workspace',
    syntax: '/memory [list|set <key> <value>|delete <key>]',
    description: 'manage memory',
  },
  {
    name: 'memories',
    group: 'workspace',
    syntax: '/memories [list|set <key> <value>|delete <key>]',
    description: 'manage memory',
  },
  {
    name: 'skills',
    group: 'workspace',
    syntax: '/skills [name]',
    description: 'list or invoke installed skills',
  },
  {
    name: 'import',
    group: 'workspace',
    syntax: '/import',
    description: 'import CLAUDE.md instructions into AGENTS.md',
  },
  {
    name: 'init',
    group: 'workspace',
    syntax: '/init',
    description: 'create an AGENTS.md starter file',
  },
  {
    name: 'mention',
    group: 'workspace',
    syntax: '/mention <path>',
    description: 'insert a workspace file reference',
  },
  { name: 'raw', group: 'workspace', syntax: '/raw', description: 'show the raw transcript' },
  { name: 'ps', group: 'workspace', syntax: '/ps', description: 'show active and queued work' },
  {
    name: 'stop',
    group: 'workspace',
    syntax: '/stop',
    description: 'stop active work and clear its queue',
  },
  {
    name: 'test-approval',
    group: 'workspace',
    syntax: '/test-approval',
    description: 'test the approval dialog',
  },
  {
    name: 'experimental',
    group: 'workspace',
    syntax: '/experimental',
    description: 'show experimental features',
  },
  {
    name: 'subagents',
    group: 'workspace',
    syntax: '/subagents [on|off]',
    description: 'show or toggle subagent tools',
  },
  {
    name: 'agent',
    group: 'workspace',
    syntax: '/agent',
    description: 'show agent and subagent status',
  },
  {
    name: 'capy',
    group: 'workspace',
    syntax: '/capy',
    description: 'show capy remote thread status and links',
  },
  {
    name: 'threads',
    group: 'workspace',
    syntax: '/threads [query]',
    description: 'list capy threads for the active project',
  },
  {
    name: 'task',
    group: 'workspace',
    syntax: '/task <id>',
    description: 'show a capy task record',
  },
  {
    name: 'tags',
    group: 'workspace',
    syntax: '/tags [list|set <name>...|create <name> [color]]',
    description: 'manage capy thread tags',
  },
  {
    name: 'usage',
    group: 'workspace',
    syntax: '/usage',
    description: 'show capy usage and billing totals',
  },
  {
    name: 'settings',
    group: 'setup',
    syntax: '/settings',
    description: 'browse and change persistent TUI settings',
  },
  {
    name: 'copy',
    group: 'setup',
    syntax: '/copy',
    description: 'copy the last reply to the clipboard',
  },
  { name: 'mcp', group: 'setup', syntax: '/mcp', description: 'list configured MCP servers' },
  {
    name: 'plugins',
    group: 'setup',
    syntax: '/plugins',
    description: 'list configured plugin modules',
  },
  { name: 'apps', group: 'setup', syntax: '/apps', description: 'list configured integrations' },
  {
    name: 'logout',
    group: 'setup',
    syntax: '/logout',
    description: 'remove the saved key for the active provider',
  },
  {
    name: 'feedback',
    group: 'setup',
    syntax: '/feedback',
    description: 'show where to report Kyokao feedback',
  },
  {
    name: 'debug-config',
    group: 'setup',
    syntax: '/debug-config',
    description: 'show the resolved configuration with secrets redacted',
  },
  { name: 'ide', group: 'setup', syntax: '/ide', description: 'show IDE integration availability' },
  { name: 'vim', group: 'setup', syntax: '/vim', description: 'show Vim-mode availability' },
  {
    name: 'setup-default-sandbox',
    group: 'setup',
    syntax: '/setup-default-sandbox',
    description: 'show sandbox configuration',
  },
  {
    name: 'sandbox-add-read-dir',
    group: 'setup',
    syntax: '/sandbox-add-read-dir <path>',
    description: 'add a sandbox read directory',
  },
  {
    name: 'approve',
    group: 'setup',
    syntax: '/approve',
    description: 'show approval request status',
  },
  {
    name: 'hooks',
    group: 'setup',
    syntax: '/hooks',
    description: 'show hook integration availability',
  },
  {
    name: 'app',
    group: 'setup',
    syntax: '/app',
    description: 'show desktop app integration availability',
  },
  {
    name: 'side',
    group: 'setup',
    syntax: '/side',
    description: 'show side-conversation availability',
  },
  {
    name: 'btw',
    group: 'setup',
    syntax: '/btw',
    description: 'show side-conversation availability',
  },
  {
    name: 'title',
    group: 'setup',
    syntax: '/title <text>',
    description: 'rename the current session',
  },
  {
    name: 'statusline',
    group: 'setup',
    syntax: '/statusline',
    description: 'show status-line configuration availability',
  },
  {
    name: 'keymap',
    group: 'setup',
    syntax: '/keymap',
    description: 'show Codex-compatible keyboard shortcuts',
  },
  {
    name: 'help',
    group: 'setup',
    syntax: '/help [command]',
    description: 'show commands and command syntax',
  },
];
export function groupedWorkspaceCommands() {
  const grouped = Object.fromEntries(COMMAND_GROUP_ORDER.map((group) => [group, []]));
  for (const command of workspaceCommands) grouped[command.group].push(command);
  return grouped;
}
export function parseWorkspaceCommand(value) {
  const raw = value.trim();
  if (!raw.startsWith('/')) return undefined;
  const [command = '', ...args] = raw.slice(1).split(/\s+/).filter(Boolean);
  const name = workspaceCommands.find((entry) => entry.name === command.toLowerCase())?.name;
  return { name, args, raw };
}
export function filterWorkspaceCommands(value, _context?) {
  void _context;
  const query = value.trim().toLowerCase().replace(/^\//, '').split(/\s/, 1)[0] ?? '';
  const byName = workspaceCommands.filter((entry) => entry.name.startsWith(query));
  if (byName.length) return byName;
  return workspaceCommands.filter((entry) => entry.description.toLowerCase().includes(query));
}
export function selectPalette(index, delta, length) {
  if (!length) return 0;
  return Math.max(0, Math.min(length - 1, index + delta));
}
export function visiblePaletteCommands(commands, selected, limit = 7) {
  const size = Math.max(1, limit);
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), commands.length - size));
  return { commands: commands.slice(start, start + size), start };
}
