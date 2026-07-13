//! Database migrations for the `meta_cache.sqlite` file.
//!
//! Creates the five tables backing the EXIF/histogram/tag caches. Run once
//! at app startup via `meta_cache::MetaCache::init`. The `seaql_migrations`
//! bookkeeping table is owned by `sea-orm-migration` and is created on
//! demand by `MigratorTrait::install` before any user migration runs, so we
//! don't need to declare it ourselves.
//!
//! PRAGMA tuning (WAL, `synchronous=NORMAL`, foreign keys, mmap, …) lives
//! in `meta_cache::MetaCache::init` rather than here — `SchemaManager`
//! has no first-class PRAGMA hooks and we'd rather keep the tuning in
//! one place next to the connection string.

use sea_orm_migration::{prelude::*, schema::*};

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Folder grouping + per-image metadata cache.
///
/// One row per image_id we've ever seen. `has_exif` / `has_histogram`
/// let `library_read_exif` / `library_read_histogram` distinguish
/// "parsed but empty" from "never parsed" without a second query.
#[derive(Iden)]
pub enum ImageMetadata {
    Table,
    ImageId,
    FolderHash,
    HasExif,
    HasHistogram,
    SourceMtime,
    ComputedAt,
    Width,
    Height,
}

/// Cached downscaled-300px RGB histogram. 3 × 256 u32 bins = 3072 B
/// raw + 16 B header = 3088 B on the wire (see `library_read_histogram`).
#[derive(Iden)]
pub enum HistogramCache {
    Table,
    ImageId,
    RData,
    GData,
    BData,
    Width,
    Height,
    SourceMtime,
}

/// Parsed EXIF metadata, flat 8-string UI view. `Option<String>` maps
/// to nullable columns because any tag may be absent or unparseable.
#[derive(Iden)]
pub enum ExifCache {
    Table,
    ImageId,
    Camera,
    Lens,
    Iso,
    Aperture,
    Shutter,
    FocalLength,
    EquivalentFocalLength,
    DateTaken,
    SourceMtime,
}

/// User- or AI-defined tag. `parent_id` is reserved for future
/// hierarchical tags; today every tag is flat.
#[derive(Iden)]
pub enum Tags {
    Table,
    Id,
    Name,
    Source,
    Confidence,
    ParentId,
    Color,
    SortOrder,
    CreatedAt,
}

/// Many-to-many join table between images and tags. FK CASCADE ensures
/// `delete_tag` cleans up its image-links automatically.
#[derive(Iden)]
pub enum ImageTags {
    Table,
    ImageId,
    TagId,
    AddedAt,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // ---- image_metadata ----
        manager
            .create_table(
                Table::create()
                    .table(ImageMetadata::Table)
                    .if_not_exists()
                    .col(string(ImageMetadata::ImageId).primary_key())
                    .col(string(ImageMetadata::FolderHash))
                    .col(
                        ColumnDef::new(ImageMetadata::HasExif)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(ImageMetadata::HasHistogram)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(ImageMetadata::SourceMtime)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ImageMetadata::ComputedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(ImageMetadata::Width).integer().null())
                    .col(ColumnDef::new(ImageMetadata::Height).integer().null())
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx-image_meta-folder")
                    .table(ImageMetadata::Table)
                    .col(ImageMetadata::FolderHash)
                    .to_owned(),
            )
            .await?;

        // ---- histogram_cache ----
        manager
            .create_table(
                Table::create()
                    .table(HistogramCache::Table)
                    .if_not_exists()
                    .col(string(HistogramCache::ImageId).primary_key())
                    .col(ColumnDef::new(HistogramCache::RData).binary().not_null())
                    .col(ColumnDef::new(HistogramCache::GData).binary().not_null())
                    .col(ColumnDef::new(HistogramCache::BData).binary().not_null())
                    .col(
                        ColumnDef::new(HistogramCache::Width)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(HistogramCache::Height)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(HistogramCache::SourceMtime)
                            .big_integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // ---- exif_cache ----
        manager
            .create_table(
                Table::create()
                    .table(ExifCache::Table)
                    .if_not_exists()
                    .col(string(ExifCache::ImageId).primary_key())
                    .col(ColumnDef::new(ExifCache::Camera).string().null())
                    .col(ColumnDef::new(ExifCache::Lens).string().null())
                    .col(ColumnDef::new(ExifCache::Iso).string().null())
                    .col(ColumnDef::new(ExifCache::Aperture).string().null())
                    .col(ColumnDef::new(ExifCache::Shutter).string().null())
                    .col(ColumnDef::new(ExifCache::FocalLength).string().null())
                    .col(
                        ColumnDef::new(ExifCache::EquivalentFocalLength)
                            .string()
                            .null(),
                    )
                    .col(ColumnDef::new(ExifCache::DateTaken).string().null())
                    .col(
                        ColumnDef::new(ExifCache::SourceMtime)
                            .big_integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // ---- tags ----
        manager
            .create_table(
                Table::create()
                    .table(Tags::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Tags::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(string(Tags::Name))
                    .col(string(Tags::Source))
                    .col(ColumnDef::new(Tags::Confidence).double().null())
                    .col(ColumnDef::new(Tags::ParentId).integer().null())
                    .col(ColumnDef::new(Tags::Color).string().null())
                    .col(
                        ColumnDef::new(Tags::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(Tags::CreatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        // UNIQUE(name, source). sea-orm-migration's schema helpers don't
        // expose COLLATE NOCASE — case-insensitivity is enforced at the
        // Rust layer (`create_tag` reads-then-writes inside a tx).
        manager
            .create_index(
                Index::create()
                    .name("idx-tags-name-source")
                    .table(Tags::Table)
                    .col(Tags::Name)
                    .col(Tags::Source)
                    .unique()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx-tags-parent")
                    .table(Tags::Table)
                    .col(Tags::ParentId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx-tags-sort")
                    .table(Tags::Table)
                    .col(Tags::SortOrder)
                    .to_owned(),
            )
            .await?;

        // ---- image_tags ----
        manager
            .create_table(
                Table::create()
                    .table(ImageTags::Table)
                    .if_not_exists()
                    .col(string(ImageTags::ImageId))
                    .col(integer(ImageTags::TagId))
                    .col(
                        ColumnDef::new(ImageTags::AddedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .primary_key(
                        Index::create()
                            .name("pk-image_tags")
                            .col(ImageTags::ImageId)
                            .col(ImageTags::TagId),
                    )
                    // FK declared inline so SQLite generates the
                    // constraint as part of CREATE TABLE. Calling
                    // `create_foreign_key` separately triggers an
                    // ALTER TABLE ADD CONSTRAINT, which SQLite does
                    // not support (sea-query panics in that mode).
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk-image_tags-tag")
                            .from(ImageTags::Table, ImageTags::TagId)
                            .to(Tags::Table, Tags::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx-image_tags-tag")
                    .table(ImageTags::Table)
                    .col(ImageTags::TagId)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Drop order respects FK dependencies: image_tags → tags first.
        manager
            .drop_table(Table::drop().table(ImageTags::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(Tags::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(ExifCache::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(HistogramCache::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(ImageMetadata::Table).to_owned())
            .await?;
        Ok(())
    }
}

/// Top-level migrator aggregating every individual `Migration`.
///
/// `MetaCache::init` calls `Migrator::up(&db, None).await` to apply all
/// pending migrations in filename order.
pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(Migration {})]
    }
}
