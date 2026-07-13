//! Picasa-style Image Library Management
//!
//! Integrates index_vault for high-performance thumbnail storage and indexing

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, OnceCell};

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use index_vault::pipeline::ScanEvent;
use index_vault::storage::index::SortKey;
use index_vault::Db;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::meta_cache::{extract_meta_payloads, ExifCacheRow, MetaCache, Tag, TagSource};

/// Library state managed by Tauri
#[derive(Clone)]
pub struct LibraryState {
    inner: Arc<LibraryStateInner>,
}

struct LibraryStateInner {
    db: Arc<Mutex<Option<Db>>>,
    db_path: PathBuf,
    is_scanning: Mutex<bool>,
    /// Lazy-initialized meta cache (Plan A). Populated by
    /// `lib.rs::setup` after `MetaCache::init` returns, or by the
    /// first `library_scan_folder` call if startup init failed.
    /// Stored as `OnceCell<Arc<…>>` so we can hand clones to the
    /// Plan B scan callback closure.
    meta: OnceCell<Arc<MetaCache>>,
    /// Phase C2: re-entry guard for the startup backfill loop.
    /// Single bit, no Mutex — `compare_exchange` is the only writer.
    backfill_running: AtomicBool,
    /// Phase C4 (P1 fix): per-image in-flight tracking for both the
    /// startup loop AND the lazy single-image path. Wrapped in `Arc`
    /// so the `BackfillInFlightGuard` RAII handle can be moved into
    /// async tasks and remove-on-drop the id from any thread without
    /// dragging `LibraryStateInner` along. Lock is short-lived —
    /// only held during insert/remove, never during the expensive
    /// `compute_and_write_one` work.
    in_flight_backfills: Arc<Mutex<HashSet<u128>>>,
}

impl LibraryState {
    #[tracing::instrument(level = "info", name = "LibraryState::new", skip(app_handle))]
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
                meta: OnceCell::new(),
                backfill_running: AtomicBool::new(false),
                in_flight_backfills: Arc::new(Mutex::new(HashSet::new())),
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

    /// Hand off a freshly-built meta cache to LibraryState. Called by
    /// `lib.rs::setup` after the async `MetaCache::init` resolves.
    /// Subsequent `ensure_meta` calls return this Arc.
    pub fn set_meta(&self, meta: Arc<MetaCache>) {
        // `OnceCell::set` returns Err if already populated — that
        // would mean setup ran twice, which we don't support today.
        let _ = self.inner.meta.set(meta);
    }

    /// Lazy-init the meta cache if not already set, then return a clone.
    ///
    /// Returns `Some(Arc)` on success, `None` if initialization fails
    /// (we deliberately *do not* propagate the error here — meta is
    /// derived data and a missing cache must not block scan).
    ///
    /// Uses `tokio::sync::OnceCell::get_or_try_init` so concurrent
    /// callers don't each kick off a redundant `MetaCache::init` —
    /// only the first caller actually opens the DB, the rest await
    /// its result. The manual `get / init / set` pattern this replaced
    /// had a TOCTOU race where N callers could each open a fresh
    /// `DatabaseConnection` against the same file (sea-orm's pool has
    /// its own internal lock, but we'd still pay N×file-open cost and
    /// N×Migrator::up runs on first init).
    pub async fn ensure_meta(&self, app: &AppHandle) -> Option<Arc<MetaCache>> {
        match self
            .inner
            .meta
            .get_or_try_init(|| MetaCache::init(app))
            .await
        {
            Ok(arc) => Some(arc.clone()),
            Err(e) => {
                tracing::warn!("meta_cache init failed: {e}; scan will proceed without meta writes");
                None
            }
        }
    }

    /// Borrow the meta cache if already initialized. Used by read-path
    /// commands (`library_read_histogram`, `library_read_exif`) that
    /// need to skip work when meta isn't ready yet.
    pub fn meta(&self) -> Option<Arc<MetaCache>> {
        self.inner.meta.get().cloned()
    }

    /// Phase C4 (P1 fix): try to claim `image_id` for backfill
    /// processing. Returns `Some(guard)` on success — caller MUST
    /// hold the guard until work is complete (Drop removes the id).
    /// Returns `None` if another path is already processing this id.
    ///
    /// Shared by `library_meta_backfill_one` (lazy single-image) and
    /// `run_meta_backfill_loop` (startup bulk path). With both paths
    /// routing through this single check, the same image_id can't be
    /// processed twice concurrently — the second arrival silently
    /// bails, mirroring the frontend's `pendingBackfill` set but as
    /// the single source of truth (the frontend dedupe window was
    /// too short: IPC promise resolves in ms but compute takes
    /// 50-100ms, so rapid prev/next could slip past it).
    fn try_acquire_in_flight(&self, image_id: u128) -> Option<BackfillInFlightGuard> {
        let inner = self.inner.clone();
        let mut set = inner.in_flight_backfills.lock().ok()?;
        if set.contains(&image_id) {
            return None;
        }
        set.insert(image_id);
        Some(BackfillInFlightGuard {
            set: inner.in_flight_backfills.clone(),
            image_id,
        })
    }
}

/// Phase C4 (P1 fix): RAII guard paired with `try_acquire_in_flight`.
/// Removes the image_id from the in-flight set on drop so the next
/// caller (e.g. another lazy miss after this compute completes)
/// can re-process without false-dedupe.
///
/// We don't use `scopeguard` (not in Cargo.toml) and `Drop` is the
/// only zero-cost way to do this in stable Rust. Panic-safe: the
/// remove runs even on unwind.
struct BackfillInFlightGuard {
    set: Arc<Mutex<HashSet<u128>>>,
    image_id: u128,
}

impl Drop for BackfillInFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.image_id);
        }
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

/// Scan folder for images. The actual scan loop lives in
/// `index_vault::pipeline::run_incremental_pipeline_with_callback`;
/// this command is the Tauri glue (event emission + scan callback
/// wiring for `meta_cache.write_batch_meta`).
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

    // Lazy-init the meta cache. `ensure_meta` swallows init errors
    // and returns `None` instead — meta is derived data and a missing
    // cache must never block scanning (R-A3.4).
    let meta_arc = state.ensure_meta(&app).await;

    // Plan B batch callback: spawned async task writes EXIF + histogram
    // into `meta_cache.sqlite` after each successful index_vault flush.
    // Failures are logged, never propagated (R-A3.4). When `meta_arc`
    // is `None` we pass `None` for the callback — scan still works.
    //
    // We extract `MetaPayload`s synchronously here so the heavy
    // `small_data` / `large_data` WebP buffers (often 5–15 MB per
    // batch) are released *before* the spawned async task runs. The
    // `Vec<MetaPayload>` we ship to the task is ~200 B per item.
    let on_batch_written: Option<index_vault::pipeline::BatchWrittenCallback> =
        meta_arc.map(|meta| {
            Arc::new(move |results: &[index_vault::pipeline::ThumbProcessResult]| {
                let payloads = extract_meta_payloads(results);
                let m = meta.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = m.write_batch_meta(&payloads).await {
                        tracing::warn!(
                            target: "meta_cache",
                            "write_batch_meta failed (scan continues): {e}"
                        );
                    }
                });
            }) as index_vault::pipeline::BatchWrittenCallback
        });

    // 创建跨线程通道
    let (tx, mut rx) = mpsc::channel::<ScanEvent>(50);

    // 启动扫描流水线
    tauri::async_runtime::spawn_blocking(move || {
        index_vault::pipeline::run_incremental_pipeline_with_callback(
            db,
            &folder_path,
            extensions,
            use_mft,
            tx,
            on_batch_written,
        );
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

/// Remove a library source (folder) and all images under it.
///
/// Phase A6: also clears meta_cache rows for the affected images in a
/// best-effort transaction. If meta is uninitialized (startup race)
/// we silently skip the cleanup — meta is derived data, and the next
/// scan will overwrite whatever stale state remains.
#[tauri::command]
pub async fn library_remove_source(
    state: State<'_, LibraryState>,
    path: String,
) -> Result<u32, AppError> {
    // Collect affected image ids BEFORE marking the source deleted —
    // `list_folders` skips deleted entries, so once we've called
    // `mark_source_deleted` we'd see a (truncated) view of the
    // library. We hold the db mutex for both ops so a concurrent
    // scan can't sneak new images in between collect and delete.
    let (count, affected_ids): (usize, Vec<u128>) = state.with_db(|db| {
        let folders = db.list_folders();
        let mut ids: Vec<u128> = Vec::new();
        for summary in &folders {
            if !summary.folder_path.starts_with(&path) {
                continue;
            }
            if let Ok(Some(folder_data)) = db.get_folder_data(summary.folder_hash) {
                ids.extend(folder_data.images.iter().map(|img| img.image_id));
            }
        }
        let count = db
            .mark_source_deleted(&path)
            .map_err(|e| AppError::LibraryError(e.to_string()))?;
        Ok((count, ids))
    })?;

    if !affected_ids.is_empty() {
        if let Some(meta) = state.meta() {
            if let Err(e) = meta.mark_images_deleted(&affected_ids).await {
                tracing::warn!(
                    target: "meta_cache",
                    "mark_images_deleted failed for source {path} ({} ids): {e}; \
                     meta rows will be re-derived on next scan",
                    affected_ids.len()
                );
            }
        }
    }

    Ok(count as u32)
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

/// Read large preview.
///
/// Binary protocol on the wire (single `tauri::ipc::Response` body):
/// ```text
/// [u32 LE orig_width] [u32 LE orig_height] [WebP bytes...]
/// ```
/// `orig_width == 0` 视为 not-found（合法 preview 不可能有零宽）。后续若 header 增字段
/// （如 `frame_id` / `timestamp`），保持同一布局切换到 `#[repr(C)] + bytemuck` 即可。
/// 详见 docs/PREVIEW_CACHE_DESIGN_2026-07-06.md「未来：Payload 优化」。
#[tauri::command]
pub async fn library_read_preview(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<Response, AppError> {
    state.with_db(|db| {
        let id = image_id
            .parse::<u128>()
            .map_err(|_| AppError::InvalidParameter(String::from("image_id")))?;

        let result = db
            .read_preview_with_dims(id)
            .map_err(|e| AppError::LibraryError(e.to_string()))?;

        let mut buf = match result {
            None => Vec::with_capacity(8),
            Some((data, orig_width, orig_height)) => {
                let mut b = Vec::with_capacity(8 + data.len());
                b.extend_from_slice(&orig_width.to_le_bytes());
                b.extend_from_slice(&orig_height.to_le_bytes());
                b.extend_from_slice(&data);
                b
            }
        };
        // not-found sentinel: width=0 时无 image bytes。
        // 上方 `None` 分支已经预留 0 长度；显式写入 0 保险起见。
        if buf.is_empty() {
            buf.extend_from_slice(&0u32.to_le_bytes());
            buf.extend_from_slice(&0u32.to_le_bytes());
        }

        Ok(Response::new(buf))
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

/// Mark a single image as deleted in both index_vault and meta_cache.
///
/// Phase A6: index_vault logical delete happens first (the source of
/// truth); meta_cache cleanup is best-effort afterward. If meta isn't
/// initialized, the index_vault delete still completes — stale meta
/// rows are harmless (the next scan overwrites them) and the frontend
/// will fall back to filesystem IPC for this image anyway.
#[tauri::command]
pub async fn library_mark_deleted(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<bool, AppError> {
    let id = image_id
        .parse::<u128>()
        .map_err(|_| AppError::InvalidParameter(String::from("image_id")))?;

    let was_present = state.with_db(|db| {
        db.mark_deleted(id)
            .map_err(|e| AppError::LibraryError(e.to_string()))
    })?;

    if let Some(meta) = state.meta() {
        if let Err(e) = meta.mark_images_deleted(&[id]).await {
            tracing::warn!(
                target: "meta_cache",
                "mark_images_deleted failed for image {id}: {e}; \
                 meta row will be re-derived on next scan"
            );
        }
    }

    Ok(was_present)
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

/// Read a cached histogram for `image_id`.
///
/// Binary protocol on the wire (single `tauri::ipc::Response` body):
/// ```text
/// [u32 LE width] [u32 LE height] [r_bins 1024B] [g_bins 1024B] [b_bins 1024B]
/// ```
/// Total 3088 B on hit. `width == 0` is the not-found sentinel — the
/// frontend's `parseHistogramBinary` reads the width first and bails
/// to `null` / filesystem fallback when it sees 0.
///
/// Layout matches `library_read_preview` (same `Response::new(buf)`
/// pattern). When meta_cache hasn't initialized yet (startup race
/// window) we still return 8 zero bytes, identical to a cache miss,
/// so the frontend can use one code path for both.
#[tauri::command]
pub async fn library_read_histogram(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<Response, AppError> {
    // Single Option-returning DB hit; no transaction (PK lookup, <1 ms).
    let result = match state.meta() {
        Some(meta) => meta.read_histogram(&image_id).await?,
        None => None,
    };

    let mut buf = match result {
        None => Vec::with_capacity(8),
        Some((width, height, r, g, b)) => {
            let mut v = Vec::with_capacity(8 + r.len() + g.len() + b.len());
            v.extend_from_slice(&width.to_le_bytes());
            v.extend_from_slice(&height.to_le_bytes());
            v.extend_from_slice(&r);
            v.extend_from_slice(&g);
            v.extend_from_slice(&b);
            v
        }
    };
    // not-found sentinel: width=0 时无 image bytes。
    // 上方 `None` 分支已经预留 0 长度；显式写入 0 保险起见。
    if buf.is_empty() {
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
    }

    Ok(Response::new(buf))
}

/// Read a cached EXIF row for `image_id`. Returns `null` on miss /
/// meta uninitialized — the frontend handles the fallback to its
/// `get_exif_data` filesystem IPC.
#[tauri::command]
pub async fn library_read_exif(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<Option<ExifCacheRow>, AppError> {
    match state.meta() {
        Some(meta) => meta.read_exif(&image_id).await,
        None => Ok(None),
    }
}

// =====================================================================
// Tag CRUD commands (Phase A5)
//
// Each command fails fast with `AppError::NotInitialized("meta_cache")`
// when the meta cache hasn't been opened yet (startup race window or
// init failure). The Slice 2 tag UI handles that by surfacing the
// error through the store's per-action try/catch and falling back to
// an empty list (no tags shown until meta is ready).
// =====================================================================

/// List tags. `source` filters by origin (`"user"` / `"ai"`); pass
/// `None` to list all tags. Ordered by `sort_order ASC, id ASC`.
#[tauri::command]
pub async fn library_list_tags(
    state: State<'_, LibraryState>,
    source: Option<String>,
) -> Result<Vec<Tag>, AppError> {
    let meta = state
        .meta()
        .ok_or(AppError::NotInitialized("meta_cache"))?;
    let parsed = match source.as_deref() {
        Some(s) => Some(TagSource::parse(s)?),
        None => None,
    };
    meta.list_tags(parsed).await
}

/// Create a new tag. `confidence`, `parent_id`, and `color` are
/// optional. Returns the auto-assigned id. Case-insensitive duplicate
/// `(name, source)` returns an error.
#[tauri::command]
pub async fn library_create_tag(
    state: State<'_, LibraryState>,
    name: String,
    source: String,
    confidence: Option<f64>,
    parent_id: Option<i32>,
    color: Option<String>,
) -> Result<i32, AppError> {
    let meta = state
        .meta()
        .ok_or(AppError::NotInitialized("meta_cache"))?;
    let src = TagSource::parse(&source)?;
    meta.create_tag(&name, src, confidence, parent_id, color).await
}

/// Rename a tag. The `meta_cache` layer does not re-check
/// case-insensitive uniqueness on rename — Slice 2's UI should fetch
/// `list_tags` first and resolve collisions before calling.
#[tauri::command]
pub async fn library_rename_tag(
    state: State<'_, LibraryState>,
    id: i32,
    name: String,
) -> Result<(), AppError> {
    let meta = state
        .meta()
        .ok_or(AppError::NotInitialized("meta_cache"))?;
    meta.rename_tag(id, &name).await
}

/// Delete a tag. `image_tags` links are removed by FK CASCADE.
#[tauri::command]
pub async fn library_delete_tag(
    state: State<'_, LibraryState>,
    id: i32,
) -> Result<(), AppError> {
    let meta = state
        .meta()
        .ok_or(AppError::NotInitialized("meta_cache"))?;
    meta.delete_tag(id).await
}

/// Replace an image's tag set in one transaction. Pass an empty
/// array to clear all tags from the image.
#[tauri::command]
pub async fn library_set_image_tags(
    state: State<'_, LibraryState>,
    image_id: String,
    tag_ids: Vec<i32>,
) -> Result<(), AppError> {
    let meta = state
        .meta()
        .ok_or(AppError::NotInitialized("meta_cache"))?;
    meta.set_image_tags(&image_id, &tag_ids).await
}

/// Fetch tags attached to an image, ordered by `sort_order ASC, id ASC`.
/// Returns an empty array when the image has no tags (or doesn't exist).
#[tauri::command]
pub async fn library_get_image_tags(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<Vec<Tag>, AppError> {
    let meta = state
        .meta()
        .ok_or(AppError::NotInitialized("meta_cache"))?;
    meta.get_image_tags(&image_id).await
}

/// Paginated list of image ids that carry a given tag, newest first.
/// Used by Slice 2's "browse by tag" view.
#[tauri::command]
pub async fn library_list_images_by_tag(
    state: State<'_, LibraryState>,
    tag_id: i32,
    offset: u64,
    limit: u64,
) -> Result<Vec<String>, AppError> {
    let meta = state
        .meta()
        .ok_or(AppError::NotInitialized("meta_cache"))?;
    meta.list_images_by_tag(tag_id, offset, limit).await
}

/// Resolve a set of image_ids into full `ImageEntry` rows.
///
/// Used by Slice 2's "browse by tag" view: `library_list_images_by_tag`
/// returns a list of ids; the frontend then calls this to materialize
/// thumbnail/filename/folder data for rendering.
///
/// Implementation notes:
/// - Phase B3 deliberately avoids a new index_vault native API. We
///   pull the full valid-image set once (`list_all_images(0, BIG, true)`)
///   and filter in memory. For a 10k-image library this is ~5-20 ms —
///   acceptable for an interactive filter view. If a future profile
///   shows a heavier hot path, add a `get_images_by_ids(ids)` method
///   to index_vault that uses a BTree index on `image_id`.
/// - We pass `image_ids` as `Vec<String>` matching the
///   `library_list_images_by_tag` return type. Unrecognized ids
///   (deleted since the tag query, or never existed) are silently
///   dropped — the caller already had them via list_images_by_tag.
/// - Empty input → empty output (no DB hit).
#[tauri::command]
pub async fn library_get_images_by_ids(
    state: State<'_, LibraryState>,
    image_ids: Vec<String>,
) -> Result<Vec<ImageEntry>, AppError> {
    if image_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Parse once into a HashSet for O(1) membership checks.
    let wanted: HashSet<u128> = image_ids
        .iter()
        .filter_map(|s| s.parse::<u128>().ok())
        .collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }

    state.with_db(|db| {
        // `true` = sort_desc (newest first) matches list_images_by_tag
        // order, so the frontend can stitch the two calls together
        // without resorting.
        let all = db.list_all_images(0, usize::MAX, true);
        let mut entries = Vec::with_capacity(wanted.len());
        for img in all {
            if !wanted.contains(&img.image_id) {
                continue;
            }
            let folder_path = db
                .get_folder_data(img.folder_hash)
                .map_err(|e| AppError::LibraryError(e.to_string()))?
                .map(|f| f.folder_path)
                .unwrap_or_default();
            entries.push(ImageEntry {
                id: img.image_id.to_string(),
                filename: img.file_name,
                folder_path,
                width: img.width,
                height: img.height,
                timestamp: img.timestamp,
                has_large: img.has_large,
            });
        }
        Ok(entries)
    })
}

// =====================================================================
// Phase C2 / C3 — meta cache backfill commands
//
// Two entry points, both fire-and-forget at the IPC layer:
//
// - `library_meta_backfill_start`: walks every non-deleted image in
//   index_vault that doesn't yet have a row in `image_metadata` and
//   computes EXIF + histogram for each. Runs as a background task;
//   emits `library-meta-backfill-progress` every 10 images and
//   `library-meta-backfill-completed` when done. Frontend surfaces
//   the progress as a corner chip.
//
// - `library_meta_backfill_one`: single-image variant fired from the
//   frontend's lazy hook (`imageStore.loadHistogram` miss path).
//   Doesn't await — the frontend has already fallen through to
//   `loadHistogramFromDisk` for the current frame, and the next
//   switch back to this id will hit meta_cache directly.
//
// Re-entry: `library_meta_backfill_start` uses an `AtomicBool`
// CAS guard so a second invocation while the first is still running
// is a silent no-op (the previous summary covers why we don't queue).
// =====================================================================

/// Phase C2: kick off the startup backfill loop.
///
/// Returns immediately after spawning the background task. The
/// loop itself:
///   1. SELECTs `image_id` from `image_metadata` → "already cached" set
///   2. Walks `db.list_all_images(0, usize::MAX, true)` → all non-deleted
///   3. Filters to the difference
///   4. For each, resolves the absolute path and calls
///      `meta.compute_and_write_one(...)`
///   5. Emits progress + completion events
///
/// Permissive end-to-end: meta-cache is derived data, so any
/// single-image error inside the loop is warn-logged and skipped.
/// The frontend's indicator updates accordingly.
#[tauri::command]
pub async fn library_meta_backfill_start(
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<(), AppError> {
    let Some(meta) = state.meta() else {
        // meta_cache not initialized yet — drop the guard and bail.
        return Ok(());
    };
    spawn_meta_backfill(app, (*state).clone(), meta);
    Ok(())
}

/// Re-entry-guarded task spawn, factored out so the Tauri command
/// and the setup() auto-call share identical behavior without one
/// having to go through IPC. Idempotent: a second call while the
/// first is still running silently no-ops via the AtomicBool CAS.
pub fn spawn_meta_backfill(app: AppHandle, state: LibraryState, meta: Arc<MetaCache>) {
    if state
        .inner
        .backfill_running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        run_meta_backfill_loop(app, state, meta).await;
    });
}

/// Phase C3: lazy single-image backfill. Fire-and-forget; never
/// awaited from the command side. Frontend invokes this on a cache
/// miss and immediately falls through to the filesystem fallback
/// for the current frame — by the time the user switches back to
/// this id, the row will (usually) be present in meta_cache.
///
/// Phase C4 (P1 fix): acquire the in-flight guard BEFORE spawning.
/// If the startup loop or another lazy miss is already processing
/// this id, we silently no-op instead of queuing a duplicate.
#[tauri::command]
pub async fn library_meta_backfill_one(
    state: State<'_, LibraryState>,
    image_id: String,
) -> Result<(), AppError> {
    let Some(meta) = state.meta() else {
        // meta_cache uninitialized → silently no-op. The frontend's
        // loadHistogramFromDisk fallback covers this frame anyway.
        return Ok(());
    };

    let id_u128: u128 = match image_id.parse() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("meta_backfill_one: image_id parse failed: {e}");
            return Ok(());
        }
    };

    // Acquire the in-flight slot synchronously so two rapid lazy misses
    // for the same id can't both spawn work. The guard MUST be moved
    // into the spawned async task below — if we just `let _guard = ...`
    // here, it would drop the moment this command returns Ok(()), long
    // before the task finishes. Drop-on-`async move` end (success,
    // error, or panic) is what actually holds the slot for the
    // compute's duration.
    let guard = match state.try_acquire_in_flight(id_u128) {
        Some(g) => g,
        None => return Ok(()),
    };

    let state_clone = (*state).clone();
    tauri::async_runtime::spawn(async move {
        let _guard = guard;

        // Resolve path + deletion status in a single db-locked pass.
        // `get_absolute_path` doesn't check `is_deleted`, so deleted
        // entries still return `Some(path)` — we must filter them
        // explicitly to avoid resurrecting meta_cache rows for images
        // the user has removed.
        let lookup = state_clone.with_db(|db| {
            let deleted = db
                .get_image_entry(id_u128)
                .map(|e| e.is_deleted())
                .unwrap_or(true);
            let path = db
                .get_absolute_path(id_u128)
                .map_err(|e| AppError::LibraryError(e.to_string()))?;
            Ok((path, deleted))
        });
        let (path, deleted) = match lookup {
            Ok((Some(p), false)) => (p, false),
            Ok((_, true)) => {
                // Deleted or never-existed — skip silently.
                return;
            }
            Ok((None, _)) => return,
            Err(e) => {
                tracing::warn!(
                    image_id = %image_id,
                    "meta_backfill_one: db lookup failed: {e}"
                );
                return;
            }
        };

        if let Err(e) = meta
            .compute_and_write_one(&image_id, path, || {
                // Re-check `is_deleted` between compute and write.
                // The lookup at the top of this task already ran the
                // same query, but `library_mark_deleted` could have
                // fired in the ~50-100ms since (image EXIF + histogram
                // compute window). Skip the write if so — better to
                // drop the freshly-computed meta than resurrect a row
                // the user just deleted.
                state_clone
                    .with_db(|db| {
                        Ok::<_, AppError>(
                            db.get_image_entry(id_u128)
                                .map(|e| !e.is_deleted())
                                .unwrap_or(false),
                        )
                    })
                    .unwrap_or(false)
            })
            .await
        {
            tracing::warn!(
                image_id = %image_id,
                "meta_backfill_one: compute_and_write_one failed: {e}"
            );
        }
    });

    Ok(())
}

/// Body of the startup backfill loop. Runs in a `tauri::async_runtime`
/// spawned task. Always resets `backfill_running` on exit so a
/// future manual `library_meta_backfill_start` (e.g. dev retry)
/// can fire again.
///
/// Phase C4 (P1 fix): each iteration acquires the in-flight guard,
/// so a concurrent lazy miss on the same id is silently skipped.
/// Phase C4 (P2 fix): also checks `is_deleted` inside the path lookup
/// to avoid resurrecting meta_cache rows for images the user has
/// removed between the SELECT and the compute step.
async fn run_meta_backfill_loop(
    app: AppHandle,
    state: LibraryState,
    meta: Arc<MetaCache>,
) {
    // RAII-ish guard: on any return path (early error, panic
    // recovery, normal completion) reset the flag.
    let _flag_guard = BackfillGuard {
        inner: state.inner.clone(),
    };

    // 1. Pull already-cached ids.
    let cached: HashSet<String> = match meta_cached_ids(&meta).await {
        Ok(set) => set,
        Err(e) => {
            tracing::warn!("meta_backfill: cached_ids SELECT failed: {e}; aborting");
            return;
        }
    };

    // 2. Pull all non-deleted image_ids from index_vault.
    let all_ids: Vec<u128> = match state.with_db(|db| Ok(db.list_all_images(0, usize::MAX, true))) {
        Ok(v) => v.into_iter().map(|img| img.image_id).collect(),
        Err(e) => {
            tracing::warn!("meta_backfill: list_all_images failed: {e}; aborting");
            return;
        }
    };

    // 3. Difference = work.
    let todo: Vec<u128> = all_ids
        .into_iter()
        .filter(|id| !cached.contains(&id.to_string()))
        .collect();
    let total = todo.len();

    // Emit 0/N immediately so the UI chip shows up even if there's
    // nothing to do (consistent feedback for the empty case).
    let _ = app.emit("library-meta-backfill-progress", (0u32, total as u32));

    if total == 0 {
        let _ = app.emit("library-meta-backfill-completed", ());
        return;
    }

    // 4. Walk + compute. Yield every 10 to keep tokio scheduler fair.
    let mut processed = 0u32;
    for id in todo {
        // Acquire the in-flight slot synchronously. If a lazy miss
        // already grabbed it, skip without burning compute — when the
        // lazy task finishes, this id will be in `image_metadata` and
        // the next startup will skip it via the cached diff anyway.
        let _item_guard = match state.try_acquire_in_flight(id) {
            Some(g) => g,
            None => continue,
        };

        // Resolve path + deletion status in one db-locked pass.
        let lookup = state.with_db(|db| {
            let deleted = db
                .get_image_entry(id)
                .map(|e| e.is_deleted())
                .unwrap_or(true);
            let path = db
                .get_absolute_path(id)
                .map_err(|e| AppError::LibraryError(e.to_string()))?;
            Ok((path, deleted))
        });
        let (path, deleted) = match lookup {
            Ok((Some(p), false)) => (p, false),
            Ok((_, true)) => continue,
            Ok((None, _)) => continue,
            Err(e) => {
                tracing::warn!(image_id = %id, "meta_backfill: db lookup failed: {e}");
                continue;
            }
        };

        if let Err(e) = meta
            .compute_and_write_one(&id.to_string(), path, || {
                // Re-check `is_deleted` between compute and write.
                // The lookup above already ran the same query, but
                // `library_mark_deleted` could have fired in the
                // ~50-100ms since (compute window). Skip the write if
                // so — drop the freshly-computed meta rather than
                // resurrect a row the user just deleted.
                state
                    .with_db(|db| {
                        Ok::<_, AppError>(
                            db.get_image_entry(id)
                                .map(|e| !e.is_deleted())
                                .unwrap_or(false),
                        )
                    })
                    .unwrap_or(false)
            })
            .await
        {
            tracing::warn!(image_id = %id, "meta_backfill: compute_and_write_one failed: {e}");
        }

        processed += 1;
        if processed % 10 == 0 {
            let _ = app.emit("library-meta-backfill-progress", (processed, total as u32));
        }
    }

    // Final progress tick — in case total wasn't a multiple of 10.
    let _ = app.emit("library-meta-backfill-progress", (processed, total as u32));
    let _ = app.emit("library-meta-backfill-completed", ());
}

/// SELECT all image_ids currently in `image_metadata`. Used by the
/// startup backfill to compute the diff against index_vault's full
/// set — only "missing" rows get re-extracted.
async fn meta_cached_ids(meta: &MetaCache) -> Result<HashSet<String>, AppError> {
    use sea_orm::{EntityTrait, QuerySelect};
    let rows = crate::entity::image_metadata::Entity::find()
        .select_only()
        .column(crate::entity::image_metadata::Column::ImageId)
        .all(meta.db())
        .await
        .map_err(AppError::Sqlx)?;
    Ok(rows.into_iter().map(|r| r.image_id).collect())
}

/// RAII guard that resets `backfill_running` to `false` when
/// `run_meta_backfill_loop` returns (normal, panic, or early
/// `return`). Avoids leaking the re-entry guard on error paths.
///
/// We can't use the `scopeguard` crate (not in Cargo.toml), and
/// `Drop` is the only zero-cost way to do this in stable Rust.
///
/// Phase C4 (P2 fix): field renamed `inner` so it doesn't shadow
/// the `state: LibraryState` parameter of the surrounding function.
struct BackfillGuard {
    inner: Arc<LibraryStateInner>,
}

impl Drop for BackfillGuard {
    fn drop(&mut self) {
        self.inner.backfill_running.store(false, Ordering::Release);
    }
}
