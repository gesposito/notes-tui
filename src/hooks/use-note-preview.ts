import { useEffect, useRef, useState } from "react";
import { useNotes } from "../notes/context.tsx";
import { htmlToTerminalText } from "../lib/render-html.ts";

const PREVIEW_DEBOUNCE_MS = 150;

/**
 * Debounced preview fetch. Pulls the HTML body and converts to terminal-
 * friendly text (with checklist markers, bullets, etc.). Sequence counter
 * discards stale responses on rapid cursor movement.
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
        const html = await notes.getNoteHtml(noteId);
        if (seq.current === mySeq) {
          setPreview(htmlToTerminalText(html));
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
