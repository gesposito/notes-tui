// Fixture-based tests for the SQLite backend. We can't touch the live
// NoteStore.sqlite from the test harness (FDA, plus we don't want to
// depend on a real machine state), so we build a tiny in-memory DB with
// the same shape we expect — Z_PRIMARYKEY plus a subset of
// ZICCLOUDSYNCINGOBJECT. If Apple's schema diverges from this, the tests
// here keep passing but the live `notes inspect` will reveal it.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSqliteBackend } from "./sqlite.ts";

// Core Data dates are seconds since 2001-01-01.
const cdEpoch = (iso: string): number =>
  Math.round(new Date(iso).getTime() / 1000) - 978307200;

let dbPath: string;
let scratchDir: string;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "notes-sqlite-fx-"));
  dbPath = join(scratchDir, "fixture.sqlite");

  // Create the file then populate via a writable handle. The backend
  // reopens it read-only. We mirror enough of NoteStore.sqlite for the
  // queries to exercise: Z_METADATA (store UUID), Z_PRIMARYKEY (entity
  // discriminators), and ZICCLOUDSYNCINGOBJECT (rows for accounts,
  // folders, and notes).
  writeFileSync(dbPath, "");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE Z_METADATA (
      Z_VERSION INTEGER PRIMARY KEY,
      Z_UUID VARCHAR,
      Z_PLIST BLOB
    );
    CREATE TABLE Z_PRIMARYKEY (
      Z_ENT INTEGER PRIMARY KEY,
      Z_NAME TEXT NOT NULL
    );
    CREATE TABLE ZICCLOUDSYNCINGOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      Z_ENT INTEGER,
      ZIDENTIFIER TEXT,
      ZTITLE1 TEXT,
      ZTITLE2 TEXT,
      ZNAME TEXT,
      ZPARENT INTEGER,
      -- Folder→account FK lives in different ZACCOUNT slot per macOS
      -- version. The backend COALESCEs across all of them; we exercise
      -- ZACCOUNT8 here (matches the user's macOS Tahoe schema).
      ZACCOUNT INTEGER,
      ZACCOUNT1 INTEGER,
      ZACCOUNT2 INTEGER,
      ZACCOUNT3 INTEGER,
      ZACCOUNT4 INTEGER,
      ZACCOUNT5 INTEGER,
      ZACCOUNT6 INTEGER,
      ZACCOUNT7 INTEGER,
      ZACCOUNT8 INTEGER,
      ZFOLDER INTEGER,
      ZMODIFICATIONDATE1 REAL,
      ZMARKEDFORDELETION INTEGER DEFAULT 0
    );
  `);

  // Z_METADATA gives the store UUID embedded into x-coredata URIs.
  db.exec(
    `INSERT INTO Z_METADATA (Z_VERSION, Z_UUID) VALUES (1, 'AAAA1111-2222-3333-4444-BBBB55556666');`,
  );

  // Entity discriminators (made-up but structurally correct).
  db.exec(`
    INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME) VALUES
      (1, 'ICAccount'),
      (2, 'ICFolder'),
      (3, 'ICNote');
  `);

  // One iCloud account, two top-level folders, one nested folder, four notes
  // (one of which is marked-for-deletion and should be filtered out).
  db.exec(`
    INSERT INTO ZICCLOUDSYNCINGOBJECT
      (Z_PK, Z_ENT, ZIDENTIFIER, ZNAME)
    VALUES
      (10, 1, 'acc-icloud', 'iCloud');

    INSERT INTO ZICCLOUDSYNCINGOBJECT
      (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZACCOUNT8, ZPARENT)
    VALUES
      (20, 2, 'fld-inbox',   'Inbox',   10, NULL),
      (21, 2, 'fld-archive', 'Archive', 10, NULL),
      (22, 2, 'fld-old',     'Old',     10, 21);

    INSERT INTO ZICCLOUDSYNCINGOBJECT
      (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZMODIFICATIONDATE1)
    VALUES
      (30, 3, 'note-1', 'Plan A',           20, ${cdEpoch("2026-05-01T10:00:00Z")}),
      (31, 3, 'note-2', 'Plan B',           20, ${cdEpoch("2026-05-01T11:00:00Z")}),
      (32, 3, 'note-3', 'Quarterly report', 21, ${cdEpoch("2026-04-30T10:00:00Z")}),
      (33, 3, 'note-4', 'Old archived',     22, ${cdEpoch("2026-04-29T10:00:00Z")});

    -- One deleted note that listFolders' counts and getFolderNotes must skip.
    INSERT INTO ZICCLOUDSYNCINGOBJECT
      (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZMODIFICATIONDATE1, ZMARKEDFORDELETION)
    VALUES
      (34, 3, 'note-5', 'Deleted note', 20, ${cdEpoch("2026-04-28T10:00:00Z")}, 1);
  `);
  db.close();
});

const FOLDER_URI = (pk: number) =>
  `x-coredata://AAAA1111-2222-3333-4444-BBBB55556666/ICFolder/p${pk}`;
const NOTE_URI = (pk: number) =>
  `x-coredata://AAAA1111-2222-3333-4444-BBBB55556666/ICNote/p${pk}`;

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("SqliteBackend.listFolders", () => {
  test("returns folders with hierarchical paths, x-coredata URIs, and live note counts", async () => {
    const backend = buildSqliteBackend(dbPath);
    const folders = await backend.listFolders();
    expect(folders).toEqual([
      {
        id: FOLDER_URI(21),
        name: "Archive",
        account: "iCloud",
        path: "iCloud / Archive",
        depth: 0,
        noteCount: 1,
      },
      {
        id: FOLDER_URI(22),
        name: "Old",
        account: "iCloud",
        path: "iCloud / Archive / Old",
        depth: 1,
        noteCount: 1,
      },
      {
        // 2 live notes (note-5 is marked-for-deletion).
        id: FOLDER_URI(20),
        name: "Inbox",
        account: "iCloud",
        path: "iCloud / Inbox",
        depth: 0,
        noteCount: 2,
      },
    ]);
  });
});

describe("SqliteBackend.getFolderNotes", () => {
  test("returns notes for requested folder URIs, skipping deleted ones", async () => {
    const backend = buildSqliteBackend(dbPath);
    const notes = await backend.getFolderNotes([FOLDER_URI(20), FOLDER_URI(22)]);
    const summary = notes
      .map((n) => `${n.id}|${n.title}|${n.folderId}`)
      .sort();
    expect(summary).toEqual([
      `${NOTE_URI(30)}|Plan A|${FOLDER_URI(20)}`,
      `${NOTE_URI(31)}|Plan B|${FOLDER_URI(20)}`,
      `${NOTE_URI(33)}|Old archived|${FOLDER_URI(22)}`,
    ]);
    // Sanity-check the date conversion (Core Data → ISO).
    const note1 = notes.find((n) => n.id === NOTE_URI(30))!;
    expect(note1.modifiedAt).toBe("2026-05-01T10:00:00.000Z");
  });

  test("empty folderIds returns empty array without touching DB", async () => {
    const backend = buildSqliteBackend(dbPath);
    const notes = await backend.getFolderNotes([]);
    expect(notes).toEqual([]);
  });

  test("ignores folder ids that aren't valid x-coredata URIs", async () => {
    const backend = buildSqliteBackend(dbPath);
    const notes = await backend.getFolderNotes(["fld-inbox", "not-a-uri"]);
    expect(notes).toEqual([]);
  });
});

describe("SqliteBackend FDA detection", () => {
  test("opening a non-existent path surfaces a useful error", async () => {
    const backend = buildSqliteBackend("/no/such/notes-store.sqlite");
    let err: Error | null = null;
    try {
      await backend.listFolders();
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    // We don't insist on the exact message here — bun:sqlite's wording
    // varies (ENOENT vs "unable to open"). What matters is we throw
    // rather than silently returning [].
    expect(err!.message.length).toBeGreaterThan(0);
  });
});
