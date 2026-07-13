use crate::config::{self, AppConfig};
use crate::error::{AppError, AppResult};
use crate::formats::{self, ImageSupport};
use crate::state::PendingFile;
use std::path::Path;
use tauri::{AppHandle, Runtime, State, WebviewWindow};
use tauri_plugin_fs::FsExt;

#[tauri::command]
pub fn load_config_cmd<R: Runtime>(app: AppHandle<R>) -> AppResult<AppConfig> {
    Ok(config::load_config(&app))
}

#[tauri::command]
pub fn save_config_cmd<R: Runtime>(app: AppHandle<R>, config: AppConfig) -> AppResult<()> {
    config::save_config(&app, &config)
}

#[tauri::command]
pub fn get_supported_formats() -> ImageSupport {
    formats::get_support_list()
}

#[tauri::command]
pub fn get_pending_file(state: State<'_, PendingFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// 从指定目录扫描图片文件
fn scan_images_in_dir(dir: &Path) -> AppResult<Vec<String>> {
    let entries = std::fs::read_dir(dir)?;
    let mut images = Vec::new();
    let mut errors = Vec::new();

    for entry in entries {
        match entry {
            Ok(entry) => {
                let p = entry.path();
                if p.is_file() {
                    if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                        if formats::is_supported(ext) {
                            images.push(p.to_string_lossy().to_string());
                        }
                    }
                }
            }
            Err(e) => {
                errors.push(e);
            }
        }
    }

    if !errors.is_empty() {
        eprintln!("[Warning] scan_images_in_dir: {} entries skipped due to errors", errors.len());
    }

    images.sort_by(|a, b| alphanumeric_sort::compare_path(a, b));
    Ok(images)
}

/// 允许应用访问指定目录
fn allow_directory_access(app: &AppHandle, dir: &Path) -> AppResult<()> {
    app.fs_scope()
        .allow_directory(dir, true)
        .map_err(|e| AppError::Tauri(e.to_string()))
}

/// 获取路径对应的目录：如果是文件则返回父目录，如果是目录则直接返回
fn resolve_directory(path: &Path) -> AppResult<&Path> {
    if path.is_dir() {
        Ok(path)
    } else {
        path.parent()
            .ok_or_else(|| AppError::Path("Cannot find parent directory".into()))
    }
}

#[tauri::command]
pub async fn get_image_list(app: AppHandle, path: String) -> AppResult<Vec<String>> {
    let path = Path::new(&path);
    let dir = resolve_directory(path)?;

    allow_directory_access(&app, dir)?;
    scan_images_in_dir(dir)
}



#[tauri::command]
#[tracing::instrument(level = "info", name = "cmd::show_main_window", skip(window))]
pub async fn show_main_window(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    tracing::info!(target: "startup", "main window shown and focused");
}

#[tauri::command]
pub async fn toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;

    if is_fullscreen {
        window.set_fullscreen(false).map_err(|e| e.to_string())?;
    } else {
        // 最大化状态下先退出最大化，防止 WebView2 布局不跟随窗口扩展
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|e| e.to_string())?;
        }
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
    }

    Ok(!is_fullscreen)
}

#[tauri::command]
pub fn is_win11() -> bool {
    let info = os_info::get();

    if info.os_type() != os_info::Type::Windows {
        return false;
    }

    match info.version() {
        os_info::Version::Semantic(major, _minor, build) => {
            if *major == 10 && *build >= 22000 {
                return true;
            }
            if *major > 10 {
                return true;
            }
        }
        _ => {}
    }

    false
}

#[derive(serde::Serialize)]
pub struct FileInfo {
    size: u64,
    modified: Option<u64>,
}

#[tauri::command]
pub fn get_file_info(path: String) -> AppResult<FileInfo> {
    let metadata = std::fs::metadata(&path)?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    Ok(FileInfo {
        size: metadata.len(),
        modified,
    })
}

#[derive(serde::Serialize, Default)]
pub struct ExifInfo {
    camera: Option<String>,
    lens: Option<String>,
    iso: Option<String>,
    aperture: Option<String>,
    shutter: Option<String>,
    focal_length: Option<String>,
    equivalent_focal_length: Option<String>,
    date_taken: Option<String>,
}

#[tauri::command]
pub fn get_exif_data(path: String) -> AppResult<ExifInfo> {
    use exif::{Reader, Tag};
    use std::fs::File;
    use std::io::BufReader;

    let file = File::open(&path)?;
    let mut reader = BufReader::new(file);

    let mut exif_info = ExifInfo::default();

    if let Ok(exif) = Reader::new().read_from_container(&mut reader) {
        // Camera make and model
        let clean_string = |s: String| {
            let c = s.trim_matches('"').trim().to_string();
            if c.is_empty() { None } else { Some(c) }
        };
        let make = exif.get_field(Tag::Make, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string())
            .and_then(clean_string);
        let model = exif.get_field(Tag::Model, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string())
            .and_then(clean_string);

        exif_info.camera = match (make, model) {
            (Some(m), Some(mdl)) => Some(format!("{} {}", m, mdl)),
            (Some(m), None) => Some(m),
            (None, Some(mdl)) => Some(mdl),
            _ => None,
        };

        // Lens — 从原始字节提取字符串，截断到第一个空字节
        exif_info.lens = exif.get_field(Tag::LensModel, exif::In::PRIMARY)
            .and_then(|f| match &f.value {
                exif::Value::Ascii(v) => v.first().and_then(|bytes| {
                    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
                    let s = String::from_utf8_lossy(&bytes[..end]).into_owned();
                    let cleaned = s.trim_matches('"').trim();
                    if cleaned.is_empty() { None } else { Some(cleaned.to_string()) }
                }),
                _ => {
                    let s = f.display_value().to_string();
                    let cleaned = s.trim_matches('"').trim().to_string();
                    if cleaned.is_empty() { None } else { Some(cleaned) }
                }
            });

        // ISO
        exif_info.iso = exif.get_field(Tag::PhotographicSensitivity, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string());

        // Aperture (FNumber)
        exif_info.aperture = exif.get_field(Tag::FNumber, exif::In::PRIMARY)
            .map(|f| format!("f/{}", f.display_value()));

        // Focal length
        exif_info.focal_length = exif.get_field(Tag::FocalLength, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string());

        // 35mm equivalent focal length
        exif_info.equivalent_focal_length = exif.get_field(Tag::FocalLengthIn35mmFilm, exif::In::PRIMARY)
            .map(|f| format!("{}mm (eq.)", f.display_value().to_string().trim_matches('"')));

        // Shutter speed (ExposureTime)
        exif_info.shutter = exif.get_field(Tag::ExposureTime, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string());

        // Date taken
        exif_info.date_taken = exif.get_field(Tag::DateTimeOriginal, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string())
            .map(|s| s.trim_matches('"').trim().to_string());
    }
    Ok(exif_info)
}

/// 检查路径是否可以通过 asset 协议访问（尝试 canonicalize）
/// 用于在请求前预判 ImDisk 等虚拟盘是否会触发 403
#[tauri::command]
pub fn check_asset_accessible(path: String) -> bool {
    match std::fs::canonicalize(&path) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[check_asset_accessible] canonicalize failed for '{}': {}", path, e);
            false
        }
    }
}

/// 删除文件：permanent=false 走系统回收站（可恢复），permanent=true 永久删除。
/// 错误通过 AppError 自动序列化返回前端，由前端决定是否提示用户。
#[tauri::command]
pub async fn delete_file(path: String, permanent: bool) -> AppResult<()> {
    if permanent {
        tokio::fs::remove_file(&path).await?;
    } else {
        // trash::Error 不实现 Into<AppError>，手动转 Anyhow 走通用错误通道
        trash::delete(&path).map_err(|e| AppError::Anyhow(anyhow::Error::new(e)))?;
    }
    Ok(())
}

/// Frontend 写入 Chrome trace 事件的通道。接收一个 JSON 数组（每条事件
/// 都是 Perfetto/Chrome trace 格式的对象），写到 `path`。
/// 仅在 `flamegraph` feature 启用时由前端调用（路径由 `__FRONTEND_TRACE_PATH__`
/// 注入），release 构建里前端不会发请求，本函数也不会被注册。
#[cfg(feature = "flamegraph")]
#[tauri::command]
#[tracing::instrument(level = "info", name = "frontend::write_perf", skip_all, fields(event_count = tracing::field::Empty, path = %path))]
pub fn write_frontend_perf(events: serde_json::Value, path: String) -> Result<(), String> {
    let event_count = events.as_array().map(|a| a.len()).unwrap_or(0);
    tracing::Span::current().record("event_count", event_count);
    use std::path::PathBuf;

    let path = PathBuf::from(&path);

    // Safety: only allow writing to a path the Rust side explicitly
    // declared via profile::init. Frontend is untrusted, but we still
    // refuse to write outside the explicit allowlist.
    let allowed = crate::profile::frontend_trace_path();
    match allowed {
        Some(ref p) if p == &path => {}
        _ => {
            return Err(format!(
                "write_frontend_perf: path '{}' is not the configured frontend trace path",
                path.display()
            ));
        }
    }

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let serialized = serde_json::to_string(&events).map_err(|e| e.to_string())?;
    std::fs::write(&path, serialized).map_err(|e| e.to_string())
}
