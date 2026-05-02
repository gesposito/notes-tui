export type { Folder, MoveResult, Note, NotesBackend } from "./types.ts";

import { osascriptBackend } from "./osascript.ts";

// Single swap point: change this binding to switch backends
// (e.g. a future Swift-helper backend driving ScriptingBridge).
export const notes = osascriptBackend;
