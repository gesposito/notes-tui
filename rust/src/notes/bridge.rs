//! ScriptingBridge backend (port of `src/notes/scripting-bridge.ts`).
//!
//! Talks line-delimited JSON-RPC to the long-lived Swift helper in
//! `helper/notes-bridge`, avoiding a process spawn per call. Opt-in only:
//! SB's KVC key paths cost one Apple Event per element, so osa wins on the
//! bulk reads this app does. Methods the helper doesn't implement (bulk
//! bodies, creation, edits) defer to osa.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use futures::future::try_join_all;
use indexmap::IndexMap;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::oneshot;

use super::osascript::OsascriptBackend;
use super::{Folder, FolderTexts, Move, MoveResult, Note, NotesBackend};

type Reply = Result<Value, String>;

/// `NOTES_BRIDGE_HELPER` overrides the location; otherwise the helper is
/// expected next to this crate, in the repo's `helper/` dir.
pub fn default_helper_path() -> PathBuf {
    std::env::var_os("NOTES_BRIDGE_HELPER").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../helper/notes-bridge"),
        PathBuf::from,
    )
}

struct Helper {
    stdin: ChildStdin,
    // Held for kill_on_drop: dropping the backend kills the helper.
    _child: Child,
    generation: u64,
}

struct Inner {
    helper_path: PathBuf,
    proc: tokio::sync::Mutex<Option<Helper>>,
    /// Request id → (helper generation it was sent to, reply channel).
    pending: Mutex<HashMap<u64, (u64, oneshot::Sender<Reply>)>>,
    next_id: AtomicU64,
    generation: AtomicU64,
}

impl Inner {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, (u64, oneshot::Sender<Reply>)>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Drops a request's pending entry if its caller goes away before the reply
/// (a cancelled read); a late reply then finds no one waiting and is ignored.
struct PendingGuard<'a> {
    inner: &'a Inner,
    id: u64,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.inner.pending().remove(&self.id);
    }
}

pub struct ScriptingBridgeBackend {
    inner: Arc<Inner>,
    osa: OsascriptBackend,
}

impl Default for ScriptingBridgeBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl ScriptingBridgeBackend {
    pub fn new() -> Self {
        Self::with_helper(default_helper_path())
    }

    pub fn with_helper(helper_path: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                helper_path,
                proc: tokio::sync::Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                generation: AtomicU64::new(0),
            }),
            osa: OsascriptBackend,
        }
    }

    fn spawn_helper(&self) -> Result<Helper> {
        let path = &self.inner.helper_path;
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| {
                format!(
                    "failed to start the notes-bridge helper at {} (build it with `bun run build:helper`)",
                    path.display()
                )
            })?;
        let stdin = child.stdin.take().context("helper stdin unavailable")?;
        let stdout = child.stdout.take().context("helper stdout unavailable")?;
        let generation = self.inner.generation.fetch_add(1, Ordering::Relaxed) + 1;
        tokio::spawn(read_loop(Arc::downgrade(&self.inner), stdout, generation));
        Ok(Helper {
            stdin,
            _child: child,
            generation,
        })
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, params: Option<Value>) -> Result<T> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let _guard = PendingGuard {
            inner: &self.inner,
            id,
        };
        {
            let mut proc = self.inner.proc.lock().await;
            if proc.is_none() {
                *proc = Some(self.spawn_helper()?);
            }
            let helper = proc.as_mut().expect("helper was just spawned");
            self.inner.pending().insert(id, (helper.generation, tx));
            let mut request = json!({ "id": id, "method": method });
            if let Some(params) = params {
                request["params"] = params;
            }
            let mut line = request.to_string();
            line.push('\n');
            let written = async {
                helper.stdin.write_all(line.as_bytes()).await?;
                helper.stdin.flush().await
            }
            .await;
            if let Err(e) = written {
                // The helper is gone; forget it so the next call respawns.
                *proc = None;
                return Err(anyhow!(e).context("notes-bridge helper is not accepting requests"));
            }
        }
        let reply = rx
            .await
            .map_err(|_| anyhow!("notes-bridge helper exited"))?;
        let value = reply.map_err(|e| anyhow!(e))?;
        serde_json::from_value(value)
            .with_context(|| format!("unexpected {method} result from notes-bridge"))
    }
}

async fn read_loop(inner: Weak<Inner>, stdout: ChildStdout, generation: u64) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some(inner) = inner.upgrade() else { return };
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
            continue; // blank or malformed line
        };
        let Some(id) = msg.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some((_, tx)) = inner.pending().remove(&id) else {
            continue; // caller gave up
        };
        let reply = match msg.get("error").and_then(Value::as_str) {
            Some(err) if !err.is_empty() => Err(err.to_owned()),
            _ => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = tx.send(reply);
    }
    // Helper exited: forget the process so the next call respawns it, then
    // fail its in-flight requests (in that order, so a woken caller can't
    // retry against the dead pipe). Generations keep a late EOF from a dead
    // helper from touching its replacement or the requests sent to it.
    let Some(inner) = inner.upgrade() else { return };
    {
        let mut proc = inner.proc.lock().await;
        if proc.as_ref().is_some_and(|h| h.generation == generation) {
            *proc = None;
        }
    }
    let orphaned: Vec<oneshot::Sender<Reply>> = {
        let mut pending = inner.pending();
        let ids: Vec<u64> = pending
            .iter()
            .filter(|(_, (generation_of, _))| *generation_of == generation)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| pending.remove(&id).map(|(_, tx)| tx))
            .collect()
    };
    for tx in orphaned {
        let _ = tx.send(Err("notes-bridge helper exited".to_owned()));
    }
}

#[async_trait]
impl NotesBackend for ScriptingBridgeBackend {
    async fn list_folders(&self) -> Result<Vec<Folder>> {
        self.call("listFolders", None).await
    }

    async fn get_folder_notes(&self, folder_ids: &[String]) -> Result<Vec<Note>> {
        if folder_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.call("getFolderNotes", Some(json!({ "folderIds": folder_ids })))
            .await
    }

    async fn get_note_body(&self, note_id: &str) -> Result<String> {
        self.call("getNoteBody", Some(json!({ "noteId": note_id })))
            .await
    }

    async fn get_note_html(&self, note_id: &str) -> Result<String> {
        self.call("getNoteHtml", Some(json!({ "noteId": note_id })))
            .await
    }

    async fn update_note_body(&self, note_id: &str, body: &str) -> Result<()> {
        self.osa.update_note_body(note_id, body).await
    }

    async fn get_folder_snippets(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        // The helper takes one folder per call; with no spawn cost we fan out
        // and assemble the same shape osa returns.
        let per_folder = try_join_all(folder_ids.iter().map(|id| {
            self.call::<IndexMap<String, String>>(
                "getFolderSnippets",
                Some(json!({ "folderId": id })),
            )
        }))
        .await?;
        Ok(folder_ids.iter().cloned().zip(per_folder).collect())
    }

    // The search index calls this in chunks, so osa's per-call spawn cost
    // stays bounded.
    async fn get_folder_bodies(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        self.osa.get_folder_bodies(folder_ids).await
    }

    async fn move_notes(&self, moves: &[Move]) -> Result<Vec<MoveResult>> {
        self.call("moveNotes", Some(json!({ "moves": moves })))
            .await
    }

    // Creation is rare and the helper doesn't implement `make`; one extra
    // osascript spawn on the write path is fine.
    async fn create_note(&self, folder_id: &str) -> Result<()> {
        self.osa.create_note(folder_id).await
    }

    async fn create_folder(&self, account_name: &str, name: &str) -> Result<()> {
        self.osa.create_folder(account_name, name).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    // A stand-in helper speaking the same line protocol, so the client's
    // request matching, error propagation, and respawn logic run for real.
    const FAKE_HELPER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
  case "$line" in
    *'"noteId":"die"'*) exit 0 ;;
    *'"method":"listFolders"'*)
      printf '{"id":%s,"result":[{"id":"f1","name":"A","account":"iCloud","path":"iCloud / A","depth":0,"noteCount":2}]}\n' "$id" ;;
    *'"method":"getNoteBody"'*) printf '\n{"id":%s,"result":"body of note"}\n' "$id" ;;
    *'"method":"getFolderSnippets"'*) printf '{"id":%s,"result":{"n1":"snip"}}\n' "$id" ;;
    *) printf '{"id":%s,"error":"unknown method"}\n' "$id" ;;
  esac
done
"#;

    fn fake_helper() -> (tempfile::TempDir, ScriptingBridgeBackend) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake-bridge");
        std::fs::write(&path, FAKE_HELPER).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, ScriptingBridgeBackend::with_helper(path))
    }

    #[tokio::test]
    async fn round_trips_requests_through_the_helper() {
        let (_dir, sb) = fake_helper();
        let folders = sb.list_folders().await.unwrap();
        assert_eq!(folders[0].path, "iCloud / A");
        assert_eq!(folders[0].note_count, 2);
        assert_eq!(sb.get_note_body("n1").await.unwrap(), "body of note");

        let snippets = sb
            .get_folder_snippets(&["f1".to_owned(), "f2".to_owned()])
            .await
            .unwrap();
        assert_eq!(snippets.keys().collect::<Vec<_>>(), ["f1", "f2"]);
        assert_eq!(snippets["f2"]["n1"], "snip");
    }

    #[tokio::test]
    async fn surfaces_helper_errors() {
        let (_dir, sb) = fake_helper();
        let err = sb.get_note_html("n1").await.unwrap_err();
        assert_eq!(err.to_string(), "unknown method");
    }

    #[tokio::test]
    async fn fails_in_flight_requests_when_the_helper_dies_then_respawns() {
        let (_dir, sb) = fake_helper();
        let err = sb.get_note_body("die").await.unwrap_err();
        assert_eq!(err.to_string(), "notes-bridge helper exited");
        assert_eq!(sb.get_note_body("n1").await.unwrap(), "body of note");
    }

    #[tokio::test]
    async fn reports_a_missing_helper_binary() {
        let sb = ScriptingBridgeBackend::with_helper(PathBuf::from("/no/such/notes-bridge"));
        let err = sb.list_folders().await.unwrap_err();
        assert!(err.to_string().contains("bun run build:helper"), "{err:#}");
    }
}
