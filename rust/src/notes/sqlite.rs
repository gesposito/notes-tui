//! Read-only NoteStore.sqlite backend (port of `src/notes/sqlite.ts`).
//!
//! Metadata comes straight from the Core-Data-shaped SQLite store — no Apple
//! Events — which needs Full Disk Access. Bodies are decoded from the gzipped
//! protobuf (see `sqlite_body`), falling back to osa per note when a blob
//! can't be decoded. HTML and every write go through osa: touching the live
//! DB directly would corrupt the sync state.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use indexmap::IndexMap;
use rusqlite::{Connection, OpenFlags, params_from_iter};

use super::osascript::OsascriptBackend;
use super::sqlite_body::{extract_note_text, snippet_from_text};
use super::{Folder, FolderTexts, Move, MoveResult, Note, NotesBackend};
use crate::text::cmp_utf16;

/// Stable across recent macOS versions; if Apple moves it, the open error
/// says so directly.
pub fn default_db_path() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join("Library/Group Containers/group.com.apple.notes/NoteStore.sqlite")
}

/// macOS privacy protection (TCC) refused to open NoteStore.sqlite: the
/// process needs Full Disk Access. Displays as the actionable hint, and the
/// TUI recognizes it to offer opening System Settings.
#[derive(Debug)]
pub struct FullDiskAccessRequired {
    pub path: PathBuf,
}

impl std::fmt::Display for FullDiskAccessRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&fda_hint(&self.path))
    }
}

impl std::error::Error for FullDiskAccessRequired {}

/// Whether `e` (or anything it wraps) is a missing Full Disk Access grant.
pub fn needs_full_disk_access(e: &anyhow::Error) -> bool {
    e.chain().any(|cause| cause.is::<FullDiskAccessRequired>())
}

fn fda_hint(path: &Path) -> String {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "the notes binary".to_owned());
    format!(
        "FullDiskAccessRequired: cannot read {path}.

The SQLite backend needs Full Disk Access. Grant it to this binary:

  {exe}

`notes grant-fda` opens the right Settings pane and reveals the binaries in
Finder (or: open \"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles\").
The binary answers for itself in macOS privacy checks when it reads the
database, so the grant applies even when it's started from a terminal. Each
`cargo build` changes the binary's identity: re-add it after rebuilding.
",
        path = path.display()
    )
}

/// Opens NoteStore.sqlite read-only, turning the inevitable missing-FDA
/// failure into the actionable hint above instead of SQLite's generic
/// "unable to open database file".
pub fn open_notes_sqlite(path: &Path) -> Result<Connection> {
    // TCC denials surface as EPERM on a plain open; SQLite would hide that.
    if let Err(e) = std::fs::File::open(path) {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            return Err(FullDiskAccessRequired {
                path: path.to_owned(),
            }
            .into());
        }
        return Err(anyhow!(e).context(format!("cannot open {}", path.display())));
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .and_then(|conn| {
        // Probe with a real query so permission failures land here rather
        // than at the first SELECT against ZICCLOUDSYNCINGOBJECT.
        conn.query_row("SELECT 1", [], |_| Ok(()))?;
        Ok(conn)
    });
    conn.map_err(|e| {
        let msg = e.to_string();
        if msg.contains("authorization denied") || msg.contains("Operation not permitted") {
            FullDiskAccessRequired {
                path: path.to_owned(),
            }
            .into()
        } else {
            anyhow!(e).context(format!("cannot open {}", path.display()))
        }
    })
}

// osa hands out IDs as Core Data managed-object URIs:
//   x-coredata://<store-uuid>/<entity-name>/p<Z_PK>
// We produce the same (the store UUID is Z_METADATA.Z_UUID), so IDs from
// this backend can go straight to the osa-backed writes.
fn pk_to_uri(store_uuid: &str, entity: &str, pk: i64) -> String {
    format!("x-coredata://{store_uuid}/{entity}/p{pk}")
}

fn uri_to_pk(uri: &str) -> Option<i64> {
    let rest = uri.strip_prefix("x-coredata://")?;
    let mut parts = rest.split('/');
    let (store, entity, pk) = (parts.next()?, parts.next()?, parts.next()?);
    let digits = pk.strip_prefix('p')?;
    if parts.next().is_some()
        || store.is_empty()
        || entity.is_empty()
        || digits.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    digits.parse().ok()
}

/// Core Data dates are seconds since 2001-01-01. Same truncation as JS
/// `new Date(ms).toISOString()`.
fn core_data_to_iso(seconds: f64) -> Option<String> {
    let ms = ((seconds + 978_307_200.0) * 1000.0).trunc();
    if !ms.is_finite() {
        return None;
    }
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

// Core Data maps entity names to numeric Z_ENT discriminators through
// Z_PRIMARYKEY; the numbers vary across macOS versions, so resolve them.
#[derive(Clone, Copy)]
struct EntityIds {
    folder: i64,
    note: i64,
    account: i64,
}

struct State {
    conn: Connection,
    entities: Option<EntityIds>,
    store_uuid: Option<String>,
}

impl State {
    fn store_uuid(&mut self) -> Result<String> {
        if let Some(uuid) = &self.store_uuid {
            return Ok(uuid.clone());
        }
        let uuid: Option<String> = self
            .conn
            .query_row("SELECT Z_UUID FROM Z_METADATA", [], |r| r.get(0))
            .context("reading Z_METADATA")?;
        let uuid = uuid
            .filter(|u| !u.is_empty())
            .ok_or_else(|| anyhow!("Z_METADATA has no Z_UUID — corrupt or unexpected schema"))?;
        self.store_uuid = Some(uuid.clone());
        Ok(uuid)
    }

    // Schema per public reverse-engineering work (apple_cloud_notes_parser,
    // apple-notes-liberator); `notes inspect` dumps the live one.
    fn entities(&mut self) -> Result<EntityIds> {
        if let Some(e) = self.entities {
            return Ok(e);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT Z_NAME, Z_ENT FROM Z_PRIMARYKEY")?;
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let find = |candidates: &[&str]| -> Result<i64> {
            candidates
                .iter()
                .find_map(|name| rows.iter().find(|(n, _)| n == name).map(|(_, ent)| *ent))
                .ok_or_else(|| {
                    anyhow!(
                        "Schema mismatch: none of [{}] in Z_PRIMARYKEY. Run `notes inspect` to dump your schema.",
                        candidates.join(", ")
                    )
                })
        };
        let entities = EntityIds {
            folder: find(&["ICFolder", "Folder"])?,
            note: find(&["ICNote", "Note"])?,
            account: find(&["ICAccount", "Account"])?,
        };
        self.entities = Some(entities);
        Ok(entities)
    }

    fn list_folders(&mut self) -> Result<Vec<Folder>> {
        let ent = self.entities()?;
        let store_uuid = self.store_uuid()?;

        struct Row {
            pk: i64,
            name: Option<String>,
            parent_pk: Option<i64>,
            account_name: Option<String>,
        }
        // The folder→account FK lives in a different ZACCOUNT slot depending
        // on the macOS version (ZACCOUNT4 older, ZACCOUNT8 newer); each row
        // has only one populated, so COALESCE is version-agnostic.
        // ZMARKEDFORDELETION filters folders trashed but not yet purged.
        let sql = format!(
            "SELECT
               f.Z_PK    AS pk,
               f.ZTITLE2 AS name,
               f.ZPARENT AS parentPk,
               a.ZNAME   AS accountName
             FROM ZICCLOUDSYNCINGOBJECT f
             LEFT JOIN ZICCLOUDSYNCINGOBJECT a
               ON a.Z_PK = COALESCE(
                   f.ZACCOUNT, f.ZACCOUNT1, f.ZACCOUNT2, f.ZACCOUNT3,
                   f.ZACCOUNT4, f.ZACCOUNT5, f.ZACCOUNT6, f.ZACCOUNT7,
                   f.ZACCOUNT8
                 ) AND a.Z_ENT = {account}
             WHERE f.Z_ENT = {folder}
               AND COALESCE(f.ZMARKEDFORDELETION, 0) = 0
             ORDER BY f.Z_PK",
            account = ent.account,
            folder = ent.folder,
        );
        let rows: Vec<Row> = self
            .conn
            .prepare(&sql)?
            .query_map([], |r| {
                Ok(Row {
                    pk: r.get(0)?,
                    name: r.get(1)?,
                    parent_pk: r.get(2)?,
                    account_name: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        // Direct note counts per folder. May lag Notes.app slightly — it
        // flushes its in-memory state periodically.
        let count_sql = format!(
            "SELECT n.ZFOLDER AS folderPk, COUNT(*) AS n
             FROM ZICCLOUDSYNCINGOBJECT n
             WHERE n.Z_ENT = {note}
               AND COALESCE(n.ZMARKEDFORDELETION, 0) = 0
             GROUP BY n.ZFOLDER",
            note = ent.note,
        );
        let counts: HashMap<i64, u32> = self
            .conn
            .prepare(&count_sql)?
            .query_map([], |r| {
                let folder: Option<i64> = r.get(0)?;
                let n: i64 = r.get(1)?;
                Ok((folder, n))
            })?
            .filter_map(|r| match r {
                Ok((Some(folder), n)) => Some(Ok((folder, u32::try_from(n).unwrap_or(u32::MAX)))),
                Ok((None, _)) => None,
                Err(e) => Some(Err(e)),
            })
            .collect::<rusqlite::Result<_>>()?;

        let by_pk: HashMap<i64, &Row> = rows.iter().map(|r| (r.pk, r)).collect();
        let mut memo: HashMap<i64, (u32, String)> = HashMap::new();
        fn compute(
            pk: i64,
            by_pk: &HashMap<i64, &Row>,
            memo: &mut HashMap<i64, (u32, String)>,
            visiting: &mut HashSet<i64>,
        ) -> (u32, String) {
            if let Some(hit) = memo.get(&pk) {
                return hit.clone();
            }
            let row = by_pk[&pk];
            let name = row.name.as_deref().unwrap_or_default();
            visiting.insert(pk);
            // A parent cycle (corrupt store) is treated as a root rather
            // than recursing forever.
            let parent = row
                .parent_pk
                .filter(|p| by_pk.contains_key(p) && !visiting.contains(p));
            let entry = match parent {
                None => (
                    0,
                    format!(
                        "{} / {name}",
                        row.account_name.as_deref().unwrap_or("Local")
                    ),
                ),
                Some(parent) => {
                    let (depth, path) = compute(parent, by_pk, memo, visiting);
                    (depth + 1, format!("{path} / {name}"))
                }
            };
            visiting.remove(&pk);
            memo.insert(pk, entry.clone());
            entry
        }

        let mut out: Vec<Folder> = rows
            .iter()
            .map(|r| {
                let (depth, path) = compute(r.pk, &by_pk, &mut memo, &mut HashSet::new());
                Folder {
                    id: pk_to_uri(&store_uuid, "ICFolder", r.pk),
                    name: r.name.clone().unwrap_or_default(),
                    account: r.account_name.clone().unwrap_or_else(|| "Local".to_owned()),
                    path,
                    depth,
                    note_count: counts.get(&r.pk).copied().unwrap_or(0),
                }
            })
            .collect();
        out.sort_by(|a, b| cmp_utf16(&a.path.to_lowercase(), &b.path.to_lowercase()));
        Ok(out)
    }

    fn get_folder_notes(&mut self, folder_pks: &[i64]) -> Result<Vec<Note>> {
        let ent = self.entities()?;
        let store_uuid = self.store_uuid()?;
        let sql = format!(
            "SELECT
               n.Z_PK               AS notePk,
               n.ZTITLE1            AS title,
               n.ZMODIFICATIONDATE1 AS modifiedAt,
               n.ZFOLDER            AS folderPk
             FROM ZICCLOUDSYNCINGOBJECT n
             WHERE n.Z_ENT = {note}
               AND COALESCE(n.ZMARKEDFORDELETION, 0) = 0
               AND n.ZFOLDER IN ({ph})",
            note = ent.note,
            ph = placeholders(folder_pks.len()),
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let notes = stmt
            .query_map(params_from_iter(folder_pks), |r| {
                let note_pk: i64 = r.get(0)?;
                let title: Option<String> = r.get(1)?;
                let modified: Option<f64> = r.get(2)?;
                let folder_pk: i64 = r.get(3)?;
                Ok(Note {
                    id: pk_to_uri(&store_uuid, "ICNote", note_pk),
                    title: title.unwrap_or_default(),
                    folder_id: pk_to_uri(&store_uuid, "ICFolder", folder_pk),
                    modified_at: modified.and_then(core_data_to_iso),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(notes)
    }

    /// Bodies decoded from ZDATA, plus the (folder, note) URIs that need the
    /// osa fallback (encrypted notes, schema mismatch).
    fn get_folder_bodies(
        &mut self,
        folder_pks: &[i64],
    ) -> Result<(FolderTexts, Vec<(String, String)>)> {
        let ent = self.entities()?;
        let store_uuid = self.store_uuid()?;
        // Single JOIN: every note in the requested folders + its body blob.
        // ZICNOTEDATA holds one row per note, joined via ZNOTE.
        let sql = format!(
            "SELECT
               n.Z_PK    AS notePk,
               n.ZFOLDER AS folderPk,
               d.ZDATA   AS zdata
             FROM ZICCLOUDSYNCINGOBJECT n
             LEFT JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
             WHERE n.Z_ENT = {note}
               AND COALESCE(n.ZMARKEDFORDELETION, 0) = 0
               AND n.ZFOLDER IN ({ph})",
            note = ent.note,
            ph = placeholders(folder_pks.len()),
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(folder_pks))?;
        let mut out = FolderTexts::new();
        let mut fallback = Vec::new();
        while let Some(r) = rows.next()? {
            let note_pk: i64 = r.get(0)?;
            let folder_pk: i64 = r.get(1)?;
            let zdata: Option<Vec<u8>> = r.get(2)?;
            let folder_uri = pk_to_uri(&store_uuid, "ICFolder", folder_pk);
            let note_uri = pk_to_uri(&store_uuid, "ICNote", note_pk);
            let text = zdata.as_deref().and_then(extract_note_text);
            if text.is_none() {
                fallback.push((folder_uri.clone(), note_uri.clone()));
            }
            out.entry(folder_uri)
                .or_default()
                .insert(note_uri, text.unwrap_or_default());
        }
        // Folders with zero notes still appear with an empty record, matching
        // osa's contract.
        for &pk in folder_pks {
            out.entry(pk_to_uri(&store_uuid, "ICFolder", pk))
                .or_default();
        }
        Ok((out, fallback))
    }

    fn note_zdata(&mut self, note_pk: i64) -> Result<Option<Vec<u8>>> {
        use rusqlite::OptionalExtension;
        let zdata: Option<Option<Vec<u8>>> = self
            .conn
            .query_row(
                "SELECT d.ZDATA AS zdata FROM ZICNOTEDATA d WHERE d.ZNOTE = ?",
                [note_pk],
                |r| r.get(0),
            )
            .optional()?;
        Ok(zdata.flatten())
    }
}

struct Inner {
    path: PathBuf,
    state: Mutex<Option<State>>,
}

impl Inner {
    // Lazy open, so constructing the backend (or never calling it) doesn't
    // fail on machines without FDA. A failed open isn't cached: the next call
    // retries, e.g. after the user grants access.
    fn with_state<T>(&self, f: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(State {
                conn: open_notes_sqlite(&self.path)?,
                entities: None,
                store_uuid: None,
            });
        }
        f(guard.as_mut().expect("state was just initialized"))
    }
}

pub struct SqliteBackend {
    inner: Arc<Inner>,
    osa: OsascriptBackend,
}

impl SqliteBackend {
    /// The path is injectable so tests (and `notes inspect`-style tooling)
    /// can point at a fixture file.
    pub fn new(path: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                path,
                state: Mutex::new(None),
            }),
            osa: OsascriptBackend,
        }
    }

    /// Runs a query on the blocking pool: SQLite and blob decoding are
    /// synchronous and would otherwise stall the async UI loop.
    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut State) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || inner.with_state(f))
            .await
            .context("sqlite worker failed")?
    }
}

/// Folder URIs → PKs, skipping anything that isn't one of our URIs (bad
/// caller input yields an empty result instead of an error).
fn folder_pks(folder_ids: &[String]) -> Vec<i64> {
    folder_ids.iter().filter_map(|id| uri_to_pk(id)).collect()
}

#[async_trait]
impl NotesBackend for SqliteBackend {
    async fn list_folders(&self) -> Result<Vec<Folder>> {
        self.blocking(State::list_folders).await
    }

    async fn get_folder_notes(&self, folder_ids: &[String]) -> Result<Vec<Note>> {
        let pks = folder_pks(folder_ids);
        if pks.is_empty() {
            return Ok(Vec::new());
        }
        self.blocking(move |s| s.get_folder_notes(&pks)).await
    }

    async fn get_note_body(&self, note_id: &str) -> Result<String> {
        let Some(pk) = uri_to_pk(note_id) else {
            return self.osa.get_note_body(note_id).await;
        };
        let zdata = self.blocking(move |s| s.note_zdata(pk)).await?;
        match zdata.as_deref().and_then(extract_note_text) {
            Some(text) => Ok(text),
            None => self.osa.get_note_body(note_id).await,
        }
    }

    // HTML would mean walking attribute_runs for formatting and attachments;
    // defer to osa.
    async fn get_note_html(&self, note_id: &str) -> Result<String> {
        self.osa.get_note_html(note_id).await
    }

    async fn update_note_body(&self, note_id: &str, body: &str) -> Result<()> {
        self.osa.update_note_body(note_id, body).await
    }

    async fn get_folder_snippets(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        let bodies = self.get_folder_bodies(folder_ids).await?;
        Ok(bodies
            .into_iter()
            .map(|(fid, by_note)| {
                let snippets: IndexMap<String, String> = by_note
                    .into_iter()
                    .map(|(nid, body)| (nid, snippet_from_text(&body)))
                    .collect();
                (fid, snippets)
            })
            .collect())
    }

    async fn get_folder_bodies(&self, folder_ids: &[String]) -> Result<FolderTexts> {
        let pks = folder_pks(folder_ids);
        if pks.is_empty() {
            return Ok(FolderTexts::new());
        }
        let (mut out, fallback) = self.blocking(move |s| s.get_folder_bodies(&pks)).await?;
        // Only undecodable notes touch osa, after the SQLite pass, so the
        // common all-decoded case skips Apple Events entirely.
        for (folder_uri, note_uri) in fallback {
            // On failure the body stays empty; the preview just shows blank.
            if let Ok(text) = self.osa.get_note_body(&note_uri).await
                && let Some(slot) = out.get_mut(&folder_uri).and_then(|m| m.get_mut(&note_uri))
            {
                *slot = text;
            }
        }
        Ok(out)
    }

    async fn move_notes(&self, moves: &[Move]) -> Result<Vec<MoveResult>> {
        self.osa.move_notes(moves).await
    }

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
    use crate::notes::sqlite_body::tests::build_zdata;

    // Fixture DB with the same shape NoteStore.sqlite has (Z_METADATA,
    // Z_PRIMARYKEY, a subset of ZICCLOUDSYNCINGOBJECT, ZICNOTEDATA). If
    // Apple's schema diverges, these keep passing but `notes inspect` on a
    // real machine reveals it.
    const UUID: &str = "AAAA1111-2222-3333-4444-BBBB55556666";

    fn folder_uri(pk: i64) -> String {
        pk_to_uri(UUID, "ICFolder", pk)
    }
    fn note_uri(pk: i64) -> String {
        pk_to_uri(UUID, "ICNote", pk)
    }

    // Core Data dates are seconds since 2001-01-01.
    fn cd_epoch(iso: &str) -> f64 {
        let t = chrono::DateTime::parse_from_rfc3339(iso).unwrap();
        (t.timestamp() - 978_307_200) as f64
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR, Z_PLIST BLOB);
             CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME TEXT NOT NULL);
             CREATE TABLE ZICCLOUDSYNCINGOBJECT (
               Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER TEXT,
               ZTITLE1 TEXT, ZTITLE2 TEXT, ZNAME TEXT, ZPARENT INTEGER,
               ZACCOUNT INTEGER, ZACCOUNT1 INTEGER, ZACCOUNT2 INTEGER, ZACCOUNT3 INTEGER,
               ZACCOUNT4 INTEGER, ZACCOUNT5 INTEGER, ZACCOUNT6 INTEGER, ZACCOUNT7 INTEGER,
               ZACCOUNT8 INTEGER, ZFOLDER INTEGER, ZMODIFICATIONDATE1 REAL,
               ZMARKEDFORDELETION INTEGER DEFAULT 0
             );
             CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);
             INSERT INTO Z_METADATA (Z_VERSION, Z_UUID) VALUES (1, 'AAAA1111-2222-3333-4444-BBBB55556666');
             INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME) VALUES (1, 'ICAccount'), (2, 'ICFolder'), (3, 'ICNote');
             INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNAME) VALUES (10, 1, 'acc-icloud', 'iCloud');
             -- ZACCOUNT8 holds the folder→account FK on macOS Tahoe.
             INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZACCOUNT8, ZPARENT) VALUES
               (20, 2, 'fld-inbox',   'Inbox',   10, NULL),
               (21, 2, 'fld-archive', 'Archive', 10, NULL),
               (22, 2, 'fld-old',     'Old',     10, 21),
               (23, 2, 'fld-empty',   'Empty',   10, NULL);",
        )
        .unwrap();
        let mut insert = db
            .prepare(
                "INSERT INTO ZICCLOUDSYNCINGOBJECT
                   (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZMODIFICATIONDATE1, ZMARKEDFORDELETION)
                 VALUES (?, 3, ?, ?, ?, ?, ?)",
            )
            .unwrap();
        for (pk, ident, title, folder, iso, deleted) in [
            (30, "note-1", "Plan A", 20, "2026-05-01T10:00:00Z", 0),
            (31, "note-2", "Plan B", 20, "2026-05-01T11:00:00Z", 0),
            (
                32,
                "note-3",
                "Quarterly report",
                21,
                "2026-04-30T10:00:00Z",
                0,
            ),
            (33, "note-4", "Old archived", 22, "2026-04-29T10:00:00Z", 0),
            // Marked for deletion: counts and note lists must skip it.
            (34, "note-5", "Deleted note", 20, "2026-04-28T10:00:00Z", 1),
        ] {
            insert
                .execute(rusqlite::params![
                    pk,
                    ident,
                    title,
                    folder,
                    cd_epoch(iso),
                    deleted
                ])
                .unwrap();
        }
        let mut data = db
            .prepare("INSERT INTO ZICNOTEDATA (ZNOTE, ZDATA) VALUES (?, ?)")
            .unwrap();
        data.execute(rusqlite::params![
            30,
            build_zdata("Plan A\nFirst draft of the Q3 forecast.")
        ])
        .unwrap();
        data.execute(rusqlite::params![
            31,
            build_zdata("Plan B\n\n  Alternate   path")
        ])
        .unwrap();
        drop((insert, data));
        db.close().unwrap();
        (dir, path)
    }

    #[tokio::test]
    async fn lists_folders_with_paths_uris_and_live_counts() {
        let (_dir, path) = fixture();
        let folders = SqliteBackend::new(path).list_folders().await.unwrap();
        let summary: Vec<(String, &str, &str, u32, u32)> = folders
            .iter()
            .map(|f| {
                (
                    f.id.clone(),
                    f.account.as_str(),
                    f.path.as_str(),
                    f.depth,
                    f.note_count,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (folder_uri(21), "iCloud", "iCloud / Archive", 0, 1),
                (folder_uri(22), "iCloud", "iCloud / Archive / Old", 1, 1),
                (folder_uri(23), "iCloud", "iCloud / Empty", 0, 0),
                // 2 live notes: note-5 is marked for deletion.
                (folder_uri(20), "iCloud", "iCloud / Inbox", 0, 2),
            ]
        );
        assert_eq!(folders[1].name, "Old");
    }

    #[tokio::test]
    async fn returns_notes_for_requested_folders_skipping_deleted_ones() {
        let (_dir, path) = fixture();
        let backend = SqliteBackend::new(path);
        let notes = backend
            .get_folder_notes(&[folder_uri(20), folder_uri(22)])
            .await
            .unwrap();
        let mut summary: Vec<String> = notes
            .iter()
            .map(|n| format!("{}|{}|{}", n.id, n.title, n.folder_id))
            .collect();
        summary.sort();
        assert_eq!(
            summary,
            vec![
                format!("{}|Plan A|{}", note_uri(30), folder_uri(20)),
                format!("{}|Plan B|{}", note_uri(31), folder_uri(20)),
                format!("{}|Old archived|{}", note_uri(33), folder_uri(22)),
            ]
        );
        let plan_a = notes.iter().find(|n| n.id == note_uri(30)).unwrap();
        assert_eq!(
            plan_a.modified_at.as_deref(),
            Some("2026-05-01T10:00:00.000Z")
        );
    }

    #[tokio::test]
    async fn empty_or_unrecognized_folder_ids_return_nothing() {
        let (_dir, path) = fixture();
        let backend = SqliteBackend::new(path);
        assert!(backend.get_folder_notes(&[]).await.unwrap().is_empty());
        let bogus = vec!["fld-inbox".to_owned(), "not-a-uri".to_owned()];
        assert!(backend.get_folder_notes(&bogus).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn decodes_bodies_and_snippets_and_keeps_empty_folders() {
        let (_dir, path) = fixture();
        let backend = SqliteBackend::new(path);
        let ids = [folder_uri(20), folder_uri(23)];
        let bodies = backend.get_folder_bodies(&ids).await.unwrap();
        assert_eq!(bodies.keys().cloned().collect::<Vec<_>>(), ids.to_vec());
        assert_eq!(
            bodies[&folder_uri(20)][&note_uri(30)],
            "Plan A\nFirst draft of the Q3 forecast."
        );
        assert!(bodies[&folder_uri(23)].is_empty());

        let snippets = backend.get_folder_snippets(&ids).await.unwrap();
        assert_eq!(snippets[&folder_uri(20)][&note_uri(31)], "Alternate path");
        assert_eq!(
            backend.get_note_body(&note_uri(30)).await.unwrap(),
            "Plan A\nFirst draft of the Q3 forecast."
        );
    }

    #[tokio::test]
    async fn opening_a_missing_store_is_an_error_not_an_empty_list() {
        let backend = SqliteBackend::new(PathBuf::from("/no/such/notes-store.sqlite"));
        let err = backend.list_folders().await.unwrap_err();
        assert!(!format!("{err:#}").is_empty());
    }

    #[test]
    fn parses_only_well_formed_coredata_uris() {
        assert_eq!(uri_to_pk(&folder_uri(42)), Some(42));
        assert_eq!(uri_to_pk("x-coredata://S/ICNote/p7"), Some(7));
        for bad in [
            "fld-inbox",
            "x-coredata://S/ICNote/7",
            "x-coredata://S/ICNote/p",
            "x-coredata:///ICNote/p1",
            "x-coredata://S/ICNote/p1/extra",
            "x-coredata://S/ICNote/p1x",
        ] {
            assert_eq!(uri_to_pk(bad), None, "{bad}");
        }
    }
}
