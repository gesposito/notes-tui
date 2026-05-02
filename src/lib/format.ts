// === Folder pane render config ================================================
// SHOW_FOLDER_COUNTS=false  → bare folder names.
// RIGHT_ALIGN_COUNTS=false  → count inline (e.g. "Work  12"), no truncation.
// FOLDER_INNER_WIDTH        → usable content width when right-aligning.
//   Pane width − 2 border − 2 padding − 1 scroll-indicator column.
//   (Select reserves the rightmost column for showScrollIndicator even when
//   it's not currently visible; without this offset the count gets clipped.)
export const SHOW_FOLDER_COUNTS = true;
export const RIGHT_ALIGN_COUNTS = true;
export const FOLDER_PANE_WIDTH = 36;
export const FOLDER_INNER_WIDTH = FOLDER_PANE_WIDTH - 4 - 1;
export const NOTES_PANE_WIDTH = 44;
export const NOTE_LINES_PER_ITEM = 2;
// ==============================================================================

export const formatFolderOptionName = (
  indent: string,
  name: string,
  count: number,
): string => {
  const baseName = indent + name;
  if (!SHOW_FOLDER_COUNTS) return baseName;
  const countText = count > 0 ? String(count) : "";
  if (!countText) return baseName;

  if (!RIGHT_ALIGN_COUNTS) {
    return `${baseName}  ${countText}`;
  }

  const minGap = 1;
  const maxNameLen = FOLDER_INNER_WIDTH - countText.length - minGap;
  const truncated =
    baseName.length > maxNameLen
      ? baseName.substring(0, Math.max(0, maxNameLen - 1)) + "…"
      : baseName;
  const padding = Math.max(
    minGap,
    FOLDER_INNER_WIDTH - truncated.length - countText.length,
  );
  return truncated + " ".repeat(padding) + countText;
};

export const formatNoteMeta = (
  modifiedAt: string | null,
  snippet: string,
): string => {
  const date = modifiedAt ? modifiedAt.substring(0, 10) : "";
  if (date && snippet) return `${date}  ${snippet}`;
  return date || snippet || "";
};
