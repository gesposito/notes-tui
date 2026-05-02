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
 * Shallow equality on the fields that affect what the UI shows: id (folder
 * present), name + path (folder renamed/moved), noteCount (notes added or
 * removed). Used by `refresh()` to skip the expensive per-folder cache
 * invalidation when nothing visibly changed.
 *
 * Note: doesn't catch within-folder note edits (title/body changes that
 * leave the count the same). For that you'd need to compare per-folder
 * note metadata, which is what the cache invalidation does anyway.
 */
export const foldersEqual = (a: Folder[], b: Folder[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.noteCount !== y.noteCount ||
      x.name !== y.name ||
      x.path !== y.path
    ) {
      return false;
    }
  }
  return true;
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
