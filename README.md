# notes-tui

A terminal UI and CLI for macOS Apple Notes, written in Bun + React (OpenTUI).

## Setup

```bash
bun install
```

First launch will prompt for Automation access to Notes.app — needed for both the TUI and CLI. If you deny it, re-enable in **System Settings → Privacy & Security → Automation**.

## TUI

```bash
bun run start                  # interactive three-pane browser
bun run dev                    # same, with --watch
bun run build && ./notes-tui   # compile a standalone binary
```

Three panes (folders | notes | preview). Highlights:
- `←/→` — collapse / expand a folder. Counts and the notes pane both follow the visuals: collapsed parents show recursive totals + aggregated notes; expanded parents show direct only.
- `f` — full-text search (title + body) scoped to the active selection. First use indexes the scope progressively; banner shows progress.
- `e` — edit a note's plaintext body (Ctrl+S to save). See [`EDITING.md`](./EDITING.md) for caveats — formatting is lost on save.
- `n` / `N` — new note / new folder. `m` — move marked notes. `r` — refresh. `?` — full keymap.

## CLI

```bash
bun run cli <command>          # run from source
bun run build:cli && ./notes   # compile a standalone `notes` binary
```

Subcommands mirror the underlying NotesBackend; output is JSON to stdout (`-r` for compact).

```bash
notes folders                                     # list all folders
notes ls -r | jq '.[] | select(.depth == 0)'      # alias + pipe
notes folder-notes <FOLDER_ID> [<FOLDER_ID>...]   # variadic positionals
notes body <NOTE_ID>                              # plaintext to stdout
notes search "q3 forecast" -f <FOLDER_ID>         # title + body grep
notes search "anything" -f <FOLDER_ID> -R         # include subfolders
echo "new body" | notes update <NOTE_ID>          # body from stdin
notes new-note -f <FOLDER_ID>
notes new-folder "Work" -a iCloud
notes move <NOTE_ID> [<NOTE_ID>...] -t <FOLDER_ID>
```

`notes --help` and `notes <command> --help` cover the full surface, aliases, and value hints.

## Backend selection

Two implementations of `NotesBackend`:
- **osascript** (default) — JXA via `osascript -l JavaScript`. Fast bulk reads via property chains.
- **scripting-bridge** — long-lived Swift helper using ScriptingBridge. Opt-in:
  ```bash
  bun run build:helper                  # compile helper/notes-bridge
  NOTES_BACKEND=scripting-bridge bun run start
  NOTES_BACKEND=scripting-bridge bun run cli folders
  ```

For most workloads osa wins (bulk listFolders ~150 ms script vs SB ~2200 ms; see `scripts/bench-list-folders.js` and `scripts/bench-backends.ts`).

## Scripts

```bash
bun run typecheck                                          # tsc --noEmit
bun test                                                   # bun:test, all suites
bun run scripts/bench-list-folders.js                      # JXA listFolders strategies
bun run scripts/time-list-folders.ts                       # end-to-end osa timing
bun run scripts/bench-backends.ts                          # full sweep × both backends
bun run scripts/bench-backends.ts --folder <ID> --runs 5   # explicit folder, more samples
```

## Debug logging

`DEBUG=1` wraps the backend with per-call timing logged to `/tmp/notes-tui-debug.log` and prints a stats summary on exit. Useful when investigating a slow code path.

```bash
DEBUG=1 bun run start
tail -f /tmp/notes-tui-debug.log    # in another terminal
```
