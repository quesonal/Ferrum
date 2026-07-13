/**
 * Per-key race counter.
 *
 * For callbacks that need to know "is the in-flight work I started
 * still the latest one?" after an `await`. The pattern is:
 *
 *   const stamp = counter.begin();
 *   try { await someIpc(); if (!counter.isLatest(stamp)) return; ... }
 *   finally { // no end() needed for plain counters
 *
 * The most common alternative — a module-scoped `let gen = 0; const
 * stamp = ++gen; if (stamp !== gen) return;` — works until you have
 * two independent call-sites that both want a counter and would
 * otherwise need separate module-scoped `gen` variables. Each
 * `useRaceCounter(key)` call gets its own counter, keyed by string,
 * in a module-level Map.
 *
 * If the caller also wants a dedupe gate ("don't start a second
 * request for this key while one is already in flight"), see
 * `useInflightKey` instead — it does both.
 *
 * Why not LRU / GC: keys are stable identifiers (composable name,
 * image id, etc.). The Map size is bounded by distinct resources
 * touched in a session.
 */

interface CounterState {
  /** Latest stamped value. `begin()` increments and returns the new value. */
  current: number;
}

const counters = new Map<string, CounterState>();

function getCounter(key: string): CounterState {
  let counter = counters.get(key);
  if (!counter) {
    counter = { current: 0 };
    counters.set(key, counter);
  }
  return counter;
}

export interface RaceCounter {
  /**
   * Stamp a new version and return it. Caller captures and checks
   * via `isLatest()` after each `await`. Bumping the version
   * doesn't cancel in-flight work — it just marks the captured
   * stamps stale.
   */
  begin(): number;
  /**
   * True if `stamp` is still the current version (no later
   * `begin()` or `invalidate()` has fired).
   */
  isLatest(stamp: number): boolean;
  /**
   * Bump to a fresh version without stamping — invalidates every
   * captured stamp. Used by callers that want to abort all
   * in-flight work without starting a new request (e.g.
   * `clearTagFilter` discarding whatever a previous tag load was
   * about to write).
   */
  invalidate(): void;
}

export function useRaceCounter(key: string): RaceCounter {
  return {
    begin(): number {
      return ++getCounter(key).current;
    },
    isLatest(stamp: number): boolean {
      return getCounter(key).current === stamp;
    },
    invalidate(): void {
      ++getCounter(key).current;
    },
  };
}
