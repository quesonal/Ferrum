<script setup lang="ts">
import { computed } from 'vue';
import { useLibraryStore } from '../stores/libraryStore';
import {
  FOLDER_HEADER_HEIGHT,
  HEADER_PADDING_TOP,
  useFolderBlocks,
} from '../composables/useFolderBlocks';
import { useThumbnailBatchLoader } from '../composables/useThumbnailBatchLoader';
import {
  GRID_LEFT_OFFSET,
  useVirtualScroller,
} from '../composables/useVirtualScroller';
import Scrollbar from './Scrollbar.vue';

const props = defineProps<{ scrollToFolderHash?: string | null }>();
const emit = defineEmits<{
  select: [imageId: string];
  folderChange: [folderHash: string];
}>();
const store = useLibraryStore();

const {
  columns,
  gap,
  verticalGap,
  cellSize,
  totalHeight,
  folderBlocks,
  folderBlockMap,
  updateFolderBlocks,
  findBlockIndex,
} = useFolderBlocks();
const { requestPreload } = useThumbnailBatchLoader();
const {
  rootRef,
  containerRef,
  containerHeight,
  scrollTop,
  maxScrollTop,
  onJoystickStep,
  scrollToTop,
  scrollToBottom,
  onWheel,
  onNativeScroll,
} = useVirtualScroller({
  scrollToFolderHash: () => props.scrollToFolderHash,
  onFolderChange: folderHash => emit('folderChange', folderHash),
  columns,
  gap,
  verticalGap,
  cellSize,
  totalHeight,
  folderBlocks,
  folderBlockMap,
  updateFolderBlocks,
  findBlockIndex,
});

void rootRef;
void containerRef;

type RenderItem =
  | { type: 'header'; top: number; height: number; hash: string; name: string; path: string }
  | { type: 'image'; id: string; top: number; left: number };

const visibleRenderItems = computed<RenderItem[]>(() => {
  const blocks = folderBlocks.value;
  if (!blocks.length) return [];

  const preBuffer = (cellSize.value + verticalGap.value) * 2;
  const viewStart = Math.max(0, scrollTop.value - preBuffer);
  const viewEnd = scrollTop.value + containerHeight.value + preBuffer;
  const startBlockIndex = findBlockIndex(viewStart);
  let endBlockIndex = findBlockIndex(viewEnd);
  if (endBlockIndex < blocks.length - 1) {
    const currentBlockEnd = blocks[endBlockIndex].top + blocks[endBlockIndex].height;
    if (viewEnd > currentBlockEnd || currentBlockEnd - viewEnd < 500) {
      endBlockIndex = Math.min(blocks.length - 1, endBlockIndex + 1);
    }
  }

  const renderItems: RenderItem[] = [];
  const uncachedIds: string[] = [];
  for (let index = startBlockIndex; index <= endBlockIndex; index++) {
    const block = blocks[index];
    renderItems.push({
      type: 'header',
      hash: block.hash,
      name: block.name,
      path: block.path,
      top: block.top,
      height: block.height,
    });

    if (block.imageCount === 0) continue;
    const loadedImages = store.imagesByFolder.get(block.hash);
    if (!loadedImages || loadedImages.length < block.imageCount) {
      store.loadFolderImages(block.hash, true);
    }
    if (!loadedImages?.length) continue;

    const folderRelativeStart = Math.max(
      0,
      viewStart - block.top - FOLDER_HEADER_HEIGHT,
    );
    const folderRelativeEnd = viewEnd - block.top - FOLDER_HEADER_HEIGHT;
    const startRow = Math.max(
      0,
      Math.floor(folderRelativeStart / (cellSize.value + verticalGap.value)),
    );
    const endRow = Math.min(
      block.rows - 1,
      Math.ceil(folderRelativeEnd / (cellSize.value + verticalGap.value)),
    );
    const startImageIndex = startRow * columns.value;
    const endImageIndex = (endRow + 1) * columns.value;

    for (let imageIndex = startImageIndex; imageIndex < endImageIndex; imageIndex++) {
      const image = loadedImages[imageIndex];
      if (!image) continue;
      const top = block.top
        + FOLDER_HEADER_HEIGHT
        + HEADER_PADDING_TOP
        + Math.floor(imageIndex / columns.value) * (cellSize.value + verticalGap.value);
      const left = GRID_LEFT_OFFSET
        + (imageIndex % columns.value) * (cellSize.value + gap.value);
      if (!store.thumbnailCache.has(image.id)) uncachedIds.push(image.id);
      renderItems.push({ type: 'image', id: image.id, top, left });
    }
  }

  requestPreload(uncachedIds);
  return renderItems;
});
</script>

<template>
  <div ref="rootRef" class="flat-grid-root">
    <div
        ref="containerRef"
        class="flat-grid-scroll-container"
        @wheel="onWheel"
        @scroll.passive="onNativeScroll"
    >
      <div class="grid-spacer" :style="{ height: `${totalHeight}px` }">
        <template
            v-for="item in visibleRenderItems"
            :key="item.type === 'header' ? `h_${item.hash}` : `i_${item.id}`"
        >
          <div
              v-if="item.type === 'header'"
              class="folder-header-track"
              :style="{ top: `${item.top}px`, height: `${item.height}px` }"
          >
            <div class="folder-header-sticky" :style="{ height: `${FOLDER_HEADER_HEIGHT}px` }">
              <div class="folder-icon i-mdi-folder"></div>
              <div class="folder-info">
                <span class="folder-name">{{ item.name }}</span>
              </div>
            </div>
          </div>

          <div
              v-else
              class="grid-item"
              :style="{
                transform: `translate(${item.left}px, ${item.top}px)`,
                width: `${cellSize}px`,
                height: `${cellSize}px`,
              }"
              @click="emit('select', item.id)"
          >
            <div class="thumbnail-wrapper">
              <img
                  v-if="store.thumbnailCache.has(item.id)"
                  :src="store.thumbnailCache.get(item.id)"
              />
              <div v-else class="thumbnail-placeholder"></div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <Scrollbar
        v-show="maxScrollTop > 0"
        :maxSpeed="180"
        @scroll-step="onJoystickStep"
        @jump-top="scrollToTop"
        @jump-bottom="scrollToBottom"
    />
  </div>
</template>

<style scoped>
.flat-grid-root {
  display: flex; flex: 1; min-height: 0; position: relative; overflow: hidden; background: var(--ui-bg);
}

.flat-grid-scroll-container {
  flex: 1;
  overflow-y: auto;
  position: relative;
  overflow-x: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.flat-grid-scroll-container::-webkit-scrollbar { display: none; }

.grid-spacer { position: absolute; width: 100%; top: 0; left: 0; }

.folder-header-track {
  position: absolute; left: 0; right: 0; z-index: 20;
  pointer-events: none;
}

.folder-header-sticky {
  position: sticky; top: 0;
  pointer-events: auto;
  display: flex; align-items: center; gap: 10px; padding: 0 16px;
  background: color-mix(in srgb, var(--ui-bg) 80%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--ui-border); box-sizing: border-box;
}
.folder-icon { font-size: 18px; line-height: 1; color: var(--ui-text-dim); }
.folder-name { font-size: 14px; font-weight: 500; color: var(--ui-text); }

.grid-item {
  position: absolute; top: 0; left: 0; cursor: pointer;
  contain: layout paint size; will-change: transform;
  content-visibility: auto;
  contain-intrinsic-size: 128px 128px;
  transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.grid-item:hover { z-index: 10; }

.thumbnail-wrapper {
  width: 100%; height: 100%; overflow: hidden; display: flex; align-items: center; justify-content: center;
}
.thumbnail-wrapper img {
  max-width: calc(100% - 4px); max-height: calc(100% - 4px); width: auto; height: auto; display: block;
  box-shadow: 0 2px 6px var(--ui-shadow); transform: translateZ(0);
  border-radius: 2px;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.grid-item:hover .thumbnail-wrapper img {
  box-shadow: 0 0 0 1px var(--ui-accent), 0 4px 12px var(--ui-shadow-strong);
}
.thumbnail-placeholder {
  display: flex; align-items: center; justify-content: center;
  width: 100%; height: 100%;
  background: var(--ui-border-faint);
  color: var(--ui-text-dim);
}
</style>
