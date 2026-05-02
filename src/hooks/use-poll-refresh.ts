import { useEffect, useRef } from "react";

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Periodically calls `onPoll` regardless of FSEvents availability.
 * Pairs with `useNotesWatcher`: when Full Disk Access is granted the watcher
 * fires in real time; without it, this hook keeps state from going stale.
 *
 * `onPoll` identity may change between renders (it captures app state); we
 * stash it in a ref so the interval is set once, not re-created each frame.
 */
export const usePollRefresh = (
  onPoll: () => void,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void => {
  const callbackRef = useRef(onPoll);
  callbackRef.current = onPoll;

  useEffect(() => {
    const id = setInterval(() => callbackRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
};
