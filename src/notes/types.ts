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
  /** Folders + their direct note counts. Fast: no per-note fetches. */
  listFolders(): Promise<Folder[]>;
  /**
   * Per-folder note metadata (id/title/date). One backend call regardless of
   * how many folders. Returns the merged list; use n.folderId to group.
   */
  getFolderNotes(folderIds: string[]): Promise<Note[]>;
  getNoteBody(noteId: string): Promise<string>;
  /**
   * Batched snippet fetch. Returns `{ folderId: { noteId: snippet } }` for every
   * requested folder.
   */
  getFolderSnippets(
    folderIds: string[],
  ): Promise<Record<string, Record<string, string>>>;
  moveNotes(
    moves: Array<{ noteId: string; folderId: string }>,
  ): Promise<MoveResult[]>;
}
