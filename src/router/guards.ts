import type { RouteLocationNormalized } from 'vue-router';
import { useImageStore } from '../stores/imageStore';
import { useLibraryStore } from '../stores/libraryStore';
import { useNavigationStore } from '../composables/useNavigationStore';
import { perfBegin, perfEnd, perfMark } from '../perf';

/**
 * Navigation guard for /open route - loads a specific file path directly
 */
export async function openFileGuard(
  to: RouteLocationNormalized,
  _from: RouteLocationNormalized,
): Promise<void> {
  const path = to.query.path as string | undefined;

  if (path) {
    const imageStore = useImageStore();
    const navStore = useNavigationStore();

    // Clear current image id since this is an open-file action.
    // Routed through `useNavigationStore().setCurrent(null)` — under
    // flag-off this hits the legacy dual-write path registered in
    // `main.ts`; under flag-on it becomes a single-source-of-truth
    // write. See `src/types/navigation.md`.
    navStore.setCurrent(null);

    try {
      await imageStore.loadFile(path);
    } catch (e) {
      console.error('Failed to load file:', e);
    }
  }
}

/**
 * Navigation guard for /image/:id route - loads image from library by id
 */
export async function openImageGuard(
  to: RouteLocationNormalized,
  _from: RouteLocationNormalized,
): Promise<void> {
  const imageId = to.params.id as string | undefined;

  if (!imageId) {
    return;
  }

  const imageStore = useImageStore();
  const libraryStore = useLibraryStore();
  const navStore = useNavigationStore();


  // Populate adjacent-image ID list so goNext/goPrev stay on the library
  // route (with previews) instead of falling through to filesystem.
  // Collect from all available sources: imagesByFolder is the most
  // reliable (populated by folder-tree clicks), flatImages and images
  // are fallbacks for flat-view / folder-detail view.
  const collected: { id: string }[] = [];
  const seen = new Set<string>();
  const addSource = (src: { id: string }[]) => {
    for (const img of src) {
      if (!seen.has(img.id)) { seen.add(img.id); collected.push(img); }
    }
  };
  // Primary: all loaded folder caches (works in both tree & flat views)
  for (const imgs of libraryStore.imagesByFolder.values()) {
    addSource(imgs);
  }
  // Fallbacks
  addSource(libraryStore.flatImages);
  addSource(libraryStore.images);
  if (collected.length > 0) {
    imageStore.setLibraryImageIds(collected.map(img => img.id));
  }
  perfMark('switch::guard_ids_populated', {
    by_folder: libraryStore.imagesByFolder.size,
    flat_len: libraryStore.flatImages.length,
    folder_len: libraryStore.images.length,
    total_ids: imageStore.libraryImageIds.length,
  });

  // Set current image id — routed through `useNavigationStore` so the
  // canonical write site is a single call (Phase 3b). Under flag-off
  // this triggers the legacy dual-write path registered in `main.ts`.
  // See `src/types/navigation.md`.
  perfBegin('switch::openImageGuard');
  navStore.setCurrent(imageId);

  try {
    perfMark('switch::getImagePath_send');
    const path = await libraryStore.getImagePath(imageId);
    perfMark('switch::getImagePath_recv', { found: !!path });
    if (path) {
      perfMark('switch::loadFile_enter');
      await imageStore.loadFile(path);
      perfMark('switch::loadFile_exit');
    } else {
      console.warn(`Image path not found for id: ${imageId}`);
    }
  } catch (e) {
    console.error('Failed to load image:', e);
  } finally {
    perfEnd('switch::openImageGuard');
  }
}
