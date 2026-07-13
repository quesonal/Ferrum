//! Entity for the `histogram_cache` table — downscaled RGB histogram.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "histogram_cache")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub image_id: String,
    /// 256 little-endian u32 bins for the red channel (1024 bytes).
    pub r_data: Vec<u8>,
    /// 256 little-endian u32 bins for the green channel (1024 bytes).
    pub g_data: Vec<u8>,
    /// 256 little-endian u32 bins for the blue channel (1024 bytes).
    pub b_data: Vec<u8>,
    pub width: i32,
    pub height: i32,
    pub source_mtime: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
