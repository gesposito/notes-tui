//! The `notes` CLI (port of `src/cli.ts`): a thin wrapper around the same
//! `NotesBackend` the TUI uses, for scripting Apple Notes from the shell.
//!
//!   notes folders | jq '.[] | select(.depth == 0)'
//!   notes search "q3 forecast" -f "$(notes folders | jq -r '.[0].id')"
//!   echo "new body" | notes update <NOTE_ID>
//!
//! Output is JSON on stdout (pretty by default, `-r` for compact), the same
//! shape and key order as the Bun build.

use std::io::{Read, Write};
use std::path::PathBuf;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use serde::Serialize;

use crate::folder_tree::descendant_ids;
use crate::notes::sqlite::{default_db_path, open_notes_sqlite};
use crate::notes::{Move, Note, NotesBackend};

const RAW_HELP: &str = "Compact JSON output (one line, no indentation)";

#[derive(Debug, Parser)]
#[command(
    name = "notes",
    version,
    about = "Apple Notes CLI. Backend selected by NOTES_BACKEND (osascript by default)."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// List every folder (flat, sorted by path)
    #[command(visible_alias = "ls")]
    Folders {
        #[arg(short, long, help = RAW_HELP)]
        raw: bool,
    },
    /// List notes in one or more folders
    #[command(visible_alias = "fn")]
    FolderNotes {
        #[arg(value_name = "FOLDER_ID", required = true)]
        folder_ids: Vec<String>,
        #[arg(short, long, help = RAW_HELP)]
        raw: bool,
    },
    /// Fetch second-line snippets per note for the given folders
    FolderSnippets {
        #[arg(value_name = "FOLDER_ID", required = true)]
        folder_ids: Vec<String>,
        #[arg(short, long, help = RAW_HELP)]
        raw: bool,
    },
    /// Fetch full plaintext bodies per note for the given folders
    FolderBodies {
        #[arg(value_name = "FOLDER_ID", required = true)]
        folder_ids: Vec<String>,
        #[arg(short, long, help = RAW_HELP)]
        raw: bool,
    },
    /// Print a note's plaintext body to stdout
    #[command(visible_alias = "cat")]
    Body {
        #[arg(value_name = "NOTE_ID")]
        note_id: String,
    },
    /// Print a note's HTML body to stdout
    Html {
        #[arg(value_name = "NOTE_ID")]
        note_id: String,
    },
    /// Create a blank note in the given folder
    #[command(visible_alias = "nn")]
    NewNote {
        /// Target folder ID
        #[arg(short, long, value_name = "FOLDER_ID")]
        folder: String,
    },
    /// Create a top-level folder in the given account
    #[command(visible_alias = "mkdir")]
    NewFolder {
        /// New folder name
        #[arg(value_name = "FOLDER_NAME")]
        name: String,
        /// Account name (e.g. 'iCloud')
        #[arg(short, long, value_name = "ACCOUNT")]
        account: String,
    },
    /// Replace a note's body with stdin (formatting is lost — see EDITING.md)
    Update {
        #[arg(value_name = "NOTE_ID")]
        note_id: String,
    },
    /// Move one or more notes into a destination folder
    #[command(visible_alias = "mv")]
    Move {
        #[arg(value_name = "NOTE_ID", required = true)]
        note_ids: Vec<String>,
        /// Destination folder ID
        #[arg(short, long, value_name = "FOLDER_ID")]
        to: String,
        #[arg(short, long, help = RAW_HELP)]
        raw: bool,
    },
    /// Full-text search (title + body). Defaults to all folders; -f narrows.
    #[command(visible_alias = "find")]
    Search {
        /// Substring to match (case-insensitive)
        #[arg(value_name = "QUERY")]
        query: String,
        /// Limit to a single folder (and its subtree if --recursive)
        #[arg(short, long, value_name = "FOLDER_ID")]
        folder: Option<String>,
        /// When --folder is set, also include descendants
        #[arg(short = 'R', long)]
        recursive: bool,
        #[arg(short, long, help = RAW_HELP)]
        raw: bool,
    },
    /// Dump NoteStore.sqlite schema (verifies the SQLite backend is viable on this Mac)
    Inspect {
        /// Path to NoteStore.sqlite [default: the live Notes store]
        #[arg(long, value_name = "DB_PATH")]
        path: Option<PathBuf>,
        /// Also print 1 row from each non-empty Z* table
        #[arg(long)]
        sample: bool,
    },
    /// Open Privacy → Full Disk Access and reveal this binary in Finder for drag-and-drop
    #[command(visible_alias = "fda")]
    GrantFda {
        /// Don't reveal the binary in Finder
        #[arg(long)]
        no_reveal: bool,
    },
}

fn print_json<T: Serialize + ?Sized>(out: &mut dyn Write, value: &T, raw: bool) -> Result<()> {
    if raw {
        serde_json::to_writer(&mut *out, value)?;
    } else {
        serde_json::to_writer_pretty(&mut *out, value)?;
    }
    writeln!(out)?;
    Ok(())
}

#[derive(Serialize)]
struct SearchHit {
    #[serde(flatten)]
    note: Note,
    body: String,
}

/// Runs one subcommand, writing its output to `out`. Write commands print
/// nothing on success, like the Bun build.
pub async fn execute(
    command: Command,
    backend: &dyn NotesBackend,
    out: &mut dyn Write,
    stdin: &mut dyn Read,
) -> Result<()> {
    match command {
        Command::Folders { raw } => print_json(out, &backend.list_folders().await?, raw),
        Command::FolderNotes { folder_ids, raw } => {
            print_json(out, &backend.get_folder_notes(&folder_ids).await?, raw)
        }
        Command::FolderSnippets { folder_ids, raw } => {
            print_json(out, &backend.get_folder_snippets(&folder_ids).await?, raw)
        }
        Command::FolderBodies { folder_ids, raw } => {
            print_json(out, &backend.get_folder_bodies(&folder_ids).await?, raw)
        }
        Command::Body { note_id } => {
            out.write_all(backend.get_note_body(&note_id).await?.as_bytes())?;
            Ok(())
        }
        Command::Html { note_id } => {
            out.write_all(backend.get_note_html(&note_id).await?.as_bytes())?;
            Ok(())
        }
        Command::NewNote { folder } => backend.create_note(&folder).await,
        Command::NewFolder { name, account } => backend.create_folder(&account, &name).await,
        Command::Update { note_id } => {
            let mut body = String::new();
            stdin.read_to_string(&mut body)?;
            backend.update_note_body(&note_id, &body).await
        }
        Command::Move { note_ids, to, raw } => {
            let moves: Vec<Move> = note_ids
                .into_iter()
                .map(|note_id| Move {
                    note_id,
                    folder_id: to.clone(),
                })
                .collect();
            print_json(out, &backend.move_notes(&moves).await?, raw)
        }
        Command::Search {
            query,
            folder,
            recursive,
            raw,
        } => {
            let all = backend.list_folders().await?;
            let folder_ids: Vec<String> = match folder {
                None => all.iter().map(|f| f.id.clone()).collect(),
                Some(id) => {
                    let Some(root) = all.iter().find(|f| f.id == id) else {
                        bail!("Folder not found: {id}");
                    };
                    if recursive {
                        descendant_ids(Some(root), &all)
                    } else {
                        vec![root.id.clone()]
                    }
                }
            };
            let (notes, bodies) = tokio::try_join!(
                backend.get_folder_notes(&folder_ids),
                backend.get_folder_bodies(&folder_ids),
            )?;
            let q = query.to_lowercase();
            let hits: Vec<SearchHit> = notes
                .into_iter()
                .map(|note| {
                    let body = bodies
                        .get(&note.folder_id)
                        .and_then(|m| m.get(&note.id))
                        .cloned()
                        .unwrap_or_default();
                    SearchHit { note, body }
                })
                .filter(|h| {
                    h.note.title.to_lowercase().contains(&q) || h.body.to_lowercase().contains(&q)
                })
                .collect();
            print_json(out, &hits, raw)
        }
        Command::Inspect { path, sample } => {
            inspect(&path.unwrap_or_else(default_db_path), sample, out)
        }
        Command::GrantFda { no_reveal } => Ok(crate::grant_fda::grant_fda(!no_reveal, out)?),
    }
}

/// Diagnostic: dumps the live schema so the SQLite backend's queries can be
/// checked against this Mac's macOS version. Independent of the selected
/// backend; goes through the shared opener so a missing FDA grant produces
/// the actionable hint.
fn inspect(path: &std::path::Path, sample: bool, out: &mut dyn Write) -> Result<()> {
    use rusqlite::types::ValueRef;

    let db = open_notes_sqlite(path)?;
    let tables: Vec<(String, Option<String>)> = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    writeln!(out, "-- Tables in {} ({}):", path.display(), tables.len())?;
    for (name, _) in &tables {
        writeln!(out, "--   {name}")?;
    }
    writeln!(out)?;
    for (_, sql) in &tables {
        if let Some(sql) = sql {
            writeln!(out, "{sql};")?;
        }
    }
    let entities: Vec<(String, i64)> = db
        .prepare("SELECT Z_NAME, Z_ENT FROM Z_PRIMARYKEY ORDER BY Z_ENT")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    writeln!(out, "\n-- Z_PRIMARYKEY (entity name → Z_ENT):")?;
    for (name, ent) in &entities {
        writeln!(out, "--   {ent:>3}  {name}")?;
    }
    if sample {
        writeln!(out, "\n-- Sample rows from Z* tables:")?;
        for (name, _) in tables.iter().filter(|(n, _)| n.starts_with('Z')) {
            let mut stmt = db.prepare(&format!(
                "SELECT * FROM \"{}\" LIMIT 1",
                name.replace('"', "\"\"")
            ))?;
            let columns: Vec<String> = stmt.column_names().map(str::to_owned).collect();
            let mut rows = stmt.query([])?;
            if let Some(row) = rows.next()? {
                let mut obj = serde_json::Map::new();
                for (i, col) in columns.iter().enumerate() {
                    let value = match row.get_ref(i)? {
                        ValueRef::Null => serde_json::Value::Null,
                        ValueRef::Integer(n) => n.into(),
                        ValueRef::Real(f) => serde_json::Number::from_f64(f)
                            .map_or(serde_json::Value::Null, Into::into),
                        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned().into(),
                        // Summarized: a byte-by-byte dump of ZDATA isn't readable.
                        ValueRef::Blob(b) => format!("<blob {} bytes>", b.len()).into(),
                    };
                    obj.insert(col.clone(), value);
                }
                writeln!(out, "-- {name}: {}", serde_json::Value::Object(obj))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::mock::{Call, MockBackend, folder, note};
    use crate::notes::{Folder, MoveResult};

    fn mock() -> MockBackend {
        MockBackend::new(
            vec![
                folder("f1", "Inbox", "iCloud / Inbox", 0, 2),
                folder("f2", "Archive", "iCloud / Archive", 0, 1),
                folder("f3", "Old", "iCloud / Archive / Old", 1, 1),
            ],
            vec![
                note("n1", "Plan A", "f1", "2026-05-01T10:00:00Z"),
                note("n2", "Plan B", "f1", "2026-05-01T11:00:00Z"),
                note("n3", "Quarterly report", "f2", "2026-04-30T10:00:00Z"),
                note("n4", "Old archived note", "f3", "2026-04-29T10:00:00Z"),
            ],
        )
        .with_bodies([
            ("n1", "Plan A\nFirst draft of the Q3 forecast."),
            ("n2", "Plan B\nAlternate path with revised budget."),
            ("n3", "Quarterly report\nNumbers go here."),
            ("n4", "Old archived note\nNothing to see here."),
        ])
    }

    /// Parses argv like the binary would, runs it, returns stdout.
    async fn run(backend: &MockBackend, args: &[&str]) -> String {
        let cli =
            Cli::try_parse_from(std::iter::once("notes").chain(args.iter().copied())).unwrap();
        let mut out = Vec::new();
        execute(cli.command, backend, &mut out, &mut std::io::empty())
            .await
            .unwrap();
        String::from_utf8(out).unwrap()
    }

    fn ids(json: &str) -> Vec<String> {
        let v: Vec<serde_json::Value> = serde_json::from_str(json).unwrap();
        v.iter()
            .map(|n| n["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[tokio::test]
    async fn folders_prints_the_backend_list() {
        let m = mock();
        let out = run(&m, &["folders"]).await;
        let folders: Vec<Folder> = serde_json::from_str(&out).unwrap();
        assert_eq!(folders.len(), 3);
        assert_eq!(m.calls(), [Call::ListFolders]);
        // Pretty by default; -r is one line.
        assert!(out.contains("\n  {\n    \"id\": \"f1\""));
        assert_eq!(run(&m, &["ls", "-r"]).await.lines().count(), 1);
    }

    #[tokio::test]
    async fn folder_notes_accepts_variadic_ids() {
        let m = mock();
        let mut got = ids(&run(&m, &["folder-notes", "f1", "f2"]).await);
        got.sort();
        assert_eq!(got, ["n1", "n2", "n3"]);
        assert_eq!(
            m.calls(),
            [Call::GetFolderNotes(vec!["f1".into(), "f2".into()])]
        );
    }

    #[tokio::test]
    async fn search_matches_body_content() {
        // n1's body mentions "Q3 forecast"; a title-only match would miss it.
        let out = run(&mock(), &["search", "Q3", "-f", "f1"]).await;
        assert_eq!(ids(&out), ["n1"]);
        let hit: Vec<serde_json::Value> = serde_json::from_str(&out).unwrap();
        let keys: Vec<&String> = hit[0].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "title", "folderId", "modifiedAt", "body"]);
    }

    #[tokio::test]
    async fn search_recursive_includes_descendants() {
        // n4 lives in f3, a child of f2.
        assert_eq!(
            ids(&run(&mock(), &["search", "archived", "-f", "f2", "-R"]).await),
            ["n4"]
        );
        assert!(ids(&run(&mock(), &["search", "archived", "-f", "f2"]).await).is_empty());
    }

    #[tokio::test]
    async fn search_rejects_unknown_folders() {
        let cli = Cli::try_parse_from(["notes", "search", "x", "-f", "nope"]).unwrap();
        let err = execute(cli.command, &mock(), &mut Vec::new(), &mut std::io::empty())
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Folder not found: nope");
    }

    #[tokio::test]
    async fn new_folder_uses_the_positional_name_and_account_flag() {
        let m = mock();
        run(&m, &["new-folder", "Q3 Plans", "--account", "iCloud"]).await;
        assert_eq!(
            m.calls(),
            [Call::CreateFolder {
                account: "iCloud".into(),
                name: "Q3 Plans".into()
            }]
        );
    }

    #[tokio::test]
    async fn move_builds_one_move_per_note() {
        let m = mock();
        let out = run(&m, &["move", "n1", "n2", "--to", "f2"]).await;
        let results: Vec<MoveResult> = serde_json::from_str(&out).unwrap();
        assert!(results.iter().all(|r| r.ok));
        assert_eq!(
            m.calls(),
            [Call::MoveNotes(vec![
                Move {
                    note_id: "n1".into(),
                    folder_id: "f2".into()
                },
                Move {
                    note_id: "n2".into(),
                    folder_id: "f2".into()
                },
            ])]
        );
    }

    #[tokio::test]
    async fn update_reads_the_body_from_stdin() {
        let m = mock();
        let cli = Cli::try_parse_from(["notes", "update", "n1"]).unwrap();
        let mut stdin = "new body\nline two".as_bytes();
        execute(cli.command, &m, &mut Vec::new(), &mut stdin)
            .await
            .unwrap();
        assert_eq!(
            m.calls(),
            [Call::UpdateNoteBody {
                note_id: "n1".into(),
                body: "new body\nline two".into()
            }]
        );
    }

    #[tokio::test]
    async fn body_prints_raw_text() {
        assert_eq!(
            run(&mock(), &["cat", "n3"]).await,
            "Quarterly report\nNumbers go here."
        );
    }

    #[test]
    fn folder_id_positionals_are_required() {
        assert!(Cli::try_parse_from(["notes", "folder-notes"]).is_err());
        assert!(Cli::try_parse_from(["notes", "move", "n1"]).is_err());
    }
}
