export type { Folder, MoveResult, Note, NotesBackend } from "./types.ts";

import type { NotesBackend } from "./types.ts";
import { osascriptBackend } from "./osascript.ts";
import { scriptingBridgeBackend } from "./scripting-bridge.ts";
import { dumpStats, wrapWithLogging } from "./logging-backend.ts";

// Backend selection: NOTES_BACKEND=scripting-bridge to use the long-lived
// Swift helper (ScriptingBridge); anything else uses the osascript backend.
const choice = Bun.env.NOTES_BACKEND;
const base: NotesBackend =
  choice === "scripting-bridge" ? scriptingBridgeBackend : osascriptBackend;

// DEBUG=1 wraps the backend with per-call stderr logging + a session summary
// printed on exit. Off by default — zero overhead.
const debug = Bun.env.DEBUG === "1";
if (debug) {
  process.on("exit", dumpStats);
}
export const notes: NotesBackend = debug ? wrapWithLogging(base) : base;

