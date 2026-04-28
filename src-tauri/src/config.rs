use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MouseAction {
    None,
    FullScreen,
    Maximize,
    Minimize,
    Exit,
    OpenFile,
    OpenFolder,
    NextImage,
    PrevImage,
    FirstImage,
    LastImage,
    Forward10,
    Backward10,
    ZoomIn,
    ZoomOut,
    ShowExif,
    FitWindow,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AppTheme {
    Dark,
    Light,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FitMode {
    Contain,
    Original,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScanMode {
    /// Auto-select best available method
    #[default]
    Auto,
    /// Use VoidTools Everything search engine
    Everything,
    /// Use NTFS MFT scanning
    Mft,
    /// Use standard filesystem walkdir
    WalkDir,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub background_color: String,
    pub default_fit_mode: FitMode,
    pub show_control_bar: bool,
    pub theme: AppTheme,
    pub mouse_left: MouseAction,
    pub mouse_right: MouseAction,
    pub mouse_middle: MouseAction,
    pub mouse_xbutton1: MouseAction,
    pub mouse_xbutton2: MouseAction,
    pub mouse_wheel_up: MouseAction,
    pub mouse_wheel_down: MouseAction,
    pub scan_mode: ScanMode,
    /// 扫描文件夹列表，用于快速访问多个目录
    #[serde(default)]
    pub scan_folders: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            background_color: "#ffffff".to_string(),
            default_fit_mode: FitMode::Contain,
            show_control_bar: true,
            theme: AppTheme::Light,
            mouse_left: MouseAction::None,
            mouse_right: MouseAction::None,
            mouse_middle: MouseAction::FullScreen,
            mouse_xbutton1: MouseAction::PrevImage,
            mouse_xbutton2: MouseAction::NextImage,
            mouse_wheel_up: MouseAction::ZoomIn,
            mouse_wheel_down: MouseAction::ZoomOut,
            scan_mode: ScanMode::Auto,
            scan_folders: Vec::new(),
        }
    }
}

fn get_config_path<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Tauri(e.to_string()))?;

    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)?;
    }
    Ok(config_dir.join("config.toml"))
}

pub fn load_config<R: Runtime>(app: &AppHandle<R>) -> AppConfig {
    let path = match get_config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };

    if !path.exists() {
        return AppConfig::default();
    }

    match fs::read_to_string(path) {
        Ok(content) => match toml::from_str::<AppConfig>(&content) {
            Ok(config) => config,
            Err(e) => {
                eprintln!("[Config] Failed to parse config.toml: {}, using defaults", e);
                AppConfig::default()
            }
        },
        Err(e) => {
            eprintln!("[Config] Failed to read config file: {}, using defaults", e);
            AppConfig::default()
        }
    }
}

pub fn save_config<R: Runtime>(app: &AppHandle<R>, config: &AppConfig) -> AppResult<()> {
    let path = get_config_path(app)?;
    let content = toml::to_string(config)?;
    fs::write(path, content)?;
    Ok(())
}
