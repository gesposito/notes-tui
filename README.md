# notes-tui

A terminal UI and CLI for macOS Apple Notes, written in Bun + React (OpenTUI).

## Setup

```bash
bun install
```

Needs a recent Bun (verified on 1.4.4): the tooling uses the built-in `bun check` type checker and `bun fmt` formatter.

See [Permissions](#permissions) below — the osa/SB backends only need Automation access, but the SQLite backend needs Full Disk Access.

## TUI

```bash
bun run start                  # interactive three-pane browser
bun run dev                    # same, with --watch
bun run build && ./notes-tui   # type check, then compile a standalone binary
bun run start:rust             # same TUI, Rust build (see Rust variant)
```

Three panes (folders | notes | preview). Highlights:

- `←/→` — collapse / expand a folder. Counts and the notes pane both follow the visuals: collapsed parents show recursive totals + aggregated notes; expanded parents show direct only.
- `f` — full-text search (title + body) scoped to the active selection. First use indexes the scope progressively; banner shows progress.
- `e` — edit a note's plaintext body (Ctrl+S to save). See [`EDITING.md`](./EDITING.md) for caveats — formatting is lost on save.
- `n` / `N` — new note / new folder. `m` — move marked notes. `r` — refresh. `?` — full keymap.

## CLI

```bash
bun run cli <command>          # run from source
bun run build:cli && ./notes   # type check, then compile a standalone `notes` binary
bun run cli:rust <command>     # same CLI, Rust build
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

## Rust variant

[`rust/`](./rust) holds a Rust port that lives alongside the Bun app — both are kept. Same three backends (with the same JXA scripts), same `notes` subcommands and JSON output, same settings file; the TUI uses ratatui instead of OpenTUI.

```bash
bun run start:rust                 # TUI (cargo builds it on first run)
bun run cli:rust folders           # CLI, same subcommands as `bun run cli`
bun run build:rust                 # → rust/target/release/{notes-tui,notes}
bun run verify:rust                # cargo fmt --check + clippy + tests
cargo install --path rust          # installs notes + notes-tui into ~/.cargo/bin
cargo run --manifest-path rust/Cargo.toml --example mock_tui   # TUI over in-memory data, no Notes access
```

- Backends are picked the same way (`NOTES_BACKEND`, `B` in the TUI, persisted to the shared `config.json`). scripting-bridge spawns the same `helper/notes-bridge`; `NOTES_BRIDGE_HELPER` points it elsewhere.
- `DEBUG=1` instruments the TUI as well as the CLI, logging to `/tmp/notes-tui-rs-debug.log`.
- Full Disk Access goes to the binaries themselves, not your terminal (see [Permissions](#permissions)): `rust/target/release/{notes,notes-tui}`, again after each rebuild.
- Small deliberate differences: search-index progress only counts folders in scope; a failed fetch isn't retried in a loop; `?` doesn't open help while typing a name or a note; the help dialog scrolls with ↑/↓; the CLI on scripting-bridge exits when done and prints keys in the same order as osa.

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

| Backend               | What it needs                                                                            | Where to grant                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `osascript` (default) | **Automation** access to Notes.app                                                       | System Settings → Privacy & Security → **Automation** (prompted on first launch)                                        |
| `scripting-bridge`    | Same Automation access (uses ScriptingBridge under the hood)                             | Same as above                                                                                                           |
| `sqlite`              | **Full Disk Access** for the `notes` / `notes-tui` binary itself, plus Automation for it | System Settings → Privacy & Security → **Full Disk Access** (manual; macOS does not allow programmatic prompts for FDA) |

### Granting Full Disk Access (for the SQLite backend)

Grant it to the compiled binaries, not your terminal: a terminal grant would cover everything run in it.

- Bun: `./notes` and `./notes-tui` (`bun run build:cli`, `bun run build`).
- Rust: `rust/target/release/notes` and `notes-tui` (`bun run build:rust`), or the copies in `~/.cargo/bin` after `cargo install --path rust`.

The TUIs walk you through it: when the grant is missing they open System Settings → Full Disk Access, reveal the binary in Finder ready to drag into the list, and say what to do next (`o` reopens both, `B` switches backend, `r` retries, `q` quits). From the CLI, `notes grant-fda` (or `bun run grant-fda` from source) does the same for both binaries. Without the grant, the SQLite backend and `notes inspect` fail with a `FullDiskAccessRequired` error that names the binary to add.

How a grant on just the binary works: macOS privacy checks apply to the **responsible process**, which for anything started in a terminal is the terminal app. So when the SQLite backend is selected (or for `notes inspect`), the binaries re-launch themselves with that responsibility disclaimed, and answer for themselves. This uses private libSystem calls that LLDB and Chromium also rely on; if a future macOS drops them, the binaries run as before, and only a terminal grant would work.

Caveats:

- Every build changes a binary's identity (it's ad-hoc signed), so macOS treats it as a new app: remove the stale entry and re-add the binary after rebuilding. An installed copy keeps its grant until it's reinstalled.
- Because the binary answers for itself, macOS also asks once whether it may control Notes (Automation), since the SQLite backend still uses Apple Events for note bodies and writes. Again after each rebuild.
- Running from source (`bun run start`, `bun run cli`) can't be granted narrowly: the process is `bun`, and the terminal answers for it. The TUI points you at the compiled binary instead.

### Why we can't auto-prompt

Other macOS TCC resources (Camera, Mic, Calendar, Photos…) trigger a one-time system dialog the first time you call their API. **FDA is the only one that doesn't** — Apple deliberately requires it to be a manual user action. The best a CLI/app can do is detect the missing permission, open the right pane, and reveal the binary to add, which we do.

## Scripts

```bash
bun check                                                  # type check (same errors as tsc)
bun fmt                                                    # format (Prettier-compatible, config in bunfig.toml)
bun test                                                   # bun:test, all suites
bun run verify                                             # fmt --check + check + test, in parallel
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
