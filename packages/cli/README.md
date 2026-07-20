# Kyokao

Kyokao is a local-first TypeScript coding-agent CLI. It sends prompts and tool definitions to an OpenAI-compatible chat-completions API, then performs a bounded tool-call loop in the directory where it is run. Its tool surface is intentionally small and file paths are constrained to that workspace.

It is a local command-line application with a full-screen terminal interface. Review generated changes before keeping or committing them.

## Contents

- [Features](#features)
- [Requirements and installation](#requirements-and-installation)
- [Quickstart](#quickstart)
- [CLI reference](#cli-reference)
- [Providers](#providers)
- [Configuration](#configuration)
- [Approvals and safety](#approvals-and-safety)
- [Sessions, memory, and workflows](#sessions-memory-and-workflows)
- [Development and verification](#development-and-verification)
- [Architecture](#architecture)
- [Security and local data](#security-and-local-data)
- [Troubleshooting](#troubleshooting)
- [Contributing and license](#contributing-and-license)

## Features

- OpenAI-compatible provider client with streaming enabled by default for normal CLI runs.
- Built-in presets for hosted and local endpoints; custom OpenAI-compatible endpoints are supported.
- One-shot prompts, piped prompts, and a persistent full-screen interactive session by default.
- Bare `kyokao`, `kyokao chat`, and `kyokao tui` open the same interactive terminal workspace in a TTY.
- Permission modes for file mutations and shell commands.
- Configurable editor launching, repository instruction files, model sampling/fallback controls, and enforceable per-run safety budgets.
- Workspace-scoped file, search, shell, read-only Git, and HTTP GET tools.
- MCP stdio servers and JavaScript ESM plugins can add tools to the same permissioned loop.
- Local JSON sessions that can be listed and resumed, plus a manual key/value memory store.
- Context compression, token/cost estimates, model capability catalog, availability validation, configuration layers, named profiles, model aliases, redacted config inspection/export, and setup diagnostics.

## Requirements and installation

Kyokao requires **Node.js 20 or later** and **Git**. Building from source uses the repository-pinned package manager, **pnpm 10.31.0**. A global installed package only needs Node.js 20 or later at runtime.

### Build and run from source

```bash
git clone https://github.com/kiyosh11/maybetest.git kyokao
cd kyokao
corepack enable
pnpm install --frozen-lockfile
pnpm build
export OPENAI_API_KEY='replace-with-your-key'
pnpm --filter kyokao start "inspect this repository"
```

PowerShell:

```powershell
git clone https://github.com/kiyosh11/maybetest.git kyokao
Set-Location kyokao
corepack enable
pnpm install --frozen-lockfile
pnpm build
$env:OPENAI_API_KEY = 'replace-with-your-key'
pnpm --filter kyokao start "inspect this repository"
```

`pnpm kyokao "..."` is the equivalent root-script shortcut. Run commands from the repository or project directory you want the agent to treat as its workspace.

### Create and install the standalone package

The CLI package is bundled during its build. Packing also copies the root README and license into `packages/cli`.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter kyokao pack
npm install -g ./kyokao-0.3.0.tgz
kyokao --help
```

The version in the tarball name follows `packages/cli/package.json`; use the actual filename that `pack` prints if it changes. To update a global local-tarball installation, rebuild, pack, and run the same `npm install -g ./<tarball>.tgz` command. To remove it:

```bash
npm uninstall -g kyokao
```

PowerShell uses the same `npm` commands:

```powershell
pnpm --filter kyokao pack
npm install -g .\kyokao-0.3.0.tgz
npm uninstall -g kyokao
```

## Quickstart

Set an API key only in your shell or a secret manager; do not commit it to `.kyokao.json`.

```bash
export OPENAI_API_KEY='replace-with-your-key'
kyokao "explain the repository structure"
```

A prompt is a one-shot run. Piped standard input is also used as a one-shot prompt:

```bash
printf '%s\n' 'run the relevant tests and report failures' | kyokao
```

For a persistent interactive session, run bare `kyokao`, `kyokao chat`, or `kyokao tui` in a TTY. If no provider is configured, Kyokao first opens its full-screen setup flow. It uses a selectable provider list (Up/Down or `j`/`k`, then Enter), supports local presets and custom OpenAI-compatible endpoints, and moves directly into the workspace after saving. Escape goes back; Ctrl-C cancels and restores the terminal.

```text
 _  ___   _____  _  __   _    ___
| |/ / | |/ _ \| |/ /  /_\  / _ \
| ' <| |_| | (_) | ' <  / _ \| (_) |
|_|\_\___/ \___/|_|\_\/_/ \_\___/

Choose a provider
› ollama — Local server at http://localhost:11434/v1
  openai — Hosted API (OPENAI_API_KEY)
```

Hosted API-key input is masked. A present preset environment variable is reported as `environment` and is never copied into the config; local Ollama, LM Studio, and vLLM presets do not require a key. The review screen shows only a key source (`environment`, `saved`, or `not configured`), not key contents. Setup writes the selected provider, model, and approval mode to `~/.config/kyokao/config.json` on Linux (or the platform config location), preserving unrelated global settings. A manually entered key is stored locally with mode `0600`; prefer an environment variable when feasible. Re-run the flow with `kyokao config setup`.

```bash
kyokao
# setup: Up/Down or j/k select, Enter continues, Escape goes back, Ctrl-C cancels
# workspace: Enter submits; Alt-Enter inserts a newline where the terminal supports it
# type / to filter commands, then use Up/Down and Enter
```

The workspace keeps one local session until `/new`. It streams provider output, tool activity, and tool results into the transcript. It only shows token and cost estimates returned or calculated by the existing agent; it does not claim hidden reasoning or exact provider billing.

| Slash command                                         | Purpose                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/help [command]`                                     | Show command help and argument syntax.                                                                                                                 |
| `/new`, `/clear`, `/exit`                             | Start a new session, clear visible output, or leave the workspace.                                                                                     |
| `/sessions`, `/resume <id>`                           | List or resume local sessions.                                                                                                                         |
| `/model [id]`, `/provider [name]`, `/approval [mode]` | Inspect or change the active runtime setting. Provider/model changes apply to later requests; approval accepts `suggest`, `auto-edit`, or `full-auto`. |
| `/memory [list\|set <key> <value>\|delete <key>]`     | Inspect or manage local memory.                                                                                                                        |
| `/doctor`, `/diff`                                    | Run setup diagnostics or show the workspace diff.                                                                                                      |

Unknown slash commands are rejected locally and are never sent to the model. One-shot prompts and piped standard input remain script-friendly and do not start the workspace.

From source, replace `kyokao` in the examples with `pnpm --filter kyokao start`:

```bash
pnpm --filter kyokao start chat
pnpm --filter kyokao start -p groq -m llama-3.3-70b-versatile "inspect this repository"
```

## CLI reference

`kyokao --help` is the installed CLI’s authoritative command list. The global options are:

| Option                   | Meaning                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `-m, --model <id>`       | Model ID or configured alias.                                                                          |
| `-p, --provider <name>`  | Built-in preset or configured provider name.                                                           |
| `--base-url <url>`       | Override the selected provider base URL for this invocation.                                           |
| `--api-key <key>`        | Override the API key for this invocation; it is not persisted. Avoid putting secrets in shell history. |
| `--approval <mode>`      | `suggest`, `auto-edit`, or `full-auto`.                                                                |
| `--profile <name>`       | Select a configuration profile.                                                                        |
| `--max-iterations <n>`   | Agent loop limit; an integer from 1 through 100.                                                       |
| `--temperature <n>`      | Sampling temperature from 0 through 2.                                                                 |
| `--max-tokens <n>`       | Maximum completion tokens.                                                                             |
| `--top-p <n>`            | Nucleus sampling probability from greater than 0 through 1.                                            |
| `--fallback-model <ids>` | Comma-separated model IDs to try after a provider failure.                                             |
| `--editor <command>`     | Editor command for this invocation.                                                                    |
| `--max-cost <usd>`       | Stop after the estimated run cost reaches this amount; 0 means unlimited.                              |
| `-V, --version`          | Print the CLI version.                                                                                 |
| `-h, --help`             | Print help.                                                                                            |

The default invocation accepts `[prompt...]`: with words it runs them as one prompt; without words it starts the terminal workspace in a TTY, or reads all piped standard input otherwise. `chat` is a compatibility alias for that workspace.

| Command                    | What it does                                                                                               | Example                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `chat`                     | Starts the interactive terminal workspace.                                                                 | `kyokao chat`                                                   |
| `tui`                      | Starts the interactive terminal workspace.                                                                 | `kyokao tui`                                                    |
| `models`                   | Requests `/models` from the selected provider and prints returned IDs.                                     | `kyokao -p openrouter models`                                   |
| `catalog`                  | Prints known context, pricing, and tool-capability metadata.                                               | `kyokao catalog`                                                |
| `usage [id]`               | Prints saved token, cost, and compression usage for one or all sessions.                                   | `kyokao usage`                                                  |
| `plugins`                  | Lists configured JavaScript/TypeScript plugin modules.                                                     | `kyokao plugins`                                                |
| `mcp`                      | Lists configured MCP stdio servers.                                                                        | `kyokao mcp`                                                    |
| `edit <path>`              | Opens a workspace file in the configured editor.                                                           | `kyokao edit src/index.ts`                                      |
| `providers`                | Prints built-in preset names and base URLs.                                                                | `kyokao providers`                                              |
| `config setup`             | Re-runs the interactive provider, model, and approval setup flow.                                          | `kyokao config setup`                                           |
| `config show`              | Prints the resolved non-profile config with key/token/secret/password fields redacted.                     | `kyokao config show`                                            |
| `config path`              | Prints the global config path.                                                                             | `kyokao config path`                                            |
| `config export <file>`     | Atomically writes a redacted resolved non-profile config.                                                  | `kyokao config export /tmp/kyokao-config.json`                  |
| `sessions`                 | Lists local sessions for the current workspace.                                                            | `kyokao sessions`                                               |
| `resume <id> <prompt...>`  | Adds a follow-up to a saved session.                                                                       | `kyokao resume 123e4567-e89b-12d3-a456-426614174000 "continue"` |
| `memory list`              | Prints the workspace’s manual memory object.                                                               | `kyokao memory list`                                            |
| `memory set <key> <value>` | Stores a string value in manual local memory.                                                              | `kyokao memory set convention "use pnpm"`                       |
| `memory delete <key>`      | Deletes a manual memory key.                                                                               | `kyokao memory delete convention`                               |
| `doctor`                   | Prints Node version, workspace, provider URL, credential presence, sandbox status, and model availability. | `kyokao doctor`                                                 |
| `diff`                     | Displays the working-tree diff through the read-only Git tool.                                             | `kyokao diff`                                                   |
| `commit [prompt...]`       | Asks the agent to review, test, then create a commit if ready.                                             | `kyokao commit "include the README"`                            |
| `explain [prompt...]`      | Asks the agent to explain repository structure and relevant implementation.                                | `kyokao explain "focus on config"`                              |
| `test [prompt...]`         | Asks the agent to run relevant tests and safely diagnose/fix failures.                                     | `kyokao test`                                                   |
| `review [prompt...]`       | Asks the agent to review current changes for bugs, security risks, and missing tests.                      | `kyokao review "focus on changed files"`                        |

`commit`, `test`, and `review` are prompts to the agent, not dedicated Git or test engines. Their ability to change files or run commands depends on the selected approval mode.

## Providers

A preset supplies only a base URL and an API-key environment-variable name. Before a chat request Kyokao asks the selected endpoint for `/models` and refuses unavailable IDs; use `--skip-model-check` only for an endpoint that intentionally does not expose model discovery. `kyokao catalog` shows local capability and pricing metadata, while `kyokao -p <preset> models` shows the endpoint’s live IDs.

| Preset       | Base URL                                | API-key environment variable | Example model string                      |
| ------------ | --------------------------------------- | ---------------------------- | ----------------------------------------- |
| `openai`     | `https://api.openai.com/v1`             | `OPENAI_API_KEY`             | `gpt-4o-mini`                             |
| `openrouter` | `https://openrouter.ai/api/v1`          | `OPENROUTER_API_KEY`         | `openai/gpt-4o-mini`                      |
| `groq`       | `https://api.groq.com/openai/v1`        | `GROQ_API_KEY`               | `llama-3.3-70b-versatile`                 |
| `nvidia`     | `https://integrate.api.nvidia.com/v1`   | `NVIDIA_API_KEY`             | `meta/llama-3.1-70b-instruct`             |
| `together`   | `https://api.together.xyz/v1`           | `TOGETHER_API_KEY`           | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| `deepinfra`  | `https://api.deepinfra.com/v1/openai`   | `DEEPINFRA_API_KEY`          | provider-controlled ID                    |
| `fireworks`  | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY`          | provider-controlled ID                    |
| `cerebras`   | `https://api.cerebras.ai/v1`            | `CEREBRAS_API_KEY`           | provider-controlled ID                    |
| `sambanova`  | `https://api.sambanova.ai/v1`           | `SAMBANOVA_API_KEY`          | provider-controlled ID                    |
| `xai`        | `https://api.x.ai/v1`                   | `XAI_API_KEY`                | `grok-2-latest`                           |
| `mistral`    | `https://api.mistral.ai/v1`             | `MISTRAL_API_KEY`            | `mistral-small-latest`                    |
| `ollama`     | `http://localhost:11434/v1`             | `OLLAMA_API_KEY`             | `llama3.2`                                |
| `lmstudio`   | `http://localhost:1234/v1`              | `LMSTUDIO_API_KEY`           | local server model ID                     |
| `vllm`       | `http://localhost:8000/v1`              | `VLLM_API_KEY`               | served model ID                           |

The example strings are passed through unchanged; they are not a claim that a provider currently serves them.

### Provider command examples

These examples use the preset URLs exactly as implemented. Substitute a model ID accepted by the service, and use a key only where that endpoint requires one.

```bash
export OPENAI_API_KEY='replace-with-your-key'
kyokao -p openai -m gpt-4o-mini "explain this project"

export OPENROUTER_API_KEY='replace-with-your-key'
kyokao -p openrouter -m openai/gpt-4o-mini "explain this project"

export GROQ_API_KEY='replace-with-your-key'
kyokao -p groq -m llama-3.3-70b-versatile "explain this project"

export NVIDIA_API_KEY='replace-with-your-key'
kyokao -p nvidia -m meta/llama-3.1-70b-instruct "explain this project"

export MISTRAL_API_KEY='replace-with-your-key'
kyokao -p mistral -m mistral-small-latest "explain this project"

export XAI_API_KEY='replace-with-your-key'
kyokao -p xai -m grok-2-latest "explain this project"

export TOGETHER_API_KEY='replace-with-your-key'
kyokao -p together -m meta-llama/Llama-3.3-70B-Instruct-Turbo "explain this project"

kyokao -p ollama -m llama3.2 "explain this project"
kyokao -p lmstudio -m your-loaded-model "explain this project"
kyokao -p vllm -m your-served-model "explain this project"
```

PowerShell environment assignment syntax differs:

```powershell
$env:OPENAI_API_KEY = 'replace-with-your-key'
kyokao -p openai -m gpt-4o-mini "explain this project"

$env:OLLAMA_API_KEY = 'optional-if-your-local-server-requires-it'
kyokao -p ollama -m llama3.2 "explain this project"
```

## Configuration

Kyokao reads JSON only. Configuration is resolved in this order, with later defined values taking precedence:

1. Built-in defaults: `openai`, `gpt-4o-mini`, `auto-edit`, 12 iterations, a 16,000-token context budget, and compression at 80% of that budget.
2. Global configuration.
3. Project `.kyokao.json` in the current working directory.
4. The selected profile, if `--profile <name>` names an existing profile.
5. Environment: `KYOKAO_PROVIDER`, `KYOKAO_MODEL`, `KYOKAO_APPROVAL`, `KYOKAO_MAX_ITERATIONS`, `KYOKAO_EDITOR`, `KYOKAO_TEMPERATURE`, `KYOKAO_MAX_TOKENS`, `KYOKAO_TOP_P`, and `KYOKAO_FALLBACK_MODELS`.
6. CLI options, including `--context-window`, model sampling flags, editor selection, and safety limits.

Global configuration paths are:

| Platform    | Path                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Linux/macOS | `$XDG_CONFIG_HOME/kyokao/config.json`, or `$HOME/.config/kyokao/config.json` when `XDG_CONFIG_HOME` is unset |
| Windows     | `%APPDATA%\\kyokao\\config.json`, or `%USERPROFILE%\\kyokao\\config.json` when `APPDATA` is unset            |
| Project     | `./.kyokao.json`                                                                                             |

Use `kyokao config path` to print the active platform global path. The application does not create a config file automatically.

### Schema and examples

The supported top-level keys are `provider`, `model`, `approval`, `maxIterations`, `profiles`, `providers`, `aliases`, `mcp`, `plugins`, `contextWindow`, `compressionThreshold`, `temperature`, `maxTokens`, `topP`, `fallbackModels`, `editor`, `editorArgs`, and `limits`. `approval` must be `suggest`, `auto-edit`, or `full-auto`; `maxIterations` must be an integer from 1 to 100. `contextWindow` must be at least 1000, and `compressionThreshold` must be between 0 and 1. Provider entries can override `baseURL`, `apiKey`, `model`, `temperature`, `maxTokens`, `topP`, and `fallbackModels`. Alias values and plugin paths are strings.

A project configuration without secrets:

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "approval": "auto-edit",
  "maxIterations": 12,
  "contextWindow": 16000,
  "compressionThreshold": 0.8,
  "temperature": 0.2,
  "maxTokens": 2000,
  "fallbackModels": ["gpt-4o"],
  "editor": "code",
  "editorArgs": ["--wait"],
  "limits": {
    "maxToolCalls": 100,
    "maxShellTimeoutMs": 120000,
    "maxOutputChars": 30000,
    "maxFileBytes": 2000000,
    "maxCostUsd": 5,
    "allowedHosts": ["api.example.com"]
  },
  "aliases": {
    "fast": "gpt-4o-mini"
  },
  "profiles": {
    "review": {
      "approval": "suggest",
      "maxIterations": 6
    }
  }
}
```

Use an alias with `-m fast` and a profile with `--profile review`. Profiles can also contain the same supported keys, including their own `providers` and `aliases`; selected profile values are merged after global and project configuration, before environment and CLI overrides.

### Custom OpenAI-compatible provider

Register the endpoint name and URL in global or project configuration. Do **not** add an `apiKey` to a shared project file.

```json
{
  "provider": "acme",
  "providers": {
    "acme": {
      "baseURL": "https://api.example.test/v1",
      "model": "acme-code-model"
    }
  }
}
```

Custom provider names have no dedicated environment-variable mapping. Keep the secret in an environment variable and pass it for the invocation, including the base URL. Passing both is important because a CLI provider override replaces that provider’s config entry for the invocation.

```bash
export ACME_API_KEY='replace-with-your-key'
kyokao -p acme \
  --base-url 'https://api.example.test/v1' \
  --api-key "$ACME_API_KEY" \
  -m acme-code-model \
  "inspect this repository"
```

PowerShell:

```powershell
$env:ACME_API_KEY = 'replace-with-your-key'
kyokao -p acme --base-url 'https://api.example.test/v1' --api-key $env:ACME_API_KEY -m acme-code-model "inspect this repository"
```

`--api-key` is never written by Kyokao. It can still be exposed by shell history or process inspection depending on the operating system, so prefer a shell/session with appropriate secret-handling controls. `config show` and `config export` redact field names containing `key`, `token`, `secret`, or `password`.

### Plugins and MCP

Plugins are JavaScript ESM modules listed in `plugins`. Each module exports a default object with a `name`, `tools` array using OpenAI function-tool definitions, and an async `execute(name, args)` function that returns `{ content, isError? }`. Relative paths resolve from the workspace.

MCP servers use the stdio transport and are configured under `mcp`:

```json
{
  "plugins": ["./.kyokao/plugins/linear.mjs"],
  "mcp": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    }
  }
}
```

MCP tools are namespaced as `mcp_<server>_<tool>` before they reach the model. Server processes inherit the current environment plus configured `env` values and are terminated when the CLI exits.

### Editor and repository instructions

`edit <path>` uses `editor`, then `VISUAL`, then `EDITOR`, and finally `vi` (or `notepad` on Windows). `editorArgs` are appended to the command; include `{file}` when the editor needs the file in a specific argument position, otherwise Kyokao appends it.

At startup Kyokao loads instruction files from the workspace root in this order: `SOUL.md`, `CLAUDE.md`, `AGENTS.md`, `KYOKAO.md`, and `.kyokao/instructions.md` or `.kyokao/soul.md`. Case variants are accepted and duplicate names are loaded once. Their content is bounded before it is added to the system prompt, while the session transcript remains unchanged.

## Approvals and safety

Approval applies to the two file-mutation tools and the shell tool:

| Mode                  | `write_file` / `apply_patch` | `shell`              |
| --------------------- | ---------------------------- | -------------------- |
| `suggest`             | Prompt every action          | Prompt every action  |
| `auto-edit` (default) | Allow without prompt         | Prompt every action  |
| `full-auto`           | Allow without prompt         | Allow without prompt |

A prompt accepts `y` or `yes`; any other response denies the action. In a non-interactive standard input session, prompted actions are denied. Read/search tools, read-only Git subcommands, and HTTP GET do not ask for approval.

`git` only permits the `status`, `diff`, `log`, `show`, and `branch` subcommands through its dedicated tool. A model can request a shell command such as `git commit`; that command is still subject to the shell approval rule above. `http_get` accepts only `http:` and `https:` URLs.

The `limits` object adds hard runtime ceilings: tool calls per run, shell timeout, tool output size, file read/write size, estimated cost, and an optional HTTP host allowlist. `maxCostUsd: 0` disables the cost ceiling; an empty `allowedHosts` list preserves unrestricted HTTP(S) access. Plugin and MCP code is trusted extension code, but its returned output is still bounded before it enters model context.

## Sessions, memory, and workflows

Each workspace stores state under `./.kyokao/`:

- `sessions/<uuid>.json` contains the task, timestamps, transcript, most recent checkpoint, context summary, and token/cost usage.
- `memory.json` contains the manual string key/value store used by `memory` commands.

List and resume sessions from the same workspace:

```bash
kyokao sessions
kyokao resume 123e4567-e89b-12d3-a456-426614174000 "continue from the last checkpoint"
```

Sessions are saved after completed tool-call iterations and when a run completes. Once a request approaches the configured context budget, older transcript turns are replaced in the provider request by a bounded local summary while the full transcript remains on disk. Provider-reported usage is preferred; endpoints without usage fields receive a local token estimate. `Ctrl+C` aborts the active request; the CLI reports that the last completed tool checkpoint remains saved. The `memory` store is local data management only: this implementation does not automatically inject memory into agent prompts.

Useful review workflows:

```bash
kyokao doctor
kyokao diff
kyokao explain "focus on packages/config"
kyokao test "run the relevant checks"
kyokao review "focus on security and tests"
kyokao commit "commit only if the working tree is ready"
```

## Development and verification

Repository scripts:

| Command             | Check                                                         |
| ------------------- | ------------------------------------------------------------- |
| `pnpm format`       | Checks formatting with Prettier.                              |
| `pnpm format:write` | Rewrites formatting with Prettier.                            |
| `pnpm lint`         | Runs ESLint.                                                  |
| `pnpm typecheck`    | Type-checks every workspace package.                          |
| `pnpm test`         | Runs Vitest once.                                             |
| `pnpm build`        | Builds every workspace package.                               |
| `pnpm kyokao "..."` | Runs the CLI source entry point through its workspace script. |

Run the full local gate used by CI:

```bash
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI runs that gate on Node 20 and 22 across Ubuntu, macOS, and Windows.

### Publish standalone CLI binaries

Push a tag matching the CLI package version to build a GitHub Release:

```bash
git tag v0.3.0
git push origin v0.3.0
```

The release workflow verifies the tag against `packages/cli/package.json`, runs the full test gate, and publishes self-contained Linux x64, macOS x64/ARM64, and Windows x64 archives with SHA-256 checksums. These binaries do not require Node.js on the target machine.

### Verify a release tarball without changing global npm state

```bash
pnpm build
pnpm --filter kyokao pack
TARBALL=kyokao-0.3.0.tgz
PREFIX="$(mktemp -d)"
npm install --prefix "$PREFIX" "$TARBALL"
"$PREFIX/node_modules/.bin/kyokao" --help
rm -rf "$PREFIX"
```

Use the tarball filename output by `pack` if the version differs. PowerShell:

```powershell
pnpm build
pnpm --filter kyokao pack
$tarball = '.\kyokao-0.3.0.tgz'
$prefix = Join-Path $env:TEMP ('kyokao-npm-' + [guid]::NewGuid())
npm install --prefix $prefix $tarball
& (Join-Path $prefix 'node_modules\.bin\kyokao.cmd') --help
Remove-Item -Recurse -Force $prefix
```

## Architecture

| Package             | Responsibility                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@kyokao/config`    | Defaults, JSON validation/loading/merging, provider presets, redaction, and atomic config writes.            |
| `@kyokao/providers` | OpenAI SDK-compatible chat/model client, usage accounting, model catalog, and wire mapping.                  |
| `@kyokao/tools`     | Workspace sandbox, core tools, plugins, MCP stdio clients, and tool composition.                             |
| `@kyokao/memory`    | Local session, usage, context-summary, and manual-memory JSON persistence.                                   |
| `@kyokao/agent`     | System prompt, retries, context compression, token/cost accounting, bounded tool-call loop, and checkpoints. |
| `@kyokao/ui`        | Colored output, syntax highlighting, approval prompts, and full-screen terminal rendering.                   |
| `kyokao`            | Commander CLI wiring, commands, and runtime construction.                                                    |

For an agent run, the CLI resolves configuration and provider settings, validates the selected model against `/models`, starts configured plugins and MCP servers, creates a workspace sandbox and local store, then sends a system prompt, compacted transcript, and user prompt to the provider. The provider response may stream text and function calls. For each returned call, the agent executes the matching core, plugin, or MCP tool, appends a tool-result message, records usage, saves a checkpoint, and calls the provider again. It stops when no tool calls remain or errors after the configured iteration limit. Transient provider failures are retried up to two times with short exponential backoff; aborts and messages matching certain client/configuration error patterns are not retried.

Core tools are `read_file`, `list_files`, `glob`, `grep`, `write_file`, `apply_patch`, `shell`, read-only `git`, and `http_get`. Directory listings omit `.git`, `node_modules`, and `dist`; listing depth is capped at 5 and output is bounded. Shell commands run in the workspace with a requested timeout clamped between 1 second and 2 minutes.

## Security and local data

- File tool paths are resolved against the current workspace and reject traversal, NUL bytes, and resolved symlinks that leave it. This is not a complete defense against filesystem races or all platform-specific filesystem behavior.
- The shell tool intentionally executes arbitrary commands **in the workspace** when approved or in `full-auto`. Treat `full-auto` as high trust.
- The sandbox does not isolate processes, network access, credentials available to subprocesses, or side effects of an approved command. It is a path/permission boundary, not a container or VM.
- Provider requests include prompts, transcripts, tool definitions, and tool results. Use a provider and API key policy appropriate for the repository’s data.
- Session, memory, and atomic config writes use owner-only file mode `0600` where supported, but existing directory permissions and platform semantics still matter.
- API keys are sourced from preset environment variables, an optional config provider `apiKey`, or `--api-key`. Prefer environment variables or a secret manager. Never commit keys.

## Troubleshooting

| Symptom                                                              | Check                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credentials: missing` in `doctor` or provider authentication errors | Export the preset’s exact API-key variable from the provider table, or pass `--api-key` for this invocation. `doctor` reports presence, not validity.                                                                               |
| `Provider baseURL is required`                                       | Select a built-in preset or configure/pass a custom provider `baseURL`. OpenAI-compatible endpoints normally need the `/v1` path because Kyokao appends `/chat/completions` and `/models`.                                          |
| `Model listing failed: ...`                                          | `models` calls the selected server’s `/models`; verify credentials, URL, and whether the server implements that endpoint. You can still supply a model string directly because the CLI does not require a successful model listing. |
| Local Ollama, LM Studio, or vLLM connection fails                    | Start the local server, confirm its port (`11434`, `1234`, or `8000` for the presets), verify its OpenAI-compatible `/v1` endpoint, and use the model ID it has loaded/serves.                                                      |
| `Invalid config ...`                                                 | Ensure JSON is valid; top-level sections are objects, provider fields and aliases are strings, approval is one of the three modes, and `maxIterations` is an integer 1–100.                                                         |
| `Unknown provider: ...`                                              | Use `kyokao providers` for presets, or add a matching name under `providers` in config.                                                                                                                                             |
| A request is denied unexpectedly                                     | In `suggest`, every mutation and shell command needs a TTY confirmation. In `auto-edit`, shell still needs confirmation. Piped/non-TTY input denies prompted actions.                                                               |
| Windows shell behavior differs                                       | Shell tool calls use `cmd.exe` (or `ComSpec`) on Windows and `/bin/sh` elsewhere. Use PowerShell only for your own invocation/setup commands; agent shell commands are not PowerShell commands by default.                          |
| A run was interrupted                                                | Run `kyokao sessions`, then `kyokao resume <id> "..."` from the same workspace. Only the last completed checkpoint is guaranteed to have been saved.                                                                                |

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for the required local checks. Kyokao is licensed under the [ISC License](LICENSE).
