# Changelog

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
