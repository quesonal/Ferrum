//! Entity for the `image_metadata` table — per-image bookkeeping row.
//!
//! `has_exif` / `has_histogram` are stored even when the underlying
//! EXIF / histogram row does not exist, so the frontend can
//! distinguish "never parsed" from "parsed but empty" without a
//! second query.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "image_metadata")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub image_id: String,
    pub folder_hash: String,
    pub has_exif: i32,
    pub has_histogram: i32,
    pub source_mtime: i64,
    pub computed_at: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
