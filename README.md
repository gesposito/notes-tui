# notes-tui

A terminal UI and CLI for macOS Apple Notes, written in Bun + React (OpenTUI).

## Setup

```bash
bun install
```

See [Permissions](#permissions) below — the osa/SB backends only need Automation access, but the SQLite backend needs Full Disk Access.

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

Three implementations of `NotesBackend`, picked via `NOTES_BACKEND`:

- **osascript** (default) — JXA via `osascript -l JavaScript`. Fast bulk reads via property chains. Needs Automation access only.
- **scripting-bridge** — long-lived Swift helper using ScriptingBridge. Opt-in:
  ```bash
  bun run build:helper                  # compile helper/notes-bridge
  NOTES_BACKEND=scripting-bridge bun run start
  NOTES_BACKEND=scripting-bridge bun run cli folders
  ```
- **sqlite** — read `NoteStore.sqlite` directly. Much faster on metadata paths (no Apple Events round trips), but requires Full Disk Access (see [Permissions](#permissions)). Body decoding and writes still defer to osa under the hood. Opt-in:
  ```bash
  NOTES_BACKEND=sqlite bun run cli folders
  ```

For most workloads osa wins among the Apple-Events backends (bulk listFolders ~150 ms script vs SB ~2200 ms; see `scripts/bench-list-folders.js` and `scripts/bench-backends.ts`). SQLite is a further step up for metadata-only reads once FDA is granted.

## Permissions

Different backends need different macOS permissions:

| Backend | What it needs | Where to grant |
| --- | --- | --- |
| `osascript` (default) | **Automation** access to Notes.app | System Settings → Privacy & Security → **Automation** (prompted on first launch) |
| `scripting-bridge` | Same Automation access (uses ScriptingBridge under the hood) | Same as above |
| `sqlite` | **Full Disk Access** for the binary that opens `NoteStore.sqlite` | System Settings → Privacy & Security → **Full Disk Access** (manual; macOS does not allow programmatic prompts for FDA) |

### Granting Full Disk Access (for the SQLite backend)

Quick start: `bun run grant-fda` opens the FDA pane and prints the exact paths you can drag in (compiled CLI, `bun` binary, or terminal app).

FDA is per-executable. **In practice**, granting it to your terminal app is the most reliable choice for everyday use — see "responsible process" below. The narrower options work but have caveats:

1. **Your terminal app** (recommended in practice, broader scope):
   - Drag Terminal.app / iTerm.app / Ghostty / WezTerm / etc. into the FDA list.
   - Everything launched from a shell in that terminal inherits access — `bun run`, `./notes`, `sqlite3`, anything.
   - Why this matters: macOS TCC attributes file access to the **responsible process** at the top of the tree. When you run `bun run cli` inside Claude Code, tmux, a terminal multiplexer, or any nested shell, the responsible process is your terminal app — not `bun`. Granting FDA to `bun` alone leaves the access blocked by the terminal-level decision.
2. **Compiled CLI only** (narrowest scope):
   ```bash
   bun run build:cli           # → ./notes
   codesign -s - ./notes       # ad-hoc sign so identity is at least explicit
   open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
   # In the System Settings pane, click +, then drag in ./notes
   ./notes inspect             # smoke test — should dump schema
   ```
   Caveat: every `bun run build:cli` produces a different binary hash. macOS treats it as a new app, so the FDA grant doesn't carry over — you need to remove the stale entry and re-add the new binary after each rebuild. A paid Developer ID cert is the only way to get a stable identity.
3. **`bun` itself**:
   - Same deep-link command, then add `$(which bun)`. Works for direct `bun run` from a terminal that's already in the FDA list (or running from a non-multiplexed shell). Often *doesn't* work when `bun` is nested under Claude Code, tmux, or similar — see (1). `bun upgrade` (or `mise install bun@…`) also replaces the binary and resets FDA.

If you forget to grant it, the SQLite backend (and `notes inspect`) throws a `FullDiskAccessRequired` error with the exact `open …` command and `codesign` hint inline — you can act on it without leaving the terminal.

Diagnostic: if `bun run cli inspect` still fails after granting, run this from the same shell to confirm whether the *shell* has FDA at all:
```bash
head -c 32 "$HOME/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite" | xxd
```
If that prints garbage hex bytes → shell has FDA, the issue is the bun/CLI grant specifically. If it prints `head: ...: Operation not permitted` → no process in this shell tree has FDA; grant to your terminal app.

### Why we can't auto-prompt

Other macOS TCC resources (Camera, Mic, Calendar, Photos…) trigger a one-time system dialog the first time you call their API. **FDA is the only one that doesn't** — Apple deliberately requires it to be a manual user action. The best a CLI/app can do is detect the missing permission and link directly to the right pane, which we do.

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
