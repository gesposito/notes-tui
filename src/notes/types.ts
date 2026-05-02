export interface Folder {
  id: string;
  name: string;
  account: string;
  path: string;
  depth: number;
  /** Direct note count (notes whose container is this folder, not descendants). */
  noteCount: number;
}

export interface Note {
  id: string;
  title: string;
  folderId: string;
  modifiedAt: string | null;
}

export interface MoveResult {
  noteId: string;
  ok: boolean;
  error?: string;
}

export interface NotesBackend {
  /**
   * Read-path methods accept an optional `AbortSignal`; passing one kills
   * the underlying osascript subprocess if the caller no longer cares
   * about the result (e.g., the user moved the cursor before the fetch
   * completed). Write methods deliberately don't accept a signal — we
   * never want to abort a half-done move/create/edit.
   */
  /** Folders + their direct note counts. Fast: no per-note fetches. */
  listFolders(signal?: AbortSignal): Promise<Folder[]>;
  /**
   * Per-folder note metadata (id/title/date). One backend call regardless of
   * how many folders. Returns the merged list; use n.folderId to group.
   */
  getFolderNotes(folderIds: string[], signal?: AbortSignal): Promise<Note[]>;
  getNoteBody(noteId: string, signal?: AbortSignal): Promise<string>;
  /** Returns the HTML body (richer than plaintext — preserves checklists). */
  getNoteHtml(noteId: string, signal?: AbortSignal): Promise<string>;
  /**
   * Replace a note's body. `body` is plain text; this wraps each line in
   * `<div>` so Apple Notes preserves line breaks. Title regenerates from
   * the first line. Note: rich formatting (checklists, lists, bold) in
   * the original is lost on round-trip.
   */
  updateNoteBody(noteId: string, body: string): Promise<void>;
  /**
   * Batched snippet fetch. Returns `{ folderId: { noteId: snippet } }` for every
   * requested folder.
   */
  getFolderSnippets(
    folderIds: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, Record<string, string>>>;
  /**
   * Batched full-plaintext fetch. Same Apple Event cost as `getFolderSnippets`
   * (one bulk `folder.notes.plaintext()` call per folder), but returns the
   * whole body keyed by note id. Used by the search index so filter mode can
   * match against body content.
   */
  getFolderBodies(
    folderIds: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, Record<string, string>>>;
  moveNotes(
    moves: Array<{ noteId: string; folderId: string }>,
  ): Promise<MoveResult[]>;
  /** Create a blank note in the given folder. */
  createNote(folderId: string): Promise<void>;
  /** Create a top-level folder in the named account. */
  createFolder(accountName: string, name: string): Promise<void>;
}
