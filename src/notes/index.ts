export type { Folder, MoveResult, Note, NotesBackend } from "./types.ts";

import type { NotesBackend } from "./types.ts";
import { osascriptBackend } from "./osascript.ts";
import { scriptingBridgeBackend } from "./scripting-bridge.ts";
import { sqliteBackend } from "./sqlite.ts";
import { dumpStats, wrapWithLogging } from "./logging-backend.ts";

export type BackendChoice = "osa" | "scripting-bridge" | "sqlite";

// Registry — used by the TUI's backend-picker so users can switch at
// runtime. Keys match the values accepted by NOTES_BACKEND.
export const availableBackends: Record<BackendChoice, NotesBackend> = {
  osa: osascriptBackend,
  "scripting-bridge": scriptingBridgeBackend,
  sqlite: sqliteBackend,
};

export const BACKEND_LABELS: Record<BackendChoice, string> = {
  osa: "osascript (default)",
  "scripting-bridge": "scripting-bridge (Swift helper)",
  sqlite: "sqlite (NoteStore.sqlite, needs FDA)",
};

// Initial choice from the env var, defaulting to osa.
export const initialBackendChoice = (): BackendChoice => {
  const env = Bun.env.NOTES_BACKEND;
  if (env === "sqlite" || env === "scripting-bridge") return env;
  return "osa";
};

// DEBUG=1 wraps the backend with per-call stderr logging + a session summary
// printed on exit. Off by default — zero overhead.
const debug = Bun.env.DEBUG === "1";
if (debug) {
  process.on("exit", dumpStats);
}

// `notes` is the singleton consumed by the CLI and any non-TUI caller
// that needs a backend at module-load time. The TUI uses the provider
// (which can swap backends at runtime).
const base = availableBackends[initialBackendChoice()];
export const notes: NotesBackend = debug ? wrapWithLogging(base) : base;

