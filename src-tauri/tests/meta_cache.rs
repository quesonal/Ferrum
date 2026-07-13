//! Integration tests for `meta_cache` (Plan A — Slice 4 PR-B).
//!
//! Each test spins up a fresh SQLite file inside a `tempfile::TempDir`
//! so PRAGMAs (FK on, WAL, NORMAL sync) and the migration set get
//! exercised against the production code path (`MetaCache::open_at`).
//!
//! What's covered:
//! - Schema bootstrap (5 tables + `seaql_migrations`) + idempotent re-open
//! - `write_batch_meta` insert / upsert / empty-noop
//! - `read_histogram` / `read_exif` hit & miss
//! - Tag CRUD: list, create, case-insensitive UNIQUE conflict,
//!   rename, delete with FK CASCADE
//! - `set_image_tags` atomic replace semantics
//! - `mark_images_deleted` multi-table cleanup
//! - `compute_and_write_one` plus the `is_still_alive` re-check
//!
//! The PNG fixture is a 1×1 RGB pixel — minimal enough that
//! `generate_thumbnail` runs in low single-digit milliseconds; its
//! only job is to take the success path past `image::load`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ferrum_lib::error::AppError;
use ferrum_lib::meta_cache::{ExifCacheRow, MetaCache, MetaPayload, TagSource};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};

// ---------- helpers ----------

// Per-test DB root lives under `<repo>/src-tauri/target/test_meta_cache/`
// rather than the system Temp dir. `tempfile::TempDir` returns a path
// like `C:\...\Temp\.tmpXXXX\` and that `.tmp` prefix combined with
// `SQLITE_OPEN_CREATE` produces a transient `unable to open database
// file` on the sqlx used here — the production path
// (`<app_data>/thumbs_db/`) doesn't have that prefix, so it works.
// Using the target dir sidesteps the path-prefix quirk without
// touching the production code path.
fn test_root() -> PathBuf {
    static INIT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    INIT.get_or_init(|| {
        let target = std::env::var("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target")
            });
        let dir = target.join("test_meta_cache");
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
    .clone()
}

static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Spin up a fresh `meta_cache.sqlite` under `<target>/test_meta_cache/`.
/// We hand out the `PathBuf` (not a `TempDir`) so the file outlives
/// each test, and assign a unique file name so parallel tests don't
/// collide on SQLite's per-DB lock.
async fn fresh_cache() -> (PathBuf, Arc<MetaCache>) {
    let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let path = test_root().join(format!("test_{pid}_{n}.sqlite"));
    let cache = MetaCache::open_at(&path)
        .await
        .expect("open_at should succeed on a fresh path");
    (path, cache)
}

/// Write a 1×1 RGB PNG at `dir/name.png`. Used as the input file for
/// `compute_and_write_one`.
fn png_fixture(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let img = image::RgbImage::from_pixel(1, 1, image::Rgb([128, 64, 32]));
    img.save(&path).expect("1x1 PNG write");
    path
}

fn exif(camera: &str) -> index_vault::pipeline::ExifFields {
    index_vault::pipeline::ExifFields {
        camera: Some(camera.to_string()),
        lens: None,
        iso: None,
        aperture: None,
        shutter: None,
        focal_length: None,
        equivalent_focal_length: None,
        date_taken: None,
        gps: None,
    }
}

/// Build a histogram with a known pixel in bin #42 of every channel.
fn histogram() -> index_vault::pipeline::HistogramBins {
    let mut h = index_vault::pipeline::HistogramBins {
        r: vec![0u32; 256],
        g: vec![0u32; 256],
        b: vec![0u32; 256],
    };
    h.r[42] = 1;
    h.g[42] = 1;
    h.b[42] = 1;
    h
}

fn payload(id: &str, exif: Option<index_vault::pipeline::ExifFields>) -> MetaPayload {
    MetaPayload {
        image_id: id.to_string(),
        folder_hash: "1".to_string(),
        timestamp: 1_700_000_000,
        orig_width: 1920,
        orig_height: 1080,
        exif,
        histogram: Some(histogram()),
    }
}

/// Direct SQL helper for assertions that go through the count of
/// rows in a table (rather than through a public method).
async fn table_count(cache: &MetaCache, table: &str) -> i64 {
    let row = cache
        .db()
        .query_one(Statement::from_string(
            DatabaseBackend::Sqlite,
            format!("SELECT COUNT(*) AS c FROM {table}"),
        ))
        .await
        .expect("count query")
        .expect("count returns a row");
    row.try_get::<i64>("", "c").expect("alias read")
}

// ============================================================
// schema / init
// ============================================================

#[tokio::test]
async fn test_init_creates_schema() {
    let (_dir, cache) = fresh_cache().await;
    let db = cache.db();

    // All 5 user tables must exist.
    for table in [
        "image_metadata",
        "histogram_cache",
        "exif_cache",
        "tags",
        "image_tags",
    ] {
        let row = db
            .query_one(Statement::from_string(
                DatabaseBackend::Sqlite,
                format!(
                    "SELECT COUNT(*) AS c FROM sqlite_master \
                     WHERE type='table' AND name='{table}'"
                ),
            ))
            .await
            .expect("query_one")
            .expect("row");
        let c: i64 = row.try_get::<i64>("", "c").expect("alias");
        assert_eq!(c, 1, "expected table {table} to exist");
    }

    // The migration bookkeeping table is created by sea-orm-migration.
    let migrations = db
        .query_one(Statement::from_string(
            DatabaseBackend::Sqlite,
            "SELECT COUNT(*) AS c FROM seaql_migrations",
        ))
        .await
        .expect("query_one")
        .expect("row");
    let n: i64 = migrations.try_get::<i64>("", "c").expect("alias");
    assert_eq!(n, 1, "exactly one migration row expected");
}

#[tokio::test]
async fn test_init_is_idempotent() {
    let path = test_root().join(format!(
        "idempotent_{}_{}.sqlite",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    // First open creates + migrates.
    let _ = MetaCache::open_at(&path).await.expect("first open");

    // Second open on the same path must not raise (sea-orm-migration
    // skips already-applied migrations).
    let cache2 = MetaCache::open_at(&path).await.expect("second open");
    let n: i64 = cache2
        .db()
        .query_one(Statement::from_string(
            DatabaseBackend::Sqlite,
            "SELECT COUNT(*) AS c FROM seaql_migrations",
        ))
        .await
        .expect("query_one")
        .expect("row")
        .try_get::<i64>("", "c")
        .expect("alias");
    assert_eq!(n, 1, "second open must not re-apply migrations");
}

// ============================================================
// write_batch_meta
// ============================================================

#[tokio::test]
async fn test_write_batch_meta_inserts_all_rows() {
    let (_dir, cache) = fresh_cache().await;

    let n = cache
        .write_batch_meta(&[payload("42", Some(exif("Canon")))])
        .await
        .expect("write");
    assert_eq!(n, 1, "one image_metadata row touched");

    assert_eq!(table_count(&cache, "image_metadata").await, 1);
    assert_eq!(table_count(&cache, "exif_cache").await, 1);
    assert_eq!(table_count(&cache, "histogram_cache").await, 1);
}

#[tokio::test]
async fn test_write_batch_meta_upsert_replaces_exif() {
    let (_dir, cache) = fresh_cache().await;

    cache
        .write_batch_meta(&[payload("42", Some(exif("Canon")))])
        .await
        .expect("first write");

    // Second payload with a different camera for the same id.
    cache
        .write_batch_meta(&[payload("42", Some(exif("Nikon")))])
        .await
        .expect("second write");

    assert_eq!(table_count(&cache, "image_metadata").await, 1);
    assert_eq!(table_count(&cache, "exif_cache").await, 1);
    assert_eq!(table_count(&cache, "histogram_cache").await, 1);

    // The exif row carries the latest camera value.
    let row = cache
        .db()
        .query_one(Statement::from_string(
            DatabaseBackend::Sqlite,
            "SELECT camera AS c FROM exif_cache WHERE image_id='42'",
        ))
        .await
        .expect("query_one")
        .expect("row");
    let camera: String = row.try_get::<String>("", "c").expect("alias");
    assert_eq!(camera, "Nikon");
}

#[tokio::test]
async fn test_write_batch_meta_empty_is_noop() {
    let (_dir, cache) = fresh_cache().await;
    let n = cache.write_batch_meta(&[]).await.expect("empty write");
    assert_eq!(n, 0);
    assert_eq!(table_count(&cache, "image_metadata").await, 0);
}

// ============================================================
// read_histogram / read_exif
// ============================================================

#[tokio::test]
async fn test_read_histogram_and_exif_hit_and_miss() {
    let (_dir, cache) = fresh_cache().await;
    cache
        .write_batch_meta(&[payload("42", Some(exif("Sony")))])
        .await
        .expect("write");

    let hit = cache.read_histogram("42").await.expect("read").expect("hit");
    assert_eq!(hit.0, 1920, "width");
    assert_eq!(hit.1, 1080, "height");
    assert_eq!(hit.2.len(), 1024, "r bins = 256 * u32 LE = 1024B");

    let miss = cache
        .read_histogram("999")
        .await
        .expect("read miss returns None");
    assert!(miss.is_none(), "miss returns None");

    let exif: ExifCacheRow = cache
        .read_exif("42")
        .await
        .expect("read")
        .expect("exif hit");
    assert_eq!(exif.camera.as_deref(), Some("Sony"));

    assert!(cache.read_exif("999").await.expect("read").is_none());
}

// ============================================================
// tag CRUD
// ============================================================

#[tokio::test]
async fn test_create_tag_and_list() {
    let (_dir, cache) = fresh_cache().await;

    let travel = cache
        .create_tag("Travel", TagSource::User, None, None, None)
        .await
        .expect("create Travel");
    let food = cache
        .create_tag("Food", TagSource::User, None, None, None)
        .await
        .expect("create Food");
    let auto = cache
        .create_tag("auto", TagSource::Ai, None, None, None)
        .await
        .expect("create ai-tag");

    let all = cache.list_tags(None).await.expect("list all");
    assert_eq!(all.len(), 3);
    let user_only = cache.list_tags(Some(TagSource::User)).await.expect("list user");
    assert_eq!(user_only.len(), 2);
    assert_eq!(user_only[0].id, travel); // (sort_order ASC, id ASC)
    assert_eq!(user_only[1].id, food);
    assert_eq!(all.iter().find(|t| t.id == auto).map(|t| t.source.as_str()), Some("ai"));
}

#[tokio::test]
async fn test_create_tag_duplicate_case_insensitive() {
    let (_dir, cache) = fresh_cache().await;
    cache
        .create_tag("Travel", TagSource::User, None, None, None)
        .await
        .expect("first create");

    // EqIgnoreAsciiCase semantics in `create_tag` should fire on
    // "TRAVEL" even though the DB UNIQUE index is binary.
    let err = cache
        .create_tag("TRAVEL", TagSource::User, None, None, None)
        .await
        .expect_err("duplicate must fail");
    match err {
        AppError::Sqlx(_) => {}
        other => panic!("expected AppError::Sqlx, got {other:?}"),
    }

    // And only one row in the tags table.
    assert_eq!(table_count(&cache, "tags").await, 1);
}

#[tokio::test]
async fn test_rename_then_delete_with_cascade() {
    let (_dir, cache) = fresh_cache().await;

    let travel = cache
        .create_tag("Travel", TagSource::User, None, None, None)
        .await
        .expect("create");
    cache
        .set_image_tags("img1", &[travel])
        .await
        .expect("link img1");
    cache
        .set_image_tags("img2", &[travel])
        .await
        .expect("link img2");
    assert_eq!(table_count(&cache, "image_tags").await, 2);

    cache.rename_tag(travel, "Trips").await.expect("rename");
    let all = cache.list_tags(None).await.expect("list");
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name, "Trips");

    cache.delete_tag(travel).await.expect("delete");

    // Tag row gone, image_tags links cascade-cleaned.
    assert_eq!(table_count(&cache, "tags").await, 0);
    assert_eq!(table_count(&cache, "image_tags").await, 0);
}

// ============================================================
// set_image_tags atomicity
// ============================================================

#[tokio::test]
async fn test_set_image_tags_replaces_atomically() {
    let (_dir, cache) = fresh_cache().await;

    let a = cache.create_tag("A", TagSource::User, None, None, None).await.unwrap();
    let b = cache.create_tag("B", TagSource::User, None, None, None).await.unwrap();
    let c = cache.create_tag("C", TagSource::User, None, None, None).await.unwrap();

    cache.set_image_tags("img1", &[a, b]).await.expect("set [a,b]");
    let got = cache.get_image_tags("img1").await.expect("get");
    assert_eq!(got.iter().map(|t| t.id).collect::<Vec<_>>(), vec![a, b]);

    // Replace — the [a, b] rows must be removed first, only [c] inserted.
    cache.set_image_tags("img1", &[c]).await.expect("set [c]");
    let got = cache.get_image_tags("img1").await.expect("get after replace");
    assert_eq!(got.iter().map(|t| t.id).collect::<Vec<_>>(), vec![c]);

    // And [a, b] rows still exist in tags table — only image_tags
    // junction rows were touched.
    assert_eq!(table_count(&cache, "image_tags").await, 1);

    // Empty array = clear.
    cache.set_image_tags("img1", &[]).await.expect("clear");
    assert!(cache.get_image_tags("img1").await.expect("get").is_empty());
    assert_eq!(table_count(&cache, "image_tags").await, 0);
}

// ============================================================
// mark_images_deleted
// ============================================================

#[tokio::test]
async fn test_mark_images_deleted_clears_four_tables() {
    let (_dir, cache) = fresh_cache().await;

    let travel = cache.create_tag("Travel", TagSource::User, None, None, None).await.unwrap();

    // Three target images get full meta + tag links; the control
    // image is unrelated and must survive untouched. Use digit-string
    // image_ids because `mark_images_deleted` accepts `Vec<u128>`,
    // matching the convention used elsewhere in this file (the test
    // for `library_mark_deleted` would pass real numeric ids from
    // index_vault).
    for id in ["100", "200", "300"] {
        cache
            .write_batch_meta(&[payload(id, Some(exif("Cam")))])
            .await
            .expect("write");
        cache
            .set_image_tags(id, &[travel])
            .await
            .expect("link");
    }
    cache
        .write_batch_meta(&[payload("control", Some(exif("Cam")))])
        .await
        .expect("write control");
    cache
        .set_image_tags("control", &[travel])
        .await
        .expect("link control");

    let target_ids: Vec<u128> = ["100", "200", "300"]
        .into_iter()
        .map(|s| s.parse().expect("u128 parse"))
        .collect();
    cache
        .mark_images_deleted(&target_ids)
        .await
        .expect("mark_images_deleted");

    assert_eq!(table_count(&cache, "image_metadata").await, 1);
    assert_eq!(table_count(&cache, "histogram_cache").await, 1);
    assert_eq!(table_count(&cache, "exif_cache").await, 1);
    assert_eq!(table_count(&cache, "image_tags").await, 1);

    // Tag vocabulary survives (untouched, only image-links of the
    // deleted images cascade).
    assert_eq!(table_count(&cache, "tags").await, 1);
}

// ============================================================
// compute_and_write_one + is_still_alive guard
// ============================================================

#[tokio::test]
async fn test_compute_and_write_one_with_alive_guard() {
    let (db_path, cache) = fresh_cache().await;
    // Put the PNG alongside the DB file; we don't actually need it
    // under a tempdir since open_at owns its own location.
    let img_dir = db_path.parent().expect("db has parent").to_path_buf();
    let img_path = png_fixture(&img_dir, "tiny.png");

    // --- alive = true: image_id is decoded and persisted ---
    cache
        .compute_and_write_one("9001", img_path.clone(), || true)
        .await
        .expect("compute alive");

    let hit = cache
        .read_histogram("9001")
        .await
        .expect("read")
        .expect("hit");
    assert_eq!(hit.0, 1, "1x1 fixture width");
    assert_eq!(hit.1, 1, "1x1 fixture height");
    assert_eq!(hit.2.len(), 1024);

    // --- alive = false: write must be skipped (Defense A) ---
    // Wipe the row to a fresh id so the previous successful write
    // doesn't bias the assertion below.
    cache
        .compute_and_write_one("9002", img_path.clone(), || false)
        .await
        .expect("compute dead");

    assert!(
        cache.read_histogram("9002").await.expect("read").is_none(),
        "is_still_alive=false must skip write_batch_meta"
    );
}
