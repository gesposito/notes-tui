import { useEffect, useRef, useState } from "react";
import { useNotes } from "../notes/context.tsx";
import type { Note } from "../notes/types.ts";

export type NotesByFolder = Map<string, Note[]>;

/**
 * Lazy per-folder note cache. When `activeFolderIds` changes, fetches notes
 * for any folder not yet cached (active + descendants in one batched call).
 * `invalidate(ids)` drops cache entries so the next render re-fetches.
 */
export const useNotesByFolder = (activeFolderIds: Set<string>) => {
  const notes = useNotes();
  const [notesByFolder, setNotesByFolder] = useState<NotesByFolder>(new Map());
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (activeFolderIds.size === 0) return;
    const toFetch: string[] = [];
    for (const folderId of activeFolderIds) {
      if (notesByFolder.has(folderId)) continue;
      if (inFlight.current.has(folderId)) continue;
      toFetch.push(folderId);
      inFlight.current.add(folderId);
    }
    if (toFetch.length === 0) return;
    notes
      .getFolderNotes(toFetch)
      .then((arr) => {
        const grouped: Record<string, Note[]> = {};
        for (const n of arr) (grouped[n.folderId] ||= []).push(n);
        setNotesByFolder((m) => {
          const next = new Map(m);
          for (const fid of toFetch) next.set(fid, grouped[fid] ?? []);
          return next;
        });
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        for (const fid of toFetch) inFlight.current.delete(fid);
      });
  }, [activeFolderIds, notesByFolder, notes]);

  const invalidate = (folderIds: Iterable<string>): void => {
    setNotesByFolder((m) => {
      const next = new Map(m);
      for (const fid of folderIds) next.delete(fid);
      return next;
    });
  };

  return { notesByFolder, invalidate, error };
};
