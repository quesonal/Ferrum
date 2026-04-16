//! Picasa-style Image Library Management
//!
//! Integrates index_vault for high-performance thumbnail storage and indexing

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::Manager;

use index_vault::Db;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::error::AppError;

/// Library state managed by Tauri
#[derive(Clone)]
pub struct LibraryState {
    inner: Arc<LibraryStateInner>,
}

struct LibraryStateInner {
    db: Mutex<Option<Db>>,
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
                db: Mutex::new(None),
                db_path,
                is_scanning: Mutex::new(false),
            }),
        }
    }

    fn ensure_open(&self) -> Result<(), AppError> {
        if *self.inner.is_scanning.lock().map_err(|_| AppError::LockPoisoned)? {
            return Err(AppError::LibraryBusy);
        }

        let mut db_guard = self.inner.db.lock().map_err(|_| AppError::LockPoisoned)?;

        if db_guard.is_none() {
            let db = Db::open(&self.inner.db_path)
                .map_err(|e| AppError::LibraryError(e.to_string()))?;
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
    state.with_db(|db| {
        let summaries = db.list_folders();
        let tree = Db::build_directory_tree(summaries);
        Ok(tree)
    })
}

/// Scan folder for images - run full pipeline
#[tauri::command]
pub async fn library_scan_folder(
    state: State<'_, LibraryState>,
    request: ScanRequest,
) -> Result<u32, AppError> {
    use index_vault::pipeline::run_full_pipeline_with_mft;
    use std::path::Path;

    let folder_path = PathBuf::from(&request.folder_path);

    if !folder_path.exists() {
        return Err(AppError::PathNotFound(request.folder_path));
    }

    // Clone state for use in blocking task
    let state_clone = state.inner.clone();
    let folder_path_clone = folder_path.clone();
    let db_path_clone = state.inner.db_path.clone();
    let scan_mode = request.scan_mode.to_lowercase();

    // Map scan_mode to use_mft flag
    // - everything: use_mft=false (everything is handled by index_vault internally)
    // - mft: use_mft=true
    // - walkdir/auto: use_mft=false
    let use_mft = scan_mode == "mft";

    // Run full pipeline in blocking task using std::thread
    // Take DB out of mutex to avoid holding the lock during the long scan,
    // preventing other library commands from blocking.
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<u32, AppError> {
        use index_vault::Db;

        // Open DB if needed, then take ownership to release the mutex
        let mut db = {
            let mut db_guard = state_clone.db.lock().map_err(|_| AppError::LockPoisoned)?;
            if db_guard.is_none() {
                let db = Db::open(&db_path_clone)
                    .map_err(|e| AppError::LibraryError(e.to_string()))?;
                *db_guard = Some(db);
            }
            db_guard.take().ok_or(AppError::LibraryNotInitialized)?
        };

        // Mark as scanning so other commands fail fast instead of blocking
        {
            let mut guard = state_clone.is_scanning.lock().map_err(|_| AppError::LockPoisoned)?;
            *guard = true;
        }

        // Supported image extensions for scanning
        let extensions: &[&str] = &[
            "jpg", "jpeg", "png", "webp", "tiff", "tif", "bmp", "gif",
            "tga", "dds", "jxl", "exr", // Formats requiring transcoding
            "rw2", "arw", "nef", "cr2", "cr3", "dng", "orf", "raf" // RAW formats
        ];

        let stats = run_full_pipeline_with_mft(
            Path::new(&folder_path_clone),
            &mut db,
            extensions,
            1000,
            use_mft
        );

        // Clear scanning flag and put DB back
        {
            let mut guard = state_clone.is_scanning.lock().map_err(|_| AppError::LockPoisoned)?;
            *guard = false;
        }
        {
            let mut db_guard = state_clone.db.lock().map_err(|_| AppError::LockPoisoned)?;
            *db_guard = Some(db);
        }

        match stats {
            Some(s) => Ok(s.processed as u32),
            None => Ok(0u32),
        }
    })
    .await
    .map_err(|e| AppError::Tauri(format!("Task join error: {}", e)))??;

    Ok(result)
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

        // Use the new list_images API for better performance and filtering
        let image_refs = db.list_images(folder_hash_num, offset, limit);

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
        // Get all folders
        let folders = db.list_folders();
        let mut all_images: Vec<FlatImageEntry> = Vec::new();
        let mut current_offset = 0usize;
        let mut remaining_limit = limit;

        for folder_summary in folders {
            if remaining_limit == 0 {
                break;
            }

            let folder_hash = folder_summary.folder_hash;
            let folder_path = folder_summary.folder_path.clone();
            let folder_name = folder_path
                .split(&['/', '\\'])
                .last()
                .unwrap_or("Unknown")
                .to_string();

            // Get images from this folder
            let folder_images = db.list_images(folder_hash, 0, folder_summary.image_count as usize);

            for img in folder_images {
                // Skip images until we reach the offset
                if current_offset < offset {
                    current_offset += 1;
                    continue;
                }

                if remaining_limit == 0 {
                    break;
                }

                all_images.push(FlatImageEntry {
                    id: img.image_id.to_string(),
                    filename: img.file_name,
                    folder_path: folder_path.clone(),
                    folder_name: folder_name.clone(),
                    folder_hash: folder_hash.to_string(),
                    width: img.width,
                    height: img.height,
                    timestamp: img.timestamp,
                    has_large: img.has_large,
                });

                remaining_limit -= 1;
                current_offset += 1;
            }
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
            .map_err(|_| AppError::InvalidParameter("image_id".to_string()))?;

        let data = db
            .read_thumb_small(id)
            .map_err(|e| AppError::LibraryError(e.to_string()))?;

        Ok(data)
    })
}

/// Read large preview
#[tauri::command]
pub async fn library_read_preview(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<Option<Vec<u8>>, AppError> {
    state.with_db(|db| {
        let id = image_id
            .parse::<u128>()
            .map_err(|_| AppError::InvalidParameter("image_id".to_string()))?;

        let data = db
            .read_preview(id)
            .map_err(|e| AppError::LibraryError(e.to_string()))?;

        Ok(data)
    })
}

/// Get library statistics
#[tauri::command]
pub async fn library_get_stats(
    state: State<'_, LibraryState>,
) -> Result<LibraryStats, AppError> {
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
            .map_err(|_| AppError::InvalidParameter("image_id".to_string()))?;

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
            .map_err(|_| AppError::InvalidParameter("image_id".to_string()))?;

        let path = db
            .get_absolute_path(id)
            .map_err(|e| AppError::LibraryError(e.to_string()))?;

        Ok(path.map(|p| p.to_string_lossy().to_string()))
    })
}
