//! Backend-agnostic types and the `NotesBackend` trait — the Rust mirror of
//! `src/notes/types.ts` + `src/notes/index.ts`.
//!
//! Serialized field names match the TypeScript shapes (camelCase) so the
//! `notes` CLI prints the same JSON as the Bun build.

pub mod bridge;
pub mod logging;
pub mod mock;
pub mod osascript;
pub mod sqlite;
pub mod sqlite_body;

use std::fmt;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub account: String,
    pub path: String,
    pub depth: u32,
    /// Direct note count (notes whose container is this folder, not descendants).
    pub note_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub folder_id: String,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResult {
    pub note_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    pub note_id: String,
    pub folder_id: String,
}

/// `{ folderId: { noteId: text } }`, in the order the backend produced it.
pub type FolderTexts = IndexMap<String, IndexMap<String, String>>;

/// Read paths are cancelled by dropping the returned future: the osascript
/// and helper processes are spawned with `kill_on_drop`, so a superseded
/// fetch (the user moved the cursor) doesn't keep running. Callers must not
/// drop write futures mid-flight — we never want to abort a half-done
/// move/create/edit.
#[async_trait]
pub trait NotesBackend: Send + Sync {
    /// Folders + their direct note counts. Fast: no per-note fetches.
    async fn list_folders(&self) -> Result<Vec<Folder>>;
    /// Per-folder note metadata (id/title/date). One backend call regardless
    /// of how many folders. Returns the merged list; use `folder_id` to group.
    async fn get_folder_notes(&self, folder_ids: &[String]) -> Result<Vec<Note>>;
    async fn get_note_body(&self, note_id: &str) -> Result<String>;
    /// Returns the HTML body (richer than plaintext — preserves checklists).
    async fn get_note_html(&self, note_id: &str) -> Result<String>;
    /// Replace a note's body. `body` is plain text; each line is wrapped in
    /// `<div>` so Apple Notes preserves line breaks. Rich formatting in the
    /// original is lost on round-trip (see EDITING.md).
    async fn update_note_body(&self, note_id: &str, body: &str) -> Result<()>;
    /// Batched second-line snippets: `{ folderId: { noteId: snippet } }`.
    async fn get_folder_snippets(&self, folder_ids: &[String]) -> Result<FolderTexts>;
    /// Batched full plaintext, same shape as `get_folder_snippets`. Feeds the
    /// search index so filtering can match body content.
    async fn get_folder_bodies(&self, folder_ids: &[String]) -> Result<FolderTexts>;
    async fn move_notes(&self, moves: &[Move]) -> Result<Vec<MoveResult>>;
    /// Create a blank note in the given folder.
    async fn create_note(&self, folder_id: &str) -> Result<()>;
    /// Create a top-level folder in the named account.
    async fn create_folder(&self, account_name: &str, name: &str) -> Result<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendChoice {
    Osa,
    ScriptingBridge,
    Sqlite,
}

impl BackendChoice {
    /// Display order in the backend picker.
    pub const ALL: [BackendChoice; 3] = [Self::Osa, Self::ScriptingBridge, Self::Sqlite];

    /// The value accepted by `NOTES_BACKEND` and stored in settings.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Osa => "osa",
            Self::ScriptingBridge => "scripting-bridge",
            Self::Sqlite => "sqlite",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Osa => "osascript (default)",
            Self::ScriptingBridge => "scripting-bridge (Swift helper)",
            Self::Sqlite => "sqlite (NoteStore.sqlite, needs FDA)",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == s)
    }

    /// `NOTES_BACKEND`, defaulting to osa (see the backend-scaling notes in
    /// the README: osa is the right default for bulk reads).
    pub fn from_env() -> Self {
        std::env::var("NOTES_BACKEND")
            .ok()
            .and_then(|v| Self::parse(&v))
            .unwrap_or(Self::Osa)
    }
}

impl fmt::Display for BackendChoice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `DEBUG=1` wraps backends with per-call timing (see `logging`).
pub fn debug_enabled() -> bool {
    std::env::var("DEBUG").is_ok_and(|v| v == "1")
}

/// Fresh backend instance for `choice`, optionally wrapped with logging.
/// Callers that switch backends at runtime should cache instances (the TUI
/// does) so the scripting-bridge helper process is reused.
pub fn make_backend(choice: BackendChoice, debug: bool) -> Arc<dyn NotesBackend> {
    let base: Arc<dyn NotesBackend> = match choice {
        BackendChoice::Osa => Arc::new(osascript::OsascriptBackend),
        BackendChoice::ScriptingBridge => Arc::new(bridge::ScriptingBridgeBackend::new()),
        BackendChoice::Sqlite => Arc::new(sqlite::SqliteBackend::new(sqlite::default_db_path())),
    };
    if debug {
        Arc::new(logging::LoggingBackend::new(base))
    } else {
        base
    }
}

/// Notes.app can surface the same item under multiple specifiers (smart
/// folders, "Recently Deleted"). Dedupe by id, keeping the first occurrence.
pub(crate) fn dedupe_by_id<T>(items: Vec<T>, id: impl Fn(&T) -> &str) -> Vec<T> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert(id(item).to_owned()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_choice_round_trips_through_its_string_form() {
        for c in BackendChoice::ALL {
            assert_eq!(BackendChoice::parse(c.as_str()), Some(c));
            assert_eq!(serde_json::to_string(&c).unwrap(), format!("\"{c}\""));
        }
        assert_eq!(BackendChoice::parse("bogus"), None);
    }

    #[test]
    fn move_result_omits_error_when_ok() {
        let ok = MoveResult {
            note_id: "n1".into(),
            ok: true,
            error: None,
        };
        assert_eq!(
            serde_json::to_string(&ok).unwrap(),
            r#"{"noteId":"n1","ok":true}"#
        );
    }

    #[test]
    fn dedupe_keeps_first_occurrence() {
        let out = dedupe_by_id(vec![("a", 1), ("b", 2), ("a", 3)], |t| t.0);
        assert_eq!(out, vec![("a", 1), ("b", 2)]);
    }
}
