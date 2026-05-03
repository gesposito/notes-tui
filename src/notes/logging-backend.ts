import type { Folder, MoveResult, Note, NotesBackend } from "./types.ts";

// ── Output sink ───────────────────────────────────────────────────────────
// stderr is invisible while OpenTUI's alt-screen is active, so we mirror
// every line to a file the user can `tail -f` from another terminal.
const LOG_PATH = "/tmp/notes-tui-debug.log";
let sink: Bun.FileSink | null = null;

const getSink = (): Bun.FileSink => {
  if (!sink) {
    // Bun.file().writer() opens for write (truncates) — fresh log per run.
    sink = Bun.file(LOG_PATH).writer();
    sink.write(
      `# notes-tui debug log — started ${new Date().toISOString()}\n`,
    );
    sink.flush();
  }
  return sink;
};

const emit = (line: string): void => {
  const s = getSink();
  s.write(line);
  s.flush();
};

// One-time hint on stderr (visible before alt-screen kicks in) so the user
// knows where to look. Gated on DEBUG=1 — without the gate this would
// also appear in CLI output and any other consumer that imports the
// module unconditionally.
if (Bun.env.DEBUG === "1") {
  process.stderr.write(
    `[notes-tui] DEBUG=1 — logging to ${LOG_PATH}\n` +
      `             (run \`tail -f ${LOG_PATH}\` in another terminal)\n`,
  );
}

// ── Stats ─────────────────────────────────────────────────────────────────
type CallStats = {
  count: number;
  totalMs: number;
  aborts: number;
  errors: number;
  durations: number[];
};

const stats = new Map<string, CallStats>();
const sessionStart = performance.now();

const fmt = (ms: number): string => `${Math.round(ms)}ms`;

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length * p) / 100);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
};

const record = (
  method: string,
  durationMs: number,
  outcome: "ok" | "abort" | "error",
): void => {
  let s = stats.get(method);
  if (!s) {
    s = { count: 0, totalMs: 0, aborts: 0, errors: 0, durations: [] };
    stats.set(method, s);
  }
  s.count++;
  s.totalMs += durationMs;
  s.durations.push(durationMs);
  if (outcome === "abort") s.aborts++;
  if (outcome === "error") s.errors++;
};

// ── Per-call logging ──────────────────────────────────────────────────────
const fmtArgs = (args: unknown): string => {
  if (args === undefined) return "()";
  let s = JSON.stringify(args);
  if (s.length > 60) s = s.slice(0, 57) + "...";
  return `(${s})`;
};

const summarize = (result: unknown): string => {
  if (Array.isArray(result)) return ` (${result.length} items)`;
  if (typeof result === "string") return ` (${result.length} chars)`;
  if (result && typeof result === "object")
    return ` (${Object.keys(result).length} keys)`;
  return "";
};

const log = (
  method: string,
  args: unknown,
  durationMs: number,
  outcome: "ok" | "abort" | "error",
  result: unknown = undefined,
  errorMsg: string = "",
): void => {
  const elapsed = Math.round(performance.now() - sessionStart);
  const tag =
    outcome === "ok" ? "✓" : outcome === "abort" ? "✗abort" : "✗error";
  const tail = outcome === "ok" ? summarize(result) : errorMsg ? ` ${errorMsg}` : "";
  emit(
    `[+${String(elapsed).padStart(5)}ms] ${method.padEnd(20)} ${fmtArgs(args)} → ${fmt(durationMs)} ${tag}${tail}\n`,
  );
};

// ── Wrap helper ───────────────────────────────────────────────────────────
const wrap = async <T>(
  method: string,
  args: unknown,
  fn: () => Promise<T>,
): Promise<T> => {
  const start = performance.now();
  try {
    const result = await fn();
    const dur = performance.now() - start;
    log(method, args, dur, "ok", result);
    record(method, dur, "ok");
    return result;
  } catch (e) {
    const dur = performance.now() - start;
    if (e instanceof Error && e.name === "AbortError") {
      log(method, args, dur, "abort");
      record(method, dur, "abort");
    } else {
      log(method, args, dur, "error", undefined, String(e instanceof Error ? e.message : e));
      record(method, dur, "error");
    }
    throw e;
  }
};

// ── Dump ──────────────────────────────────────────────────────────────────
export const dumpStats = (): void => {
  if (stats.size === 0) return;
  const lines: string[] = ["", "=== notes-tui session summary ==="];
  const methods = [...stats.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [method, s] of methods) {
    const sorted = [...s.durations].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const avg = s.totalMs / s.count;
    lines.push(
      `${method.padEnd(20)} × ${String(s.count).padStart(4)}  avg=${fmt(avg)}  p50=${fmt(p50)}  p95=${fmt(p95)}  aborts=${s.aborts}  errors=${s.errors}`,
    );
  }
  const summary = lines.join("\n") + "\n";
  // Both: the file (so it's preserved with the trace) and stderr (so it
  // shows on the terminal after alt-screen restores).
  emit(summary);
  process.stderr.write(summary);
};

// ── Public wrapper ────────────────────────────────────────────────────────
export const wrapWithLogging = (backend: NotesBackend): NotesBackend => ({
  listFolders: (signal) =>
    wrap<Folder[]>("listFolders", undefined, () => backend.listFolders(signal)),
  getFolderNotes: (folderIds, signal) =>
    wrap<Note[]>("getFolderNotes", folderIds, () =>
      backend.getFolderNotes(folderIds, signal),
    ),
  getFolderSnippets: (folderIds, signal) =>
    wrap("getFolderSnippets", folderIds, () =>
      backend.getFolderSnippets(folderIds, signal),
    ),
  getFolderBodies: (folderIds, signal) =>
    wrap("getFolderBodies", `${folderIds.length} folders`, () =>
      backend.getFolderBodies(folderIds, signal),
    ),
  getNoteBody: (noteId, signal) =>
    wrap<string>("getNoteBody", noteId, () => backend.getNoteBody(noteId, signal)),
  getNoteHtml: (noteId, signal) =>
    wrap<string>("getNoteHtml", noteId, () => backend.getNoteHtml(noteId, signal)),
  moveNotes: (moves) =>
    wrap<MoveResult[]>(
      "moveNotes",
      `${moves.length} moves`,
      () => backend.moveNotes(moves),
    ),
  createNote: (folderId) =>
    wrap<void>("createNote", folderId, () => backend.createNote(folderId)),
  createFolder: (accountName, name) =>
    wrap<void>("createFolder", { accountName, name }, () =>
      backend.createFolder(accountName, name),
    ),
  updateNoteBody: (noteId, body) =>
    wrap<void>(
      "updateNoteBody",
      { noteId, bodyLen: body.length },
      () => backend.updateNoteBody(noteId, body),
    ),
});
