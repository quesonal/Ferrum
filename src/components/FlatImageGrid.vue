<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch, shallowRef, nextTick, onActivated} from 'vue';
import {useLibraryStore} from '../stores/libraryStore';
import type {FolderNode} from '../types/folderNode';

const props = defineProps<{ scrollToFolderHash?: string | null }>();
const emit = defineEmits<{ select: [imageId: string] }>();
const store = useLibraryStore();

const rootRef = ref<HTMLElement | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const containerHeight = ref(800);
const scrollTop = ref(0);

const folderBlockMap = new Map<string, FolderBlock>();

// 布局参数
const columns = ref(1);
const gap = ref(30);
const cellSize = ref(128);
const folderHeaderHeight = 48;
const leftOffset = 16;
const totalHeight = ref(0);

interface FolderBlock {
  hash: string;
  name: string;
  path: string;
  imageCount: number;
  rows: number;
  top: number;
  height: number;
}

// 仅包含文件夹区块的数组 (最多几千条，极度轻量)
const folderBlocks = shallowRef<FolderBlock[]>([]);

// 展开 store 的树计算扁平顺序的 Folder Blocks
function updateFolderBlocks() {
  const blocks: FolderBlock[] = [];
  folderBlockMap.clear(); // 清空旧字典
  let currentTop = 0;

  const collect = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      if (node.folderHash) {
        const folderInfo = store.folders.find(f => f.id === node.folderHash);
        const count = folderInfo?.image_count || 0;
        const rows = Math.ceil(count / columns.value);

        let blockHeight = folderHeaderHeight;
        if (count > 0) blockHeight += rows * (cellSize.value + gap.value) + gap.value;
        else blockHeight += 8;

        const block: FolderBlock = {
          hash: node.folderHash, name: node.name, path: node.path,
          imageCount: count, rows, top: currentTop, height: blockHeight
        };

        blocks.push(block);
        folderBlockMap.set(node.folderHash, block); // 存入字典
        currentTop += blockHeight;
      }
      if (node.children?.length) collect(node.children);
    }
  };

  if (store.folderTree.length > 0) {
    collect(store.folderTree);
    folderBlocks.value = blocks;
    totalHeight.value = currentTop;
  }
}

// 当视窗大小改变（列数改变）或文件夹数据更新时，重新计算区块
watch([() => store.folderTree, () => store.folders, columns], () => {
  updateFolderBlocks();
}, {deep: false});

// 二分查找当前视口落在哪个文件夹区块内
function findBlockIndex(topPos: number): number {
  let l = 0, r = folderBlocks.value.length - 1, res = 0;
  while (l <= r) {
    const m = (l + r) >> 1;
    if (folderBlocks.value[m].top <= topPos) {
      res = m;
      l = m + 1;
    } else r = m - 1;
  }
  return res;
}

// ==========================================
// 核心：基于数学公式的纯粹可视区域推导 (O(1) 性能)
// ==========================================
const visibleRenderItems = computed(() => {
  const blocks = folderBlocks.value;
  if (!blocks.length) return [];

  const scrollY = scrollTop.value;
  // 视口拓展区：上下多渲染 2 排防闪烁
  const preBuffer = (cellSize.value + gap.value) * 2;
  const viewStart = Math.max(0, scrollY - preBuffer);
  const viewEnd = scrollY + containerHeight.value + preBuffer;

  const startBlockIdx = findBlockIndex(viewStart);
  let endBlockIdx = findBlockIndex(viewEnd);
  // 防止最后区块越界
  if (endBlockIdx < blocks.length - 1 && blocks[endBlockIdx].top + blocks[endBlockIdx].height < viewEnd) {
    endBlockIdx++;
  }

  const renderItems: any[] = [];
  const uncachedIds: string[] = [];

  for (let i = startBlockIdx; i <= endBlockIdx; i++) {
    const block = blocks[i];

    // 渲染 Header
    renderItems.push({type: 'header', top: block.top, hash: block.hash, name: block.name, path: block.path});

    if (block.imageCount > 0) {
      // 检查该文件夹数据是否已加载到 Store 中
      const loadedImages = store.imagesByFolder.get(block.hash);

      if (!loadedImages) {
        // 未加载，触发加载 (不阻塞渲染，此时是空白占位)
        store.loadFolderImages(block.hash);
      } else {
        // 数学推导：当前文件夹内部，哪些 "行" 落在可视区域？
        const folderRelativeStart = Math.max(0, viewStart - block.top - folderHeaderHeight);
        const folderRelativeEnd = viewEnd - block.top - folderHeaderHeight;

        const startRow = Math.max(0, Math.floor(folderRelativeStart / (cellSize.value + gap.value)));
        const endRow = Math.min(block.rows - 1, Math.ceil(folderRelativeEnd / (cellSize.value + gap.value)));

        const startImgIdx = startRow * columns.value;
        const endImgIdx = Math.min(loadedImages.length, (endRow + 1) * columns.value);

        for (let j = startImgIdx; j < endImgIdx; j++) {
          const img = loadedImages[j];
          if (!store.thumbnailCache.has(img.id)) uncachedIds.push(img.id);

          renderItems.push({
            type: 'image',
            id: img.id,
            top: block.top + folderHeaderHeight + Math.floor(j / columns.value) * (cellSize.value + gap.value),
            left: leftOffset + (j % columns.value) * (cellSize.value + gap.value),
          });
        }
      }
    }
  }

  // 触发缩略图队列
  requestPreload(uncachedIds);

  return renderItems;
});

// 轻量级并发加载队列
const MAX_CONCURRENT = 12;
let activeRequests = 0;
const queue = new Set<string>();

function requestPreload(ids: string[]) {
  queue.clear(); // 直接将视口最新需要的图置为优先
  ids.forEach(id => queue.add(id));
  processQueue();
}

function processQueue() {
  while (activeRequests < MAX_CONCURRENT && queue.size > 0) {
    const id = queue.keys().next().value;
    queue.delete(id!);
    activeRequests++;
    store.getThumbnail(id!).finally(() => {
      activeRequests--;
      processQueue();
    });
  }
}

// 滚动节流优化
let rafId: number | null = null;

function onScroll(e: Event) {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    const top = (e.target as HTMLElement).scrollTop;
    scrollTop.value = top;
    store.flatGridScrollTop = top;
    rafId = null;
  });
}

function restoreScroll() {
  if (containerRef.value && store.flatGridScrollTop > 0) {
    containerRef.value.scrollTop = store.flatGridScrollTop;
    scrollTop.value = store.flatGridScrollTop;
  }
}

// 定位跳转
watch(() => props.scrollToFolderHash, (hash) => {
  if (!hash || !containerRef.value) return;
  // 直接从 Map 取，耗时 < 0.01ms，如果是 Array.find 2万次耗时可能达 2-5ms
  const block = folderBlockMap.get(hash);
  if (block) {
    containerRef.value.scrollTop = block.top;
    store.loadFolderImages(hash);
  }
});

let resizeObserver: ResizeObserver | null = null;
onMounted(async () => {
  if (rootRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      containerHeight.value = entry.contentRect.height;
      const availableW = Math.max(0, entry.contentRect.width - 60 - leftOffset);
      columns.value = Math.max(1, Math.ceil((availableW + gap.value) / (144 + gap.value)));
      // cellSize.value = Math.max(10, Math.floor((availableW - (columns.value - 1) * gap.value) / columns.value));
    });
    resizeObserver.observe(rootRef.value);
  }

  // 数据初始化
  if (store.folderTree.length === 0) await store.loadFolderTree();
  if (store.folders.length === 0) await store.loadFolders();
  updateFolderBlocks();
});

onMounted(async () => {
  if (rootRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      containerHeight.value = entry.contentRect.height;
      const availableW = Math.max(0, entry.contentRect.width - 60 - leftOffset);
      columns.value = Math.max(1, Math.ceil((availableW + gap.value) / (144 + gap.value)));
      // cellSize.value = Math.max(10, Math.floor((availableW - (columns.value - 1) * gap.value) / columns.value));
    });
    resizeObserver.observe(rootRef.value);
  }

  // 数据初始化
  if (store.folderTree.length === 0) await store.loadFolderTree();
  if (store.folders.length === 0) await store.loadFolders();
  updateFolderBlocks();

  // 【新增】等待 DOM 渲染一帧后，恢复持久化的滚动位置
  nextTick(() => {
    restoreScroll();
  });
});

// 【新增】如果你外层使用了 <KeepAlive>，需要在这个钩子里恢复
onActivated(() => {
  restoreScroll();
});

onUnmounted(() => resizeObserver?.disconnect());
</script>

<template>
  <div ref="rootRef" class="flat-grid-root">
    <div ref="containerRef" class="flat-grid-scroll-container" @scroll.passive="onScroll">

      <!-- 纯高占位撑开原生的 500 万像素滚动条 -->
      <div class="grid-spacer" :style="{ height: `${totalHeight}px` }">
        <template v-for="item in visibleRenderItems" :key="item.type === 'header' ? 'h_'+item.hash : 'i_'+item.id">

          <!-- 文件夹标头 -->
          <div v-if="item.type === 'header'" class="folder-header"
               :style="{ transform: `translateY(${item.top}px)`, height: folderHeaderHeight+'px' }">
            <div class="folder-icon">📁</div>
            <div class="folder-info">
              <span class="folder-name">{{ item.name }}</span>
              <span class="folder-path">{{ item.path }}</span>
            </div>
          </div>

          <!-- 图片项目 -->
          <div v-else class="grid-item"
               :style="{ transform: `translate(${item.left}px, ${item.top}px)`, width: cellSize+'px', height: cellSize+'px' }"
               @click="emit('select', item.id)">
            <div class="thumbnail-wrapper">
              <img v-if="store.thumbnailCache.has(item.id)" :src="store.thumbnailCache.get(item.id)" class="fade-in-img"
                   loading="lazy"/>
              <div v-else class="thumbnail-placeholder"></div>
            </div>
          </div>

        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 使用 transform 而不是 top/left 极大地利用 GPU 加速渲染 */
.flat-grid-root { display: flex; width: 100%; flex: 1; min-height: 0; position: relative; overflow: hidden; background: var(--ui-bg); }
.flat-grid-scroll-container { flex: 1; overflow-y: auto; position: relative; will-change: scroll-position; }
.grid-spacer { position: absolute; width: 100%; top: 0; left: 0; }

.folder-header {
  position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; gap: 10px; padding: 0 16px;
  background: var(--ui-bg); border-bottom: 1px solid var(--ui-border); box-sizing: border-box; z-index: 20;
  contain: layout paint size; /* 给 Header 加上 Contain 大幅提升重绘性能 */
  will-change: transform;
}
.folder-name { font-size: 14px; font-weight: 600; color: var(--ui-text); }
.folder-path { font-size: 10px; color: var(--ui-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.grid-item { position: absolute; top: 0; left: 0; cursor: pointer; contain: layout paint size; will-change: transform; }
.grid-item:hover { z-index: 10; }

.thumbnail-wrapper {
  width: 100%;
  height: 100%;
  /*background-color: #1a1a1a;
  border-radius: 2px;

     【关键修复 1】：必须保留 overflow: hidden 裁剪背景，
     但它会导致贴边的阴影被切掉，所以下一步至关重要！
  */
  overflow: hidden;

  /* Flex 完美居中 */
  display: flex;
  align-items: center;
  justify-content: center;

  /* 给整个格子一个极微弱的内发光线，增加立体感 */
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
}

.thumbnail-wrapper img {
  max-width: calc(100% - 4px);
  max-height: calc(100% - 4px);
  width: auto;
  height: auto;
  display: block;

  /* 常态下的物理死边阴影，让图片从背景色中微微凸起 */
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
  transition: box-shadow 0.15s ease, transform 0.15s ease;

  /* 解决可能出现的像素抖动 */
  transform: translateZ(0);

}

.grid-item:hover .thumbnail-wrapper img {
  box-shadow:
      0 0 0 1px #4a9eff, /* Picasa 经典蓝色紧密外框 */
      0 4px 12px rgba(0, 0, 0, 0.6); /* 悬浮时阴影加深变大 */
}

.thumbnail-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--ui-text-dim);
}
.fade-in-img {
  animation: fadeIn 0.2s ease-out forwards;
}
.loading-icon {
  font-size: 20px;
  animation: spin 1s linear infinite;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>