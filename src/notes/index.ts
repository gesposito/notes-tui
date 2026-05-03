export type { Folder, MoveResult, Note, NotesBackend } from "./types.ts";

import type { NotesBackend } from "./types.ts";
import { osascriptBackend } from "./osascript.ts";
import { scriptingBridgeBackend } from "./scripting-bridge.ts";
import { sqliteBackend } from "./sqlite.ts";
import { dumpStats, wrapWithLogging } from "./logging-backend.ts";

// Backend selection via NOTES_BACKEND:
//   sqlite           — read NoteStore.sqlite directly (needs Full Disk
//                      Access; writes + body decoding still defer to osa)
//   scripting-bridge — long-lived Swift helper using ScriptingBridge
//   anything else    — osascript (default)
const choice = Bun.env.NOTES_BACKEND;
const base: NotesBackend =
  choice === "sqlite"
    ? sqliteBackend
    : choice === "scripting-bridge"
      ? scriptingBridgeBackend
      : osascriptBackend;

// DEBUG=1 wraps the backend with per-call stderr logging + a session summary
// printed on exit. Off by default — zero overhead.
const debug = Bun.env.DEBUG === "1";
if (debug) {
  process.on("exit", dumpStats);
}
export const notes: NotesBackend = debug ? wrapWithLogging(base) : base;

