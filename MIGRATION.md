# Migration Guide

## 0.7.x → 0.8.0: TUI redesign

Kyokao 0.8.0 rebuilds the terminal workspace UI with a minimal free-flowing transcript layout and adds seven new slash commands for context management, planning, and clipboard access.

### Visual changes

- **The outer frame is gone.** The transcript now flows free at the top of the screen instead of inside a `╭─╮`/`╰─╯` box.
- **Prompt box at the bottom.** A single bordered box holds the input. The session title and current status (`Ready`, `Working`, etc.) appear on its top border — e.g. `╭ input · auth-refactor · Ready ──╮`.
- **Top metadata bar.** Brand, session title, provider/model, and approval mode run across the first line, right-aligned with live token usage and cost.
- **Role labels in the transcript.** Each entry now shows a lowercase `user` / `assistant` / `tool` / `error` / `status` / `system` label above its content (previously only tool/error/system had labels). Tool calls collapse to a `⏵ tool_name  argument` header with the result indented below.
- **Inline palette, queue, and plan boxes.** When active, each renders as its own thin `╭─ label ──╮` box above the prompt box instead of a divider inside the outer frame.
- **Glyph shortcuts in hints.** The footer uses `↵` for Enter (`↵ send · shift+↵ newline · ctrl+↵ queue · esc cancel`).

### New slash commands

| Command | Group | Description |
|---|---|---|
| `/rename <title>` | Session | Set the session title shown on the prompt-box border. |
| `/context` | Context | Show transcript token usage against the configured budget, compression threshold, and cumulative session totals. |
| `/compact` | Context | Manually run context compression on the saved transcript. Refuses during active requests or on the Capy remote backend. |
| `/rewind` | Context | Drop the last conversation turn (the most recent user prompt and everything after it). |
| `/plan <step>` | Planning | Add a step to the session plan. Also `/plan run` (enqueue all steps) and `/plan clear`. |
| `/view-plan` | Planning | Show the current plan. |
| `/copy` | Setup | Copy the last assistant reply to the system clipboard (uses `clip.exe` / `pbcopy` / `xclip` — no new dependency). |

All commands are grouped into the `/help` output: **Session**, **Model**, **Context**, **Planning**, **Workspace**, **Setup**. The command palette shows a `N of M` counter and group-aware section labels (`Providers`, `Models`, `Themes`, etc.).

### Capy provider: full API coverage + new TUI commands

0.8.0 implements the current published [Capy OpenAPI surface](https://docs.capy.ai/openapi.json). In addition to models, projects, threads, tasks, tags, usage, setup, session tokens, and personal environment-variable metadata, `CapyClient` covers snapshots, browser snapshots, automations, and session verification. The existing `createThread` now accepts the published body (`speed`, `reasoning`, `buildModel`, `buildSpeed`, `repos`, `tags`, `attachmentUrls`, `browserSnapshotIds`, and supported integration fields). Personal environment-variable values remain write-only: reads return metadata, never secrets.

Five TUI slash-command flows are available for Capy:

| Command | Description |
|---|---|
| `/threads [query]` | List Capy threads for the active project. Optional free-text `query` filters by title/content. |
| `/task <id>` | Show a task record (identifier, status, prompt, linked PR, thread). |
| `/tags [list\|set <name>...\|create <name> [color]]` | Manage Capy thread tags. `set` tags the active thread; `create` defines a project tag. |
| `/usage [orgId] [from] [to]` | Show Capy usage/billing totals (LLM + VM dollars) for the month or a custom range. |
| `/diff <taskId>` | Extended `/diff`: with a task ID, fetches and renders the task's remote diff. |

`/resume` for Capy sessions now **rebuilds the local transcript from remote history** — when the Capy API returns both user and assistant messages, the local session file is repopulated from the authoritative remote record (recovering history even when the local file is missing or stale).

### Capy execution config

`ProviderConfig` for the `capy` provider accepts new optional fields applied to every new thread:

```json
{
  "providers": {
    "capy": {
      "apiKey": "...",
      "projectId": "...",
      "speed": "fast",
      "buildModel": "gpt-5.6-terra",
      "buildSpeed": "standard",
      "repos": [{ "repoFullName": "owner/repo", "branch": "main" }],
      "tags": ["cli"]
    }
  }
}
```

### Session schema

- New optional field `Session.plan?: string[]` — persisted across sessions, surfaced by `/plan` and `/view-plan`. Existing sessions load fine without it.
- `Session.task` is now also user-editable via `/rename` (previously only set by the first prompt).

### What did not change

- The CLI subcommand surface (`kyokao sessions`, `kyokao config show`, etc.) is unchanged.
- `~/.kyokao/` layout, `KYOKAO_HOME` isolation, config precedence, providers, MCP, plugins, sub-agents, headless output formats — all unchanged from 0.7.0.
- Editor bindings, history, paste handling, bracketed paste, enhanced keyboard reporting — unchanged.

---

## 0.6.x → 0.7.0: Consolidated state under `~/.kyokao/`

Kyokao 0.7.0 consolidates all state under a single home directory (`~/.kyokao/`). The workspace-local `.kyokao/` folder and `.kyokao.json` config file are no longer read.

### What moved

| Before (0.6.x) | After (0.7.0) |
|---|---|
| `~/.config/kyokao/config.json` (Unix) | `~/.kyokao/config.json` |
| `%APPDATA%/kyokao/config.json` (Windows) | `~/.kyokao/config.json` |
| `<workspace>/.kyokao/sessions/` | `~/.kyokao/sessions/` |
| `<workspace>/.kyokao/memory.json` | `~/.kyokao/memory.json` |
| `<workspace>/.kyokao/instructions.md` | `~/.kyokao/instructions.md` |
| `<workspace>/.kyokao/soul.md` | `~/.kyokao/soul.md` |
| `<workspace>/.kyokao/commands/*.md` | `~/.kyokao/commands/*.md` |
| `<workspace>/.kyokao.json` (config overrides) | **Removed** — use `~/.kyokao/config.json` or a profile |

### What stays workspace-local

Repository-convention instruction files are still read from the workspace root:

- `AGENTS.md`
- `CLAUDE.md`
- `SOUL.md`
- `KYOKAO.md`

These are per-repo and should be committed to version control.

### How to migrate manually

#### Config

Copy your global config to the new location:

```bash
# Unix
mkdir -p ~/.kyokao
cp ~/.config/kyokao/config.json ~/.kyokao/config.json

# Windows (PowerShell)
New-Item -ItemType Directory -Force ~/.kyokao
Copy-Item "$env:APPDATA\kyokao\config.json" ~/.kyokao/config.json
```

If you had a `<workspace>/.kyokao.json` with overrides, merge those values into `~/.kyokao/config.json` or create a [profile](README.md#configuration) for scoped settings.

#### Sessions and memory

If you want to preserve session history and memory from a specific workspace:

```bash
mkdir -p ~/.kyokao/sessions
cp <workspace>/.kyokao/sessions/*.json ~/.kyokao/sessions/
cp <workspace>/.kyokao/memory.json ~/.kyokao/memory.json
```

Sessions are now **global** — `kyokao session list` shows sessions from all workspaces. Each session records the workspace path it was created in (the `workspace` field) for future filtering.

#### Custom commands

```bash
mkdir -p ~/.kyokao/commands
cp <workspace>/.kyokao/commands/*.md ~/.kyokao/commands/
```

#### Instructions

If you had `<workspace>/.kyokao/instructions.md` (Kyokao-specific user instructions, not repo conventions):

```bash
cp <workspace>/.kyokao/instructions.md ~/.kyokao/instructions.md
```

### Detecting legacy state

Run `kyokao doctor` in any workspace that had a `.kyokao/` folder or `.kyokao.json`. It will print a notice if it detects legacy state:

```
legacy: found pre-0.7.0 state at /path/to/.kyokao, /path/to/.kyokao.json.
Kyokao no longer reads workspace .kyokao/ or .kyokao.json — sessions, memory,
and instructions now live at ~/.kyokao/. See MIGRATION.md.
```

### `KYOKAO_HOME` override

For testing or non-standard home directories, set the `KYOKAO_HOME` environment variable:

```bash
export KYOKAO_HOME=/custom/path/kyokao
```

Kyokao will use that directory instead of `~/.kyokao/`.
