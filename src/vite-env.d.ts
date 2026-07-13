/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

import type { AppConfigDto } from "./types/ipc";

declare global {
  interface Window {
    /**
     * Set by `src-tauri/src/lib.rs::setup` during the Tauri setup phase.
     * `lib.rs` resolves the path to absolute and strips a leading `./`.
     * The frontend reads it once via `takeInitialFile()` and clears it.
     */
    __INITIAL_FILE__?: string | null;
    /**
     * Set by `src-tauri/src/lib.rs::setup`. The full `AppConfig` as JSON,
     * serialized from `config::load_config()`. Read once via
     * `takeAppConfig()`; cleared after the first read.
     */
    __APP_CONFIG__?: AppConfigDto | null;
    /**
     * Set by `src-tauri/src/lib.rs::setup` when the `flamegraph` feature
     * is enabled. Empty string when the feature is off. Read once via
     * `takeFrontendTracePath()`.
     */
    __FRONTEND_TRACE_PATH__?: string;
  }
}
