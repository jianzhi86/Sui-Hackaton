import { useState } from 'react';

/**
 * A `useState` that also remembers its value in `localStorage`, so a batch
 * or unit ID pasted into one tab is still there when you switch to another
 * tab that needs the same ID (Scan/Mint both want a batch ID; Verify's URL
 * param and Pay's `?unit=` still take priority when present — this is only
 * the fallback for "nothing more specific was provided"). Wrapped in
 * try/catch since `localStorage` can throw in private-browsing contexts or
 * when storage is full; falling back to in-memory state only is fine, it
 * just loses the "remembered across tabs" convenience, not correctness.
 */
export function usePersistedState(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });

  function set(next: string) {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // Private browsing / quota exceeded — the value still works for this
      // session via React state, it just won't persist across a reload.
    }
  }

  return [value, set];
}

/** Shared localStorage keys, so every component reads/writes the same slot. */
export const LAST_BATCH_ID_KEY = 'pharmatrust:lastBatchId';
export const LAST_UNIT_ID_KEY = 'pharmatrust:lastUnitId';
