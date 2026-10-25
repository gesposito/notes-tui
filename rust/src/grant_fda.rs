//! Full Disk Access helpers (port of `src/lib/grant-fda.ts`): `notes
//! grant-fda`, the TUI's "open Settings + Finder" on a missing grant, and
//! making the binary answer for itself so a grant on the binary alone works.
//! macOS has no API to grant Full Disk Access; the best we can do is open the
//! right Settings pane and reveal the binary in Finder for drag-and-drop.

use std::ffi::{CString, c_char, c_int, c_void};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const FDA_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

// ── Responsibility ──────────────────────────────────────────────────────────
// macOS privacy checks (TCC) apply to the "responsible process". For a
// command started in a terminal that's the terminal app, so a Full Disk
// Access grant on this binary alone would be ignored, and the only grant
// that works would cover everything run in that terminal. Re-launching with
// responsibility disclaimed makes the binary answer for itself. These are
// private libSystem calls (LLDB and Chromium use them the same way), so
// they're looked up at runtime and skipped if a future macOS drops them.

type ResponsibleForPid = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
type SetDisclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;

fn lookup(name: &std::ffi::CStr) -> Option<*mut c_void> {
    let ptr = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    (!ptr.is_null()).then_some(ptr)
}

/// Whether macOS holds this process responsible for itself. Unknown counts
/// as yes, so nothing is re-launched on a guess.
fn is_self_responsible() -> bool {
    let Some(ptr) = lookup(c"responsibility_get_pid_responsible_for_pid") else {
        return true;
    };
    let responsible_for = unsafe { std::mem::transmute::<*mut c_void, ResponsibleForPid>(ptr) };
    let me = unsafe { libc::getpid() };
    unsafe { responsible_for(me) == me }
}

/// Makes this process answer for itself in macOS privacy checks: re-launches
/// the binary with responsibility disclaimed and exits with the child's
/// status. Returns in the re-launched process (or when re-launching isn't
/// possible), where the caller carries on as usual.
pub fn ensure_self_responsible() {
    if !is_self_responsible()
        && let Some(code) = relaunch_disclaimed()
    {
        std::process::exit(code);
    }
}

fn relaunch_disclaimed() -> Option<i32> {
    let set_disclaim = unsafe {
        std::mem::transmute::<*mut c_void, SetDisclaim>(lookup(
            c"responsibility_spawnattrs_setdisclaim",
        )?)
    };
    let exe = CString::new(std::env::current_exe().ok()?.as_os_str().as_bytes()).ok()?;
    let args: Vec<CString> = std::env::args_os()
        .map(|a| CString::new(a.as_bytes()))
        .collect::<Result<_, _>>()
        .ok()?;
    let mut argv: Vec<*mut c_char> = args.iter().map(|a| a.as_ptr().cast_mut()).collect();
    argv.push(std::ptr::null_mut());

    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
        if libc::posix_spawnattr_init(&mut attr) != 0 {
            return None;
        }
        let mut pid: libc::pid_t = 0;
        let spawned = set_disclaim(&mut attr, 1) == 0
            && libc::posix_spawn(
                &mut pid,
                exe.as_ptr(),
                std::ptr::null(),
                &attr,
                argv.as_ptr(),
                *libc::_NSGetEnviron(),
            ) == 0;
        libc::posix_spawnattr_destroy(&mut attr);
        if !spawned {
            return None;
        }
        // The child owns the terminal now; like system(), leave ^C and ^\
        // to it rather than dying underneath it.
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGQUIT, libc::SIG_IGN);
        let mut status = 0;
        while libc::waitpid(pid, &mut status, 0) < 0 {
            if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                return Some(1);
            }
        }
        Some(if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            128 + libc::WTERMSIG(status)
        })
    }
}

// ── Settings + Finder ───────────────────────────────────────────────────────

/// What `open_fda_help` opened, for the TUI to describe on screen.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FdaHelp {
    /// The binary to turn on, e.g. `notes-tui`.
    pub app: String,
    /// Its full path, revealed in Finder.
    pub path: String,
}

fn open_settings_and_reveal(paths: Vec<PathBuf>) {
    let _ = Command::new("open").arg(FDA_URL).status();
    if !paths.is_empty() {
        let _ = Command::new("open").arg("-R").args(paths).status();
    }
}

/// Opens Privacy & Security → Full Disk Access and reveals this binary in
/// Finder, ready to drag into the list. The `open` calls run on a background
/// thread so the TUI never blocks on them.
pub fn open_fda_help() -> FdaHelp {
    let exe = std::env::current_exe().unwrap_or_default();
    let reveal: Vec<PathBuf> = (!exe.as_os_str().is_empty())
        .then(|| exe.clone())
        .into_iter()
        .collect();
    std::thread::spawn(move || open_settings_and_reveal(reveal));
    FdaHelp {
        app: exe.file_name().map_or_else(
            || "notes-tui".to_owned(),
            |n| n.to_string_lossy().into_owned(),
        ),
        path: exe.display().to_string(),
    }
}

/// This binary plus its sibling (`notes` ↔ `notes-tui`) when it's there:
/// each needs its own entry in the list.
fn notes_binaries() -> Vec<PathBuf> {
    let Ok(exe) = std::env::current_exe() else {
        return Vec::new();
    };
    let sibling = match exe.file_name().and_then(|n| n.to_str()) {
        Some("notes") => Some(exe.with_file_name("notes-tui")),
        Some("notes-tui") => Some(exe.with_file_name("notes")),
        _ => None,
    };
    std::iter::once(exe)
        .chain(sibling.filter(|p| p.exists()))
        .collect()
}

pub fn grant_fda(reveal: bool, out: &mut dyn Write) -> io::Result<()> {
    let binaries = notes_binaries();
    writeln!(
        out,
        "Opening System Settings → Privacy & Security → Full Disk Access…"
    )?;
    if reveal && !binaries.is_empty() {
        writeln!(out, "Revealing the notes binaries in Finder…")?;
        open_settings_and_reveal(binaries.clone());
    } else {
        open_settings_and_reveal(Vec::new());
    }
    let list: String = binaries
        .iter()
        .map(|p| format!("    {}\n", p.display()))
        .collect();
    let first = binaries
        .first()
        .map_or_else(|| Path::new("notes").to_owned(), Clone::clone);
    write!(
        out,
        r#"
Drag these into the list and toggle them ON:

{list}
They answer for themselves in macOS privacy checks whenever they read Notes'
database (the sqlite backend, `notes inspect`), so the grant applies even
when you start them from a terminal, without giving the terminal (and
everything else run in it) Full Disk Access.

Caveat: every `cargo build` changes a binary's identity, so macOS treats it
as a new app: re-add it after rebuilding. An installed copy (`cargo install`)
keeps its grant until it's reinstalled.

Test after granting:
  {first} inspect | head -50
"#,
        first = first.display()
    )
}
