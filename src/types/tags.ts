// ============================================================================
// Tag types — re-export `TagDto` from `types/ipc.ts`.
//
// The frontend currently uses the same snake_case shape (see `tagStore.ts`).
// A future PR (Phase 4d) will introduce a camelCase UI variant + a converter.
// ============================================================================

export type { TagDto as Tag } from './ipc';
