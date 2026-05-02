import type {
  MouseEvent as OpenTUIMouseEvent,
  SelectRenderable,
} from "@opentui/core";

const DEFAULT_WHEEL_STEP = 3;

/**
 * Builds an onMouseScroll handler that translates wheel events into
 * cursor movement. Up/down scrolls the cursor by `step`, clamped to
 * `[0, total - 1]`.
 */
export const makeWheelScrollHandler = (
  total: number,
  setCursor: (updater: (n: number) => number) => void,
  step: number = DEFAULT_WHEEL_STEP,
) =>
  (e: OpenTUIMouseEvent): void => {
    const dir = e.scroll?.direction;
    if (!dir || total === 0) return;
    const delta = dir === "up" ? -step : dir === "down" ? step : 0;
    if (delta === 0) return;
    setCursor((c) => {
      const next = c + delta;
      if (next < 0) return 0;
      if (next >= total) return total - 1;
      return next;
    });
  };

/**
 * Builds an onMouseDown handler that maps a left-click position inside
 * a Select to the corresponding option index. Caller-provided `onPick`
 * receives the index (so this lib doesn't need to know about focus or
 * any other app-level concept).
 *
 * `linesPerItem` accounts for the row height — Select renders 1 line per
 * option by default, 2 with showDescription=true.
 */
export const makeOptionClickHandler = (
  sel: SelectRenderable | null,
  scrollOffset: number,
  total: number,
  linesPerItem: number,
  onPick: (index: number) => void,
) =>
  (e: OpenTUIMouseEvent): void => {
    if (!sel || e.button !== 0) return;
    const localY = e.y - sel.screenY;
    if (localY < 0) return;
    const clickedIndex = scrollOffset + Math.floor(localY / linesPerItem);
    if (clickedIndex < 0 || clickedIndex >= total) return;
    onPick(clickedIndex);
  };
