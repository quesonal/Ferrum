//! Entity for the `image_tags` join table — many-to-many
//! `image_metadata × tags`. Composite PK (image_id, tag_id); FK CASCADE
//! from `tag_id` ensures `delete_tag` cleans up its links.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "image_tags")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub image_id: String,
    #[sea_orm(primary_key)]
    pub tag_id: i32,
    pub added_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
