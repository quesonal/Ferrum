import { useRouter } from 'vue-router';
import { useImageStore } from '../stores/imageStore';
import { useLibraryStore } from '../stores/libraryStore';
import { perfMark } from '../perf';

/**
 * Shared image-navigation primitives used by keyboard, mouse, and
 * delete flows in the viewer.
 *
 * Two navigation scopes coexist here, matching the app's original
 * behavior — do not "unify" them:
 *   - `goNext` / `goPrev` step within the CURRENT FOLDER's id list in
 *     library mode (`getCurrentFolderIds`), wrapping around.
 *   - `firstImage` / `lastImage` / `forward` / `backward` jump within
 *     the FULL library list (`libraryStore.images`), clamped.
 * Filesystem mode always uses `imageStore.fileList` for both.
 */
export function useImageNavigation() {
  const router = useRouter();
  const imageStore = useImageStore();
  const libraryStore = useLibraryStore();

  function navigateFilesystem(targetPath: string) {
    perfMark('switch::navigate_filesystem', { path: targetPath });
    router.replace({ path: '/open', query: { path: targetPath } });
  }

  function resolveFileListIndex(offset: number): string | null {
    const list = imageStore.fileList;
    if (list.length === 0) return null;
    const cur = imageStore.currentPath;
    if (!cur) return null;
    const idx = list.indexOf(cur);
    if (idx < 0) return null;
    return list[(idx + offset + list.length) % list.length];
  }

  function getCurrentFolderIds(): string[] | null {
    const currentId = libraryStore.currentImageId;
    if (!currentId) return null;
    for (const imgs of libraryStore.imagesByFolder.values()) {
      if (imgs.some(img => img.id === currentId)) {
        return imgs.map(img => img.id);
      }
    }
    const flat = libraryStore.flatImages;
    if (flat.length > 0) {
      const idx = flat.findIndex(img => img.id === currentId);
      if (idx >= 0) {
        const folderHash = flat[idx].folder_hash;
        return flat.filter(img => img.folder_hash === folderHash).map(img => img.id);
      }
    }
    return null;
  }

  function goNext() {
    perfMark('switch::navigate_next');
    if (libraryStore.currentImageId) {
      const ids = getCurrentFolderIds();
      if (ids && ids.length > 0) {
        const idx = ids.indexOf(libraryStore.currentImageId);
        if (idx >= 0) {
          perfMark('switch::goNext_library_check', { has_currentId: true, folder_id_len: ids.length });
          const nextId = ids[(idx + 1) % ids.length];
          router.push(`/image/${nextId}`);
          return;
        }
      }
    } else {
      perfMark('switch::goNext_library_check', { has_currentId: false });
    }
    const path = resolveFileListIndex(1);
    if (path) navigateFilesystem(path);
  }

  function goPrev() {
    perfMark('switch::navigate_prev');
    if (libraryStore.currentImageId) {
      const ids = getCurrentFolderIds();
      if (ids && ids.length > 0) {
        const idx = ids.indexOf(libraryStore.currentImageId);
        if (idx >= 0) {
          const prevId = ids[(idx - 1 + ids.length) % ids.length];
          router.push(`/image/${prevId}`);
          return;
        }
      }
    }
    const path = resolveFileListIndex(-1);
    if (path) navigateFilesystem(path);
  }

  function firstImage() {
    if (libraryStore.currentImageId) {
      const images = libraryStore.images;
      if (images.length > 0) router.push(`/image/${images[0].id}`);
    } else if (imageStore.fileList.length > 0) {
      navigateFilesystem(imageStore.fileList[0]);
    }
  }

  function lastImage() {
    if (libraryStore.currentImageId) {
      const images = libraryStore.images;
      if (images.length > 0) router.push(`/image/${images[images.length - 1].id}`);
    } else {
      const list = imageStore.fileList;
      if (list.length > 0) navigateFilesystem(list[list.length - 1]);
    }
  }

  function jumpBy(step: number) {
    if (libraryStore.currentImageId) {
      const images = libraryStore.images;
      const idx = images.findIndex(img => img.id === libraryStore.currentImageId);
      if (idx >= 0) {
        const clamped = Math.max(0, Math.min(idx + step, images.length - 1));
        router.push(`/image/${images[clamped].id}`);
      }
    } else {
      const path = resolveFileListIndex(step);
      if (path) navigateFilesystem(path);
    }
  }

  function backToLibrary() {
    router.push('/');
  }

  return {
    navigateFilesystem,
    resolveFileListIndex,
    getCurrentFolderIds,
    goNext,
    goPrev,
    firstImage,
    lastImage,
    jumpBy,
    backToLibrary,
  };
}

export type ImageNavigation = ReturnType<typeof useImageNavigation>;
