//! Metadata cache layer (Plan A).
//!
//! Holds a sea-orm connection to `<app_data_dir>/thumbs_db/meta_cache.sqlite`
//! alongside five tables that back the EXIF / histogram / tag caches:
//!
//! - `image_metadata` — per-image bookkeeping row (always populated when
//!   the source image has been scanned)
//! - `histogram_cache` — downscaled RGB histogram (3 × 1024 B blobs)
//! - `exif_cache` — flat eight-string UI view of parsed EXIF
//! - `tags` — user- or AI-defined tag vocabulary
//! - `image_tags` — many-to-many join
//!
//! **Failure mode is permissive**: a corrupt or missing DB must never
//! block app startup. `init` returns `Result` so callers can `warn!`
//! and fall back to the existing filesystem IPC path on the frontend.

use std::path::PathBuf;
use std::sync::Arc;

use sea_orm::sqlx::sqlite::{SqliteJournalMode, SqliteSynchronous};
use sea_orm::{ColumnTrait, ConnectOptions, Database, DatabaseConnection, QueryFilter};
use sea_orm_migration::MigratorTrait;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::entity;
use crate::error::AppError;
use crate::migration::Migrator;

/// Flat eight-string UI view of a cached EXIF row.
///
/// Mirrors `exif_cache::Model` minus `image_id` (the PK is implicit in
/// the lookup key) and with `serde::Serialize` for the Tauri IPC
/// `library_read_exif` command. The frontend's `ExifData` type has the
/// same eight fields, so this serializes 1:1 into the UI shape.
#[derive(Debug, Clone, Serialize)]
pub struct ExifCacheRow {
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<String>,
    pub aperture: Option<String>,
    pub shutter: Option<String>,
    pub focal_length: Option<String>,
    pub equivalent_focal_length: Option<String>,
    pub date_taken: Option<String>,
    pub source_mtime: i64,
}

/// Holds the connection to `meta_cache.sqlite`.
///
/// Returned as `Arc<Self>` from `init` so `library_scan_folder` can
/// clone the Arc into the Plan B batch callback closure (which lives
/// on the pipeline consumer thread and outlives the originating Tauri
/// command). Storage itself is held inside `LibraryState` via a
/// `OnceCell<Arc<MetaCache>>` for lazy init on first scan.
pub struct MetaCache {
    db: DatabaseConnection,
    #[allow(dead_code)] // Stored for diagnostics + future log lines.
    path: PathBuf,
}

impl MetaCache {
    /// Open `meta_cache.sqlite` in the app's data dir. Resolves the
    /// canonical path from `AppHandle::path()` and delegates to
    /// [`Self::open_at`]. The split exists so integration tests can
    /// target a `tempfile::TempDir` without spinning up a Tauri
    /// runtime; production code should keep using `init`.
    pub async fn init(app: &AppHandle) -> Result<Arc<Self>, AppError> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::LibraryError(format!("app_data_dir: {e}")))?;
        let dir = app_data_dir.join("thumbs_db");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return Err(AppError::Io(e));
        }
        let path = dir.join("meta_cache.sqlite");
        Self::open_at(&path).await
    }

    /// Open (or create) the SQLite file at `path` with the same PRAGMAs
    /// and migrations used in production. The parent directory must
    /// already exist.
    ///
    /// Public so `tests/meta_cache.rs` can drive the cache against a
    /// `TempDir`-scoped DB. There is no other external consumer.
    pub async fn open_at(path: &std::path::Path) -> Result<Arc<Self>, AppError> {
        // sea-orm expects an `sqlite://` URL; plain `Path` won't parse.
        //
        // The `?mode=rwc` query parameter tells sqlx-sqlite to open the
        // file read-write + create-on-open. Without it sqlx falls back
        // to a default that breaks for paths like `F:\...\target\...`
        // in integration tests (intermittent SQLITE_CANTOPEN 14),
        // while the production app_data path happens to be parsed
        // leniently. Pinning the mode makes both paths deterministic.
        let url = format!(
            "sqlite://{}?mode=rwc",
            path.to_string_lossy()
        );
        let mut opts = ConnectOptions::new(&url);
        // Suppress sqlx's per-statement logging — we don't need it and it
        // would balloon the log output during scan flushes.
        opts.sqlx_logging(false);

        // PRAGMAs must be set on every pool connection. `Database::connect`
        // uses the underlying sqlx builder for the pool, so configuring via
        // `map_sqlx_sqlite_opts` is the only way to make per-connection
        // pragmas (`foreign_keys`, `synchronous`, `temp_store`, `mmap_size`,
        // `cache_size`) stick. A `db.execute(...)` after connect would only
        // affect a single connection — and FK CASCADE in particular would
        // silently no-op on pool warm-up connections. `journal_mode=WAL`
        // happens to be database-persistent so it's redundant here, but we
        // set it explicitly to be self-documenting.
        opts.map_sqlx_sqlite_opts(|o| {
            o.foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal)
                .synchronous(SqliteSynchronous::Normal)
                .pragma("temp_store", "MEMORY")
                .pragma("mmap_size", "268435456") // 256 MiB
                .pragma("cache_size", "-64000") // 64 MiB page cache
        });

        let db = Database::connect(opts).await?;

        Migrator::up(&db, None)
            .await
            .map_err(|e| AppError::Migration(format!("Migrator::up failed: {e}")))?;

        Ok(Arc::new(Self {
            db,
            path: path.to_path_buf(),
        }))
    }

    /// Borrow the sea-orm connection. Used by read-path IPC commands
    /// (`library_read_histogram`, `library_read_exif`, …).
    pub fn db(&self) -> &DatabaseConnection {
        &self.db
    }

    // ------------------------------------------------------------------
    // Read path (Phase A3)
    //
    // Both lookups return `Option<_>`. Callers (`library::library_read_*`
    // commands) translate a `None` into the wire-format sentinel:
    // histogram → 8 zero bytes (width = 0), EXIF → JSON `null`.
    //
    // Both calls go straight through the sea-orm pool without a
    // wrapping transaction — single-row PK lookups don't need one, and
    // skipping it shaves ~0.5 ms off the p99 (we target <10 ms p99 for
    // library mode image switching).
    // ------------------------------------------------------------------

    /// Read a cached histogram for `image_id`. Returns `Some((width,
    /// height, r_bins, g_bins, b_bins))` on hit, `None` when no row
    /// exists. Each `Vec<u8>` is 1024 B (256 × `u32` LE) by schema
    /// contract — see `write_batch_meta` / `pack_histogram`.
    pub async fn read_histogram(
        &self,
        image_id: &str,
    ) -> Result<Option<(u32, u32, Vec<u8>, Vec<u8>, Vec<u8>)>, AppError> {
        use entity::histogram_cache::{Column, Entity};
        let row = Entity::find()
            .filter(Column::ImageId.eq(image_id))
            .one(&self.db)
            .await
            .map_err(AppError::Sqlx)?;
        Ok(row.map(|r| (r.width as u32, r.height as u32, r.r_data, r.g_data, r.b_data)))
    }

    /// Read a cached EXIF row for `image_id`. Returns `Some(ExifCacheRow)`
    /// on hit, `None` when no row exists.
    pub async fn read_exif(
        &self,
        image_id: &str,
    ) -> Result<Option<ExifCacheRow>, AppError> {
        use entity::exif_cache::{Column, Entity};
        let row = Entity::find()
            .filter(Column::ImageId.eq(image_id))
            .one(&self.db)
            .await
            .map_err(AppError::Sqlx)?;
        Ok(row.map(|r| ExifCacheRow {
            camera: r.camera,
            lens: r.lens,
            iso: r.iso,
            aperture: r.aperture,
            shutter: r.shutter,
            focal_length: r.focal_length,
            equivalent_focal_length: r.equivalent_focal_length,
            date_taken: r.date_taken,
            source_mtime: r.source_mtime,
        }))
    }

    // ------------------------------------------------------------------
    // Write path (Phase A2)
    //
    // Called by `library_scan_folder` via the Plan B
    // `on_batch_written` callback. All upserts run inside one
    // `sea_orm::Transaction` so a partial batch failure rolls back
    // cleanly. Errors are surfaced to the caller; the caller (callback
    // closure) is responsible for `warn!`-logging and not blocking the
    // scan (meta is derived data per R-A3.4).
    // ------------------------------------------------------------------

    /// Write a single batch's metadata in one transaction.
    ///
    /// For each `MetaPayload`, upserts `image_metadata` then writes
    /// the `exif_cache` / `histogram_cache` rows whose payload is
    /// `Some(_)`. Returns the number of metadata rows touched for
    /// logging.
    ///
    /// Callers are expected to pre-filter `ThumbProcessResult::Failed`
    /// variants via `extract_meta_payloads` before invoking this — see
    /// the scan callback in `library::library_scan_folder`.
    pub async fn write_batch_meta(&self, payloads: &[MetaPayload]) -> Result<usize, AppError> {
        if payloads.is_empty() {
            return Ok(0);
        }

        let db = &self.db;
        let now_ms = std_time_millis();

        // Clone payloads into an owned Vec inside the transaction closure
        // so the returned `Pin<Box<dyn Future + Send + 'c>>` doesn't borrow
        // from `payloads` — the HRTB on `transaction()` requires the future
        // to outlive any caller-chosen `'c`, which a borrowed slice can't
        // satisfy (`MetaPayload` clones are cheap, ~200 B / item).
        db.transaction(move |txn| {
            let payloads = payloads.to_vec();
            Box::pin(async move {
                let mut written = 0usize;
                for p in payloads {
                    let has_exif = p.exif.is_some();
                    let has_histogram = p.histogram.is_some();

                    // image_metadata upsert
                    let am = entity::image_metadata::ActiveModel {
                        image_id: ActiveValue::set(p.image_id.clone()),
                        folder_hash: ActiveValue::set(p.folder_hash.clone()),
                        has_exif: ActiveValue::set(has_exif as i32),
                        has_histogram: ActiveValue::set(has_histogram as i32),
                        source_mtime: ActiveValue::set(p.timestamp as i64),
                        computed_at: ActiveValue::set(now_ms),
                        width: ActiveValue::set(Some(p.orig_width as i32)),
                        height: ActiveValue::set(Some(p.orig_height as i32)),
                    };
                    upsert_image_metadata(&txn, &am).await?;
                    written += 1;

                    if let Some(exif) = &p.exif {
                        let am = entity::exif_cache::ActiveModel {
                            image_id: ActiveValue::set(p.image_id.clone()),
                            camera: ActiveValue::set(exif.camera.clone()),
                            lens: ActiveValue::set(exif.lens.clone()),
                            iso: ActiveValue::set(exif.iso.clone()),
                            aperture: ActiveValue::set(exif.aperture.clone()),
                            shutter: ActiveValue::set(exif.shutter.clone()),
                            focal_length: ActiveValue::set(exif.focal_length.clone()),
                            equivalent_focal_length: ActiveValue::set(
                                exif.equivalent_focal_length.clone(),
                            ),
                            date_taken: ActiveValue::set(exif.date_taken.clone()),
                            source_mtime: ActiveValue::set(p.timestamp as i64),
                        };
                        upsert_exif_cache(&txn, &am).await?;
                    }

                    if let Some(h) = &p.histogram {
                        let (r_bytes, g_bytes, b_bytes) = pack_histogram(h);
                        let am = entity::histogram_cache::ActiveModel {
                            image_id: ActiveValue::set(p.image_id.clone()),
                            r_data: ActiveValue::set(r_bytes),
                            g_data: ActiveValue::set(g_bytes),
                            b_data: ActiveValue::set(b_bytes),
                            // Store the source image's original dimensions
                            // (not a sum of histogram bins). Frontend needs
                            // these to know how many pixels the histogram
                            // represents when normalizing for display.
                            width: ActiveValue::set(p.orig_width as i32),
                            height: ActiveValue::set(p.orig_height as i32),
                            source_mtime: ActiveValue::set(p.timestamp as i64),
                        };
                        upsert_histogram_cache(&txn, &am).await?;
                    }
                }
                Ok(written)
            })
        })
        .await
        .map_err(|e| match e {
            sea_orm::TransactionError::Connection(db) => AppError::Sqlx(db),
            // Inner callback errors are also `sea_orm::DbErr` (the
            // upsert helpers return `Result<_, DbErr>`).
            sea_orm::TransactionError::Transaction(db) => AppError::Sqlx(db),
        })
    }
}

// ----------------- private upsert helpers -----------------

use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue, EntityTrait, QueryOrder, QuerySelect, TransactionTrait};

/// Metadata payload extracted from a `ThumbProcessResult::Success`.
///
/// Carries only the small fields needed by the meta_cache write path.
/// Intentionally excludes `small_data` / `large_data` (WebP thumbnail
/// and preview buffers, often 5–15 MB total per batch) so we can
/// extract these payloads in the scan callback and drop the heavy
/// buffers immediately, instead of cloning the full
/// `ThumbProcessResult` across the spawn boundary.
///
/// `pub` so `tests/meta_cache.rs` can construct payloads directly
/// without going through the heavier `ThumbProcessResult` enum. The
/// scan callback (`library.rs`) is the only production constructor.
#[derive(Clone)]
pub struct MetaPayload {
    pub image_id: String,
    pub folder_hash: String,
    pub timestamp: u64,
    pub orig_width: u32,
    pub orig_height: u32,
    pub exif: Option<index_vault::pipeline::ExifFields>,
    pub histogram: Option<index_vault::pipeline::HistogramBins>,
}

/// Extract `MetaPayload`s from a batch of `ThumbProcessResult`s,
/// skipping `Failed` variants (R-A3.2). Called from the scan
/// callback so the heavy thumbnail / preview buffers are released
/// before the spawned async task starts.
pub fn extract_meta_payloads(
    results: &[index_vault::pipeline::ThumbProcessResult],
) -> Vec<MetaPayload> {
    results
        .iter()
        .filter_map(|r| match r {
            index_vault::pipeline::ThumbProcessResult::Success(d) => Some(MetaPayload {
                image_id: d.identity.image_id.to_string(),
                folder_hash: d.identity.folder_hash.to_string(),
                timestamp: d.timestamp,
                orig_width: d.orig_width,
                orig_height: d.orig_height,
                exif: d.exif.clone(),
                histogram: d.histogram.clone(),
            }),
            _ => None,
        })
        .collect()
}

/// Pack 256 little-endian u32 bins into 1024 raw bytes.
///
/// We pack here so the on-wire representation (and BLOB storage)
/// matches what the frontend's `parseHistogramBinary` expects.
fn pack_histogram(h: &index_vault::pipeline::HistogramBins) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let pack = |bins: &[u32]| -> Vec<u8> {
        let mut out = Vec::with_capacity(bins.len() * 4);
        for &v in bins {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    };
    (pack(&h.r), pack(&h.g), pack(&h.b))
}

fn std_time_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn upsert_image_metadata(
    txn: &sea_orm::DatabaseTransaction,
    am: &entity::image_metadata::ActiveModel,
) -> Result<(), sea_orm::DbErr> {
    use entity::image_metadata::{Column, Entity};
    Entity::insert(am.clone())
        .on_conflict(
            OnConflict::column(Column::ImageId)
                .update_columns([
                    Column::FolderHash,
                    Column::HasExif,
                    Column::HasHistogram,
                    Column::SourceMtime,
                    Column::ComputedAt,
                    Column::Width,
                    Column::Height,
                ])
                .to_owned(),
        )
        .exec(txn)
        .await?;
    Ok(())
}

async fn upsert_exif_cache(
    txn: &sea_orm::DatabaseTransaction,
    am: &entity::exif_cache::ActiveModel,
) -> Result<(), sea_orm::DbErr> {
    use entity::exif_cache::{Column, Entity};
    Entity::insert(am.clone())
        .on_conflict(
            OnConflict::column(Column::ImageId)
                .update_columns([
                    Column::Camera,
                    Column::Lens,
                    Column::Iso,
                    Column::Aperture,
                    Column::Shutter,
                    Column::FocalLength,
                    Column::EquivalentFocalLength,
                    Column::DateTaken,
                    Column::SourceMtime,
                ])
                .to_owned(),
        )
        .exec(txn)
        .await?;
    Ok(())
}

async fn upsert_histogram_cache(
    txn: &sea_orm::DatabaseTransaction,
    am: &entity::histogram_cache::ActiveModel,
) -> Result<(), sea_orm::DbErr> {
    use entity::histogram_cache::{Column, Entity};
    Entity::insert(am.clone())
        .on_conflict(
            OnConflict::column(Column::ImageId)
                .update_columns([
                    Column::RData,
                    Column::GData,
                    Column::BData,
                    Column::Width,
                    Column::Height,
                    Column::SourceMtime,
                ])
                .to_owned(),
        )
        .exec(txn)
        .await?;
    Ok(())
}

// =====================================================================
// Tag CRUD (Phase A5)
//
// 7 read/write entry points backing `library_list_tags`,
// `library_create_tag`, `library_rename_tag`, `library_delete_tag`,
// `library_set_image_tags`, `library_get_image_tags`,
// `library_list_images_by_tag`. Tag UI lives in Slice 2 — these
// commands only need to round-trip cleanly through DevTools today.
//
// Design notes:
// - Case-insensitive uniqueness for `(name, source)` is enforced
//   at the Rust layer. The schema's UNIQUE index uses SQLite's
//   default BINARY collation; relying on it alone would let
//   "Travel" + "TRAVEL" both register. We check before insert
//   inside the same transaction so the SELECT-after-INSERT race
//   that a plain CHECK would have can't bite us.
// - FK CASCADE on `image_tags.tag_id` means `delete_tag` does not
//   need to manually clean up links.
// - `set_image_tags` is a single transaction: DELETE existing rows
//   for the image, INSERT the new set. A failure mid-loop rolls
//   back cleanly (no partial tag state visible to readers).
// =====================================================================

/// Flat wire-format view of a `tags` row.
///
/// Mirrors `entity::tags::Model` 1:1 with `Serialize` for IPC. Field
/// names stay snake_case to match `ExifCacheRow`'s convention; the
/// frontend maps to camelCase at the call site if needed.
#[derive(Debug, Clone, Serialize)]
pub struct Tag {
    pub id: i32,
    pub name: String,
    pub source: String,
    pub confidence: Option<f64>,
    pub parent_id: Option<i32>,
    pub color: Option<String>,
    pub sort_order: i32,
    pub created_at: i64,
    /// Number of images that carry this tag.
    ///
    /// Sentinel `-1` is returned from `get_image_tags` (where the
    /// caller sees a single image's membership, not the whole
    /// vocabulary; the count would be misleading). `list_tags`
    /// always returns a real `>= 0` value aggregated via a second
    /// `image_tags` query — see `list_tags`.
    pub image_count: i32,
}

/// Tag origin. Stored as the literal string in the DB (`"user"` /
/// `"ai"`); the enum exists so callers don't accidentally invent
/// a third source value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagSource {
    User,
    Ai,
}

impl TagSource {
    pub fn parse(s: &str) -> Result<Self, AppError> {
        match s.to_ascii_lowercase().as_str() {
            "user" => Ok(TagSource::User),
            "ai" => Ok(TagSource::Ai),
            _ => Err(AppError::InvalidParameter(format!("tag source: {s}"))),
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            TagSource::User => "user",
            TagSource::Ai => "ai",
        }
    }
}

/// Single row returned by the per-tag `image_tags` `GROUP BY` query.
/// `c` is `COUNT(image_id)` and capped at `i32` because a single tag
/// holding more than 2 billion image associations is not realistic
/// in this app and would already indicate DB corruption.
#[derive(Debug, sea_orm::FromQueryResult)]
struct TagCountRow {
    tag_id: i32,
    c: i32,
}

fn tag_from_model(m: entity::tags::Model, image_count: i32) -> Tag {
    Tag {
        id: m.id,
        name: m.name,
        source: m.source,
        confidence: m.confidence,
        parent_id: m.parent_id,
        color: m.color,
        sort_order: m.sort_order,
        created_at: m.created_at,
        image_count,
    }
}

impl MetaCache {
    /// List tags ordered by `sort_order ASC, id ASC`. Optional `source`
    /// filter restricts to one origin (user vs. ai).
    ///
    /// Each tag's `image_count` reflects how many distinct images
    /// currently carry it (via the `image_tags` join table). Counted
    /// via a second `GROUP BY` query against `idx-image_tags-tag` and
    /// joined in memory — typical tag vocabularies are a few hundred
    /// rows, so the join stays O(N) and a single LEFT JOIN round trip
    /// via sea-query's GROUP BY projection wouldn't be measurably
    /// cheaper while being much noisier code.
    pub async fn list_tags(&self, source: Option<TagSource>) -> Result<Vec<Tag>, AppError> {
        use entity::tags::{Column, Entity};
        let mut q = Entity::find()
            .order_by_asc(Column::SortOrder)
            .order_by_asc(Column::Id);
        if let Some(s) = source {
            q = q.filter(Column::Source.eq(s.as_str()));
        }
        let rows = q.all(&self.db).await.map_err(AppError::Sqlx)?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }

        use entity::image_tags::{Column as ITColumn, Entity as IT};
        use sea_orm::{FromQueryResult, QuerySelect};
        let count_rows = IT::find()
            .select_only()
            .column(ITColumn::TagId)
            .column_as(ITColumn::ImageId.count(), "c")
            .group_by(ITColumn::TagId)
            .into_model::<TagCountRow>()
            .all(&self.db)
            .await
            .map_err(AppError::Sqlx)?;
        let mut counts = std::collections::HashMap::with_capacity(count_rows.len());
        for row in count_rows {
            counts.insert(row.tag_id, row.c);
        }

        Ok(rows
            .into_iter()
            .map(|m| {
                let c = counts.get(&m.id).copied().unwrap_or(0);
                tag_from_model(m, c)
            })
            .collect())
    }

    /// Create a new tag. Returns the auto-incremented `id`.
    ///
    /// Case-insensitive duplicate check is enforced inside the
    /// transaction. `name` is trimmed; empty-after-trim is rejected
    /// up front so we don't burn an INSERT just to roll it back.
    pub async fn create_tag(
        &self,
        name: &str,
        source: TagSource,
        confidence: Option<f64>,
        parent_id: Option<i32>,
        color: Option<String>,
    ) -> Result<i32, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidParameter("tag name".to_string()));
        }
        let now_ms = std_time_millis();
        let db = &self.db;
        db.transaction(|txn| {
            let name = name.to_string();
            Box::pin(async move {
                use entity::tags::{Column, Entity};
                // Case-insensitive uniqueness check. We pull every row for
                // this source and compare in Rust; for typical tag counts
                // (hundreds at most) this is cheaper than reasoning about
                // `Expr::cust_with_values` bindings and avoids a round-trip
                // through SQLite's collation logic.
                let existing = Entity::find()
                    .filter(Column::Source.eq(source.as_str()))
                    .all(txn)
                    .await?;
                if existing
                    .iter()
                    .any(|t| t.name.eq_ignore_ascii_case(&name))
                {
                    return Err(sea_orm::DbErr::Custom(format!(
                        "tag '{}' already exists for source '{}'",
                        name,
                        source.as_str()
                    )));
                }
                let am = entity::tags::ActiveModel {
                    id: ActiveValue::NotSet,
                    name: ActiveValue::set(name),
                    source: ActiveValue::set(source.as_str().to_string()),
                    confidence: ActiveValue::set(confidence),
                    parent_id: ActiveValue::set(parent_id),
                    color: ActiveValue::set(color),
                    sort_order: ActiveValue::NotSet,
                    created_at: ActiveValue::set(now_ms),
                };
                let res = Entity::insert(am).exec(txn).await?;
                Ok(res.last_insert_id as i32)
            })
        })
        .await
        .map_err(|e| match e {
            sea_orm::TransactionError::Connection(db) => AppError::Sqlx(db),
            sea_orm::TransactionError::Transaction(db) => AppError::Sqlx(db),
        })
    }

    /// Rename a tag by id. Empty-after-trim names are rejected.
    ///
    /// Case-insensitivity is **not** re-checked here — the assumption
    /// is the caller already validated the new name. A rename that
    /// collides with an existing tag in the same source will succeed
    /// at the row level; the DB's UNIQUE index only kicks in for
    /// exact byte-equal pairs. We leave the collision handling to the
    /// UI layer (which can call `list_tags` first and decide).
    pub async fn rename_tag(&self, id: i32, name: &str) -> Result<(), AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidParameter("tag name".to_string()));
        }
        use entity::tags::Entity;
        let am = entity::tags::ActiveModel {
            id: ActiveValue::set(id),
            name: ActiveValue::set(name.to_string()),
            ..Default::default()
        };
        Entity::update(am).exec(&self.db).await.map_err(AppError::Sqlx)?;
        Ok(())
    }

    /// Delete a tag by id. `image_tags` links are removed by FK CASCADE
    /// (see `migration::Migration::up`).
    ///
    /// Non-existent ids return success with `rows_affected = 0` —
    /// callers can't distinguish from a real delete, but that's fine
    /// for an idempotent admin operation.
    pub async fn delete_tag(&self, id: i32) -> Result<(), AppError> {
        use entity::tags::{Column, Entity};
        Entity::delete_many()
            .filter(Column::Id.eq(id))
            .exec(&self.db)
            .await
            .map_err(AppError::Sqlx)?;
        Ok(())
    }

    /// Replace an image's tag set. Atomic: clears existing links, then
    /// inserts the new ones in a single transaction. An invalid `tag_id`
    /// trips the FK and rolls back the entire call.
    pub async fn set_image_tags(
        &self,
        image_id: &str,
        tag_ids: &[i32],
    ) -> Result<(), AppError> {
        let now_ms = std_time_millis();
        let db = &self.db;
        db.transaction(|txn| {
            let image_id = image_id.to_string();
            let tag_ids = tag_ids.to_vec();
            Box::pin(async move {
                use entity::image_tags::{Column, Entity};
                Entity::delete_many()
                    .filter(Column::ImageId.eq(&image_id))
                    .exec(txn)
                    .await?;
                for tag_id in tag_ids {
                    let am = entity::image_tags::ActiveModel {
                        image_id: ActiveValue::set(image_id.clone()),
                        tag_id: ActiveValue::set(tag_id),
                        added_at: ActiveValue::set(now_ms),
                    };
                    Entity::insert(am).exec(txn).await?;
                }
                Ok(())
            })
        })
        .await
        .map_err(|e| match e {
            sea_orm::TransactionError::Connection(db) => AppError::Sqlx(db),
            sea_orm::TransactionError::Transaction(db) => AppError::Sqlx(db),
        })
    }

    /// Look up the tags attached to an image, ordered by
    /// `sort_order ASC, id ASC` (matches `list_tags` ordering so the
    /// UI can render consistently).
    pub async fn get_image_tags(&self, image_id: &str) -> Result<Vec<Tag>, AppError> {
        use entity::image_tags::{Column as ITColumn, Entity as IT};
        let tag_ids: Vec<i32> = IT::find()
            .filter(ITColumn::ImageId.eq(image_id))
            .all(&self.db)
            .await
            .map_err(AppError::Sqlx)?
            .into_iter()
            .map(|r| r.tag_id)
            .collect();
        if tag_ids.is_empty() {
            return Ok(Vec::new());
        }
        use entity::tags::{Column, Entity};
        let rows = Entity::find()
            .filter(Column::Id.is_in(tag_ids))
            .order_by_asc(Column::SortOrder)
            .order_by_asc(Column::Id)
            .all(&self.db)
            .await
            .map_err(AppError::Sqlx)?;
        Ok(rows
            .into_iter()
            .map(|m| tag_from_model(m, -1))
            .collect())
    }

    /// Paginated lookup of image ids that have a given tag, newest
    /// first (`added_at DESC`). The schema doesn't index `added_at`,
    /// so this query falls back to a table scan on `image_tags` —
    /// fine for the volumes we expect (tens of thousands at most).
    pub async fn list_images_by_tag(
        &self,
        tag_id: i32,
        offset: u64,
        limit: u64,
    ) -> Result<Vec<String>, AppError> {
        use entity::image_tags::{Column, Entity};
        let rows = Entity::find()
            .filter(Column::TagId.eq(tag_id))
            .order_by_desc(Column::AddedAt)
            .offset(offset)
            .limit(limit)
            .all(&self.db)
            .await
            .map_err(AppError::Sqlx)?;
        Ok(rows.into_iter().map(|r| r.image_id).collect())
    }

    /// Phase A6: mark images as deleted in all 4 meta_cache tables.
    ///
    /// Runs the four DELETEs inside one sea-orm transaction so a
    /// mid-loop failure rolls back cleanly. Each table gets its own
    /// `WHERE image_id IN (...)` statement — sea-orm's `is_in`
    /// consumes the iterator, so we re-`cloned()` it four times
    /// instead of materializing four owned `Vec`s.
    ///
    /// Idempotent: an empty input short-circuits; non-existent ids
    /// match zero rows and silently no-op (no error). FK CASCADE on
    /// `image_tags.tag_id` is irrelevant here — we delete by
    /// `image_id`, not by `tag_id`, and `image_tags.image_id` has no
    /// FK pointing back at `image_metadata`, so this is a plain
    /// bulk delete.
    pub async fn mark_images_deleted(&self, image_ids: &[u128]) -> Result<(), AppError> {
        if image_ids.is_empty() {
            return Ok(());
        }
        let image_ids_str: Vec<String> = image_ids.iter().map(|id| id.to_string()).collect();
        let db = &self.db;
        db.transaction(|txn| {
            let image_ids = image_ids_str;
            Box::pin(async move {
                use entity::{exif_cache, histogram_cache, image_metadata, image_tags};

                image_metadata::Entity::delete_many()
                    .filter(
                        image_metadata::Column::ImageId
                            .is_in(image_ids.iter().cloned()),
                    )
                    .exec(txn)
                    .await?;
                histogram_cache::Entity::delete_many()
                    .filter(
                        histogram_cache::Column::ImageId
                            .is_in(image_ids.iter().cloned()),
                    )
                    .exec(txn)
                    .await?;
                exif_cache::Entity::delete_many()
                    .filter(
                        exif_cache::Column::ImageId
                            .is_in(image_ids.iter().cloned()),
                    )
                    .exec(txn)
                    .await?;
                image_tags::Entity::delete_many()
                    .filter(
                        image_tags::Column::ImageId
                            .is_in(image_ids.iter().cloned()),
                    )
                    .exec(txn)
                    .await?;

                Ok(())
            })
        })
        .await
        .map_err(|e| match e {
            sea_orm::TransactionError::Connection(db) => AppError::Sqlx(db),
            sea_orm::TransactionError::Transaction(db) => AppError::Sqlx(db),
        })
    }

    /// Phase C1: compute EXIF + histogram for a single image and
    /// persist to meta_cache.
    ///
    /// Used by:
    /// - `library_meta_backfill_start` startup loop
    /// - `library_meta_backfill_one` lazy per-image hook
    ///
    /// `image_id` is the decimal-string u128 used everywhere in
    /// index_vault / meta_cache (the same string format `extract_meta_payloads`
    /// writes into `image_metadata.image_id`). `image_path` must be
    /// the original on-disk absolute path — the caller resolves it
    /// via `db.get_absolute_path(id)` because meta_cache itself
    /// doesn't have a back-reference to index_vault.
    ///
    /// `is_still_alive` is invoked AFTER `generate_thumbnail` returns
    /// (≈50-100ms of EXIF + histogram work) and BEFORE
    /// `write_batch_meta`. The caller supplies it so `meta_cache`
    /// stays decoupled from `index_vault::Db` — the implementation
    /// typically looks up `db.get_image_entry(id).is_deleted()`.
    /// Without this re-check, an image that the user deletes while
    /// backfill is mid-compute would have its `image_metadata` row
    /// resurrected immediately after `library_mark_deleted` clears
    /// it. The wasted compute is bounded by one image per delete
    /// race window.
    ///
    /// **Permissive**: any single-image failure (path missing / decode
    /// error / EXIF parse / histogram / write) is `warn!`-logged and
    /// swallowed with `Ok(())` so a surrounding loop continues. Meta
    /// is derived data; partial population is acceptable (it'll be
    /// retried on next launch / next switch).
    ///
    /// `folder_hash` is passed as `0` because `get_absolute_path`
    /// doesn't return it — we'd need a separate `list_all_images`
    /// round-trip to recover it. The persisted `image_metadata.folder_hash`
    /// column is currently unused by any read path, so this is a
    /// cosmetic inconsistency only. If a future feature starts
    /// reading it, swap this for a precomputed lookup map.
    pub async fn compute_and_write_one(
        &self,
        image_id: &str,
        image_path: PathBuf,
        is_still_alive: impl FnOnce() -> bool,
    ) -> Result<(), AppError> {
        let image_id_u128: u128 = match image_id.parse() {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(image_id, "meta_backfill: image_id parse failed: {e}");
                return Ok(());
            }
        };

        let work = index_vault::pipeline::PendingWork {
            path: image_path,
            image_id: image_id_u128,
            folder_hash: 0,
            mtime: 0,
        };

        let Some(result) = index_vault::image_processor::generate_thumbnail(&work) else {
            tracing::warn!(image_id, "meta_backfill: generate_thumbnail returned None");
            return Ok(());
        };

        let payloads = extract_meta_payloads(&[result]);
        if payloads.is_empty() {
            // ThumbProcessResult::Failed — decode/prepare errored.
            // Skip without retry (the next loop tick would face the
            // same file).
            return Ok(());
        }

        // Defense-in-depth re-check (Slice 3 P0 follow-up): the image
        // could have been deleted by `library_mark_deleted` while
        // `generate_thumbnail` was running. Without this, the write
        // below would resurrect a meta row that the user's delete
        // just cleared, leaving the UI showing histogram/EXIF for a
        // file that no longer exists in the library.
        if !is_still_alive() {
            tracing::debug!(
                image_id,
                "meta_backfill: skipped write — image deleted during compute"
            );
            return Ok(());
        }

        if let Err(e) = self.write_batch_meta(&payloads).await {
            tracing::warn!(image_id, "meta_backfill: write_batch_meta failed: {e}");
        }
        Ok(())
    }
}
