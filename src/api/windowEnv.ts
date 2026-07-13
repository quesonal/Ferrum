// ============================================================================
// Typed accessors for `window.__XXX__` globals injected by `lib.rs::setup`.
//
// Replaces the 8 `(window as any).__XXX__` casts scattered across the frontend.
// After the first read, the value is cleared from the window object so that
// any accidental re-read returns `null` / `undefined`.
// ============================================================================

import type { AppConfigDto } from '../types/ipc';

/** Read `window.__INITIAL_FILE__` once, then clear. Returns `null` if the
 *  app was not launched with a file argument. */
export function takeInitialFile(): string | null {
  const w = window as WindowWithAppGlobals;
  const v = w.__INITIAL_FILE__ ?? null;
  w.__INITIAL_FILE__ = null;
  return v;
}

/** Read `window.__APP_CONFIG__` once, then clear. Falls back to `null` when
 *  the Rust setup didn't inject a config (e.g. extremely early renderer). */
export function takeAppConfig(): AppConfigDto | null {
  const w = window as WindowWithAppGlobals;
  const v = w.__APP_CONFIG__ ?? null;
  w.__APP_CONFIG__ = null;
  return v;
}

/** Read `window.__FRONTEND_TRACE_PATH__` once, then clear. Returns `null`
 *  when the flamegraph feature is not enabled. */
export function takeFrontendTracePath(): string | null {
  const w = window as WindowWithAppGlobals;
  const v = w.__FRONTEND_TRACE_PATH__ || null;
  w.__FRONTEND_TRACE_PATH__ = '';
  return v;
}

interface WindowWithAppGlobals {
  __INITIAL_FILE__?: string | null;
  __APP_CONFIG__?: AppConfigDto | null;
  __FRONTEND_TRACE_PATH__?: string;
}
