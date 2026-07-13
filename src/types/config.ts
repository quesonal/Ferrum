// ============================================================================
// Config types — re-export the DTO enums and `AppConfigDto` from `types/ipc.ts`.
//
// The frontend currently uses the same snake_case shape (see `configStore.ts`).
// A future PR (Phase 4d) will introduce a camelCase UI variant + a converter.
// ============================================================================

export {
  MouseAction,
  AppTheme,
  ScanMode,
  type AppConfigDto as AppConfig,
} from './ipc';
