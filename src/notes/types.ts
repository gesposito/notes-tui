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
  listFolders(): Promise<Folder[]>;
  listNotes(): Promise<Note[]>;
  moveNotes(
    moves: Array<{ noteId: string; folderId: string }>,
  ): Promise<MoveResult[]>;
  getNoteBody(noteId: string): Promise<string>;
  /** Map of noteId → snippet (line-after-title) for every note in the folder. */
  getFolderSnippets(folderId: string): Promise<Record<string, string>>;
}
