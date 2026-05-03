import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import type {
  Folder,
  MoveResult,
  Note,
  NotesBackend,
} from "./types.ts";
import { osascriptBackend } from "./osascript.ts";

// macOS Notes stores everything in a single Core-Data-shaped SQLite. Path
// is stable across recent macOS versions; if Apple ever moves it, we'll
// surface the EPERM/ENOENT to the user directly.
const DB_PATH = `${homedir()}/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`;

const FDA_HINT = (path: string) => `Cannot read ${path}.

The SQLite backend needs Full Disk Access for whichever binary launched
this process. To grant it:

  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

Then drag the binary into the list. For the compiled CLI:

  bun run build:cli       # produces ./notes
  codesign -s - ./notes   # ad-hoc sign so FDA persists across rebuilds

For dev iteration with \`bun run cli\`, grant FDA to the \`bun\` binary
itself (e.g. \`which bun\` → drag that path in). Note that \`bun upgrade\`
replaces the binary, so you'd need to re-grant.
`;

// Wraps `new Database(...)` so the inevitable FDA failure produces the
// hint above (with a stable error name) instead of a raw SQLITE_AUTH /
// "Operation not permitted" stack trace.
export const openNotesSqlite = (path: string = DB_PATH): Database => {
  try {
    const db = new Database(path, { readonly: true });
    // Probe with a real query so we surface permission failures here
    // rather than at the first SELECT against ZICCLOUDSYNCINGOBJECT.
    db.query("SELECT 1").get();
    return db;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("Operation not permitted") ||
      msg.includes("EACCES") ||
      msg.includes("authorization denied") ||
      msg.includes("SQLITE_AUTH")
    ) {
      const err = new Error(FDA_HINT(path));
      err.name = "FullDiskAccessRequired";
      throw err;
    }
    throw e;
  }
};

// Core Data uses a Z_PRIMARYKEY registry mapping entity names → numeric
// Z_ENT discriminators on ZICCLOUDSYNCINGOBJECT. We resolve at runtime
// because the numbers vary across macOS versions.
type EntityIds = {
  folder: number;
  note: number;
  account: number;
};

// osa returns IDs as Core Data managed-object URIs:
//   x-coredata://<store-uuid>/<entity-name>/p<Z_PK>
// We do the same so the SQLite backend can hand IDs to osa-backed writes
// (move/createNote/updateNoteBody) without translation. The store UUID is
// in Z_METADATA.Z_UUID and matches what JXA's `note.id()` produces.
const URI_RE = /^x-coredata:\/\/[^/]+\/([^/]+)\/p(\d+)$/;
const pkToUri = (storeUuid: string, entityName: string, pk: number): string =>
  `x-coredata://${storeUuid}/${entityName}/p${pk}`;
const uriToPk = (uri: string): number | null => {
  const m = URI_RE.exec(uri);
  return m ? Number(m[2]) : null;
};

class SqliteBackend implements NotesBackend {
  private db: Database | null = null;
  private entities: EntityIds | null = null;
  private storeUuid: string | null = null;

  // Path is injectable so tests (and `buildSqliteBackend`) can point at
  // a fixture file. Defaults to the real macOS Notes store.
  constructor(private dbPath: string = DB_PATH) {}

  private getStoreUuid(): string {
    if (this.storeUuid) return this.storeUuid;
    const row = this.getDb()
      .query<{ Z_UUID: string }, []>("SELECT Z_UUID FROM Z_METADATA")
      .get();
    if (!row?.Z_UUID) {
      throw new Error("Z_METADATA has no Z_UUID — corrupt or unexpected schema");
    }
    this.storeUuid = row.Z_UUID;
    return this.storeUuid;
  }

  // Lazy open so importing the module without ever calling a method
  // (e.g., during tests) doesn't fail on machines without FDA. Open
  // failures (FDA missing, file gone) surface as `FullDiskAccessRequired`
  // with the actionable hint.
  private getDb(): Database {
    if (this.db) return this.db;
    this.db = openNotesSqlite(this.dbPath);
    return this.db;
  }

  // The schema below is based on public reverse-engineering work
  // (apple_cloud_notes_parser, apple-notes-liberator). Expect minor
  // column-name variation between macOS versions — `notes inspect` dumps
  // the live schema so we can adapt if needed.
  private getEntities(): EntityIds {
    if (this.entities) return this.entities;
    const db = this.getDb();
    const rows = db
      .query<{ Z_NAME: string; Z_ENT: number }, []>(
        "SELECT Z_NAME, Z_ENT FROM Z_PRIMARYKEY",
      )
      .all();
    const find = (...candidates: string[]): number => {
      for (const name of candidates) {
        const hit = rows.find((r) => r.Z_NAME === name);
        if (hit) return hit.Z_ENT;
      }
      throw new Error(
        `Schema mismatch: none of [${candidates.join(", ")}] in Z_PRIMARYKEY. ` +
          `Run \`notes inspect\` to dump your schema.`,
      );
    };
    this.entities = {
      folder: find("ICFolder", "Folder"),
      note: find("ICNote", "Note"),
      account: find("ICAccount", "Account"),
    };
    return this.entities;
  }

  async listFolders(_signal?: AbortSignal): Promise<Folder[]> {
    const db = this.getDb();
    const ent = this.getEntities();
    const storeUuid = this.getStoreUuid();

    // ZACCOUNT* — the folder→account FK lives in different ZACCOUNT slot
    // depending on macOS version (ZACCOUNT4 on older, ZACCOUNT8 on
    // newer). COALESCE is version-agnostic since each row only has one
    // populated. ZMARKEDFORDELETION filters out folders moved to trash
    // but not yet purged.
    const rows = db
      .query<
        {
          pk: number;
          name: string;
          parentPk: number | null;
          accountPk: number | null;
          accountName: string | null;
        },
        []
      >(
        `
        SELECT
          f.Z_PK    AS pk,
          f.ZTITLE2 AS name,
          f.ZPARENT AS parentPk,
          COALESCE(
            f.ZACCOUNT, f.ZACCOUNT1, f.ZACCOUNT2, f.ZACCOUNT3,
            f.ZACCOUNT4, f.ZACCOUNT5, f.ZACCOUNT6, f.ZACCOUNT7,
            f.ZACCOUNT8
          ) AS accountPk,
          a.ZNAME   AS accountName
        FROM ZICCLOUDSYNCINGOBJECT f
        LEFT JOIN ZICCLOUDSYNCINGOBJECT a
          ON a.Z_PK = COALESCE(
              f.ZACCOUNT, f.ZACCOUNT1, f.ZACCOUNT2, f.ZACCOUNT3,
              f.ZACCOUNT4, f.ZACCOUNT5, f.ZACCOUNT6, f.ZACCOUNT7,
              f.ZACCOUNT8
            ) AND a.Z_ENT = ${ent.account}
        WHERE f.Z_ENT = ${ent.folder}
          AND COALESCE(f.ZMARKEDFORDELETION, 0) = 0
        ORDER BY f.Z_PK
        `,
      )
      .all();

    const byPk = new Map<number, (typeof rows)[number]>();
    for (const r of rows) byPk.set(r.pk, r);

    // Direct note counts per folder. May lag the live state of Notes.app
    // by a small amount — Notes' in-memory state is flushed periodically,
    // so a freshly-modified folder's count can differ here vs osa.
    const counts = db
      .query<{ folderPk: number; n: number }, []>(
        `
        SELECT n.ZFOLDER AS folderPk, COUNT(*) AS n
        FROM ZICCLOUDSYNCINGOBJECT n
        WHERE n.Z_ENT = ${ent.note}
          AND COALESCE(n.ZMARKEDFORDELETION, 0) = 0
        GROUP BY n.ZFOLDER
        `,
      )
      .all();
    const countByPk = new Map<number, number>();
    for (const c of counts) countByPk.set(c.folderPk, c.n);

    const computePath = (
      pk: number,
      memo: Map<number, { depth: number; path: string }>,
    ): { depth: number; path: string } => {
      const cached = memo.get(pk);
      if (cached) return cached;
      const r = byPk.get(pk)!;
      const parentRow = r.parentPk == null ? null : byPk.get(r.parentPk);
      let entry: { depth: number; path: string };
      if (!parentRow) {
        entry = {
          depth: 0,
          path: `${r.accountName ?? "Local"} / ${r.name}`,
        };
      } else {
        const p = computePath(parentRow.pk, memo);
        entry = { depth: p.depth + 1, path: `${p.path} / ${r.name}` };
      }
      memo.set(pk, entry);
      return entry;
    };

    const memo = new Map<number, { depth: number; path: string }>();
    const out: Folder[] = rows.map((r) => {
      const { depth, path } = computePath(r.pk, memo);
      return {
        id: pkToUri(storeUuid, "ICFolder", r.pk),
        name: r.name,
        account: r.accountName ?? "Local",
        path,
        depth,
        noteCount: countByPk.get(r.pk) ?? 0,
      };
    });
    out.sort((a, b) => {
      const ap = a.path.toLowerCase();
      const bp = b.path.toLowerCase();
      return ap < bp ? -1 : ap > bp ? 1 : 0;
    });
    return out;
  }

  async getFolderNotes(
    folderIds: string[],
    _signal?: AbortSignal,
  ): Promise<Note[]> {
    if (folderIds.length === 0) return [];
    const db = this.getDb();
    const ent = this.getEntities();
    const storeUuid = this.getStoreUuid();

    // We hand out URIs (`x-coredata://…/ICFolder/p<PK>`); join on the PK
    // extracted from each. Skip any input that isn't a recognizable URI
    // — return empty instead of crashing on bad caller input.
    const folderPks = folderIds
      .map((id) => uriToPk(id))
      .filter((n): n is number => n != null);
    if (folderPks.length === 0) return [];

    const placeholders = folderPks.map(() => "?").join(",");
    const rows = db
      .query<
        {
          notePk: number;
          title: string | null;
          modifiedAt: number | null;
          folderPk: number;
        },
        number[]
      >(
        `
        SELECT
          n.Z_PK               AS notePk,
          n.ZTITLE1            AS title,
          n.ZMODIFICATIONDATE1 AS modifiedAt,
          n.ZFOLDER            AS folderPk
        FROM ZICCLOUDSYNCINGOBJECT n
        WHERE n.Z_ENT = ${ent.note}
          AND COALESCE(n.ZMARKEDFORDELETION, 0) = 0
          AND n.ZFOLDER IN (${placeholders})
        `,
      )
      .all(...folderPks);

    return rows.map((r) => ({
      id: pkToUri(storeUuid, "ICNote", r.notePk),
      title: r.title ?? "",
      folderId: pkToUri(storeUuid, "ICFolder", r.folderPk),
      // Core Data stores dates as seconds since 2001-01-01. Convert.
      modifiedAt:
        r.modifiedAt == null
          ? null
          : new Date((r.modifiedAt + 978307200) * 1000).toISOString(),
    }));
  }

  // ── Body / snippet / write paths defer to osa for now ────────────────────
  // Bodies in NoteStore.sqlite are gzipped protobuf in
  // ZICNOTEDATA.ZDATA, encoded with Apple's internal "typedstream"-ish
  // format. Decoding is its own project (see apple_cloud_notes_parser
  // for prior art); until we port a decoder, defer to the osa backend
  // so the contract stays intact.
  getFolderSnippets(
    folderIds: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, Record<string, string>>> {
    return osascriptBackend.getFolderSnippets(folderIds, signal);
  }
  getFolderBodies(
    folderIds: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, Record<string, string>>> {
    return osascriptBackend.getFolderBodies(folderIds, signal);
  }
  getNoteBody(noteId: string, signal?: AbortSignal): Promise<string> {
    return osascriptBackend.getNoteBody(noteId, signal);
  }
  getNoteHtml(noteId: string, signal?: AbortSignal): Promise<string> {
    return osascriptBackend.getNoteHtml(noteId, signal);
  }
  // Writes always go through Apple Events — touching the live DB
  // directly would corrupt the sync state.
  moveNotes(
    moves: Array<{ noteId: string; folderId: string }>,
  ): Promise<MoveResult[]> {
    return osascriptBackend.moveNotes(moves);
  }
  createNote(folderId: string): Promise<void> {
    return osascriptBackend.createNote(folderId);
  }
  createFolder(accountName: string, name: string): Promise<void> {
    return osascriptBackend.createFolder(accountName, name);
  }
  updateNoteBody(noteId: string, body: string): Promise<void> {
    return osascriptBackend.updateNoteBody(noteId, body);
  }
}

export const sqliteBackend: NotesBackend = new SqliteBackend();
export { DB_PATH as SQLITE_DB_PATH };

// For `notes inspect` and tests: build a backend pointed at a non-default
// DB (in-memory fixture, alternate file, etc.). Construct with the path
// you want; the lazy open uses it.
export const buildSqliteBackend = (dbPath: string): NotesBackend =>
  new SqliteBackend(dbPath);
