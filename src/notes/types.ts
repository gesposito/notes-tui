export interface Folder {
  id: string;
  name: string;
  account: string;
  path: string;
  depth: number;
}

export interface Note {
  id: string;
  title: string;
  folderId: string;
  folderPath: string;
  account: string;
  modifiedAt: string | null;
}

export interface MoveResult {
  noteId: string;
  ok: boolean;
  error?: string;
}

export interface NotesBackend {
  /**
   * Combined fetch: returns both folders and notes in a single backend call.
   * Cheaper than `Promise.all([listFolders(), listNotes()])` for osa (one
   * spawn, shared per-folder iteration, app-level note-metadata bulk).
   */
  listAll(): Promise<{ folders: Folder[]; notes: Note[] }>;
  listFolders(): Promise<Folder[]>;
  listNotes(): Promise<Note[]>;
  moveNotes(
    moves: Array<{ noteId: string; folderId: string }>,
  ): Promise<MoveResult[]>;
  getNoteBody(noteId: string): Promise<string>;
  /**
   * Batched snippet fetch. Returns `{ folderId: { noteId: snippet } }` for every
   * requested folder. One backend call regardless of how many folders.
   */
  getFolderSnippets(
    folderIds: string[],
  ): Promise<Record<string, Record<string, string>>>;
}
