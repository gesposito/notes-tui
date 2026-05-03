// scripts/bench-backends.ts — sweep every read method across both backends.
//
//   bun run scripts/bench-backends.ts                  # picks busiest folder
//   bun run scripts/bench-backends.ts --folder <id>    # explicit folder
//   bun run scripts/bench-backends.ts --runs 5         # iterations per cell
//
// Each cell runs N iterations; the first is "cold" (whatever the system
// happens to have cached), the rest contribute to mean/p50/p95. The two
// backends share the same `NotesBackend` interface so the same benchmark
// closure can target both — just swap the implementation.
//
// Skips write methods (createNote/createFolder/moveNotes/updateNoteBody) —
// they mutate Apple Notes and we don't want a benchmark to touch user data.
import { osascriptBackend } from "../src/notes/osascript.ts";
import { scriptingBridgeBackend } from "../src/notes/scripting-bridge.ts";
import type { NotesBackend, Note } from "../src/notes/types.ts";

// ── Argv ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const RUNS = Number(arg("--runs") ?? 5);
const FOLDER_ARG = arg("--folder");

// ── Stats helpers ──────────────────────────────────────────────────────────
const time = async <T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> => {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
};

const summarize = (samples: number[]) => {
  if (samples.length === 0) return { mean: 0, p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
  return {
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: idx(50),
    p95: idx(95),
  };
};

// ── Bench ──────────────────────────────────────────────────────────────────
type CellResult = {
  cold: number;
  mean: number;
  p50: number;
  p95: number;
  error?: string;
};

const benchCell = async (
  fn: () => Promise<unknown>,
  runs: number,
): Promise<CellResult> => {
  try {
    const cold = (await time(fn)).ms;
    const samples: number[] = [];
    for (let i = 0; i < runs - 1; i++) {
      samples.push((await time(fn)).ms);
    }
    return { cold, ...summarize(samples) };
  } catch (e) {
    return {
      cold: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

const fmt = (ms: number): string =>
  ms === 0 ? "—" : ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();

// ── Driver ─────────────────────────────────────────────────────────────────
const main = async () => {
  console.error(`Sampling each cell ${RUNS}× (1 cold + ${RUNS - 1} warm)\n`);

  // Pick a target folder + note ahead of time so per-backend benches are
  // comparable. listFolders runs against osa first since SB defers to it
  // for some methods anyway.
  const folders = await osascriptBackend.listFolders();
  const folder =
    folders.find((f) => f.id === FOLDER_ARG) ??
    [...folders].sort((a, b) => b.noteCount - a.noteCount)[0];
  if (!folder) {
    console.error("No folders found");
    process.exit(1);
  }
  console.error(
    `Using folder: ${folder.path} (${folder.noteCount} notes, id=${folder.id.slice(-8)})`,
  );

  // Pick a single note for getNoteBody/getNoteHtml. Use the first note in
  // the chosen folder.
  const sampleNotes = await osascriptBackend.getFolderNotes([folder.id]);
  const sampleNote: Note | undefined = sampleNotes[0];
  if (!sampleNote) {
    console.error("Chosen folder has no notes; getNoteBody/Html will be skipped");
  }
  console.error(
    `Sample note:   ${sampleNote ? sampleNote.title.slice(0, 50) : "<none>"}\n`,
  );

  type MethodName =
    | "listFolders"
    | "getFolderNotes"
    | "getFolderSnippets"
    | "getFolderBodies"
    | "getNoteBody"
    | "getNoteHtml";

  const methods: Array<{
    name: MethodName;
    fn: (b: NotesBackend) => () => Promise<unknown>;
    skipIf?: boolean;
  }> = [
    { name: "listFolders", fn: (b) => () => b.listFolders() },
    { name: "getFolderNotes", fn: (b) => () => b.getFolderNotes([folder.id]) },
    { name: "getFolderSnippets", fn: (b) => () => b.getFolderSnippets([folder.id]) },
    { name: "getFolderBodies", fn: (b) => () => b.getFolderBodies([folder.id]) },
    {
      name: "getNoteBody",
      fn: (b) => () => b.getNoteBody(sampleNote!.id),
      skipIf: !sampleNote,
    },
    {
      name: "getNoteHtml",
      fn: (b) => () => b.getNoteHtml(sampleNote!.id),
      skipIf: !sampleNote,
    },
  ];

  const backends: Array<{ name: string; backend: NotesBackend }> = [
    { name: "osa", backend: osascriptBackend },
    { name: "sb", backend: scriptingBridgeBackend },
  ];

  // Run all cells.
  const results: Record<string, Record<string, CellResult>> = {};
  for (const m of methods) {
    results[m.name] = {};
    for (const b of backends) {
      if (m.skipIf) {
        results[m.name]![b.name] = {
          cold: 0,
          mean: 0,
          p50: 0,
          p95: 0,
          error: "skipped",
        };
        continue;
      }
      process.stderr.write(`  ${m.name.padEnd(20)} ${b.name.padEnd(4)} … `);
      const r = await benchCell(m.fn(b.backend), RUNS);
      results[m.name]![b.name] = r;
      process.stderr.write(
        r.error ? `FAIL ${r.error}\n` : `${fmt(r.mean)} ms mean\n`,
      );
    }
  }

  // ── Pretty table ─────────────────────────────────────────────────────────
  console.log("");
  console.log(
    "method".padEnd(20) +
      "  " +
      ["cold", "mean", "p50", "p95"]
        .map((h) =>
          backends.map((b) => `${b.name}.${h}`.padStart(11)).join(""),
        )
        .join(""),
  );
  console.log("─".repeat(20 + 2 + backends.length * 4 * 11));
  for (const m of methods) {
    const row = m.name.padEnd(20) + "  ";
    const cells: string[] = [];
    for (const stat of ["cold", "mean", "p50", "p95"] as const) {
      for (const b of backends) {
        const r = results[m.name]![b.name]!;
        cells.push((r.error ? r.error : fmt(r[stat])).padStart(11));
      }
    }
    console.log(row + cells.join(""));
  }
  console.log("");
  console.log(
    `(All times in ms. ${RUNS} samples per cell; cold = first run, warm stats from the remaining ${RUNS - 1}.)`,
  );
};

await main();
