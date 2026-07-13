/**
 * Per-key in-flight dedupe + race counter.
 *
 * Some callers want both: a dedupe gate ("don't start a second
 * request for this key while one is in flight") and a stale-stamp
 * check ("if a newer request fired while I was awaiting, drop my
 * writes"). That's what `loadFolderImages` needs — clicks on the
 * folder tree fire repeatedly while the user expands / collapses,
 * and only the latest landing in `imagesByFolder` should commit.
 *
 * ## API
 *
 *   const stamp = key.tryBegin();
 *   if (stamp === null) return;        // another request in flight
 *   try {
 *     await someIpc();
 *     if (!key.isLatest(stamp)) return;// a newer begin() raced us
 *     commitWrites();
 *   } finally {
 *     key.end();
 *   }
 *
 * `tryBegin` collapses the dedupe-and-stamp sequence into one
 * call so the caller can't forget either step. Always pair with
 * `end()` in a `finally` — even on throw — otherwise the gate
 * stays shut for the rest of the session.
 *
 * If the caller doesn't need a dedupe gate (most async work),
 * use `useRaceCounter` instead — narrower API surface.
 *
 * Why not LRU / GC: the key is a stable resource identifier
 * (folder hash). Map size is bounded by distinct folders touched
 * in a session.
 */

interface InflightState {
  current: number;
  inFlight: boolean;
}

const inflight = new Map<string, InflightState>();

function getState(key: string): InflightState {
  let state = inflight.get(key);
  if (!state) {
    state = { current: 0, inFlight: false };
    inflight.set(key, state);
  }
  return state;
}

export interface InflightKey {
  /**
   * Stamp a new version **iff** no request for this key is in
   * flight. Returns the new stamp on success, or `null` if another
   * call is already in flight (caller should drop the work).
   */
  tryBegin(): number | null;
  /**
   * True if `stamp` is still the current version. Always call
   * after each `await` before mutating shared state.
   */
  isLatest(stamp: number): boolean;
  /**
   * Release the in-flight slot. Always call in `finally` after a
   * successful `tryBegin()`, even on throw.
   */
  end(): void;
}

export function useInflightKey(key: string): InflightKey {
  return {
    tryBegin(): number | null {
      const state = getState(key);
      if (state.inFlight) return null;
      state.inFlight = true;
      return ++state.current;
    },
    isLatest(stamp: number): boolean {
      return getState(key).current === stamp;
    },
    end(): void {
      getState(key).inFlight = false;
    },
  };
}
