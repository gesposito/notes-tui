export type { Folder, MoveResult, Note, NotesBackend } from "./types.ts";

import type { NotesBackend } from "./types.ts";
import { osascriptBackend } from "./osascript.ts";
import { scriptingBridgeBackend } from "./scripting-bridge.ts";

// Backend selection: NOTES_BACKEND=scripting-bridge to use the long-lived
// Swift helper (ScriptingBridge); anything else uses the osascript backend.
const choice = Bun.env.NOTES_BACKEND;
export const notes: NotesBackend =
  choice === "scripting-bridge" ? scriptingBridgeBackend : osascriptBackend;

