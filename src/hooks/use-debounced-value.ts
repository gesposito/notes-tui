import { useEffect, useState } from "react";

/**
 * Returns `value` debounced by `ms`. While the input changes, the returned
 * value lags by up to `ms`; once the input settles for `ms`, it catches up.
 *
 * Use to avoid firing expensive downstream effects (lazy fetches, etc.)
 * during fast keyboard scroll where the user blasts past intermediate states.
 */
export const useDebouncedValue = <T>(value: T, ms: number): T => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
};
