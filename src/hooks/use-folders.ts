import { useCallback, useEffect, useState } from "react";
import { useNotes } from "../notes/context.tsx";
import type { Folder } from "../notes/types.ts";

/**
 * Loads the folder list (plus per-folder direct counts) from the active
 * backend. Call `reload()` after a write operation (move) to refresh counts.
 */
export const useFolders = () => {
  const notes = useNotes();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<Folder[] | null> => {
    setLoading(true);
    setError(null);
    try {
      const f = await notes.listFolders();
      setFolders(f);
      return f;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [notes]);

  // Clear stale folders when the backend itself changes (different IDs,
  // possibly different account labels). Avoids showing the previous
  // backend's data during the brief window before reload completes.
  useEffect(() => {
    setFolders([]);
    setError(null);
  }, [notes]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { folders, loading, error, reload };
};
