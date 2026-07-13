// ============================================================================
// IPC contract types — snake_case DTOs that mirror the Rust entities 1:1.
//
// IMPORTANT: Field names match the Rust `#[serde]` (de)serialized form.
// Do NOT add camelCase aliases here. The UI layer transforms DTO → UI types
// at the call site (see types/{config,tags,library}.ts for the UI variants).
//
// Source of truth for shape:
//   - src-tauri/src/commands.rs        (load_config_cmd, get_image_list, ...)
//   - src-tauri/src/library.rs         (library_* commands + FolderInfo etc.)
//   - src-tauri/src/config.rs          (AppConfig, MouseAction, AppTheme, ScanMode)
//   - src-tauri/src/formats.rs         (ImageSupport)
//   - src-tauri/src/meta_cache.rs      (ExifCacheRow, Tag)
//   - index_vault (path dep)           (FolderNode — camelCase by serde)
// ============================================================================

// ----- Enums (mirror Rust `#[serde(rename_all = "...")]`) -----

/** Mirrors `config::MouseAction` — `#[serde(rename_all = "snake_case")]`. */
export enum MouseAction {
  None = 'none',
  FullScreen = 'full_screen',
  Maximize = 'maximize',
  Minimize = 'minimize',
  Exit = 'exit',
  OpenFile = 'open_file',
  OpenFolder = 'open_folder',
  NextImage = 'next_image',
  PrevImage = 'prev_image',
  FirstImage = 'first_image',
  LastImage = 'last_image',
  Forward10 = 'forward_10',
  Backward10 = 'backward_10',
  ZoomIn = 'zoom_in',
  ZoomOut = 'zoom_out',
  Zoom = 'zoom',
  ShowExif = 'show_exif',
  FitWindow = 'fit_window',
}

/** Mirrors `config::AppTheme` — `#[serde(rename_all = "lowercase")]`. */
export enum AppTheme {
  Dark = 'dark',
  Light = 'light',
}

/** Mirrors `config::ScanMode` — `#[serde(rename_all = "snake_case")]`. */
export enum ScanMode {
  Auto = 'auto',
  Everything = 'everything',
  Mft = 'mft',
  WalkDir = 'walkdir',
}

/** Mirrors `meta_cache::TagSource` — stored as a literal string. */
export const TagSourceKind = {
  User: 'user',
  Ai: 'ai',
} as const;
export type TagSourceKind = (typeof TagSourceKind)[keyof typeof TagSourceKind];

// ----- commands.rs DTOs -----

/** Mirrors `commands::FileInfo`. `modified` is UNIX seconds; null when unavailable. */
export interface FileInfoDto {
  size: number;
  modified: number | null;
}

/** Mirrors `commands::ExifInfo` (8 fields returned by `get_exif_data`). */
export interface ExifInfoDto {
  camera: string | null;
  lens: string | null;
  iso: string | null;
  aperture: string | null;
  shutter: string | null;
  focal_length: string | null;
  equivalent_focal_length: string | null;
  date_taken: string | null;
}

/** Mirrors `formats::ImageSupport`. `all = native ∪ transcode ∪ raw`, sorted. */
export interface ImageSupportDto {
  native: string[];
  transcode: string[];
  raw: string[];
  all: string[];
}

/** Mirrors `config::AppConfig` (snake_case, 1:1 with `#[serde(rename_all = "snake_case")]`). */
export interface AppConfigDto {
  background_color: string;
  show_control_bar: boolean;
  show_histogram: boolean;
  theme: AppTheme;
  language: string;
  mouse_left: MouseAction;
  mouse_right: MouseAction;
  mouse_middle: MouseAction;
  mouse_xbutton1: MouseAction;
  mouse_xbutton2: MouseAction;
  mouse_wheel_up: MouseAction;
  mouse_wheel_down: MouseAction;
  scan_mode: ScanMode;
  scan_folders: string[];
  delete_confirm: boolean;
}

// ----- library.rs DTOs -----

/** Mirrors `library::FolderInfo`. */
export interface FolderInfoDto {
  id: string;
  name: string;
  path: string;
  image_count: number;
  cover_image_id: string | null;
}

/** Mirrors `library::ImageEntry`. */
export interface ImageEntryDto {
  id: string;
  filename: string;
  folder_path: string;
  width: number;
  height: number;
  timestamp: number;
  has_large: boolean;
}

/** Mirrors `library::FlatImageEntry`. */
export interface FlatImageEntryDto {
  id: string;
  filename: string;
  folder_path: string;
  folder_name: string;
  folder_hash: string;
  width: number;
  height: number;
  timestamp: number;
  has_large: boolean;
}

/** Mirrors `library::ThumbnailData`. `data` is `Vec<u8>` serialized as `number[]`. */
export interface ThumbnailDataDto {
  id: string;
  data: number[];
  width: number;
  height: number;
}

/** Mirrors `library::ScanRequest` — inbound only. */
export interface ScanRequestDto {
  folder_path: string;
  recursive: boolean;
  scan_mode: string;
}

/** Mirrors `library::LibraryStats`. */
export interface LibraryStatsDto {
  total_images: number;
  valid_images: number;
  deleted_images: number;
  folder_count: number;
}

// ----- meta_cache.rs DTOs -----

/** Mirrors `meta_cache::ExifCacheRow` (8 UI fields + `source_mtime`). */
export interface ExifCacheRowDto {
  camera: string | null;
  lens: string | null;
  iso: string | null;
  aperture: string | null;
  shutter: string | null;
  focal_length: string | null;
  equivalent_focal_length: string | null;
  date_taken: string | null;
  source_mtime: number;
}

/** Mirrors `meta_cache::Tag`. `image_count == -1` is the "single-image" sentinel
 *  returned by `library_get_image_tags` (where the count would be misleading);
 *  `library_list_tags` always returns `>= 0` (aggregated via GROUP BY). */
export interface TagDto {
  id: number;
  name: string;
  source: string;
  confidence: number | null;
  parent_id: number | null;
  color: string | null;
  sort_order: number;
  created_at: number;
  image_count: number;
}

// ----- index_vault::FolderNode (camelCase, NOT snake_case) -----

/** Mirrors `index_vault::storage::folder_node::FolderNode`. The index_vault
 *  crate uses `#[serde(rename_all = "camelCase")]` for this type, so the
 *  on-the-wire shape is camelCase (unlike the rest of the IPC contract). */
export interface FolderNodeDto {
  folderHash: string | null;
  path: string;
  name: string;
  imageCount: number;
  totalImageCount: number;
  children: FolderNodeDto[];
}

// ----- Error shape -----

/** Tauri serializes `AppError` as a string. The frontend should treat this
 *  as opaque — error handling is best-effort, not type-driven. */
export type IpcError = string;
