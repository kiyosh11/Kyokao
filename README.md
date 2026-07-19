# Kyokao

Kyokao is a local-first TypeScript coding-agent CLI. It sends prompts and tool definitions to an OpenAI-compatible chat-completions API, then performs a bounded tool-call loop in the directory where it is run. Its tool surface is intentionally small and file paths are constrained to that workspace.

It is an early, command-line-oriented implementation—not a hosted service or a full-screen terminal application. Review generated changes before keeping or committing them.

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
- [Limitations](#limitations)
- [Contributing and license](#contributing-and-license)

## Features

- OpenAI-compatible provider client with streaming enabled by default for normal CLI runs.
- Built-in presets for hosted and local endpoints; custom OpenAI-compatible endpoints are supported.
- One-shot prompts, piped prompts, and a simple persistent interactive `chat` loop.
- Permission modes for file mutations and shell commands.
- Workspace-scoped file, search, shell, read-only Git, and HTTP GET tools.
- Local JSON sessions that can be listed and resumed, plus a manual key/value memory store.
- Configuration layers, named profiles, model aliases, redacted config inspection/export, and setup diagnostics.

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
npm install -g ./kyokao-0.1.0.tgz
kyokao --help
```

The version in the tarball name follows `packages/cli/package.json`; use the actual filename that `pack` prints if it changes. To update a global local-tarball installation, rebuild, pack, and run the same `npm install -g ./<tarball>.tgz` command. To remove it:

```bash
npm uninstall -g kyokao
```

PowerShell uses the same `npm` commands:

```powershell
pnpm --filter kyokao pack
npm install -g .\kyokao-0.1.0.tgz
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

For a persistent interactive session, use `chat` (or run bare `kyokao`) in a TTY. Type `/exit` or submit an empty line to leave.

```bash
kyokao chat
# kyokao (type /exit)> inspect the tests
# kyokao> explain the failures
# kyokao> /exit
```

From source, replace `kyokao` in the examples with `pnpm --filter kyokao start`:

```bash
pnpm --filter kyokao start chat
pnpm --filter kyokao start -p groq -m llama-3.3-70b-versatile "inspect this repository"
```

## CLI reference

`kyokao --help` is the installed CLI’s authoritative command list. The global options are:

| Option                  | Meaning                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `-m, --model <id>`      | Model ID or configured alias.                                                                          |
| `-p, --provider <name>` | Built-in preset or configured provider name.                                                           |
| `--base-url <url>`      | Override the selected provider base URL for this invocation.                                           |
| `--api-key <key>`       | Override the API key for this invocation; it is not persisted. Avoid putting secrets in shell history. |
| `--approval <mode>`     | `suggest`, `auto-edit`, or `full-auto`.                                                                |
| `--profile <name>`      | Select a configuration profile.                                                                        |
| `--max-iterations <n>`  | Agent loop limit; an integer from 1 through 100.                                                       |
| `-V, --version`         | Print the CLI version.                                                                                 |
| `-h, --help`            | Print help.                                                                                            |

The default invocation accepts `[prompt...]`: with words it runs them as one prompt; without words it starts `chat` in a TTY, or reads all piped standard input otherwise.

| Command                    | What it does                                                                           | Example                                                         |
| -------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `chat`                     | Starts the TTY-only interactive loop.                                                  | `kyokao chat`                                                   |
| `models`                   | Requests `/models` from the selected provider and prints returned IDs.                 | `kyokao -p openrouter models`                                   |
| `providers`                | Prints built-in preset names and base URLs.                                            | `kyokao providers`                                              |
| `config show`              | Prints the resolved non-profile config with key/token/secret/password fields redacted. | `kyokao config show`                                            |
| `config path`              | Prints the global config path.                                                         | `kyokao config path`                                            |
| `config export <file>`     | Atomically writes a redacted resolved non-profile config.                              | `kyokao config export /tmp/kyokao-config.json`                  |
| `sessions`                 | Lists local sessions for the current workspace.                                        | `kyokao sessions`                                               |
| `resume <id> <prompt...>`  | Adds a follow-up to a saved session.                                                   | `kyokao resume 123e4567-e89b-12d3-a456-426614174000 "continue"` |
| `memory list`              | Prints the workspace’s manual memory object.                                           | `kyokao memory list`                                            |
| `memory set <key> <value>` | Stores a string value in manual local memory.                                          | `kyokao memory set convention "use pnpm"`                       |
| `memory delete <key>`      | Deletes a manual memory key.                                                           | `kyokao memory delete convention`                               |
| `doctor`                   | Prints Node version, workspace, provider URL, credential presence, and sandbox status. | `kyokao doctor`                                                 |
| `diff`                     | Displays the working-tree diff through the read-only Git tool.                         | `kyokao diff`                                                   |
| `commit [prompt...]`       | Asks the agent to review, test, then create a commit if ready.                         | `kyokao commit "include the README"`                            |
| `explain [prompt...]`      | Asks the agent to explain repository structure and relevant implementation.            | `kyokao explain "focus on config"`                              |
| `test [prompt...]`         | Asks the agent to run relevant tests and safely diagnose/fix failures.                 | `kyokao test`                                                   |
| `review [prompt...]`       | Asks the agent to review current changes for bugs, security risks, and missing tests.  | `kyokao review "focus on changed files"`                        |

`commit`, `test`, and `review` are prompts to the agent, not dedicated Git or test engines. Their ability to change files or run commands depends on the selected approval mode.

## Providers

A preset supplies only a base URL and an API-key environment-variable name. Kyokao accepts **any model string**; it does not validate model IDs locally. Model availability, tool-call support, and the actual IDs are controlled by the provider or local server. Use `kyokao -p <preset> models` when that server implements `/models`.

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

1. Built-in defaults: `openai`, `gpt-4o-mini`, `auto-edit`, and 12 iterations.
2. Global configuration.
3. Project `.kyokao.json` in the current working directory.
4. The selected profile, if `--profile <name>` names an existing profile.
5. Environment: `KYOKAO_PROVIDER`, `KYOKAO_MODEL`, `KYOKAO_APPROVAL`, and `KYOKAO_MAX_ITERATIONS`.
6. CLI options.

Global configuration paths are:

| Platform    | Path                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Linux/macOS | `$XDG_CONFIG_HOME/kyokao/config.json`, or `$HOME/.config/kyokao/config.json` when `XDG_CONFIG_HOME` is unset |
| Windows     | `%APPDATA%\\kyokao\\config.json`, or `%USERPROFILE%\\kyokao\\config.json` when `APPDATA` is unset            |
| Project     | `./.kyokao.json`                                                                                             |

Use `kyokao config path` to print the active platform global path. The application does not create a config file automatically.

### Schema and examples

The supported top-level keys are `provider`, `model`, `approval`, `maxIterations`, `profiles`, `providers`, and `aliases`. `approval` must be `suggest`, `auto-edit`, or `full-auto`; `maxIterations` must be an integer from 1 to 100. Provider entries allow only string `baseURL`, `apiKey`, and `model` fields. Alias values are strings.

A project configuration without secrets:

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "approval": "auto-edit",
  "maxIterations": 12,
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

## Approvals and safety

Approval applies to the two file-mutation tools and the shell tool:

| Mode                  | `write_file` / `apply_patch` | `shell`              |
| --------------------- | ---------------------------- | -------------------- |
| `suggest`             | Prompt every action          | Prompt every action  |
| `auto-edit` (default) | Allow without prompt         | Prompt every action  |
| `full-auto`           | Allow without prompt         | Allow without prompt |

A prompt accepts `y` or `yes`; any other response denies the action. In a non-interactive standard input session, prompted actions are denied. Read/search tools, read-only Git subcommands, and HTTP GET do not ask for approval.

`git` only permits the `status`, `diff`, `log`, `show`, and `branch` subcommands through its dedicated tool. A model can request a shell command such as `git commit`; that command is still subject to the shell approval rule above. `http_get` accepts only `http:` and `https:` URLs.

## Sessions, memory, and workflows

Each workspace stores state under `./.kyokao/`:

- `sessions/<uuid>.json` contains the task, timestamps, transcript, and most recent checkpoint.
- `memory.json` contains the manual string key/value store used by `memory` commands.

List and resume sessions from the same workspace:

```bash
kyokao sessions
kyokao resume 123e4567-e89b-12d3-a456-426614174000 "continue from the last checkpoint"
```

Sessions are saved after completed tool-call iterations and when a run completes. `Ctrl+C` aborts the active request; the CLI reports that the last completed tool checkpoint remains saved. The `memory` store is local data management only: this implementation does not automatically inject memory into agent prompts.

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

### Verify a release tarball without changing global npm state

```bash
pnpm build
pnpm --filter kyokao pack
TARBALL=kyokao-0.1.0.tgz
PREFIX="$(mktemp -d)"
npm install --prefix "$PREFIX" "$TARBALL"
"$PREFIX/node_modules/.bin/kyokao" --help
rm -rf "$PREFIX"
```

Use the tarball filename output by `pack` if the version differs. PowerShell:

```powershell
pnpm build
pnpm --filter kyokao pack
$tarball = '.\kyokao-0.1.0.tgz'
$prefix = Join-Path $env:TEMP ('kyokao-npm-' + [guid]::NewGuid())
npm install --prefix $prefix $tarball
& (Join-Path $prefix 'node_modules\.bin\kyokao.cmd') --help
Remove-Item -Recurse -Force $prefix
```

## Architecture

| Package             | Responsibility                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `@kyokao/config`    | Defaults, JSON validation/loading/merging, provider presets, redaction, and atomic config writes. |
| `@kyokao/providers` | OpenAI SDK-compatible chat and model-list client plus transcript-to-wire mapping.                 |
| `@kyokao/tools`     | Workspace sandbox and core tool implementations.                                                  |
| `@kyokao/memory`    | Local session and manual-memory JSON persistence.                                                 |
| `@kyokao/agent`     | System prompt, retries, bounded tool-call loop, and checkpoints.                                  |
| `@kyokao/ui`        | Colored terminal output and approval prompts.                                                     |
| `kyokao`            | Commander CLI wiring, commands, and runtime construction.                                         |

For an agent run, the CLI resolves configuration and provider settings, creates a workspace sandbox and local store, then sends a system prompt, saved transcript, and user prompt to the provider. The provider response may stream text and function calls. For each returned call, the agent executes the matching core tool, appends a tool-result message, saves a checkpoint, and calls the provider again. It stops when no tool calls remain or errors after the configured iteration limit. Transient provider failures are retried up to two times with short exponential backoff; aborts and messages matching certain client/configuration error patterns are not retried.

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

## Limitations

Kyokao currently has no MCP integration, plugin system, context compression, token/cost reporting, model catalog, syntax highlighting, or full-screen TUI. It does not validate model availability before a chat request, and it relies on the selected endpoint’s OpenAI-compatible behavior, including tool calling. The manual memory store is not automatically included in prompts. The workspace sandbox limits file-path escapes but is not a process sandbox.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for the required local checks. Kyokao is licensed under the [ISC License](LICENSE).
