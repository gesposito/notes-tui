//! `notes grant-fda` (port of `src/lib/grant-fda.ts`). macOS has no API to
//! grant Full Disk Access programmatically; this removes the click-around by
//! opening the right Settings pane and revealing this binary in Finder.

use std::io::{self, Write};
use std::process::Command;

const FDA_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

pub fn grant_fda(reveal: bool, out: &mut dyn Write) -> io::Result<()> {
    let exe = std::env::current_exe().ok();
    let exe_display = exe.as_ref().map_or_else(
        || "(could not resolve this binary's path)".to_owned(),
        |p| p.display().to_string(),
    );

    writeln!(
        out,
        "Opening System Settings → Privacy & Security → Full Disk Access…"
    )?;
    let _ = Command::new("open").arg(FDA_URL).status();
    if reveal && let Some(exe) = &exe {
        writeln!(out, "Revealing this binary in Finder…")?;
        let _ = Command::new("open").arg("-R").arg(exe).status();
    }

    write!(
        out,
        r#"
Drag ONE of these into the list (then toggle ON).
Recommended in practice: your terminal app — see why below.

  • Your terminal app (recommended):
      e.g. /Applications/Ghostty.app, /Applications/Utilities/Terminal.app,
      /Applications/iTerm.app, /Applications/WezTerm.app — whichever you use.
    Why: macOS attributes file access to the *responsible process* at the
    top of the tree (your terminal), not the immediate child. Granting FDA
    to this binary alone often DOESN'T work when it's launched from Claude
    Code, tmux, or other nested shells — TCC defers to the terminal's own
    decision, which is the entry NOT in the list. Granting at the terminal
    level covers the whole tree.

  • This binary (narrowest scope):
      {exe_display}
    Caveat: every `cargo build` changes the binary's hash. macOS treats it
    as a new app and the FDA grant doesn't carry over — re-toggle (or
    remove + re-add) after each build.

Test after granting:
  {exe_display} inspect | head -50

Diagnostic if it still fails: from the same shell, run
  head -c 32 "$HOME/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite" | xxd
  → hex bytes:                  shell has FDA, only this binary is missing it
  → "Operation not permitted":  no FDA in this shell tree → grant terminal
"#
    )
}
