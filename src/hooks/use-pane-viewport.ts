import { useEffect, useState } from "react";
import { NOTE_LINES_PER_ITEM } from "../lib/format.ts";

/**
 * Approximates Select's internal viewport from the terminal height so the
 * scroll-offset mirror and click-to-select math have something to work with.
 * Folders use 1 line per option; notes use 2 (showDescription=true).
 */
export const usePaneViewport = (
  termHeight: number,
  filterRowVisible: boolean,
) => {
  // Reserve: footer + toast + 2 pane borders + 1 title.
  const baseRows = Math.max(1, termHeight - 5);
  const folderVisibleRows = baseRows;
  const noteVisibleRows = Math.max(
    1,
    Math.floor((baseRows - (filterRowVisible ? 1 : 0)) / NOTE_LINES_PER_ITEM),
  );
  // Shift+↑/↓ jumps roughly one viewport.
  const pageStep = Math.max(5, termHeight - 6);
  return { pageStep, folderVisibleRows, noteVisibleRows };
};

/**
 * Mirrors a Select's private `scrollOffset` so we can map mouse-click y →
 * option index (Select doesn't expose its scroll position publicly).
 */
export const useScrollOffset = (
  cursor: number,
  visibleRows: number,
  total: number,
): number => {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset((prev) => {
      if (total <= visibleRows) return 0;
      let next = prev;
      if (cursor < next) next = cursor;
      else if (cursor >= next + visibleRows) next = cursor - visibleRows + 1;
      return Math.max(0, Math.min(next, total - visibleRows));
    });
  }, [cursor, visibleRows, total]);
  return offset;
};
