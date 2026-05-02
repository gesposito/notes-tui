import { useNotes } from "../notes/context.tsx";
import type { Folder, Note } from "../notes/types.ts";
import type { Mode, Pane } from "../types.ts";

type Deps = {
  folderById: Map<string, Folder>;
  notesByFolder: Map<string, Note[]>;
  marked: Set<string>;
  highlightedNote: Note | undefined;
  setMode: (m: Mode) => void;
  setFocused: (p: Pane) => void;
  setMarked: (m: Set<string>) => void;
  setToast: (s: string) => void;
  invalidateNotes: (ids: Iterable<string>) => void;
  invalidateSnippets: (ids: Iterable<string>) => void;
  reload: () => Promise<void>;
};

/**
 * Encapsulates the two move-related actions:
 *   - enterMoveMode: validate selection, switch focus to folder pane.
 *   - performMove:   execute the move via the backend, invalidate caches,
 *                    reload folder counts.
 *
 * Reads its inputs as a deps bag so the call site is one line and the
 * keyboard handler in App stays focused on dispatch, not implementation.
 */
export const useMoveAction = (deps: Deps) => {
  const notes = useNotes();

  const idsToMove = (): string[] =>
    deps.marked.size > 0
      ? Array.from(deps.marked)
      : deps.highlightedNote
        ? [deps.highlightedNote.id]
        : [];

  const accountOfNote = (noteId: string): string | undefined => {
    for (const arr of deps.notesByFolder.values()) {
      const note = arr.find((n) => n.id === noteId);
      if (note) return deps.folderById.get(note.folderId)?.account;
    }
    return undefined;
  };

  const enterMoveMode = (): void => {
    const ids = idsToMove();
    if (ids.length === 0) {
      deps.setToast("Nothing to move");
      return;
    }
    const accounts = new Set<string>();
    for (const id of ids) {
      const a = accountOfNote(id);
      if (a) accounts.add(a);
    }
    if (accounts.size > 1) {
      deps.setToast("Cannot move across accounts");
      return;
    }
    const [sourceAccount] = accounts;
    if (!sourceAccount) return;
    deps.setMode({
      kind: "moveTarget",
      sourceAccount,
      sourceCount: ids.length,
    });
    deps.setFocused("folders");
  };

  const performMove = async (
    target: Folder,
    sourceAccount: string,
  ): Promise<void> => {
    if (target.account !== sourceAccount) {
      deps.setToast(`Cannot move to ${target.account} (cross-account)`);
      return;
    }
    const ids = idsToMove();
    if (ids.length === 0) {
      deps.setToast("Nothing to move");
      return;
    }
    const sourceFolderIds = new Set<string>();
    for (const id of ids) {
      for (const arr of deps.notesByFolder.values()) {
        const note = arr.find((n) => n.id === id);
        if (note) {
          sourceFolderIds.add(note.folderId);
          break;
        }
      }
    }
    sourceFolderIds.add(target.id);

    try {
      const results = await notes.moveNotes(
        ids.map((noteId) => ({ noteId, folderId: target.id })),
      );
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      deps.setToast(
        `Moved ${ok} note${ok === 1 ? "" : "s"} → ${target.path}` +
          (failed ? ` (${failed} failed)` : ""),
      );
      deps.setMarked(new Set());
      deps.setMode({ kind: "browse" });
      deps.setFocused("notes");
      deps.invalidateNotes(sourceFolderIds);
      deps.invalidateSnippets(sourceFolderIds);
      await deps.reload();
    } catch (e) {
      deps.setToast(
        `Move failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  return { enterMoveMode, performMove };
};
