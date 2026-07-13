//! Entity for the `exif_cache` table — parsed EXIF fields, flat
//! `Option<String>` layout matching the UI's `ExifData` shape.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "exif_cache")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub image_id: String,
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

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
