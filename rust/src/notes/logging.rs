//! `DEBUG=1` instrumentation (port of `src/notes/logging-backend.ts`): wraps
//! a backend with per-call timing, mirrored to a file you can `tail -f` (the
//! TUI's alternate screen hides stderr), plus a stats summary at exit.

use std::fs::File;
use std::future::Future;
use std::io::Write;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::{Value, json};

use super::{Folder, FolderTexts, Move, MoveResult, Note, NotesBackend};
use crate::text::{truncate_utf16, utf16_len};

/// Distinct from the Bun build's `/tmp/notes-tui-debug.log` so running both
/// side by side doesn't interleave their traces.
pub const LOG_PATH: &str = "/tmp/notes-tui-rs-debug.log";

static SESSION_START: LazyLock<Instant> = LazyLock::new(Instant::now);
static SINK: LazyLock<Mutex<Option<File>>> = LazyLock::new(|| {
    // Truncate: a fresh log per run.
    let file = File::create(LOG_PATH).ok().map(|mut f| {
        let _ = writeln!(f, "# notes-tui (rust) debug log — started {}", now_iso());
        f
    });
    Mutex::new(file)
});
static STATS: LazyLock<Mutex<IndexMap<&'static str, CallStats>>> =
    LazyLock::new(|| Mutex::new(IndexMap::new()));

#[derive(Default)]
struct CallStats {
    count: usize,
    total_ms: f64,
    aborts: usize,
    errors: usize,
    durations: Vec<f64>,
}

enum Outcome {
    Ok(String),
    Abort,
    Error(String),
}

fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn emit(line: &str) {
    if let Some(file) = SINK.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

fn fmt_ms(ms: f64) -> String {
    format!("{}ms", ms.round())
}

fn fmt_args(args: &Option<Value>) -> String {
    match args {
        None => "()".to_owned(),
        Some(v) => {
            let s = v.to_string();
            if utf16_len(&s) > 60 {
                format!("({}...)", truncate_utf16(&s, 57))
            } else {
                format!("({s})")
            }
        }
    }
}

fn record(method: &'static str, args: &Option<Value>, duration_ms: f64, outcome: Outcome) {
    let elapsed = SESSION_START.elapsed().as_millis();
    let (tag, tail) = match &outcome {
        Outcome::Ok(summary) => ("✓", summary.clone()),
        Outcome::Abort => ("✗abort", String::new()),
        Outcome::Error(msg) => ("✗error", format!(" {msg}")),
    };
    emit(&format!(
        "[+{elapsed:>5}ms] {method:<20} {} → {} {tag}{tail}\n",
        fmt_args(args),
        fmt_ms(duration_ms)
    ));
    let mut stats = STATS.lock().unwrap_or_else(|e| e.into_inner());
    let s = stats.entry(method).or_default();
    s.count += 1;
    s.total_ms += duration_ms;
    s.durations.push(duration_ms);
    match outcome {
        Outcome::Abort => s.aborts += 1,
        Outcome::Error(_) => s.errors += 1,
        Outcome::Ok(_) => {}
    }
}

/// Logs `✗abort` when a wrapped call's future is dropped before finishing —
/// how cancelled reads look in Rust.
struct AbortGuard<'a> {
    method: &'static str,
    args: &'a Option<Value>,
    start: Instant,
    done: bool,
}

impl Drop for AbortGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            let ms = self.start.elapsed().as_secs_f64() * 1000.0;
            record(self.method, self.args, ms, Outcome::Abort);
        }
    }
}

/// The " (N items)" tail of a successful call's log line.
trait Summary {
    fn summary(&self) -> String;
}

impl<T> Summary for Vec<T> {
    fn summary(&self) -> String {
        format!(" ({} items)", self.len())
    }
}

impl Summary for String {
    fn summary(&self) -> String {
        format!(" ({} chars)", utf16_len(self))
    }
}

impl Summary for FolderTexts {
    fn summary(&self) -> String {
        format!(" ({} keys)", self.len())
    }
}

impl Summary for () {
    fn summary(&self) -> String {
        String::new()
    }
}

async fn wrap<T: Summary>(
    method: &'static str,
    args: Option<Value>,
    fut: impl Future<Output = Result<T>>,
) -> Result<T> {
    let start = Instant::now();
    let mut guard = AbortGuard {
        method,
        args: &args,
        start,
        done: false,
    };
    let result = fut.await;
    guard.done = true;
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    let outcome = match &result {
        Ok(value) => Outcome::Ok(value.summary()),
        Err(e) => Outcome::Error(format!("{e:#}")),
    };
    record(method, &args, ms, outcome);
    result
}

fn percentile(sorted: &[f64], p: usize) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[(sorted.len() * p / 100).min(sorted.len() - 1)]
}

/// Session summary, written to both the log file and stderr (visible once
/// the alternate screen is gone). No-op if nothing was recorded.
pub fn dump_stats() {
    let stats = STATS.lock().unwrap_or_else(|e| e.into_inner());
    if stats.is_empty() {
        return;
    }
    let mut methods: Vec<(&&'static str, &CallStats)> = stats.iter().collect();
    methods.sort_by_key(|(_, s)| std::cmp::Reverse(s.count));
    let mut lines = vec![
        String::new(),
        "=== notes-tui session summary ===".to_owned(),
    ];
    for (method, s) in methods {
        let mut sorted = s.durations.clone();
        sorted.sort_by(f64::total_cmp);
        lines.push(format!(
            "{method:<20} × {:>4}  avg={}  p50={}  p95={}  aborts={}  errors={}",
            s.count,
            fmt_ms(s.total_ms / s.count as f64),
            fmt_ms(percentile(&sorted, 50)),
            fmt_ms(percentile(&sorted, 95)),
            s.aborts,
            s.errors,
        ));
    }
    let summary = lines.join("\n") + "\n";
    emit(&summary);
    eprint!("{summary}");
}

/// One-time pointer on stderr, before the TUI takes over the screen.
pub fn print_debug_hint() {
    eprintln!(
        "[notes-tui] DEBUG=1 — logging to {LOG_PATH}\n             (run `tail -f {LOG_PATH}` in another terminal)"
    );
}

pub struct LoggingBackend {
    inner: Arc<dyn NotesBackend>,
}

impl LoggingBackend {
    pub fn new(inner: Arc<dyn NotesBackend>) -> Self {
        LazyLock::force(&SESSION_START);
        Self { inner }
    }
}

#[async_trait]
impl NotesBackend for LoggingBackend {
    async fn list_folders(&self) -> Result<Vec<Folder>> {
        wrap("listFolders", None, self.inner.list_folders()).await
    }

    async fn get_folder_notes(&self, folder_ids: &[String]) -> Result<Vec<Note>> {
        let args = Some(json!(folder_ids));
        wrap(
            "getFolderNotes",
            args,
            self.inner.get_folder_notes(folder_ids),
        )
        .await
    }

    async fn get_note_body(&self, note_id: &str) -> Result<String> {
        wrap(
            "getNoteBody",
            Some(json!(note_id)),
            self.inner.get_note_body(note_id),
        )
        .await
    }

    async fn get_note_html(&self, note_id: &str) -> Result<String> {
        wrap(
            "getNoteHtml",
            Some(json!(note_id)),
            self.inner.get_note_html(note_id),
        )
        .await
    }

    async fn update_note_body(&self, note_id: &str, body: &str) -> Result<()> {
        let args = Some(json!({ "noteId": note_id, "bodyLen": utf16_len(body) }));
        wrap(
            "updateNoteBody",
            args,
            self.inner.update_note_body(note_id, body),
        )
        .await
    }

    async fn get_folder_snippets(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        let args = Some(json!(folder_ids));
        wrap(
            "getFolderSnippets",
            args,
            self.inner.get_folder_snippets(folder_ids),
        )
        .await
    }

    async fn get_folder_bodies(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        let args = Some(json!(format!("{} folders", folder_ids.len())));
        wrap(
            "getFolderBodies",
            args,
            self.inner.get_folder_bodies(folder_ids),
        )
        .await
    }

    async fn move_notes(&self, moves: &[Move]) -> Result<Vec<MoveResult>> {
        let args = Some(json!(format!("{} moves", moves.len())));
        wrap("moveNotes", args, self.inner.move_notes(moves)).await
    }

    async fn create_note(&self, folder_id: &str) -> Result<()> {
        wrap(
            "createNote",
            Some(json!(folder_id)),
            self.inner.create_note(folder_id),
        )
        .await
    }

    async fn create_folder(&self, account_name: &str, name: &str) -> Result<()> {
        let args = Some(json!({ "accountName": account_name, "name": name }));
        wrap(
            "createFolder",
            args,
            self.inner.create_folder(account_name, name),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_args_like_the_ts_logger() {
        assert_eq!(fmt_args(&None), "()");
        assert_eq!(fmt_args(&Some(json!(["f1"]))), r#"(["f1"])"#);
        let long = fmt_args(&Some(json!("x".repeat(100))));
        assert!(long.ends_with("...)"));
        assert_eq!(utf16_len(&long), 57 + "(...)".len());
    }

    #[test]
    fn percentile_clamps_to_the_last_sample() {
        assert_eq!(percentile(&[], 50), 0.0);
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 50), 3.0);
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 95), 4.0);
    }
}
