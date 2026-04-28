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
pub async fn show_main_window(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
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
        let make = exif.get_field(Tag::Make, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string());
        let model = exif.get_field(Tag::Model, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string());

        exif_info.camera = match (make, model) {
            (Some(m), Some(mdl)) => Some(format!("{} {}", m.trim_matches('"'), mdl.trim_matches('"'))),
            (Some(m), None) => Some(m.trim_matches('"').to_string()),
            (None, Some(mdl)) => Some(mdl.trim_matches('"').to_string()),
            _ => None,
        };

        // Lens
        exif_info.lens = exif.get_field(Tag::LensModel, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string().trim_matches('"').to_string());

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
            .map(|f| f.display_value().to_string().trim_matches('"').to_string());
    }

    Ok(exif_info)
}
