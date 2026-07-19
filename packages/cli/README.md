# Kyokao

Kyokao is a local-first TypeScript coding-agent CLI for Node 20+. It uses OpenAI-compatible APIs and exposes a permissioned tool surface that can be extended with plugins and MCP stdio servers.

## Quickstart

```sh
pnpm install
pnpm build
export OPENAI_API_KEY=...
pnpm --filter kyokao start -- "inspect this repository"
# after packaging: kyokao "add a test"
```

Run bare `kyokao` or `kyokao chat` in a TTY for a persistent interactive session (`/exit` leaves it), or use `kyokao tui` for the full-screen interface; `kyokao edit <path>` opens a workspace file in the configured editor. Chat requests validate the selected model against the provider’s `/models` response unless `--skip-model-check` is supplied. Sampling parameters, fallback models, instruction files, and hard safety limits are configurable; `kyokao usage` reports provider usage when available and local estimates otherwise.

## Configuration

Precedence is defaults, global (`$XDG_CONFIG_HOME/kyokao/config.json` or platform equivalent), project `.kyokao.json`, selected profile, environment, then CLI. Set `KYOKAO_PROVIDER`, `KYOKAO_MODEL`, `KYOKAO_MAX_ITERATIONS`, `KYOKAO_EDITOR`, and provider-specific keys (for example `OPENAI_API_KEY`). Config also supports `contextWindow`, `compressionThreshold`, model sampling/fallback fields, `editor`/`editorArgs`, `limits`, `plugins`, and `mcp`; use `config export` only for redacted, non-secret sharing. Never put API keys in project config.

## Security model

All file paths are constrained to the current workspace with traversal and resolved-symlink checks. Outputs and command time are bounded. `suggest` asks before every mutation, `auto-edit` permits file edits but asks for shell commands, and `full-auto` permits actions; shell commands always ask in `suggest` and `auto-edit`. HTTP is HTTP(S) only. Review generated changes before committing.

## Architecture

Workspace packages: config, providers, tools, memory, agent, UI, and CLI. Project state (sessions, context summaries, and usage) persists in `.kyokao` and sessions can resume with a protocol-faithful transcript. The agent performs bounded OpenAI SDK-compatible function-call loops with retry/backoff, context compression, cost estimates, syntax-highlighted output, and plugins/MCP tools. File safety prevents traversal and resolved symlink escapes, but concurrent filesystem races cannot be fully eliminated across platforms.
