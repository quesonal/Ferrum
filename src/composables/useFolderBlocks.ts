import { ref, shallowRef, watch } from 'vue';
import { useLibraryStore } from '../stores/libraryStore';
import type { FolderNode } from '../types/folderNode';

export const FOLDER_HEADER_HEIGHT = 48;
export const HEADER_PADDING_TOP = 12;
const FOLDER_BOTTOM_MARGIN = 24;

export interface FolderBlock {
  hash: string;
  name: string;
  path: string;
  imageCount: number;
  rows: number;
  top: number;
  height: number;
}

export function useFolderBlocks() {
  const store = useLibraryStore();
  const columns = ref(1);
  const gap = ref(30);
  const verticalGap = ref(30);
  const cellSize = ref(128);
  const totalHeight = ref(0);
  const folderBlocks = shallowRef<FolderBlock[]>([]);
  const folderBlockMap = new Map<string, FolderBlock>();

  function updateFolderBlocks() {
    folderBlockMap.clear();
    const blocks: FolderBlock[] = [];
    let currentTop = 0;

    const tagId = store.currentTagId;
    if (tagId !== null) {
      const hash = store.tagHash(tagId);
      const imageCount = store.tagFilteredImages.length;
      const rows = Math.ceil(imageCount / columns.value);
      const height = FOLDER_HEADER_HEIGHT
        + (imageCount > 0
          ? HEADER_PADDING_TOP
            + rows * cellSize.value
            + Math.max(0, rows - 1) * verticalGap.value
            + FOLDER_BOTTOM_MARGIN
          : 8);
      const block: FolderBlock = {
        hash,
        name: `#${store.tagFilterTagName ?? tagId}`,
        path: '',
        imageCount,
        rows,
        top: 0,
        height,
      };
      blocks.push(block);
      folderBlockMap.set(hash, block);
      folderBlocks.value = blocks;
      totalHeight.value = height;
      return;
    }

    const collect = (nodes: FolderNode[]) => {
      for (const node of nodes) {
        if (node.folderHash) {
          const imageCount = node.imageCount || 0;
          const rows = Math.ceil(imageCount / columns.value);
          const height = FOLDER_HEADER_HEIGHT
            + (imageCount > 0
              ? HEADER_PADDING_TOP
                + rows * cellSize.value
                + Math.max(0, rows - 1) * verticalGap.value
                + FOLDER_BOTTOM_MARGIN
              : 8);
          const block: FolderBlock = {
            hash: node.folderHash,
            name: node.name,
            path: node.path,
            imageCount,
            rows,
            top: currentTop,
            height,
          };
          blocks.push(block);
          folderBlockMap.set(node.folderHash, block);
          currentTop += height;
        }
        if (node.children?.length) collect(node.children);
      }
    };

    if (store.folderTree.length > 0) collect(store.folderTree);
    folderBlocks.value = blocks;
    totalHeight.value = currentTop;
  }

  function findBlockIndex(top: number) {
    let left = 0;
    let right = folderBlocks.value.length - 1;
    let result = 0;
    while (left <= right) {
      const middle = (left + right) >> 1;
      if (folderBlocks.value[middle].top <= top) {
        result = middle;
        left = middle + 1;
      } else {
        right = middle - 1;
      }
    }
    return result;
  }

  watch(
    [
      () => store.folderTree,
      () => store.folders,
      columns,
      verticalGap,
      () => store.currentTagId,
      () => store.tagFilteredImages.length,
    ],
    updateFolderBlocks,
    { deep: false, immediate: true },
  );

  return {
    columns,
    gap,
    verticalGap,
    cellSize,
    totalHeight,
    folderBlocks,
    folderBlockMap,
    updateFolderBlocks,
    findBlockIndex,
  };
}
