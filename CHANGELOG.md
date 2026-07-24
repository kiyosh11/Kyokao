# Changelog

## 0.8.0

Reference-style terminal workspace and complete Capy OpenAPI integration.

### Terminal workspace

- Rebuilt the interactive screen around the supplied dark terminal reference: workspace/context top bar, timestamped full-width user prompts, free-flow Markdown, compact tool activity, live elapsed/token status, bottom-anchored composer, model/approval label, and shortcut legend.
- Added `/context`, `/compact`, `/rewind`, `/plan`, `/view-plan`, `/rename`, `/copy`, `/threads`, `/task`, `/tags`, and Capy-aware `/usage` and `/diff` flows.
- Ctrl-C now stops an active prompt and exits only while idle; Escape remains a cancellation shortcut.

### Capy

- Covered all 37 endpoints in the current published OpenAPI, including threads/messages, projects/tasks/diffs, tags, usage, setup/snapshots, write-only personal environment variables, browser snapshots, automations, and session verification.
- Corrected official request enums and shapes (`fast|standard` speed, string tag names, enumerated tag colors, ISO usage timestamps) and typed the corresponding response records.
- Added remote-history resume, thread participant/Slack metadata, pagination, and configurable thread defaults.

### Tooling and safety

- Hardened patch uniqueness, read-only Git boundaries, HTTP redirect allowlisting/output limits, and MCP tool-name mapping/collision cleanup.
- Fixed Windows CLI builds by replacing the Unix-only `chmod` step with Node's cross-platform file API.
- Added focused regression coverage; 159 tests pass (one POSIX-only case skipped on Windows), with typecheck, lint, and the bundled build clean.

## 0.7.0

Consolidated all state under `~/.kyokao/`. The workspace-local `.kyokao/` folder and `.kyokao.json` config are no longer read. All 134 tests pass; typecheck/lint/build clean. See [MIGRATION.md](MIGRATION.md) for the upgrade path.

### What moved to `~/.kyokao/`

- **Global config**: `~/.config/kyokao/config.json` (Unix) / `%APPDATA%/kyokao/` (Windows) → `~/.kyokao/config.json` (all platforms).
- **Sessions**: `<workspace>/.kyokao/sessions/` → `~/.kyokao/sessions/`. Sessions are now **global** — `kyokao session list` shows sessions from all workspaces. Each session records its origin workspace path (`workspace` field) for future filtering.
- **Memory**: `<workspace>/.kyokao/memory.json` → `~/.kyokao/memory.json`.
- **User instructions**: `<workspace>/.kyokao/instructions.md` / `soul.md` → `~/.kyokao/instructions.md` / `soul.md`.
- **Custom command templates**: `<workspace>/.kyokao/commands/` → `~/.kyokao/commands/`.

### What was removed

- **Workspace `.kyokao.json` config overrides** — no longer read. Use `~/.kyokao/config.json` or a profile for scoped settings.
- **Workspace `.kyokao/` folder** — gone entirely.

### What stays workspace-local

Repository-convention instruction files (`AGENTS.md`, `CLAUDE.md`, `SOUL.md`, `KYOKAO.md`) are still read from the workspace root.

### New `kyokaoHome()` helper + `KYOKAO_HOME` override

A single `kyokaoHome()` function in `@kyokao/config` resolves the home directory (`~/.kyokao/` by default), with a `KYOKAO_HOME` environment variable override for testing or non-standard layouts. This is the one chokepoint all state paths flow through.

### Legacy detection

`kyokao doctor` now detects pre-0.7.0 workspace state (`.kyokao/` folder or `.kyokao.json`) and prints a notice pointing to MIGRATION.md. No auto-migration — hard-cut for the pre-1.0 audience.

## 0.6.1

Command-surface redesign: the flat ~21-command tree is reorganized into noun-verb groups with sectioned `--help`, the inline agent-verb loop is replaced with a configurable template loader, and renamed/removed commands stay available as hidden aliases for back-compat. All 134 tests pass; typecheck/lint/build clean.

### Restructured command tree (grouped `--help`)

- Custom Commander help formatter (`packages/cli/src/help.ts`) renders commands under section headers: Interactive, Agent-assisted, Configuration, Sessions & memory, Providers & themes, Listings, Diagnostics, Integration.
- New noun-verb groups: `session list` / `session resume <id> [prompt...]`, `memory list/set/delete` (plus bare `memory` now lists), `provider use/list`, `theme save/list`, `config show/path/export`.
- `setup` promoted to a top-level verb (was buried at `config setup`).
- `run [prompt...]` added as an explicit headless entry point.
- `models --known` absorbs the old `catalog` command.

### Configurable agent-assisted templates

- `commit`, `review`, `test`, `explain` are now backed by prompt templates with `{{args}}`, `{{flags.<name>}}`, `{{#flags.x}}…{{/flags.x}}`, and `{{passthrough}}` placeholders.
- `commit` gains `-m, --message <m>` and `--no-verify`; `review` gains `-b, --base <ref>`; `test` accepts `-- <test-args>` passthrough.
- Drop a `.md` file in `<workspace>/.kyokao/commands/` (or `~/.kyokao/commands/`) to override a built-in or add a new verb (first line = description, body = prompt).

### Hidden back-compat aliases

`chat` → `tui`, `catalog` → `models --known`, `sessions` → `session list`, `resume <id> <prompt...>` → `session resume`, `config setup` → `setup`, bare `memory` → `memory list`. Old scripts and muscle memory keep working; the aliases are hidden from `--help`.

### Other changes

- `session resume <id>` now accepts an optional prompt (was required), matching TUI `/resume` arity.
- Every command and subcommand has a description (several were missing: `config show`, `config path`, `memory list/set/delete`).
- Command registrations extracted to `packages/cli/src/commands.ts` (~500 lines) with dependency injection, shrinking `index.ts` from 1163 → ~900 lines and making the tree testable.
- 14 new tests cover template rendering, flag/passthrough substitution, and user-override loading.

## 0.6.0

Modernization pass: four verified bugs fixed, the provider surface unified, the CLI controller made testable, and three new integration modes added. Typecheck, lint, and the full test suite (120 tests) pass; the bundled CLI builds cleanly.

### Bug fixes

- **Fallback model downgrade is no longer permanent.** A successful `chat()` now resets the fallback index, so a single transient 5xx on the primary no longer downgrades the entire session. (`packages/providers/src/index.ts`)
- **`validateModel` no longer hard-fails on an unavailable fallback.** Missing fallbacks now emit a warning instead of blocking startup, preserving the resilience the fallback list exists to provide.
- **MCP servers now have timeouts.** `McpClient` enforces a per-server `startTimeoutMs` (default 10s) on the initialize handshake and a per-request `requestTimeoutMs` (default 30s) on each JSON-RPC call; both are overridable via `McpServerConfig`. A misbehaving server can no longer hang startup or a tool call indefinitely. New typed errors: `McpStartupTimeoutError`, `McpRequestTimeoutError`.
- **Context compression now persists across iterations.** The agent's working message set is reassigned to the compacted array when compression fires, so subsequent iterations benefit from the smaller transcript instead of recomputing from a history that grows unbounded.

### Architecture

- **Unified `Provider` interface.** `OpenAICompatibleProvider` and the new `CapyProviderAdapter` both implement a common `Provider` surface (`baseURL`, `models`, `validateModel`, `chat`). The CLI's `runtime` now exposes a single `provider: Provider` for both backends; the `r.capy`/`r.provider` branching is gone from the doctor/models/status sites.
- **Extracted `packages/cli/src/runtime.ts`.** The `Runtime` type, `buildRuntime`, `createBackend`, and `runPrompt` are now a testable module separate from the 1,200-line TUI controller, and take the merged config plus a `skipModelCheck` flag explicitly rather than reading the commander global.

### New features

- **Headless output formats** (`--output-format plain|json|streaming-json`). `streaming-json` emits one NDJSON line per backend event for bots and scripts; `json` emits a single aggregated object at the end. Explicit format wins; otherwise plain in a TTY and streaming-json when piped. See `packages/cli/src/headless.ts`.
- **Sub-agents** (`--subagents`, off by default). Exposes a `spawn_subagent` tool that delegates scoped sub-tasks to a fresh isolated agent with a read-only tool grant by default; write/shell/http access requires explicit per-spawn opt-in. Sub-agent cost is bounded by the parent's remaining budget. See `packages/agent/src/subagent.ts`.
- **Agent Client protocol** (`kyokao agent-client`). A JSON-RPC 2.0 over stdio NDJSON protocol that wraps any `PromptBackend` for IDE/bot integration: `initialize` → `session/start` → `turn/run` streams `item/assistant`, `item/tool`, `item/toolResult`, `item/usage`, `item/status` notifications and ends with `turn/completed`; `turn/interrupt` cancels in flight. See `packages/agent/src/agent-client.ts`.

### Tests

- 29 new tests covering all four bug fixes, the Provider interface conformance, headless output formats, sub-agent tool-subset restriction and budget enforcement, and the Agent Client protocol lifecycle.
- 120 tests total pass (1 skipped on Windows); typecheck and lint are clean.

## 0.5.5

- Fixed Windows `EPERM` crashes while replacing existing session files by retrying through a safe copy fallback, cleaning temporary files, and keeping the prompt scheduler alive when autosave fails.

## 0.5.4

- Reused saved or environment provider credentials when selecting providers; API-token entry now opens only when credentials are missing or the explicit `/provider key` action is selected.
- Made Escape cancel an active model request while Ctrl-C exits the interactive workspace.

## 0.5.3

- Added composer pickers for command help, live provider models, resumable sessions, and memory deletion; refreshed session/model choices as runtime state changes and tightened invalid memory/queue command handling.

## 0.5.2

- Simplified provider drop-up rows to provider names and added masked in-composer API-token entry with atomic credential persistence, cancellation, and session-preserving credential rotation.

## 0.5.1

- Removed the `You` and `Kyokao` transcript headers while retaining semantic colors, spacing, tool labels, and lossless wrapping.

## 0.5.0

- Added immutable, workspace-scoped TUI and code theme registries with eight TUI themes, seven code themes, ANSI 16/256/truecolor negotiation, `NO_COLOR`, configuration/CLI precedence, live `/theme` switching, atomic theme persistence, and `kyokao themes` previews.
- Added streaming-safe Markdown rendering and deterministic language-aware highlighting for TypeScript/JavaScript, Python, JSON, shell, Go, Rust, Java/C/C++, HTML/XML, CSS, YAML, SQL, Markdown, and diff.
- Fixed ANSI/Unicode transcript geometry with lossless word-aware wrapping and hard-wrap fallback at narrow Windows terminal widths.
- Added a bounded coding completion guard that continues clearly unfinished future-intent responses through repository mutation and verification without forcing tools for explanation-only prompts.

## 0.4.0

- Added a production prompt scheduler: the composer remains editable during work, Enter replaces the active turn, Ctrl-Enter queues FIFO follow-ups, and `/queue` exposes retryable pending work.
- Added native Capy remote-agent support with dynamic Captain model/project setup, remote thread continuation and resume, bounded polling, cancellation, status, task, and PR reporting.
- Added Shift-Enter keyboard protocol support, atomic interrupted-session/queue checkpoints, backend lifecycle isolation, and race/fake-server/PTY coverage.

## 0.3.2

- Moved interactive session resume guidance out of the transcript and into the restored shell after exit.
- Moved cumulative token and estimated cost usage into a right-aligned footer that adapts to terminal width.
- Combined workspace status and input into one status-labeled composer border so editable text remains visibly inside the active box.

## 0.3.1

- Fixed interactive setup and workspace screen ownership so real terminals use one balanced alternate-screen session and restore the previous shell display on every exit path.
- Anchored the transcript, status, slash palette, bordered composer, and footer to the terminal height with Unicode-aware sizing and resize cleanup.
- Added a cursor-based multiline editor with navigation, deletion, prompt history, slash completion, and bracketed-paste support.

## 0.3.0

- Added the full-screen first-run provider, model, and approval setup flow.
- Added `kyokao config setup` for safely re-running provider setup.

## 0.2.0

- Added the interactive terminal workspace, command palette, streamed activity transcript, and local session controls.
- Added npm trusted-publishing automation for published GitHub Releases.

## 0.1.0

- Initial production MVP.
