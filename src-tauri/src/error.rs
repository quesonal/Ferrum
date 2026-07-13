use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("IO Error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Config Error: {0}")]
    Config(#[from] toml::ser::Error),

    #[error("JSON Error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Path Error: {0}")]
    Path(String),

    #[error("Path not found: {0}")]
    PathNotFound(String),

    #[error("Tauri Error: {0}")]
    Tauri(String),

    #[error("Library Error: {0}")]
    LibraryError(String),

    #[error("Library not initialized")]
    LibraryNotInitialized,

    #[error("Library is busy scanning")]
    LibraryBusy,

    #[error("Lock poisoned")]
    LockPoisoned,

    #[error("Invalid parameter: {0}")]
    InvalidParameter(String),

    #[error("Operation failed: {0}")]
    Anyhow(#[from] anyhow::Error),

    #[error("Database error: {0}")]
    Sqlx(#[from] sea_orm::DbErr),

    #[error("Migration error: {0}")]
    Migration(String),

    #[error("Not initialized: {0}")]
    NotInitialized(&'static str),

    #[error("Already initialized: {0}")]
    AlreadyInitialized(&'static str),
}

// 实现 Serialize 以便将错误返回给前端
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

// 这是一个别名，方便 Result 返回
pub type AppResult<T> = Result<T, AppError>;
