#!/usr/bin/env bun
// scripts/test-move-live.ts — end-to-end move test against the *real* Apple
// Notes database. Creates two scratch folders + a test note, moves the note
// back and forth, asserts the move is reflected on read, and cleans up.
//
//   bun run scripts/test-move-live.ts --yes              # default backend (osa)
//   bun run scripts/test-move-live.ts --yes --backend scripting-bridge
//   bun run scripts/test-move-live.ts --yes --all        # run both, sequentially
//
// SAFETY:
//   - All test items are namespaced with `notes-tui-e2e/<timestamp>` so they
//     can't collide with real notes/folders.
//   - On success, we delete what we created (folder + note) via osascript.
//   - On failure, we still try to clean up; anything left behind is logged
//     with the exact `osascript` command to remove it manually.
//   - Refuses to run without `--yes` since it mutates iCloud-synced state.
import { spawnSync } from "node:child_process";
import { osascriptBackend } from "../src/notes/osascript.ts";
import { scriptingBridgeBackend } from "../src/notes/scripting-bridge.ts";
import type { Folder, NotesBackend } from "../src/notes/types.ts";

// ── Argv ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const yes = argv.includes("--yes") || argv.includes("-y");
const all = argv.includes("--all");
const backendName = arg("--backend") ?? "osa";

if (!yes) {
  console.error(
    "This will CREATE + MOVE + DELETE test notes in Apple Notes (iCloud-synced).\n" +
      "Pass --yes to confirm. Items are namespaced `notes-tui-e2e/...` so they\n" +
      "can't collide with real content.",
  );
  process.exit(2);
}

const ALL_BACKENDS: Record<string, NotesBackend> = {
  osa: osascriptBackend,
  "scripting-bridge": scriptingBridgeBackend,
};
const targets: Array<{ name: string; backend: NotesBackend }> = all
  ? Object.entries(ALL_BACKENDS).map(([name, backend]) => ({ name, backend }))
  : [{ name: backendName, backend: ALL_BACKENDS[backendName]! }];
if (!targets.every((t) => t.backend)) {
  console.error(`Unknown backend: ${backendName}`);
  process.exit(2);
}

// ── Helpers ────────────────────────────────────────────────────────────────
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const SOURCE_NAME = `notes-tui-e2e-source-${STAMP}`;
const TARGET_NAME = `notes-tui-e2e-target-${STAMP}`;
const NOTE_TITLE = `notes-tui-e2e-note-${STAMP}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Notes.app sometimes lags by a tick on bulk reads after a write. Poll
// listFolders / getFolderNotes for a short window before declaring failure.
const waitFor = async <T>(
  fn: () => Promise<T | null | undefined>,
  desc: string,
  attempts = 20,
  delayMs = 500,
): Promise<T> => {
  for (let i = 0; i < attempts; i++) {
    const v = await fn();
    if (v != null) return v;
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for: ${desc} (${(attempts * delayMs) / 1000}s)`);
};

const oscript = (script: string): { ok: boolean; out: string } => {
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: (r.stdout || r.stderr).trim() };
};

// Delete via JXA — backend doesn't have a delete method, and we don't want
// to add one just for tests. Logs the command if it fails so the user can
// retry manually.
const deleteFolderByName = (account: string, name: string): void => {
  // Wrap in an IIFE — JXA disallows top-level `return`.
  const script = `
    (function () {
      const Notes = Application("Notes");
      const accs = Notes.accounts();
      for (let i = 0; i < accs.length; i++) {
        if (accs[i].name() === ${JSON.stringify(account)}) {
          const folders = accs[i].folders();
          for (let j = 0; j < folders.length; j++) {
            if (folders[j].name() === ${JSON.stringify(name)}) {
              Notes.delete(folders[j]);
              return "deleted";
            }
          }
        }
      }
      return "not found";
    })();
  `;
  const r = oscript(script);
  if (!r.ok) {
    console.warn(
      `  ! cleanup: failed to delete folder ${name}: ${r.out}\n` +
        `    Manual: osascript -l JavaScript -e '${script.replace(/\n/g, " ").trim()}'`,
    );
  }
};

// ── E2E flow ───────────────────────────────────────────────────────────────
type RunResult = { backend: string; pass: boolean; error?: string; ms: number };

const runE2E = async (
  name: string,
  backend: NotesBackend,
): Promise<RunResult> => {
  console.log(`\n═══ ${name} ═══`);
  const t0 = performance.now();
  let createdSource = false;
  let createdTarget = false;
  let account = "";

  try {
    // 1. Pick account
    const initial = await backend.listFolders();
    if (initial.length === 0) throw new Error("no folders found — empty Notes?");
    account = initial[0]!.account;
    console.log(`  account=${account}`);

    // 2. Create scratch folders
    await backend.createFolder(account, SOURCE_NAME);
    createdSource = true;
    await backend.createFolder(account, TARGET_NAME);
    createdTarget = true;
    console.log(`  ✓ created ${SOURCE_NAME}, ${TARGET_NAME}`);

    // 3. Resolve their IDs
    const findFolder = async (n: string): Promise<Folder | null> => {
      const list = await backend.listFolders();
      return list.find((f) => f.name === n) ?? null;
    };
    const source = await waitFor(() => findFolder(SOURCE_NAME), "source folder visible");
    const target = await waitFor(() => findFolder(TARGET_NAME), "target folder visible");
    console.log(`  ✓ resolved IDs (source=${source.id.slice(-12)} target=${target.id.slice(-12)})`);

    // 4. Create a test note in source
    await backend.createNote(source.id);
    // The created note's title defaults to its first body line. Newly-
    // created blank notes appear with title "" or "New Note". Find by
    // being the only thing in our scratch source folder.
    const note = await waitFor(async () => {
      const ns = await backend.getFolderNotes([source.id]);
      return ns[0] ?? null;
    }, "test note appears in source");
    console.log(`  ✓ created note (id=${note.id.slice(-12)} title=${JSON.stringify(note.title)})`);

    // 5. Move source → target
    const move1 = await backend.moveNotes([
      { noteId: note.id, folderId: target.id },
    ]);
    if (!move1[0]?.ok) throw new Error(`move source→target failed: ${move1[0]?.error}`);
    await waitFor(async () => {
      const ns = await backend.getFolderNotes([target.id]);
      return ns.some((n) => n.id === note.id) ? true : null;
    }, "note visible in target after first move");
    const inSource1 = (await backend.getFolderNotes([source.id])).some(
      (n) => n.id === note.id,
    );
    if (inSource1) throw new Error("note still appears in source after move");
    console.log("  ✓ moved source → target, source no longer contains it");

    // 6. Move back target → source
    const move2 = await backend.moveNotes([
      { noteId: note.id, folderId: source.id },
    ]);
    if (!move2[0]?.ok) throw new Error(`move target→source failed: ${move2[0]?.error}`);
    await waitFor(async () => {
      const ns = await backend.getFolderNotes([source.id]);
      return ns.some((n) => n.id === note.id) ? true : null;
    }, "note visible in source after reverse move");
    const inTarget2 = (await backend.getFolderNotes([target.id])).some(
      (n) => n.id === note.id,
    );
    if (inTarget2) throw new Error("note still appears in target after reverse move");
    console.log("  ✓ moved back target → source, target no longer contains it");

    // 7. Move to a folder in a different account (should be rejected). Skip
    //    if there's only one account — most users have just iCloud.
    const otherAccount = initial.find((f) => f.account !== account)?.account;
    if (otherAccount) {
      const otherFolder = initial.find((f) => f.account === otherAccount)!;
      const moveCross = await backend.moveNotes([
        { noteId: note.id, folderId: otherFolder.id },
      ]);
      if (moveCross[0]?.ok) {
        console.warn(
          "  ! cross-account move SUCCEEDED — backend isn't enforcing the guard",
        );
      } else {
        console.log(
          `  ✓ cross-account move rejected: ${moveCross[0]?.error?.slice(0, 60)}`,
        );
      }
    } else {
      console.log("  · single-account library — skipping cross-account guard test");
    }

    return { backend: name, pass: true, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return {
      backend: name,
      pass: false,
      error: e instanceof Error ? e.message : String(e),
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    // 8. Cleanup — delete folders (folders take their notes with them).
    console.log("  · cleaning up…");
    if (createdSource && account) deleteFolderByName(account, SOURCE_NAME);
    if (createdTarget && account) deleteFolderByName(account, TARGET_NAME);
  }
};

// ── Driver ─────────────────────────────────────────────────────────────────
const results: RunResult[] = [];
for (const t of targets) {
  results.push(await runE2E(t.name, t.backend));
}

console.log("\n═══ Summary ═══");
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  ${tag}  ${r.backend.padEnd(18)} ${r.ms}ms${r.error ? `  — ${r.error}` : ""}`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
