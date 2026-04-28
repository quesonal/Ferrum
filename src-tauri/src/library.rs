//! Picasa-style Image Library Management
//!
//! Integrates index_vault for high-performance thumbnail storage and indexing

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use tauri::{AppHandle, Emitter, Manager, State};

use index_vault::pipeline::ScanEvent;
use index_vault::storage::index::SortKey;
use index_vault::Db;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Library state managed by Tauri
#[derive(Clone)]
pub struct LibraryState {
    inner: Arc<LibraryStateInner>,
}

struct LibraryStateInner {
    db: Arc<Mutex<Option<Db>>>,
    db_path: PathBuf,
    is_scanning: Mutex<bool>,
}

impl LibraryState {
    pub fn new(app_handle: &AppHandle) -> Self {
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let db_path = app_data_dir.join("thumbs_db");

        Self {
            inner: Arc::new(LibraryStateInner {
                db: Arc::new(Mutex::new(None)),
                db_path,
                is_scanning: Mutex::new(false),
            }),
        }
    }

    fn ensure_open(&self) -> Result<(), AppError> {
        let mut db_guard = self.inner.db.lock().map_err(|_| AppError::LockPoisoned)?;

        if db_guard.is_none() {
            let db =
                Db::open(&self.inner.db_path).map_err(|e| AppError::LibraryError(e.to_string()))?;
            *db_guard = Some(db);
        }
        Ok(())
    }

    pub fn with_db<F, R>(&self, f: F) -> Result<R, AppError>
    where
        F: FnOnce(&mut Db) -> Result<R, AppError>,
    {
        self.ensure_open()?;
        let mut db_guard = self.inner.db.lock().map_err(|_| AppError::LockPoisoned)?;
        let db = db_guard.as_mut().ok_or(AppError::LibraryNotInitialized)?;
        f(db)
    }

    pub fn db_path(&self) -> &Path {
        &self.inner.db_path
    }
}

/// Folder information for UI
#[derive(Debug, Clone, Serialize)]
pub struct FolderInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub image_count: u32,
    pub cover_image_id: Option<String>,
}

/// Image entry for grid view
#[derive(Debug, Clone, Serialize)]
pub struct ImageEntry {
    pub id: String,
    pub filename: String,
    pub folder_path: String,
    pub width: u16,
    pub height: u16,
    pub timestamp: u64,
    pub has_large: bool,
}

/// Thumbnail data response
#[derive(Debug, Clone, Serialize)]
pub struct ThumbnailData {
    pub id: String,
    pub data: Vec<u8>,
    pub width: u16,
    pub height: u16,
}

/// Scan request
#[derive(Debug, Deserialize)]
pub struct ScanRequest {
    pub folder_path: String,
    pub recursive: bool,
    pub scan_mode: String,
}

/// Get folders list (flat structure)
#[tauri::command]
pub async fn library_get_folders(
    state: State<'_, LibraryState>,
) -> Result<Vec<FolderInfo>, AppError> {
    state.with_db(|db| {
        // Use the new list_folders API for better performance
        let folder_summaries = db.list_folders();
        let mut folders = Vec::with_capacity(folder_summaries.len());

        for summary in folder_summaries {
            // Get folder name from path
            let folder_name = summary
                .folder_path
                .split(&['/', '\\'])
                .last()
                .unwrap_or("Unknown")
                .to_string();

            // Get cover image (first image in folder)
            let cover_image_id = if let Ok(Some(folder_data)) = db.get_folder_data(summary.folder_hash) {
                folder_data.images.first().map(|img| img.image_id.to_string())
            } else {
                None
            };

            folders.push(FolderInfo {
                id: summary.folder_hash.to_string(),
                name: folder_name,
                path: summary.folder_path,
                image_count: summary.image_count as u32,
                cover_image_id,
            });
        }

        Ok(folders)
    })
}

/// Get folder tree (hierarchical structure)
#[tauri::command]
pub async fn library_get_folder_tree(
    state: State<'_, LibraryState>,
) -> Result<Vec<index_vault::storage::folder_node::FolderNode>, AppError> {
    state.with_db(|db| Ok(db.get_folder_tree()))
}

/// Scan folder for images
/// TODO move to index_vault
#[tauri::command]
pub async fn library_scan_folder(
    app: AppHandle,
    state: State<'_, LibraryState>,
    request: ScanRequest,
) -> Result<u32, AppError> {
    let extensions: &[&str] = &[
        "jpg", "jpeg", "png", "webp", "tiff", "tif", "bmp", "gif", "tga", "dds", "jxl", "exr",
        "rw2", "arw", "nef", "cr2", "cr3", "dng", "orf", "raf",
    ];

    let state_inner = state.inner.clone();
    let db = state_inner.db.clone();
    let folder_path = PathBuf::from(&request.folder_path);
    let use_mft = request.scan_mode.to_lowercase() == "mft";

    // 创建跨线程通道
    let (tx, mut rx) = mpsc::channel::<ScanEvent>(50);

    // 启动扫描流水线
    tauri::async_runtime::spawn_blocking(move || {
        index_vault::pipeline::run_incremental_pipeline(db, &folder_path, extensions, use_mft, tx);
    });

    // 在异步上下文中处理接收到的事件
    let mut total_processed = 0;
    while let Some(event) = rx.recv().await {
        match event {
            ScanEvent::Progress { current, total } => {
                let _ = app.emit("library-scan-progress", (current, total));
            }
            ScanEvent::IncrementalUpdated => {
                let _ = app.emit("library-db-incremental-update", ());
            }
            ScanEvent::Completed(count) => {
                total_processed = count;
                let _ = app.emit("library-db-updated", ());
            }
            ScanEvent::Failed(err) => {
                return Err(AppError::LibraryError(err));
            }
        }
    }

    Ok(total_processed)
}

#[tauri::command]
pub async fn library_remove_source(
    state: State<'_, LibraryState>,
    path: String,
) -> Result<u32, AppError> {
    state.with_db(|db| {
        let count = db
            .mark_source_deleted(&path)
            .map_err(|e| AppError::LibraryError(e.to_string()))?;
        Ok(count as u32)
    })
}

/// Get images in a folder
#[tauri::command]
pub async fn library_get_images(
    state: State<'_, LibraryState>,
    folder_hash: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<ImageEntry>, AppError> {
    state.with_db(|db| {
        let folder_hash_num = folder_hash
            .parse::<u128>()
            .map_err(|_| AppError::InvalidParameter("folder_hash".to_string()))?;

        // Get folder path first
        let folder_path = db
            .get_folder_data(folder_hash_num)
            .map_err(|e| AppError::LibraryError(e.to_string()))?
            .map(|f| f.folder_path)
            .unwrap_or_default();

        // Use the new list_images API with sort key for better performance and filtering
        let image_refs = db.list_images(folder_hash_num, offset, limit, &SortKey::TimeDesc);

        let entries: Vec<ImageEntry> = image_refs
            .into_iter()
            .map(|img| ImageEntry {
                id: img.image_id.to_string(),
                filename: img.file_name,
                folder_path: folder_path.clone(),
                width: img.width,
                height: img.height,
                timestamp: img.timestamp,
                has_large: img.has_large,
            })
            .collect();

        Ok(entries)
    })
}

/// Image entry with folder info for flat view
#[derive(Debug, Clone, Serialize)]
pub struct FlatImageEntry {
    pub id: String,
    pub filename: String,
    pub folder_path: String,
    pub folder_name: String,
    pub folder_hash: String,
    pub width: u16,
    pub height: u16,
    pub timestamp: u64,
    pub has_large: bool,
}

/// Get all images from all folders (for Picasa-style flat view)
#[tauri::command]
pub async fn library_get_all_images(
    state: State<'_, LibraryState>,
    offset: usize,
    limit: usize,
) -> Result<Vec<FlatImageEntry>, AppError> {
    state.with_db(|db| {
        // Use the efficient list_all_images API that handles pagination in a single pass
        let images = db.list_all_images(offset, limit, true); // sort_desc = true (newest first)

        // Get folder info for each image (folder_cache is already populated by list_all_images)
        let mut all_images: Vec<FlatImageEntry> = Vec::with_capacity(images.len());

        for img in images {
            // Get folder path and name from folder hash
            let folder_path = db
                .get_folder_data(img.folder_hash)
                .map_err(|e| AppError::LibraryError(e.to_string()))?
                .map(|f| f.folder_path)
                .unwrap_or_default();
            let folder_name = folder_path
                .split(&['/', '\\'])
                .last()
                .unwrap_or("Unknown")
                .to_string();

            all_images.push(FlatImageEntry {
                id: img.image_id.to_string(),
                filename: img.file_name,
                folder_path,
                folder_name,
                folder_hash: img.folder_hash.to_string(),
                width: img.width,
                height: img.height,
                timestamp: img.timestamp,
                has_large: img.has_large,
            });
        }

        Ok(all_images)
    })
}

/// Get total image count across all folders
#[tauri::command]
pub async fn library_get_total_image_count(
    state: State<'_, LibraryState>,
) -> Result<usize, AppError> {
    state.with_db(|db| {
        let stats = db.stats();
        Ok(stats.valid_images as usize)
    })
}

/// Read small thumbnail
#[tauri::command]
pub async fn library_read_thumbnail(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<Option<Vec<u8>>, AppError> {
    state.with_db(|db| {
        let id = image_id
            .parse::<u128>()
            .map_err(|_| AppError::InvalidParameter(String::from("image_id")))?;

        let data = db
            .read_thumb_small(id)
            .map_err(|e| AppError::LibraryError(e.to_string()))?;

        Ok(data)
    })
}

#[tauri::command]
pub async fn library_read_thumbnails_batch(
    state: State<'_, LibraryState>,
    image_ids: Vec<String>,
) -> Result<HashMap<String, Vec<u8>>, AppError> {
    state.with_db(|db| {
        let mut results = HashMap::with_capacity(image_ids.len());

        for image_id in image_ids {
            if let Ok(id) = image_id.parse::<u128>() {
                // 尝试从数据库读取缩略图
                if let Ok(Some(data)) = db.read_thumb_small(id) {
                    results.insert(image_id, data);
                }
            }
        }

        Ok(results)
    })
}

/// Preview data with original image dimensions
#[derive(Debug, Clone, Serialize)]
pub struct PreviewData {
    pub data: Vec<u8>,
    pub orig_width: u32,
    pub orig_height: u32,
}

/// Read large preview
#[tauri::command]
pub async fn library_read_preview(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<Option<PreviewData>, AppError> {
    state.with_db(|db| {
        let id = image_id
            .parse::<u128>()
            .map_err(|_| AppError::InvalidParameter(String::from("image_id")))?;

        let result = db
            .read_preview_with_dims(id)
            .map_err(|e| AppError::LibraryError(e.to_string()))?;

        Ok(result.map(|(data, orig_width, orig_height)| PreviewData {
            data,
            orig_width,
            orig_height,
        }))
    })
}

/// Get library statistics
#[tauri::command]
pub async fn library_get_stats(state: State<'_, LibraryState>) -> Result<LibraryStats, AppError> {
    state.with_db(|db| {
        let stats = db.stats();
        Ok(LibraryStats {
            total_images: stats.total_images as u32,
            valid_images: stats.valid_images as u32,
            deleted_images: stats.deleted_images as u32,
            folder_count: stats.folder_count as u32,
        })
    })
}

/// Library statistics
#[derive(Debug, Clone, Serialize)]
pub struct LibraryStats {
    pub total_images: u32,
    pub valid_images: u32,
    pub deleted_images: u32,
    pub folder_count: u32,
}

/// Compact library (remove deleted entries)
#[tauri::command]
pub async fn library_compact(state: State<'_, LibraryState>) -> Result<String, AppError> {
    state.with_db(|db| {
        // Check if compaction is needed
        if let Some((ratio, reclaim_bytes)) = db.check_compaction_needed() {
            let result = db
                .compact_with_space_check()
                .map_err(|e| AppError::LibraryError(e.to_string()))?;

            Ok(format!(
                "Compacted: removed {} entries, reclaimed {} bytes",
                result.deleted_entries, result.reclaimed_bytes
            ))
        } else {
            Ok("No compaction needed".to_string())
        }
    })
}

/// Mark image as deleted
#[tauri::command]
pub async fn library_mark_deleted(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<bool, AppError> {
    state.with_db(|db| {
        let id = image_id
            .parse::<u128>()
            .map_err(|_| AppError::InvalidParameter(String::from("image_id")))?;

        db.mark_deleted(id)
            .map_err(|e| AppError::LibraryError(e.to_string()))
    })
}

/// Get absolute path of an image
#[tauri::command]
pub async fn library_get_image_path(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<Option<String>, AppError> {
    state.with_db(|db| {
        let id = image_id
            .parse::<u128>()
            .map_err(|_| AppError::InvalidParameter(String::from("image_id")))?;

        let path = db
            .get_absolute_path(id)
            .map_err(|e| AppError::LibraryError(e.to_string()))?;

        Ok(path.map(|p| p.to_string_lossy().to_string()))
    })
}
