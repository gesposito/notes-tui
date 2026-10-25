//! osascript/JXA backend (port of `src/notes/osascript.ts`) — the default.
//!
//! The JXA scripts are kept verbatim from the TypeScript build so both send
//! identical Apple Events. The hot paths rely on property chains like
//! `account.folders.container.id()`, which the Notes scripting engine resolves
//! as a single Apple Event per property — O(properties), not O(items).

use std::process::Stdio;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::{Folder, FolderTexts, Move, MoveResult, Note, NotesBackend, dedupe_by_id};

#[derive(Debug, Clone, Copy, Default)]
pub struct OsascriptBackend;

/// Runs a JXA script through `osascript -l JavaScript -` and returns stdout
/// verbatim (osascript appends a newline after the last expression's value;
/// `get_note_body` passes it through, like the TypeScript build).
///
/// Dropping the future kills the subprocess, which is how superseded reads
/// get cancelled.
pub async fn run_jxa(script: &str) -> Result<String> {
    let mut child = Command::new("osascript")
        .args(["-l", "JavaScript", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("failed to spawn osascript")?;
    if let Some(mut stdin) = child.stdin.take() {
        // A write error means osascript already exited; its status and stderr
        // below say why, so don't mask them with EPIPE.
        let _ = stdin.write_all(script.as_bytes()).await;
    }
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map_or_else(|| "signal".to_owned(), |c| c.to_string());
        bail!(
            "osascript failed (exit {code}): {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Serializes a value as a JS literal (JSON is a subset of JS since ES2019).
fn js<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).expect("plain data always serializes")
}

/// Fills `__PLACEHOLDER__` tokens in one pass over the template, so inserted
/// values are never rescanned for other tokens.
fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + 64);
    let mut rest = template;
    loop {
        let next = vars
            .iter()
            .filter_map(|&(key, value)| rest.find(key).map(|at| (at, key, value)))
            .min_by_key(|&(at, _, _)| at);
        match next {
            Some((at, key, value)) => {
                out.push_str(&rest[..at]);
                out.push_str(value);
                rest = &rest[at + key.len()..];
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

/// Wraps each line in `<div>` so newlines survive; empty lines become
/// `<br>`. Matches Apple Notes' own paragraph structure when it serializes.
pub fn body_to_html(body: &str) -> String {
    body.split('\n')
        .map(|line| {
            let escaped = line
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            if escaped.is_empty() {
                "<div><br></div>".to_owned()
            } else {
                format!("<div>{escaped}</div>")
            }
        })
        .collect()
}

#[async_trait]
impl NotesBackend for OsascriptBackend {
    async fn list_folders(&self) -> Result<Vec<Folder>> {
        let folders: Vec<Folder> = serde_json::from_str(&run_jxa(LIST_FOLDERS).await?)
            .context("unexpected listFolders output")?;
        Ok(dedupe_by_id(folders, |f| &f.id))
    }

    async fn get_folder_notes(&self, folder_ids: &[String]) -> Result<Vec<Note>> {
        if folder_ids.is_empty() {
            return Ok(Vec::new());
        }
        let script = fill(GET_FOLDER_NOTES, &[("__FOLDER_IDS__", &js(folder_ids))]);
        let notes: Vec<Note> = serde_json::from_str(&run_jxa(&script).await?)
            .context("unexpected getFolderNotes output")?;
        Ok(dedupe_by_id(notes, |n| &n.id))
    }

    async fn get_note_body(&self, note_id: &str) -> Result<String> {
        run_jxa(&fill(GET_NOTE_BODY, &[("__NOTE_ID__", &js(note_id))])).await
    }

    async fn get_note_html(&self, note_id: &str) -> Result<String> {
        run_jxa(&fill(GET_NOTE_HTML, &[("__NOTE_ID__", &js(note_id))])).await
    }

    async fn update_note_body(&self, note_id: &str, body: &str) -> Result<()> {
        let script = fill(
            UPDATE_NOTE_BODY,
            &[
                ("__NOTE_ID__", &js(note_id)),
                ("__HTML__", &js(&body_to_html(body))),
            ],
        );
        run_jxa(&script).await.map(drop)
    }

    async fn get_folder_snippets(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        if folder_ids.is_empty() {
            return Ok(FolderTexts::new());
        }
        let script = fill(GET_FOLDER_SNIPPETS, &[("__FOLDER_IDS__", &js(folder_ids))]);
        serde_json::from_str(&run_jxa(&script).await?)
            .context("unexpected getFolderSnippets output")
    }

    async fn get_folder_bodies(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        if folder_ids.is_empty() {
            return Ok(FolderTexts::new());
        }
        // Same shape as get_folder_snippets — one bulk plaintext() call per
        // folder — but keeps the full body so search can match anywhere.
        let script = fill(GET_FOLDER_BODIES, &[("__FOLDER_IDS__", &js(folder_ids))]);
        serde_json::from_str(&run_jxa(&script).await?).context("unexpected getFolderBodies output")
    }

    async fn move_notes(&self, moves: &[Move]) -> Result<Vec<MoveResult>> {
        if moves.is_empty() {
            return Ok(Vec::new());
        }
        let script = fill(MOVE_NOTES, &[("__MOVES__", &js(moves))]);
        serde_json::from_str(&run_jxa(&script).await?).context("unexpected moveNotes output")
    }

    async fn create_note(&self, folder_id: &str) -> Result<()> {
        run_jxa(&fill(CREATE_NOTE, &[("__FOLDER_ID__", &js(folder_id))]))
            .await
            .map(drop)
    }

    async fn create_folder(&self, account_name: &str, name: &str) -> Result<()> {
        let script = fill(
            CREATE_FOLDER,
            &[
                ("__ACCOUNT_NAME__", &js(account_name)),
                ("__NAME__", &js(name)),
            ],
        );
        run_jxa(&script).await.map(drop)
    }
}

// Bulk property-chain strategy: one Apple Event per property per account,
// regardless of folder count (~150 ms for 43 folders, vs ~1100 ms for the old
// per-folder container() + notes.length loop).
const LIST_FOLDERS: &str = r#"
  function compute(node, byId, accountSet) {
    if (!node || node._computed) return node;
    var pid = node.parentId;
    if (accountSet.has(pid) || !byId[pid]) {
      node.depth = 0;
      node.path = node.account + " / " + node.name;
    } else {
      var p = compute(byId[pid], byId, accountSet);
      node.depth = p.depth + 1;
      node.path = p.path + " / " + node.name;
    }
    node._computed = true;
    return node;
  }

  const Notes = Application("Notes");
  const accounts = Notes.accounts();
  const accountSet = new Set();
  for (var i = 0; i < accounts.length; i++) {
    accountSet.add(accounts[i].id());
  }

  const folderInfo = {};
  const orderedFolderIds = [];
  for (var i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const accountName = account.name();
    // Each of these is a single Apple Event that returns an array covering
    // every folder in the account; the Notes scripting engine evaluates the
    // property chains (folders.container.id, folders.notes.id) in one shot.
    const folderIds = account.folders.id();
    const folderNames = account.folders.name();
    const containerIds = account.folders.container.id();
    const noteIdArrays = account.folders.notes.id();
    for (var j = 0; j < folderIds.length; j++) {
      const fid = folderIds[j];
      folderInfo[fid] = {
        name: folderNames[j],
        parentId: containerIds[j],
        account: accountName,
        depth: 0,
        path: "",
        noteCount: noteIdArrays[j].length,
        _computed: false,
      };
      orderedFolderIds.push(fid);
    }
  }

  for (var i = 0; i < orderedFolderIds.length; i++) {
    compute(folderInfo[orderedFolderIds[i]], folderInfo, accountSet);
  }

  const out = [];
  for (var i = 0; i < orderedFolderIds.length; i++) {
    const id = orderedFolderIds[i];
    const n = folderInfo[id];
    out.push({
      id: id,
      name: n.name,
      account: n.account,
      path: n.path,
      depth: n.depth,
      noteCount: n.noteCount,
    });
  }
  out.sort(function (a, b) {
    const ap = a.path.toLowerCase();
    const bp = b.path.toLowerCase();
    return ap < bp ? -1 : ap > bp ? 1 : 0;
  });
  JSON.stringify(out);
"#;

// Per folder: 3 bulk events (id, name, modificationDate).
const GET_FOLDER_NOTES: &str = r#"
  const Notes = Application("Notes");
  const folderIds = __FOLDER_IDS__;
  const out = [];
  for (var f = 0; f < folderIds.length; f++) {
    const fid = folderIds[f];
    try {
      const folder = Notes.folders.byId(fid);
      const ids = folder.notes.id();
      const names = folder.notes.name();
      const dates = folder.notes.modificationDate();
      const count = Math.min(ids.length, names.length);
      for (var k = 0; k < count; k++) {
        const d = dates[k];
        out.push({
          id: ids[k],
          title: names[k],
          folderId: fid,
          modifiedAt: d ? d.toISOString() : null,
        });
      }
    } catch (e) {}
  }
  JSON.stringify(out);
"#;

const GET_NOTE_BODY: &str = r#"
  const Notes = Application("Notes");
  const note = Notes.notes.byId(__NOTE_ID__);
  note.plaintext();
"#;

const GET_NOTE_HTML: &str = r#"
  const Notes = Application("Notes");
  const note = Notes.notes.byId(__NOTE_ID__);
  note.body();
"#;

const GET_FOLDER_SNIPPETS: &str = r#"
  const Notes = Application("Notes");
  const folderIds = __FOLDER_IDS__;
  const out = {};
  for (let f = 0; f < folderIds.length; f++) {
    const fid = folderIds[f];
    try {
      const folder = Notes.folders.byId(fid);
      const ids = folder.notes.id();
      const plaintexts = folder.notes.plaintext();
      const snippets = {};
      for (let k = 0; k < ids.length; k++) {
        const text = plaintexts[k] || "";
        const lines = text.split("\n");
        let snippet = "";
        for (let l = 1; l < lines.length; l++) {
          const t = lines[l].replace(/\s+/g, " ").trim();
          if (t) { snippet = t; break; }
        }
        if (snippet.length > 120) snippet = snippet.substring(0, 120);
        snippets[ids[k]] = snippet;
      }
      out[fid] = snippets;
    } catch (e) {
      out[fid] = {};
    }
  }
  JSON.stringify(out);
"#;

const GET_FOLDER_BODIES: &str = r#"
  const Notes = Application("Notes");
  const folderIds = __FOLDER_IDS__;
  const out = {};
  for (let f = 0; f < folderIds.length; f++) {
    const fid = folderIds[f];
    try {
      const folder = Notes.folders.byId(fid);
      const ids = folder.notes.id();
      const plaintexts = folder.notes.plaintext();
      const bodies = {};
      for (let k = 0; k < ids.length; k++) {
        bodies[ids[k]] = plaintexts[k] || "";
      }
      out[fid] = bodies;
    } catch (e) {
      out[fid] = {};
    }
  }
  JSON.stringify(out);
"#;

const UPDATE_NOTE_BODY: &str = r#"
  const Notes = Application("Notes");
  const note = Notes.notes.byId(__NOTE_ID__);
  note.body = __HTML__;
"#;

const CREATE_NOTE: &str = r#"
  const Notes = Application("Notes");
  const folder = Notes.folders.byId(__FOLDER_ID__);
  Notes.make({ new: "note", at: folder });
"#;

const CREATE_FOLDER: &str = r#"
  const Notes = Application("Notes");
  const accounts = Notes.accounts();
  let account = null;
  for (let i = 0; i < accounts.length; i++) {
    if (accounts[i].name() === __ACCOUNT_NAME__) {
      account = accounts[i];
      break;
    }
  }
  if (!account) throw new Error("Account not found: " + __ACCOUNT_NAME__);
  Notes.make({
    new: "folder",
    at: account,
    withProperties: { name: __NAME__ },
  });
"#;

const MOVE_NOTES: &str = r#"
  const Notes = Application("Notes");
  const moves = __MOVES__;
  const results = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    try {
      const note = Notes.notes.byId(m.noteId);
      const folder = Notes.folders.byId(m.folderId);
      note.move({ to: folder });
      results.push({ noteId: m.noteId, ok: true });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      results.push({ noteId: m.noteId, ok: false, error: msg });
    }
  }
  JSON.stringify(results);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_to_html_wraps_lines_and_escapes() {
        assert_eq!(
            body_to_html("Title\n\na < b & c > d"),
            "<div>Title</div><div><br></div><div>a &lt; b &amp; c &gt; d</div>"
        );
    }

    #[test]
    fn fill_replaces_repeated_tokens_without_rescanning_values() {
        let out = fill(
            "a=__A__; b=__B__; again=__A__",
            &[("__A__", "\"has __B__ inside\""), ("__B__", "2")],
        );
        assert_eq!(
            out,
            "a=\"has __B__ inside\"; b=2; again=\"has __B__ inside\""
        );
    }

    #[test]
    fn scripts_embed_parameters_as_js_literals() {
        let ids = vec![
            "x-coredata://A/ICFolder/p1".to_owned(),
            "quote\"id".to_owned(),
        ];
        let script = fill(GET_FOLDER_NOTES, &[("__FOLDER_IDS__", &js(&ids))]);
        assert!(
            script.contains(r#"const folderIds = ["x-coredata://A/ICFolder/p1","quote\"id"];"#)
        );
        assert!(!script.contains("__FOLDER_IDS__"));

        let moves = vec![Move {
            note_id: "n1".into(),
            folder_id: "f2".into(),
        }];
        let script = fill(MOVE_NOTES, &[("__MOVES__", &js(&moves))]);
        assert!(script.contains(r#"const moves = [{"noteId":"n1","folderId":"f2"}];"#));
    }

    #[test]
    fn create_folder_fills_both_account_references() {
        let script = fill(
            CREATE_FOLDER,
            &[
                ("__ACCOUNT_NAME__", &js("iCloud")),
                ("__NAME__", &js("Q3 Plans")),
            ],
        );
        assert_eq!(script.matches("\"iCloud\"").count(), 2);
        assert!(script.contains(r#"withProperties: { name: "Q3 Plans" }"#));
    }
}
