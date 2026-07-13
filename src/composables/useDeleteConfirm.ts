import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useImageStore } from '../stores/imageStore';
import { useLibraryStore } from '../stores/libraryStore';
import { useConfigStore } from '../stores/configStore';
import { deleteFile } from '../api/commands';
import { useConfirm } from './useConfirm';
import type { ImageNavigation } from './useImageNavigation';

/**
 * 删除当前图片流程。
 * - permanent=false：移到回收站（可恢复）
 * - permanent=true ：永久删除（Shift+Del）
 * 顺序：先确认 → 算好导航目标 → 删除文件 → 同步 library DB → 导航。
 * 导航目标必须在删除前算好：library_mark_deleted 会改变 flatImages/imagesByFolder，
 * 删除后再算就会找不到当前 id。
 */
export function useDeleteConfirm(nav: ImageNavigation) {
  const router = useRouter();
  const imageStore = useImageStore();
  const libraryStore = useLibraryStore();
  const configStore = useConfigStore();
  const { t } = useI18n();
  const showConfirm = useConfirm();

  async function triggerDelete(permanent: boolean) {
    const targetPath = imageStore.currentPath;
    const targetId = imageStore.currentImageId;
    if (!targetPath) return;

    const filename = targetPath.split(/[\\/]/).pop() || targetPath;

    if (configStore.config.delete_confirm) {
      if (!showConfirm) {
        // provide 缺失（理论上不应发生），降级为直接执行
        console.warn('[delete] showConfirm not provided');
      } else {
        const ok = await showConfirm(
          permanent ? t('delete.permanentTitle') : t('delete.trashTitle'),
          permanent
            ? t('delete.permanentMessage', { name: filename })
            : t('delete.trashMessage', { name: filename }),
          {
            danger: true,
            confirmText: permanent ? t('delete.permanentConfirm') : t('delete.trashConfirm'),
          }
        );
        if (!ok) return;
      }
    }

    // 算好下一步去哪里（删除后再算会失效）
    let navTarget:
      | { kind: 'library' }
      | { kind: 'imageId'; id: string }
      | { kind: 'path'; offset: 1 | -1 } = { kind: 'library' };

    if (targetId) {
      // library 模式：当前 folder 列表的下一张（末尾则上一张），只剩一张就回图库
      const ids = nav.getCurrentFolderIds();
      if (ids && ids.length > 1) {
        const idx = ids.indexOf(targetId);
        if (idx >= 0) {
          const targetIdx = idx === ids.length - 1 ? idx - 1 : idx + 1;
          navTarget = { kind: 'imageId', id: ids[targetIdx] };
        }
      }
    } else {
      // 文件系统模式：用 imageStore.fileList 算偏移
      const list = imageStore.fileList;
      const idx = list.indexOf(targetPath);
      if (list.length > 1 && idx >= 0) {
        navTarget = { kind: 'path', offset: idx === list.length - 1 ? -1 : 1 };
      }
    }

    // 删文件（失败则保持原状不导航）
    try {
      await deleteFile(targetPath, permanent);
    } catch (e) {
      console.error('[delete] file deletion failed:', e);
      return;
    }

    // 同步 library DB（只清 DB + 内存状态，不动文件 —— 文件已删）
    if (targetId) {
      await libraryStore.markDeleted(targetId);
    }

    // 导航到预计算目标
    switch (navTarget.kind) {
      case 'library':
        nav.backToLibrary();
        break;
      case 'imageId':
        router.push(`/image/${navTarget.id}`);
        break;
      case 'path':
        if (navTarget.offset === 1) imageStore.nextImage();
        else imageStore.prevImage();
        break;
    }

    // 清理 imageStore.fileList：必须在导航之后调用 —— nextImage 用 currentIndex
    // 算 nextIdx，先删 B 再 nav 会让 currentIndex=-1，nextImage 直接 return。
    // library 模式下 fileList 不是导航源（用 router.push），但也清理避免后续
    // reload 同目录时残留 stale entry。
    imageStore.removeFromFileList(targetPath);
  }

  return { triggerDelete };
}
