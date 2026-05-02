import { useEffect, useRef, useState } from "react";
import { useNotes } from "../notes/context.tsx";

const PREVIEW_DEBOUNCE_MS = 150;

/**
 * Debounced preview-body fetch. When `noteId` changes, waits 150ms (so fast
 * cursor scrolling doesn't spawn an osascript per keystroke), then loads the
 * body. A sequence counter discards stale responses if the cursor has moved on.
 */
export const useNotePreview = (noteId: string | undefined) => {
  const notes = useNotes();
  const [preview, setPreview] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!noteId) {
      setPreview("");
      setLoading(false);
      return;
    }
    const mySeq = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const body = await notes.getNoteBody(noteId);
        if (seq.current === mySeq) {
          setPreview(body);
          setLoading(false);
        }
      } catch (e) {
        if (seq.current === mySeq) {
          setPreview(`(error: ${e instanceof Error ? e.message : String(e)})`);
          setLoading(false);
        }
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [noteId, notes]);

  return { preview, loading };
};
