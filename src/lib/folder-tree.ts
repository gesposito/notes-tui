import type { Folder } from "../notes/types.ts";

/**
 * Returns the set of folder ids covering the active folder + every descendant,
 * matching Apple Notes' "selecting a parent shows all child notes" behavior.
 * Descendants are detected via the path-prefix convention from listFolders.
 */
export const descendantIdSet = (
  active: Folder | undefined,
  all: Folder[],
): Set<string> => {
  if (!active) return new Set<string>();
  const ids = new Set<string>([active.id]);
  const prefix = active.path + " / ";
  for (const f of all) {
    if (f.path.startsWith(prefix)) ids.add(f.id);
  }
  return ids;
};

/**
 * Recursive note counts: each folder's total = its own direct count + the
 * direct counts of every descendant. O(F²); fine for hundreds of folders.
 */
export const recursiveFolderCounts = (
  folders: Folder[],
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of folders) {
    let total = f.noteCount;
    const prefix = f.path + " / ";
    for (const child of folders) {
      if (child.id !== f.id && child.path.startsWith(prefix)) {
        total += child.noteCount;
      }
    }
    out[f.id] = total;
  }
  return out;
};
