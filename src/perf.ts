// Frontend performance tracing.
//
// Emits Chrome trace format events that get flushed to a separate file
// (`<rust-trace>.frontend.json`) via the `write_frontend_perf` Tauri
// command. The file can be loaded alongside the Rust trace in
// https://ui.perfetto.dev for a unified view of the startup timeline.
//
// Active only when the Rust side passed `--profile-output`. Otherwise
// `__FRONTEND_TRACE_PATH__` is empty and every helper is a no-op.
//
// Timestamps use `performance.now()` relative to module load (i.e. when
// `main.ts` first executes), so they cover JS parse + Vue mount + store
// init + IPC. To align with the Rust trace (which uses process start as
// t=0), subtract `performance.timeOrigin + module_load_offset` from
// each event's `ts`. The `frontend::navigation_start` marker at ts=0
// carries `perf_time_origin` (Unix ms) and `module_load_ms` so the
// offset can be computed in Perfetto via "Adjust for clock drift".

import { writeFrontendPerf } from './api/commands';
import { takeFrontendTracePath } from './api/windowEnv';

interface PerfEvent {
  name: string;
  ph: 'M' | 'i' | 'B' | 'E';
  ts: number;
  pid: number;
  tid: number;
  cat: string;
  s?: 't' | 'p';
  args?: Record<string, unknown>;
}

const MODULE_LOAD_MS = performance.now();
const NAV_TIME_ORIGIN = performance.timeOrigin;
const events: PerfEvent[] = [];
let flushTimer: number | null = null;
const FLUSH_INTERVAL_MS = 1000;

// Read the trace path once at module load. `takeFrontendTracePath()`
// returns null when the flamegraph feature is off, or a non-empty
// path string when it's on; cache the result so the per-event
// `isPerfEnabled()` checks stay cheap (no window lookup per call).
const TRACE_PATH: string | null = takeFrontendTracePath();

function nowMicros(): number {
  return performance.now() * 1000;
}

function push(ev: PerfEvent) {
  events.push(ev);
}

// Trace header: thread name + navigation-start marker.
push({
  name: 'thread_name',
  ph: 'M',
  ts: 0,
  pid: 2,
  tid: 2,
  cat: '__metadata',
  args: { name: 'frontend' },
});
push({
  name: 'frontend::navigation_start',
  ph: 'i',
  ts: 0,
  pid: 2,
  tid: 2,
  cat: 'frontend_meta',
  s: 't',
  args: {
    perf_time_origin_unix_ms: NAV_TIME_ORIGIN,
    module_load_ms_from_navigation: MODULE_LOAD_MS,
  },
});

export function isPerfEnabled(): boolean {
  return TRACE_PATH !== null;
}

export function perfMark(name: string, args?: Record<string, unknown>): void {
  if (!isPerfEnabled()) return;
  push({
    name: `frontend::${name}`,
    ph: 'i',
    ts: nowMicros(),
    pid: 2,
    tid: 2,
    cat: 'frontend',
    s: 't',
    args,
  });
}

export function perfBegin(name: string, args?: Record<string, unknown>): void {
  if (!isPerfEnabled()) return;
  push({
    name: `frontend::${name}`,
    ph: 'B',
    ts: nowMicros(),
    pid: 2,
    tid: 2,
    cat: 'frontend',
    args,
  });
}

export function perfEnd(name: string): void {
  if (!isPerfEnabled()) return;
  push({
    name: `frontend::${name}`,
    ph: 'E',
    ts: nowMicros(),
    pid: 2,
    tid: 2,
    cat: 'frontend',
  });
}

async function doFlush(): Promise<void> {
  if (TRACE_PATH === null) return;

  try {
    await writeFrontendPerf(events, TRACE_PATH);
  } catch (_e) {
    // Silently ignore flush errors during auto-flush
  }
}

export async function flushPerf(): Promise<void> {
  if (TRACE_PATH === null) return;

  // Start periodic auto-flush so switch events survive process kill
  if (flushTimer === null) {
    flushTimer = window.setInterval(doFlush, FLUSH_INTERVAL_MS);
  }

  await doFlush();
  // eslint-disable-next-line no-console
  console.info('[perf] flushed', events.length, 'events to', TRACE_PATH);
}