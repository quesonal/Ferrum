// ============================================================================
// Image-related UI types — camelCase, used by `imageStore` and `ImageView`.
//
// Distinct from `types/ipc.ts` (snake_case DTOs). The two layers meet at the
// `api/commands.ts` boundary; UI code never sees raw DTOs.
// ============================================================================

/** Where the current image came from. Determines which histogram/EXIF read
 *  path the UI takes. */
export type HistogramSource =
  | { kind: 'library'; id: string | null }
  | { kind: 'filesystem'; path: string | null };

/** RGB histogram as it lives in the UI (post-decode, normalized 0–100). */
export interface HistogramData {
  r: number[];
  g: number[];
  b: number[];
  width: number;
  height: number;
}

/** Flat 8-string EXIF row + filesystem-only extras (fileSize, fileType, dims).
 *  Used by both `Histogram.vue` and `ImageView.vue` EXIF panel. */
export interface ExifData {
  fileSize?: string;
  fileType?: string;
  dateTaken?: string;
  camera?: string;
  lens?: string;
  iso?: string;
  aperture?: string;
  shutter?: string;
  focalLength?: string;
  equivalentFocalLength?: string;
  width?: number;
  height?: number;
}

/** Bundle returned from `imageStore.loadHistogram` (library mode). */
export interface HistogramAndExif {
  histogram: HistogramData;
  exif: ExifData;
}
