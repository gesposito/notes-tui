// Two CLI test patterns:
//
// 1. Programmatic (`runCommand` from citty) — fast, no subprocess, no I/O
//    coupling. The mock NotesBackend can return whatever shape we want and
//    we assert on the subcommand's return value. Default for unit tests.
//
// 2. Subprocess — spawn `bun run src/cli.ts ...` so we exercise the actual
//    binary path, including stdout/stderr separation and exit codes. Slower,
//    used for one or two smoke tests that the wiring works end-to-end.
//
// Subcommand `run` handlers also `process.stdout.write(...)` — we suppress
// that by stubbing in beforeAll so unit-test output isn't littered with
// JSON dumps.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { runCommand } from "citty";
import type {
  Folder,
  MoveResult,
  Note,
  NotesBackend,
} from "./notes/types.ts";
import { buildCli } from "./cli.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────
const fixtureFolders: Folder[] = [
  {
    id: "f1",
    name: "Inbox",
    account: "iCloud",
    path: "iCloud / Inbox",
    depth: 0,
    noteCount: 2,
  },
  {
    id: "f2",
    name: "Archive",
    account: "iCloud",
    path: "iCloud / Archive",
    depth: 0,
    noteCount: 1,
  },
  {
    id: "f3",
    name: "Old",
    account: "iCloud",
    path: "iCloud / Archive / Old",
    depth: 1,
    noteCount: 1,
  },
];

const fixtureNotes: Note[] = [
  { id: "n1", title: "Plan A", folderId: "f1", modifiedAt: "2026-05-01T10:00:00Z" },
  { id: "n2", title: "Plan B", folderId: "f1", modifiedAt: "2026-05-01T11:00:00Z" },
  { id: "n3", title: "Quarterly report", folderId: "f2", modifiedAt: "2026-04-30T10:00:00Z" },
  { id: "n4", title: "Old archived note", folderId: "f3", modifiedAt: "2026-04-29T10:00:00Z" },
];

const fixtureBodies: Record<string, string> = {
  n1: "Plan A\nFirst draft of the Q3 forecast.",
  n2: "Plan B\nAlternate path with revised budget.",
  n3: "Quarterly report\nNumbers go here.",
  n4: "Old archived note\nNothing to see here.",
};

// Track call counts so tests can assert what the backend was asked to do.
type CallLog = { method: string; args: unknown[] };

const makeMock = (
  overrides: Partial<NotesBackend> = {},
): { backend: NotesBackend; calls: CallLog[] } => {
  const calls: CallLog[] = [];
  const log = <T>(method: string, args: unknown[], result: T): T => {
    calls.push({ method, args });
    return result;
  };
  const backend: NotesBackend = {
    listFolders: async () => log("listFolders", [], fixtureFolders),
    getFolderNotes: async (ids) =>
      log(
        "getFolderNotes",
        [ids],
        fixtureNotes.filter((n) => ids.includes(n.folderId)),
      ),
    getNoteBody: async (id) => log("getNoteBody", [id], fixtureBodies[id] ?? ""),
    getNoteHtml: async (id) =>
      log("getNoteHtml", [id], `<p>${fixtureBodies[id] ?? ""}</p>`),
    getFolderSnippets: async (ids) =>
      log(
        "getFolderSnippets",
        [ids],
        Object.fromEntries(ids.map((id) => [id, {}])),
      ),
    getFolderBodies: async (ids) =>
      log(
        "getFolderBodies",
        [ids],
        Object.fromEntries(
          ids.map((id) => [
            id,
            Object.fromEntries(
              fixtureNotes
                .filter((n) => n.folderId === id)
                .map((n) => [n.id, fixtureBodies[n.id] ?? ""]),
            ),
          ]),
        ),
      ),
    moveNotes: async (moves) =>
      log<MoveResult[]>(
        "moveNotes",
        [moves],
        moves.map((m) => ({ noteId: m.noteId, ok: true })),
      ),
    createNote: async (folderId) => {
      log("createNote", [folderId], undefined);
    },
    createFolder: async (account, name) => {
      log("createFolder", [account, name], undefined);
    },
    updateNoteBody: async (noteId, body) => {
      log("updateNoteBody", [noteId, body], undefined);
    },
    ...overrides,
  };
  return { backend, calls };
};

// Stub stdout so subcommand `printJson` calls don't litter test output.
const originalWrite = process.stdout.write.bind(process.stdout);
beforeAll(() => {
  process.stdout.write = (() => true) as typeof process.stdout.write;
});
afterAll(() => {
  process.stdout.write = originalWrite;
});

// ── Programmatic (runCommand) ──────────────────────────────────────────────
// citty's runCommand on a root command dispatches to a subcommand but
// doesn't propagate its return value (see citty/dist/index.mjs ~line 217:
// `await runCommand(subCommand, ...)` is unawaited-result). We sidestep
// that by invoking each subcommand directly: defineCommand returns the
// definition as-is, so `cli.subCommands[name]` is the subcommand object.
type SubMap = Record<string, ReturnType<typeof buildCli>>;
const sub = (
  cli: ReturnType<typeof buildCli>,
  name: string,
): ReturnType<typeof buildCli> => {
  const subs = cli.subCommands as unknown as SubMap;
  const found = subs[name];
  if (!found) throw new Error(`subcommand not found: ${name}`);
  return found;
};

describe("CLI — programmatic via runCommand", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
  });

  test("`folders` returns the backend's folder list", async () => {
    const cli = buildCli(mock.backend);
    const { result } = await runCommand(sub(cli, "folders"), { rawArgs: [] });
    expect(result).toEqual(fixtureFolders);
    expect(mock.calls).toEqual([{ method: "listFolders", args: [] }]);
  });

  test("`folder-notes` accepts variadic positional IDs", async () => {
    const cli = buildCli(mock.backend);
    const { result } = await runCommand(sub(cli, "folder-notes"), {
      rawArgs: ["f1", "f2"],
    });
    expect((result as Note[]).map((n) => n.id).sort()).toEqual([
      "n1",
      "n2",
      "n3",
    ]);
    expect(mock.calls).toEqual([
      { method: "getFolderNotes", args: [["f1", "f2"]] },
    ]);
  });

  test("`search` matches body content (not just title)", async () => {
    const cli = buildCli(mock.backend);
    const { result } = await runCommand(sub(cli, "search"), {
      rawArgs: ["Q3", "-f", "f1"],
    });
    // n1 body contains "Q3 forecast" — title-only would have missed it.
    expect((result as Note[]).map((n) => n.id)).toEqual(["n1"]);
  });

  test("`search --recursive` expands to descendants", async () => {
    const cli = buildCli(mock.backend);
    const { result } = await runCommand(sub(cli, "search"), {
      rawArgs: ["archived", "-f", "f2", "-R"],
    });
    // n4 is in f3 (child of f2). Without --recursive it wouldn't be reachable.
    expect((result as Note[]).map((n) => n.id)).toEqual(["n4"]);
  });

  test("`new-folder` invokes createFolder with positional + --account", async () => {
    const cli = buildCli(mock.backend);
    await runCommand(sub(cli, "new-folder"), {
      rawArgs: ["Q3 Plans", "--account", "iCloud"],
    });
    expect(mock.calls).toEqual([
      { method: "createFolder", args: ["iCloud", "Q3 Plans"] },
    ]);
  });

  test("`move` translates positionals + --to into moveNotes payload", async () => {
    const cli = buildCli(mock.backend);
    const { result } = await runCommand(sub(cli, "move"), {
      rawArgs: ["n1", "n2", "--to", "f2"],
    });
    expect(result).toEqual([
      { noteId: "n1", ok: true },
      { noteId: "n2", ok: true },
    ]);
    expect(mock.calls).toEqual([
      {
        method: "moveNotes",
        args: [
          [
            { noteId: "n1", folderId: "f2" },
            { noteId: "n2", folderId: "f2" },
          ],
        ],
      },
    ]);
  });
});

// ── Subprocess smoke ───────────────────────────────────────────────────────
// One end-to-end test that the binary path works: spawn `bun run src/cli.ts
// folders --raw`, parse stdout, sanity-check shape. This catches issues
// that only appear when the module is loaded as `import.meta.main`.
describe("CLI — subprocess smoke", () => {
  test("`bun run src/cli.ts --help` prints usage and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DEBUG: "" },
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain("folders");
    expect(stdout).toContain("search");
  });
});
