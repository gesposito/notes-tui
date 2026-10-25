//! In-memory `NotesBackend` for tests and the `mock_tui` example. Records
//! every call, and applies writes to its own data so the UI reflects them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use tokio::sync::Notify;

use super::sqlite_body::snippet_from_text;
use super::{Folder, FolderTexts, Move, MoveResult, Note, NotesBackend};
use crate::text::cmp_utf16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Call {
    ListFolders,
    GetFolderNotes(Vec<String>),
    GetNoteBody(String),
    GetNoteHtml(String),
    UpdateNoteBody { note_id: String, body: String },
    GetFolderSnippets(Vec<String>),
    GetFolderBodies(Vec<String>),
    MoveNotes(Vec<Move>),
    CreateNote(String),
    CreateFolder { account: String, name: String },
}

#[derive(Default)]
struct Data {
    folders: Vec<Folder>,
    notes: Vec<Note>,
    bodies: HashMap<String, String>,
    calls: Vec<Call>,
    list_folders_error: Option<String>,
    created: usize,
}

#[derive(Default)]
pub struct MockBackend {
    data: Mutex<Data>,
    gate: Mutex<Option<Arc<Notify>>>,
}

pub fn folder(id: &str, name: &str, path: &str, depth: u32, note_count: u32) -> Folder {
    Folder {
        id: id.into(),
        name: name.into(),
        account: path.split(" / ").next().unwrap_or_default().into(),
        path: path.into(),
        depth,
        note_count,
    }
}

pub fn note(id: &str, title: &str, folder_id: &str, modified_at: &str) -> Note {
    Note {
        id: id.into(),
        title: title.into(),
        folder_id: folder_id.into(),
        modified_at: Some(modified_at.into()),
    }
}

impl MockBackend {
    pub fn new(folders: Vec<Folder>, notes: Vec<Note>) -> Self {
        Self {
            data: Mutex::new(Data {
                folders,
                notes,
                ..Data::default()
            }),
            gate: Mutex::new(None),
        }
    }

    /// Bodies by note id; notes without one read as `Body of <id>`.
    pub fn with_bodies<'a>(self, bodies: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        self.lock().bodies.extend(
            bodies
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v.to_owned())),
        );
        self
    }

    /// Makes `list_folders` wait until the returned handle is notified.
    pub fn gate_list_folders(&self) -> Arc<Notify> {
        let notify = Arc::new(Notify::new());
        *self.gate.lock().unwrap() = Some(notify.clone());
        notify
    }

    pub fn fail_list_folders(&self, message: &str) {
        self.lock().list_folders_error = Some(message.to_owned());
    }

    pub fn calls(&self) -> Vec<Call> {
        self.lock().calls.clone()
    }

    fn lock(&self) -> MutexGuard<'_, Data> {
        self.data.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn log(&self, call: Call) -> MutexGuard<'_, Data> {
        let mut data = self.lock();
        data.calls.push(call);
        data
    }
}

impl Data {
    fn body(&self, id: &str) -> String {
        self.bodies
            .get(id)
            .cloned()
            .unwrap_or_else(|| format!("Body of {id}"))
    }

    fn texts(&self, folder_ids: &[String], f: impl Fn(String) -> String) -> FolderTexts {
        folder_ids
            .iter()
            .map(|fid| {
                let by_note = self
                    .notes
                    .iter()
                    .filter(|n| &n.folder_id == fid)
                    .map(|n| (n.id.clone(), f(self.body(&n.id))))
                    .collect();
                (fid.clone(), by_note)
            })
            .collect()
    }
}

#[async_trait]
impl NotesBackend for MockBackend {
    async fn list_folders(&self) -> Result<Vec<Folder>> {
        drop(self.log(Call::ListFolders));
        let gate = self.gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.notified().await;
        }
        let data = self.lock();
        match &data.list_folders_error {
            Some(msg) => Err(anyhow!(msg.clone())),
            None => Ok(data.folders.clone()),
        }
    }

    async fn get_folder_notes(&self, folder_ids: &[String]) -> Result<Vec<Note>> {
        let data = self.log(Call::GetFolderNotes(folder_ids.to_vec()));
        Ok(data
            .notes
            .iter()
            .filter(|n| folder_ids.contains(&n.folder_id))
            .cloned()
            .collect())
    }

    async fn get_note_body(&self, note_id: &str) -> Result<String> {
        Ok(self.log(Call::GetNoteBody(note_id.into())).body(note_id))
    }

    async fn get_note_html(&self, note_id: &str) -> Result<String> {
        let body = self.log(Call::GetNoteHtml(note_id.into())).body(note_id);
        Ok(format!("<p>{body}</p>"))
    }

    async fn update_note_body(&self, note_id: &str, body: &str) -> Result<()> {
        let mut data = self.log(Call::UpdateNoteBody {
            note_id: note_id.into(),
            body: body.into(),
        });
        data.bodies.insert(note_id.into(), body.into());
        // Apple regenerates the title from the first line.
        let title = body.lines().next().unwrap_or_default().to_owned();
        if let Some(n) = data.notes.iter_mut().find(|n| n.id == note_id) {
            n.title = title;
        }
        Ok(())
    }

    async fn get_folder_snippets(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        let data = self.log(Call::GetFolderSnippets(folder_ids.to_vec()));
        Ok(data.texts(folder_ids, |body| snippet_from_text(&body)))
    }

    async fn get_folder_bodies(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        let data = self.log(Call::GetFolderBodies(folder_ids.to_vec()));
        Ok(data.texts(folder_ids, |body| body))
    }

    async fn move_notes(&self, moves: &[Move]) -> Result<Vec<MoveResult>> {
        let mut data = self.log(Call::MoveNotes(moves.to_vec()));
        Ok(moves
            .iter()
            .map(|m| {
                let found = data.notes.iter_mut().find(|n| n.id == m.note_id);
                let ok = found.is_some();
                if let Some(n) = found {
                    n.folder_id = m.folder_id.clone();
                }
                MoveResult {
                    note_id: m.note_id.clone(),
                    ok,
                    error: (!ok).then(|| "note not found".to_owned()),
                }
            })
            .collect())
    }

    async fn create_note(&self, folder_id: &str) -> Result<()> {
        let mut data = self.log(Call::CreateNote(folder_id.into()));
        data.created += 1;
        let id = format!("mock-note-{}", data.created);
        data.notes
            .push(note(&id, "New Note", folder_id, "2026-10-25T12:00:00.000Z"));
        Ok(())
    }

    async fn create_folder(&self, account_name: &str, name: &str) -> Result<()> {
        let mut data = self.log(Call::CreateFolder {
            account: account_name.into(),
            name: name.into(),
        });
        data.created += 1;
        let id = format!("mock-folder-{}", data.created);
        data.folders
            .push(folder(&id, name, &format!("{account_name} / {name}"), 0, 0));
        data.folders
            .sort_by(|a, b| cmp_utf16(&a.path.to_lowercase(), &b.path.to_lowercase()));
        Ok(())
    }
}
