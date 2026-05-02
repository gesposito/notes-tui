import { useEffect, useRef, useState } from "react";
import { useNotes } from "../notes/context.tsx";

export type SnippetCache = Map<string, Record<string, string>>;

/**
 * Lazy per-folder snippet cache. Same shape and invalidation contract as
 * useNotesByFolder. Snippets are non-critical, so fetch errors are swallowed.
 */
export const useFolderSnippets = (activeFolderIds: Set<string>) => {
  const notes = useNotes();
  const [snippetCache, setSnippetCache] = useState<SnippetCache>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (activeFolderIds.size === 0) return;
    const toFetch: string[] = [];
    for (const folderId of activeFolderIds) {
      if (snippetCache.has(folderId)) continue;
      if (inFlight.current.has(folderId)) continue;
      toFetch.push(folderId);
      inFlight.current.add(folderId);
    }
    if (toFetch.length === 0) return;
    notes
      .getFolderSnippets(toFetch)
      .then((byFolder) => {
        setSnippetCache((m) => {
          const next = new Map(m);
          for (const [fid, snippets] of Object.entries(byFolder)) {
            next.set(fid, snippets);
          }
          return next;
        });
      })
      .catch(() => {
        // Snippets are non-critical; swallow.
      })
      .finally(() => {
        for (const fid of toFetch) inFlight.current.delete(fid);
      });
  }, [activeFolderIds, snippetCache, notes]);

  const invalidate = (folderIds: Iterable<string>): void => {
    setSnippetCache((m) => {
      const next = new Map(m);
      for (const fid of folderIds) next.delete(fid);
      return next;
    });
  };

  return { snippetCache, invalidate };
};
