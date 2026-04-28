mod cache;
mod commands;
mod config;
mod error;
mod formats;
mod library;
mod protocol;
mod state;

use std::env;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

use commands::*;
use library::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let _ = app.emit("open-file", args);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            WindowStateBuilder::default()
                .with_state_flags(
                    StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS,
                )
                .build(),
        )
        .manage(state::PendingFile(Mutex::new(None)))
        .setup(|app| {
            let win = app.get_webview_window("main").expect("Main window missing");

            let args: Vec<String> = env::args().collect();
            let initial_path = args.get(1).cloned().unwrap_or_default();

            let config = config::load_config(app.handle());

            let config_json = serde_json::to_string(&config).unwrap_or_else(|_| "{}".into());
            let path_json = serde_json::to_string(&initial_path).unwrap_or_else(|_| "\"\"".into());

            let script = format!(
                "window.__INITIAL_FILE__ = {}; window.__APP_CONFIG__ = {};",
                path_json, config_json
            );

            win.eval(&script)?;

            // Initialize library state
            app.manage(library::LibraryState::new(app.handle()));

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
            library_get_stats,
            library_compact,
            library_mark_deleted,
            library_get_image_path,
            library_remove_source,
        ])
        .register_uri_scheme_protocol("img", |ctx, req| protocol::img_protocol_handler(&ctx, &req))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
