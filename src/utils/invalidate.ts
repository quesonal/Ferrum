/**
 * Cross-store per-image cache invalidation.
 *
 * After `library_mark_deleted` succeeds on the Rust side, the
 * frontend still holds four per-image caches keyed by `imageId`.
 * Each one has a different reason it must be cleared:
 *
 *   - `thumbnailCache.delete(imageId)` — holds a blob URL. Without
 *     an explicit `delete()` the URL lives until FIFO eviction at
 *     3000 entries (potentially the rest of the user's session),
 *     and `FlatImageGrid`'s v-for keeps the `<img>` bound to it.
 *     The `BoundedCache.delete` fires `onEvict: URL.revokeObjectURL`,
 *     so the leak closes here rather than dragging on.
 *
 *   - `tagsForImage.delete(imageId)` — chips row. The Rust side has
 *     already removed the `image_tags` row in `mark_images_deleted`;
 *     if the in-memory Map still has an entry, returning to this id
 *     (re-add path with same content hash) would briefly show stale
 *     tag chips before the next refetch lands.
 *
 *   - `metaCache.delete(imageId)` — histogram+EXIF row. Same
 *     re-add hash-collision rationale. Stale `HistogramAndExif`
 *     wouldn't be served after a refetch, but a same-frame render
 *     between delete and refetch would show the deleted image's
 *     dimensions / camera.
 *
 *   - `previewCache.delete(imageId)` — **added after a re-add
 *     hash-collision report.** The preview-path watcher
 *     (`watch(currentImageId)` in `imageStore`) hits the cache
 *     before any IPC; a stale raw-bytes row from a previous file
 *     with the same id would be displayed with no further fetching.
 *     The cache stores raw bytes (no URL leak risk) so FIFO alone
 *     would clear it within 10 nav-ticks, but staleness on the
 *     next visit costs more than a one-line `delete()`.
 *
 * `libraryStore.markDeleted` is the canonical caller; nothing else
 * in the codebase needs per-image invalidation because most paths
 * replace whole lists rather than single ids.
 *
 * If a future fifth cache is keyed by `imageId`, add it here and
 * add a one-line "why" above so the next person knows what makes
 * the cache eviction-sensitive.
 */

import { useImageStore } from '../stores/imageStore';
import { useLibraryStore } from '../stores/libraryStore';
import { useTagStore } from '../stores/tagStore';

export function invalidateImage(imageId: string): void {
  if (!imageId) return;
  const imageStore = useImageStore();
  const libraryStore = useLibraryStore();
  const tagStore = useTagStore();

  imageStore.deleteMetaCache(imageId);
  imageStore.deletePreviewCache(imageId);
  libraryStore.thumbnailCache.delete(imageId);
  tagStore.invalidateImage(imageId);
}
