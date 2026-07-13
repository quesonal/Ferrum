// ============================================================================
// EXIF type helpers — conversions between snake_case DTOs and the UI shape.
//
// DTOs (snake_case) live in `types/ipc.ts` (`ExifInfoDto` + `ExifCacheRowDto`).
// The UI type is `ExifData` (camelCase, in `types/image.ts`).
//
// The 8 photo fields (camera, lens, iso, aperture, shutter, focal_length,
// equivalent_focal_length, date_taken) are identical between `ExifInfoDto`
// (filesystem IPC) and `ExifCacheRowDto` (meta_cache IPC). The UI adds
// fileSize / fileType / width / height as filesystem-only extras.
// ============================================================================

import type { ExifInfoDto, ExifCacheRowDto } from './ipc';
import type { ExifData } from './image';

/** Convert a snake_case DTO (8 fields) to the UI camelCase shape. */
export function exifDtoToUi(
  dto: ExifInfoDto | ExifCacheRowDto | null | undefined,
): Partial<ExifData> {
  if (!dto) return {};
  return {
    camera: dto.camera ?? undefined,
    lens: dto.lens ?? undefined,
    iso: dto.iso ?? undefined,
    aperture: dto.aperture ?? undefined,
    shutter: dto.shutter ?? undefined,
    focalLength: dto.focal_length ?? undefined,
    equivalentFocalLength: dto.equivalent_focal_length ?? undefined,
    dateTaken: dto.date_taken ?? undefined,
  };
}
