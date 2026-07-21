# Changelog

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
