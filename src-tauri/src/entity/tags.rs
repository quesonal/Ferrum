//! Entity for the `tags` table — user-defined or AI-defined tag.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "tags")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub name: String,
    /// `"user"` or `"ai"`. Indexed together with `name` for the
    /// UNIQUE(name, source) constraint; case-insensitivity is
    /// enforced at the `meta_cache` layer, not in SQLite.
    pub source: String,
    pub confidence: Option<f64>,
    /// Reserved for future hierarchical tags. Currently always NULL.
    pub parent_id: Option<i32>,
    pub color: Option<String>,
    pub sort_order: i32,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
