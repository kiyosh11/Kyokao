# Kyokao

Kyokao is a local-first TypeScript coding-agent CLI for Node 20+. It uses OpenAI-compatible APIs and exposes a deliberately small, permissioned tool surface.

## Quickstart

```sh
pnpm install
pnpm build
export OPENAI_API_KEY=...
pnpm --filter kyokao start -- "inspect this repository"
# after packaging: kyokao "add a test"
```

Run bare `kyokao` or `kyokao chat` in a TTY for a persistent interactive session (`/exit` leaves it); provide a prompt or pipe stdin for one-shot execution. Use `kyokao --help`, `kyokao providers`, `kyokao models`, and `kyokao doctor`. Any model string is accepted: `kyokao -p groq -m llama-3.3-70b-versatile "..."`. Presets cover OpenAI, OpenRouter, Groq, NVIDIA NIM, Together, DeepInfra, Fireworks, Cerebras, SambaNova, xAI, Mistral, Ollama, LM Studio, and vLLM. `models` asks the selected provider dynamically; Kyokao intentionally has no brittle exhaustive catalog.

## Configuration

Precedence is defaults, global (`$XDG_CONFIG_HOME/kyokao/config.json` or platform equivalent), project `.kyokao.json`, selected profile, environment, then CLI. Set `KYOKAO_PROVIDER`, `KYOKAO_MODEL`, `KYOKAO_MAX_ITERATIONS`, and provider-specific keys (for example `OPENAI_API_KEY`). Config supports `providers`, `profiles`, and `aliases`; use `config export` only for redacted, non-secret sharing. Never put API keys in project config.

## Security model

All file paths are constrained to the current workspace with traversal and resolved-symlink checks. Outputs and command time are bounded. `suggest` asks before every mutation, `auto-edit` permits file edits but asks for shell commands, and `full-auto` permits actions; shell commands always ask in `suggest` and `auto-edit`. HTTP is HTTP(S) only. Review generated changes before committing.

## Architecture and limitations

Workspace packages: config, providers, tools, memory, agent, UI, and CLI. Project state (sessions and memory) persists in `.kyokao` and sessions can resume with a protocol-faithful transcript. The agent performs bounded OpenAI SDK-compatible function-call loops with retry/backoff and streams SSE text/tool deltas by default. It has no context compression, cost reporting, plugins, MCP, or syntax-highlighting support. File safety prevents traversal and resolved symlink escapes, but concurrent filesystem races cannot be fully eliminated across platforms.
