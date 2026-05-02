import { useEffect, useRef, useState } from "react";
import { useNotes } from "../notes/context.tsx";
import { htmlToTerminalText } from "../lib/render-html.ts";
import { LRU } from "../lib/lru.ts";

const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_CACHE_CAP = 200;

/**
 * Debounced + cached preview fetch. On cursor change:
 *   - Cache hit: instant; no debounce, no fetch.
 *   - Cache miss: 300 ms debounce, then `getNoteHtml`, store result.
 *
 * `bustToken` invalidates the entire cache (called on manual/auto refresh
 * and after edits, so an externally-changed note gets re-fetched).
 *
 * Sequence counter discards stale-response setState; the cache write is
 * unconditional so revisits are still fast even for once-stale fetches.
 */
export const useNotePreview = (
  noteId: string | undefined,
  bustToken: number = 0,
) => {
  const notes = useNotes();
  const [preview, setPreview] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const cacheRef = useRef<LRU<string, string>>(new LRU(PREVIEW_CACHE_CAP));

  // Bust the cache on refresh ticks.
  useEffect(() => {
    cacheRef.current.clear();
  }, [bustToken]);

  useEffect(() => {
    if (!noteId) {
      setPreview("");
      setLoading(false);
      return;
    }
    const cached = cacheRef.current.get(noteId);
    if (cached !== undefined) {
      setPreview(cached);
      setLoading(false);
      return;
    }
    const mySeq = ++seq.current;
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const html = await notes.getNoteHtml(noteId, controller.signal);
        const rendered = htmlToTerminalText(html);
        cacheRef.current.set(noteId, rendered);
        if (seq.current === mySeq) {
          setPreview(rendered);
          setLoading(false);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (seq.current === mySeq) {
          setPreview(`(error: ${e instanceof Error ? e.message : String(e)})`);
          setLoading(false);
        }
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [noteId, notes, bustToken]);

  return { preview, loading };
};
