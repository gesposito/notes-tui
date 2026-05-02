import { useCallback, useEffect, useRef, useState } from "react";
import { useNotes } from "../notes/context.tsx";
import type { Note } from "../notes/types.ts";

const CHUNK_SIZE = 8;

export type IndexedNote = Note & { body: string };

/**
 * Lazy full-text index for the filter pane. When `enabled` flips true,
 * progressively fetches every folder's notes (titles, dates) in parallel
 * with their full plaintext bodies, in chunks of {@link CHUNK_SIZE}. The
 * cache survives between filter sessions in the same run; `bustToken`
 * (refresh) resets it.
 *
 * Why progressive: a one-shot fetch of all 4000+ notes' plaintext is ~6 s
 * with no UI feedback. Chunked we get a "X / Y folders indexed" updating
 * roughly every chunk's ~1 s. Same total time, much better perceived
 * responsiveness.
 *
 * The hook fetches metadata + bodies in parallel per chunk: getFolderNotes
 * is fast (~50 ms/folder), getFolderBodies is the slow one (plaintext is
 * the bottleneck), so the wall time per chunk ≈ the plaintext call.
 */
export const useNoteIndex = (
  allFolderIds: string[],
  enabled: boolean,
  bustToken: number = 0,
) => {
  const notes = useNotes();
  const [index, setIndex] = useState<Map<string, IndexedNote>>(new Map());
  const [indexedFolderIds, setIndexedFolderIds] = useState<Set<string>>(
    new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  // Bumping `runId` cancels the in-flight chunk loop. The visible chunk
  // progress (indexedFolderIds.size) is what the banner reads.
  const runId = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  // Refresh invalidates everything; rebuild from scratch next time enabled.
  useEffect(() => {
    setIndex(new Map());
    setIndexedFolderIds(new Set());
  }, [bustToken]);

  useEffect(() => {
    if (!enabled) {
      inFlight.current?.abort();
      inFlight.current = null;
      return;
    }
    const myRun = ++runId.current;

    const run = async () => {
      // Snapshot the already-indexed set; we mutate it as chunks land but
      // don't want to re-read state inside the loop (closure capture).
      const done = new Set(indexedFolderIds);
      let pending = allFolderIds.filter((id) => !done.has(id));
      while (pending.length > 0 && runId.current === myRun) {
        const chunk = pending.slice(0, CHUNK_SIZE);
        const controller = new AbortController();
        inFlight.current = controller;
        try {
          const [notesArr, bodyMap] = await Promise.all([
            notes.getFolderNotes(chunk, controller.signal),
            notes.getFolderBodies(chunk, controller.signal),
          ]);
          if (runId.current !== myRun) return;
          setIndex((m) => {
            const next = new Map(m);
            for (const n of notesArr) {
              const body = bodyMap[n.folderId]?.[n.id] ?? "";
              next.set(n.id, { ...n, body });
            }
            return next;
          });
          setIndexedFolderIds((s) => {
            const next = new Set(s);
            for (const fid of chunk) next.add(fid);
            return next;
          });
          for (const fid of chunk) done.add(fid);
        } catch (e) {
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
        pending = allFolderIds.filter((id) => !done.has(id));
      }
      inFlight.current = null;
    };
    void run();

    return () => {
      // New deps came in (or unmount) — bump runId so the loop bails.
      runId.current++;
      inFlight.current?.abort();
      inFlight.current = null;
    };
    // `indexedFolderIds` is intentionally excluded — it changes inside the
    // loop and re-running the effect every chunk would restart the scan.
    // We snapshot it via the `done` closure and rely on the runId guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, allFolderIds, notes, bustToken]);

  const reset = useCallback(() => {
    runId.current++;
    inFlight.current?.abort();
    inFlight.current = null;
    setIndex(new Map());
    setIndexedFolderIds(new Set());
    setError(null);
  }, []);

  // Drop affected folders from the index so the next enabled pass refetches
  // them. Used after writes (move/create/save): the index entries are stale
  // wrt folder membership or body content, but every other folder is fine.
  const invalidate = useCallback((folderIds: Iterable<string>) => {
    const targets = new Set(folderIds);
    if (targets.size === 0) return;
    setIndex((m) => {
      let changed = false;
      const next = new Map<string, IndexedNote>();
      for (const [id, entry] of m) {
        if (targets.has(entry.folderId)) {
          changed = true;
          continue;
        }
        next.set(id, entry);
      }
      return changed ? next : m;
    });
    setIndexedFolderIds((s) => {
      let changed = false;
      const next = new Set(s);
      for (const fid of targets) {
        if (next.delete(fid)) changed = true;
      }
      return changed ? next : s;
    });
  }, []);

  return {
    index,
    progress: { loaded: indexedFolderIds.size, total: allFolderIds.length },
    indexing:
      enabled &&
      allFolderIds.length > 0 &&
      indexedFolderIds.size < allFolderIds.length,
    error,
    reset,
    invalidate,
  };
};
