// ============================================================================
// Typed Tauri invoke wrappers — the ONLY place in the codebase that calls
// `invoke` directly. Every IPC command in `src-tauri/src/{commands,library}.rs`
// has exactly one async function here. Each function's args + return types
// are pinned to the DTOs in `types/ipc.ts`.
//
// Conventions:
//   - Command name in source matches the Rust `#[tauri::command]` name exactly.
//   - Argument object keys are camelCase (Tauri's serializer converts to the
//     Rust `snake_case` parameter name automatically).
//   - Return type is the Rust return type. `Option<T>` → `T | null`.
//   - Binary protocol commands (preview / histogram) return `ArrayBuffer`.
// ============================================================================

import { invoke } from '@tauri-apps/api/core';
import type {
  AppConfigDto,
  ExifCacheRowDto,
  ExifInfoDto,
  FileInfoDto,
  FolderInfoDto,
  FolderNodeDto,
  ImageEntryDto,
  FlatImageEntryDto,
  ImageSupportDto,
  LibraryStatsDto,
  ScanRequestDto,
  TagDto,
} from '../types/ipc';

// ----------------------------------------------------------------------------
// App / config
// ----------------------------------------------------------------------------

export function loadConfig(): Promise<AppConfigDto> {
  return invoke<AppConfigDto>('load_config_cmd');
}

export function saveConfig(config: AppConfigDto): Promise<void> {
  return invoke<void>('save_config_cmd', { config });
}

export function getSupportedFormats(): Promise<ImageSupportDto> {
  return invoke<ImageSupportDto>('get_supported_formats');
}

export function isWin11(): Promise<boolean> {
  return invoke<boolean>('is_win11');
}

// ----------------------------------------------------------------------------
// Window / app shell
// ----------------------------------------------------------------------------

export function showMainWindow(): Promise<void> {
  return invoke<void>('show_main_window');
}

export function toggleFullscreen(): Promise<boolean> {
  return invoke<boolean>('toggle_fullscreen');
}

// ----------------------------------------------------------------------------
// Filesystem mode
// ----------------------------------------------------------------------------

export function getImageList(path: string): Promise<string[]> {
  return invoke<string[]>('get_image_list', { path });
}

export function getPendingFile(): Promise<string | null> {
  return invoke<string | null>('get_pending_file');
}

export function getFileInfo(path: string): Promise<FileInfoDto> {
  return invoke<FileInfoDto>('get_file_info', { path });
}

export function getExifData(path: string): Promise<ExifInfoDto> {
  return invoke<ExifInfoDto>('get_exif_data', { path });
}

export function checkAssetAccessible(path: string): Promise<boolean> {
  return invoke<boolean>('check_asset_accessible', { path });
}

export function deleteFile(path: string, permanent: boolean): Promise<void> {
  return invoke<void>('delete_file', { path, permanent });
}

// ----------------------------------------------------------------------------
// Library — folders & tree
// ----------------------------------------------------------------------------

export function libraryGetFolders(): Promise<FolderInfoDto[]> {
  return invoke<FolderInfoDto[]>('library_get_folders');
}

export function libraryGetFolderTree(): Promise<FolderNodeDto[]> {
  return invoke<FolderNodeDto[]>('library_get_folder_tree');
}

export function libraryScanFolder(request: ScanRequestDto): Promise<number> {
  return invoke<number>('library_scan_folder', { request });
}

export function libraryRemoveSource(path: string): Promise<number> {
  return invoke<number>('library_remove_source', { path });
}

// ----------------------------------------------------------------------------
// Library — images
// ----------------------------------------------------------------------------

export function libraryGetImages(
  folderHash: string,
  offset: number,
  limit: number,
): Promise<ImageEntryDto[]> {
  return invoke<ImageEntryDto[]>('library_get_images', {
    folderHash,
    offset,
    limit,
  });
}

export function libraryGetAllImages(
  offset: number,
  limit: number,
): Promise<FlatImageEntryDto[]> {
  return invoke<FlatImageEntryDto[]>('library_get_all_images', {
    offset,
    limit,
  });
}

export function libraryGetTotalImageCount(): Promise<number> {
  return invoke<number>('library_get_total_image_count');
}

export function libraryGetStats(): Promise<LibraryStatsDto> {
  return invoke<LibraryStatsDto>('library_get_stats');
}

export function libraryCompact(): Promise<string> {
  return invoke<string>('library_compact');
}

export function libraryMarkDeleted(imageId: string): Promise<boolean> {
  return invoke<boolean>('library_mark_deleted', { imageId });
}

export function libraryGetImagePath(imageId: string): Promise<string | null> {
  return invoke<string | null>('library_get_image_path', { imageId });
}

export function libraryGetImagesByIds(
  imageIds: string[],
): Promise<ImageEntryDto[]> {
  return invoke<ImageEntryDto[]>('library_get_images_by_ids', { imageIds });
}

// ----------------------------------------------------------------------------
// Library — preview / histogram / EXIF (binary + DTO reads)
// ----------------------------------------------------------------------------

/** Single thumbnail, raw `Vec<u8>` as `number[]`. */
export function libraryReadThumbnail(imageId: string): Promise<number[] | null> {
  return invoke<number[] | null>('library_read_thumbnail', { imageId });
}

/** Batch thumbnail read. Returns `imageId → Vec<u8>` map. */
export function libraryReadThumbnailsBatch(
  imageIds: string[],
): Promise<Record<string, number[]>> {
  return invoke<Record<string, number[]>>('library_read_thumbnails_batch', {
    imageIds,
  });
}

/** Preview as `ArrayBuffer`. Wire format: `[u32 LE width][u32 LE height][webp bytes]`.
 *  `width == 0` is the not-found sentinel. */
export function libraryReadPreview(imageId: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('library_read_preview', { imageId });
}

/** Histogram as `ArrayBuffer`. Wire format: `[u32 LE width][u32 LE height][r 1024B][g 1024B][b 1024B]`.
 *  `width == 0` is the not-found sentinel. */
export function libraryReadHistogram(imageId: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('library_read_histogram', { imageId });
}

/** Cached EXIF row (8 fields + source_mtime), or `null` on miss. */
export function libraryReadExif(imageId: string): Promise<ExifCacheRowDto | null> {
  return invoke<ExifCacheRowDto | null>('library_read_exif', { imageId });
}

// ----------------------------------------------------------------------------
// Library — tags
// ----------------------------------------------------------------------------

export function libraryListTags(source?: string): Promise<TagDto[]> {
  return invoke<TagDto[]>('library_list_tags', { source });
}

export function libraryCreateTag(
  name: string,
  source: string,
  confidence?: number | null,
  parentId?: number | null,
  color?: string | null,
): Promise<number> {
  return invoke<number>('library_create_tag', {
    name,
    source,
    confidence: confidence ?? null,
    parentId: parentId ?? null,
    color: color ?? null,
  });
}

export function libraryRenameTag(id: number, name: string): Promise<void> {
  return invoke<void>('library_rename_tag', { id, name });
}

export function libraryDeleteTag(id: number): Promise<void> {
  return invoke<void>('library_delete_tag', { id });
}

export function librarySetImageTags(
  imageId: string,
  tagIds: number[],
): Promise<void> {
  return invoke<void>('library_set_image_tags', { imageId, tagIds });
}

export function libraryGetImageTags(imageId: string): Promise<TagDto[]> {
  return invoke<TagDto[]>('library_get_image_tags', { imageId });
}

export function libraryListImagesByTag(
  tagId: number,
  offset: number,
  limit: number,
): Promise<string[]> {
  return invoke<string[]>('library_list_images_by_tag', {
    tagId,
    offset,
    limit,
  });
}

// ----------------------------------------------------------------------------
// Library — meta cache backfill
// ----------------------------------------------------------------------------

export function libraryMetaBackfillStart(): Promise<void> {
  return invoke<void>('library_meta_backfill_start');
}

export function libraryMetaBackfillOne(imageId: string): Promise<void> {
  return invoke<void>('library_meta_backfill_one', { imageId });
}

// ----------------------------------------------------------------------------
// Flamegraph (only present in flamegraph feature builds)
// ----------------------------------------------------------------------------

export function writeFrontendPerf(
  events: unknown,
  path: string,
): Promise<void> {
  return invoke<void>('write_frontend_perf', { events, path });
}
