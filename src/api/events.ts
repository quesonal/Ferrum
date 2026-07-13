// ============================================================================
// Typed Tauri event listener wrapper — the ONLY place in the codebase that
// calls `listen` / `emit` directly. Event names + payload shapes are pinned
// in `IpcEventMap` below.
//
// Events are emitted by the Rust side (see `src-tauri/src/library.rs` +
// `lib.rs::single_instance`) and consumed by the frontend via `api.on(...)`.
// ============================================================================

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Map of event name → payload shape. Add a key here when adding a new event. */
export interface IpcEventMap {
  /** Emitted by the `tauri-plugin-single-instance` plugin when a second
   *  instance is launched. Payload is the new instance's CLI args. */
  'open-file': string[];

  /** Scan progress. `(current, total)`. */
  'library-scan-progress': [current: number, total: number];

  /** Emitted after a successful index_vault incremental update. No payload. */
  'library-db-incremental-update': undefined;

  /** Emitted when the scan completes. No payload. */
  'library-db-updated': undefined;

  /** Backfill progress. `(processed, total)`. */
  'library-meta-backfill-progress': [processed: number, total: number];

  /** Emitted when the backfill loop finishes. No payload. */
  'library-meta-backfill-completed': undefined;
}

/** Type-safe `listen` wrapper. The handler's payload type is inferred from
 *  `IpcEventMap`. Returns the same `UnlistenFn` as Tauri core. */
export function on<K extends keyof IpcEventMap>(
  event: K,
  handler: (payload: IpcEventMap[K]) => void,
): Promise<UnlistenFn> {
  return listen<IpcEventMap[K]>(event, (e) => handler(e.payload));
}
