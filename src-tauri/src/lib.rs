mod cache;
mod commands;
mod config;
// Same rationale as `pub mod meta_cache` below — integration tests
// pattern-match `AppError::Sqlx` etc.
pub mod error;
mod formats;
mod library;
#[cfg(feature = "flamegraph")]
pub mod profile;
// Exposed `pub` so `tests/meta_cache.rs` (an external compilation
// unit) can reach `MetaCache::open_at` and a small handful of
// helper types (`MetaPayload`, `extract_meta_payloads`). The public
// Tauri surface (`#[tauri::command]` functions in `library.rs`) is
// unchanged; this just widens `pub` vs `pub(crate)` for one module.
pub mod meta_cache;
mod migration;
mod protocol;
mod state;

pub(crate) mod entity;

use std::env;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

use commands::*;
use library::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[tracing::instrument(name = "ferrum::run", skip_all, fields(args = ?env::args().collect::<Vec<_>>()))]
pub fn run() {
    tracing::info!(target: "startup", "ferrum_lib::run entered");

    // Build the Tauri app one plugin at a time, with each plugin
    // initialization wrapped in its own span so the flame graph shows
    // exactly how long each plugin took to register.
    let builder = tauri::Builder::default();

    let builder = {
        let _span = tracing::info_span!("plugin::log").entered();
        // When profiling is on, we already installed a tracing
        // subscriber as the global default. Ask tauri-plugin-log to
        // skip its own global logger install so we don't conflict.
        // The `tracing` feature on the plugin (enabled by the
        // `flamegraph` feature in Cargo.toml) makes it emit via
        // `tracing::event!`, so the chrome layer sees those events.
        let mut log_builder = tauri_plugin_log::Builder::new().targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::Webview),
        ]);
        #[cfg(feature = "flamegraph")]
        {
            log_builder = log_builder.skip_logger();
        }
        builder.plugin(log_builder.build())
    };

    let builder = {
        let _span = tracing::info_span!("plugin::fs").entered();
        builder.plugin(tauri_plugin_fs::init())
    };

    let builder = {
        let _span = tracing::info_span!("plugin::dialog").entered();
        builder.plugin(tauri_plugin_dialog::init())
    };

    let builder = {
        let _span = tracing::info_span!("plugin::single_instance").entered();
        builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let _ = app.emit("open-file", args);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
    };

    let builder = {
        let _span = tracing::info_span!("plugin::window_state").entered();
        builder.plugin(
            WindowStateBuilder::default()
                .with_state_flags(
                    StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS,
                )
                .build(),
        )
    };

    let builder = builder
        .manage(state::PendingFile(Mutex::new(None)))
        .setup(|app| {
            let _setup_span = tracing::info_span!("tauri::setup").entered();

            let win = app
                .get_webview_window("main")
                .expect("Main window missing");

            let initial_path = {
                let _s = tracing::info_span!("parse_args").entered();
                // Mirror the flag consumption in `main.rs` so Tauri doesn't
                // mistake the profile output path (or the flag itself) for a
                // file the user wanted to open.
                let mut args: Vec<String> = env::args().collect();
                #[cfg(feature = "flamegraph")]
                {
                    let _ = profile::extract_output_arg(&mut args);
                }
                let raw = args.into_iter().nth(1).unwrap_or_default();
                // Resolve to absolute path so the frontend / img:// protocol
                // sees a stable path regardless of cwd at launch time.
                if raw.is_empty() {
                    raw
                } else {
                    let p = std::path::PathBuf::from(&raw);
                    let cleaned: std::path::PathBuf = p
                        .to_str()
                        .and_then(|s| {
                            s.strip_prefix("./")
                                .or_else(|| s.strip_prefix(".\\"))
                        })
                        .map(std::path::PathBuf::from)
                        .unwrap_or(p.clone());
                    if cleaned.is_absolute() {
                        cleaned.to_string_lossy().to_string()
                    } else {
                        std::fs::canonicalize(&cleaned)
                            .map(|c| c.to_string_lossy().to_string())
                            .unwrap_or_else(|_| raw)
                    }
                }
            };

            let config = {
                let _s = tracing::info_span!("load_config").entered();
                config::load_config(app.handle())
            };
            tracing::info!(target: "startup", "config loaded");

            let (config_json, path_json, frontend_trace_json) = {
                let _s = tracing::info_span!("serialize_init_payload").entered();
                #[cfg(feature = "flamegraph")]
                let frontend_trace_path = profile::frontend_trace_path()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                #[cfg(not(feature = "flamegraph"))]
                let frontend_trace_path = String::new();
                (
                    serde_json::to_string(&config).unwrap_or_else(|_| "{}".into()),
                    serde_json::to_string(&initial_path).unwrap_or_else(|_| "\"\"".into()),
                    serde_json::to_string(&frontend_trace_path)
                        .unwrap_or_else(|_| "\"\"".into()),
                )
            };

            let script = format!(
                "window.__INITIAL_FILE__ = {}; window.__APP_CONFIG__ = {}; window.__FRONTEND_TRACE_PATH__ = {};",
                path_json, config_json, frontend_trace_json
            );

            {
                let _s = tracing::info_span!("eval_init_script").entered();
                win.eval(&script)?;
            }
            tracing::info!(target: "startup", "frontend init script evaluated");

            // Initialize library state
            {
                let _s = tracing::info_span!("library_state::new").entered();
                app.manage(library::LibraryState::new(app.handle()));
            }
            tracing::info!(target: "startup", "library state initialized");

            // Initialize meta cache (Plan A). Failure is logged but
            // does NOT block startup — index_vault remains usable and
            // the frontend falls back to filesystem IPC for histogram
            // / EXIF. We hand the Arc off to LibraryState (rather than
            // managing it as a separate Tauri State) so the scan
            // callback can hold an Arc clone without going through
            // Tauri's State wrapper.
            //
            // Phase C4 (P1 fix): backfill is now triggered by the
            // frontend (`App.vue` awaits `setupMetaBackfillListeners`
            // then `startMetaBackfill`). The previous auto-call here
            // raced with frontend listener registration — if the loop
            // emitted `library-meta-backfill-progress` before the
            // listener was wired, the events were dropped silently.
            {
                let _s = tracing::info_span!("meta_cache::init").entered();
                let app_handle = app.handle().clone();
                let library_state = app.state::<library::LibraryState>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    match meta_cache::MetaCache::init(&app_handle).await {
                        Ok(meta) => {
                            library_state.set_meta(meta);
                            tracing::info!(target: "startup", "meta cache initialized");
                        }
                        Err(e) => {
                            tracing::warn!(
                                target: "startup",
                                "meta cache init failed: {e}; frontend will fall back to filesystem IPC"
                            );
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_main_window,
            load_config_cmd,
            save_config_cmd,
            get_image_list,
            get_pending_file,
            get_supported_formats,
            is_win11,
            get_file_info,
            get_exif_data,
            toggle_fullscreen,
            check_asset_accessible,
            delete_file,
            // Library commands
            library_get_folders,
            library_get_folder_tree,
            library_scan_folder,
            library_get_images,
            library_get_all_images,
            library_get_total_image_count,
            library_read_thumbnail,
            library_read_thumbnails_batch,
            library_read_preview,
            library_read_histogram,
            library_read_exif,
            library_get_stats,
            library_compact,
            library_mark_deleted,
            library_get_image_path,
            library_remove_source,
            // Tag CRUD (Phase A5)
            library_list_tags,
            library_create_tag,
            library_rename_tag,
            library_delete_tag,
            library_set_image_tags,
            library_get_image_tags,
            library_list_images_by_tag,
            library_get_images_by_ids,
            // Meta cache backfill (Phase C2 / C3)
            library_meta_backfill_start,
            library_meta_backfill_one,
            #[cfg(feature = "flamegraph")]
            write_frontend_perf,
        ]);

    // Register the custom img:// protocol last; this is fast (just a
    // hash-map insert) but we still mark it on the timeline.
    let _span = tracing::info_span!("register_uri_scheme_protocol::img").entered();
    let builder = builder
        .register_uri_scheme_protocol("img", |ctx, req| protocol::img_protocol_handler(&ctx, &req));
    drop(_span);

    tracing::info!(target: "startup", "all plugins registered, entering run loop");

    let _run_span = tracing::info_span!("tauri::run").entered();
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
