<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, shallowRef, nextTick, onActivated } from 'vue';
import { useLibraryStore } from '../stores/libraryStore';
import type { FolderNode } from '../types/folderNode';
import Scrollbar from './Scrollbar.vue'; // 引入操纵杆滚动条组件

const props = defineProps<{ scrollToFolderHash?: string | null }>();
const emit = defineEmits<{ select: [imageId: string], folderChange:[folderHash: string]; }>();
const store = useLibraryStore();

const rootRef = ref<HTMLElement | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const containerHeight = ref(800);

// ==========================================
// 🚀 自定义滚动引擎状态
// ==========================================
const scrollTop = ref(0);         // 实际渲染使用的滚动位置
const targetScrollTop = ref(0);   // 目标位置（滚轮想要到达的位置）
let animFrameId: number | null = null;

const SCROLLBAR_WIDTH = 18;             // 为 Picasa 操纵杆预留的宽度
const MAX_SCROLL_SPEED_PER_FRAME = 120; // 滚轮限速阀门 (px/帧)

// 每批请求 24 张，既能减少 IPC 频率，又不会让单次 payload 过大
const BATCH_SIZE = 24;

const folderBlockMap = new Map<string, FolderBlock>();

// 布局参数
const columns = ref(1);
const gap = ref(30);
const verticalGap = 30;
const cellSize = ref(128);
const folderHeaderHeight = 48;
const leftOffset = 16;
const totalHeight = ref(0);
const minGap = 8;

// 动态最大滚动距离
const maxScrollTop = computed(() => Math.max(0, totalHeight.value - containerHeight.value));

interface FolderBlock {
  hash: string; name: string; path: string;
  imageCount: number; rows: number; top: number; height: number;
}
const folderBlocks = shallowRef<FolderBlock[]>([]);

const headerPaddingTop = 12;    // 标题文字下方到第一行图片的距离
const folderBottomMargin = 24;  // 文件夹区块结束到下一个标题的距离

// 展开 store 的树计算扁平顺序的 Folder Blocks
function updateFolderBlocks() {
  const blocks: FolderBlock[] =[];
  folderBlockMap.clear();
  let currentTop = 0;

  const collect = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      if (node.folderHash) {
        // Use node.imageCount directly — it comes from the same get_folder_tree call
        // and doesn't depend on store.folders being refreshed in lockstep.
        const count = node.imageCount || 0;
        const rows = Math.ceil(count / columns.value);

        let blockHeight = folderHeaderHeight;
        if (count > 0) {
          // 高度 = Header + 上方留白 + (行数 * 格子大小) + ((行数-1) * 行间距) + 底部留白
          blockHeight += headerPaddingTop
              + (rows * cellSize.value)
              + (Math.max(0, rows - 1) * verticalGap)
              + folderBottomMargin;
        } else {
          blockHeight += 8; // 空文件夹的占位高度
        }

        const block: FolderBlock = {
          hash: node.folderHash, name: node.name, path: node.path,
          imageCount: count, rows, top: currentTop, height: blockHeight
        };

        blocks.push(block);
        folderBlockMap.set(node.folderHash, block);
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

watch(
    [() => store.folderTree, () => store.folders, columns],
    () => {
      updateFolderBlocks(); // 树变了，区块位置必须重算
    },
    { deep: false, immediate: true }
);

// 尺寸变化时保护滚动不要越界
watch(maxScrollTop, (newMax) => {
  if (targetScrollTop.value > newMax) {
    targetScrollTop.value = newMax;
    scrollTop.value = Math.min(scrollTop.value, newMax);
    syncNativeScroll();
  }
});

// ==========================================
// 🖱️ Picasa 操纵杆 & 滚动事件处理
// ==========================================

// 操纵杆传来的极速滚动指令（绕过缓动引擎直接改变渲染位置）
function onJoystickStep(velocity: number) {
  let nextTop = targetScrollTop.value + velocity;
  nextTop = Math.max(0, Math.min(maxScrollTop.value, nextTop));

  targetScrollTop.value = nextTop;
  scrollTop.value = nextTop;
  syncNativeScroll();
}

function scrollToTop() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  // 1. 确保数据已同步计算（防止初始化时 Blocks 为空）
  if (folderBlocks.value.length === 0 && store.folderTree.length > 0) {
    updateFolderBlocks();
  }

  const blocks = folderBlocks.value;
  if (blocks.length > 0) {
    const firstBlock = blocks[0];

    // 2. 瞬间跳跃逻辑：直接改变 scrollTop，不启动动画循环
    const target = firstBlock.top;
    targetScrollTop.value = target;
    scrollTop.value = target; // 关键：立即同步当前渲染位置
    syncNativeScroll();       // 强行更新 DOM 容器位置

    // 3. 业务联动
    store.loadFolderImages(firstBlock.hash); // 预加载第一组图
    emit('folderChange', firstBlock.hash);   // 同步左侧树高亮

    console.log('Instant Jump to first folder:', firstBlock.name);
  } else {
    // 4. 物理兜底：如果没有文件夹数据，直接回最顶端
    targetScrollTop.value = 0;
    scrollTop.value = 0;
    syncNativeScroll();
  }
}

function scrollToBottom() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  const blocks = folderBlocks.value;
  if (blocks.length > 0) {
    const lastBlock = blocks[blocks.length - 1];

    // 瞬间到位，不走动画循环
    const target = Math.min(lastBlock.top, maxScrollTop.value);
    targetScrollTop.value = target;
    scrollTop.value = target; // 直接跳
    syncNativeScroll();

    store.loadFolderImages(lastBlock.hash);
    emit('folderChange', lastBlock.hash);
  } else {
    targetScrollTop.value = maxScrollTop.value;
    scrollTop.value = maxScrollTop.value;
    syncNativeScroll();
  }
}

// 缓动动画循环 (用于滚轮、回到顶部等)
function startAnimationLoop() {
  if (animFrameId) return;

  const loop = () => {
    const diff = targetScrollTop.value - scrollTop.value;

    if (Math.abs(diff) < 1) {
      scrollTop.value = targetScrollTop.value;
      syncNativeScroll();
      animFrameId = null;
      return;
    }

    let step = diff * 0.15;
    if (Math.abs(step) > MAX_SCROLL_SPEED_PER_FRAME) {
      step = Math.sign(step) * MAX_SCROLL_SPEED_PER_FRAME;
    }

    scrollTop.value += step;
    syncNativeScroll();
    animFrameId = requestAnimationFrame(loop);
  };
  animFrameId = requestAnimationFrame(loop);
}

// 接管滚轮
function onWheel(e: WheelEvent) {
  e.preventDefault();
  targetScrollTop.value = Math.max(0, Math.min(maxScrollTop.value, targetScrollTop.value + e.deltaY));
  startAnimationLoop();
}

// 处理原生导致（如键盘 PageDown/Focus）的滚动
function onNativeScroll(e: Event) {
  const top = (e.target as HTMLElement).scrollTop;
  if (Math.abs(top - scrollTop.value) > 2) {
    scrollTop.value = top;
    targetScrollTop.value = top;
  }
}

function syncNativeScroll() {
  if (containerRef.value) {
    // Round to avoid fractional scrollTop causing a sub-pixel gap
    // between the sticky header and the container edge in Chrome.
    containerRef.value.scrollTop = Math.round(scrollTop.value);
  }
  // Persist scroll position on every sync so it's always current when
  // the user navigates away (joystick, wheel mid-flight, jumps, etc.)
  store.flatGridScrollTop = scrollTop.value;
}

// ==========================================
// 核心可视区域推导 & 类型定义
// ==========================================
type RenderItem =
    | { type: 'header'; top: number; height: number; hash: string; name: string; path: string }
    | { type: 'image'; id: string; top: number; left: number };

function findBlockIndex(topPos: number): number {
  let l = 0, r = folderBlocks.value.length - 1, res = 0;
  while (l <= r) {
    const m = (l + r) >> 1;
    if (folderBlocks.value[m].top <= topPos) { res = m; l = m + 1; }
    else r = m - 1;
  }
  return res;
}

const visibleRenderItems = computed(() => {
  const blocks = folderBlocks.value;
  if (!blocks.length) return[];

  const currentScroll = scrollTop.value;
  const preBuffer = (cellSize.value + verticalGap) * 2;
  const viewStart = Math.max(0, currentScroll - preBuffer);
  const viewEnd = currentScroll + containerHeight.value + preBuffer;

  const startBlockIdx = findBlockIndex(viewStart);
  let endBlockIdx = findBlockIndex(viewEnd);
  if (endBlockIdx < blocks.length - 1) {
    // 如果视口终点距离下一个块的顶部很近，或者当前块已经结束，强制包含下一个块
    const currentBlockEnd = blocks[endBlockIdx].top + blocks[endBlockIdx].height;
    if (viewEnd > currentBlockEnd || (currentBlockEnd - viewEnd < 500)) {
      endBlockIdx = Math.min(blocks.length - 1, endBlockIdx + 1);
    }
  }

  const renderItems: RenderItem[] = [];
  const uncachedIds: string[] =[];

  for (let i = startBlockIdx; i <= endBlockIdx; i++) {
    const block = blocks[i];

    // Header 轨道位置推送
    renderItems.push({
      type: 'header', hash: block.hash, name: block.name, path: block.path,
      top: block.top, height: block.height
    });

    if (block.imageCount > 0) {
      const loadedImages = store.imagesByFolder.get(block.hash);
      if (!loadedImages || loadedImages.length < block.imageCount) {
        console.log('[visibleRenderItems] triggering loadFolderImages for:', block.name, 'hash:', block.hash, 'imageCount:', block.imageCount, 'loadedImages:', loadedImages?.length ?? 'undefined');
        store.loadFolderImages(block.hash, true); // 传入 force 确保拉取最新 ID 列表
      }
      if (loadedImages && loadedImages.length > 0) {
        const folderRelativeStart = Math.max(0, viewStart - block.top - folderHeaderHeight);
        const folderRelativeEnd = viewEnd - block.top - folderHeaderHeight;

        const startRow = Math.max(0, Math.floor(folderRelativeStart / (cellSize.value + verticalGap)));
        // ✨ 关键优化 2：计算 endRow 时，以“元数据预估的行数”为准，而不是以当前加载的图片数为准
        // 这样可以确保即使图片还没加载完，占位逻辑也能正确运行
        const endRow = Math.min(block.rows - 1, Math.ceil(folderRelativeEnd / (cellSize.value + verticalGap)));

        const startImgIdx = startRow * columns.value;
        const endImgIdx = (endRow + 1) * columns.value;

        for (let j = startImgIdx; j < endImgIdx; j++) {
          // ✨ 关键优化 3：如果图片数据还没到，渲染一个占位符，而不是直接 break
          const img = loadedImages[j];
          const imgTop = block.top
              + folderHeaderHeight
              + headerPaddingTop // 加上这个偏移量
              + Math.floor(j / columns.value) * (cellSize.value + verticalGap);
          const imgLeft = leftOffset + (j % columns.value) * (cellSize.value + gap.value);

          if (img) {
            if (!store.thumbnailCache.has(img.id)) uncachedIds.push(img.id);
            renderItems.push({ type: 'image', id: img.id, top: imgTop, left: imgLeft });
          } else if (j < block.imageCount) {
            // 数据还没到，但位置确实有图片，渲染一个“空占位”类型（可选）
            // 或者简单地不推入，这样该位置就是透明的背景色，但高度是保留的
          }
        }
      }
    }
  }
  requestPreload(uncachedIds);
  return renderItems;
});

// ==========================================
// 并发队列与生命周期
// ==========================================
// const MAX_CONCURRENT = 12;
let activeRequests = 0;
const queue = new Set<string>();

function requestPreload(ids: string[]) {
  queue.clear();
  ids.forEach(id => queue.add(id));
  processQueue();
}

function processQueue() {
  if (activeRequests >= 1) return; // 对于批量接口，我们控制并发数为 1 即可，因为单次量大

  if (queue.size > 0) {
    // 从队列中取出 BATCH_SIZE 个 ID
    const batch: string[] = [];
    const iter = queue.values();
    for (let i = 0; i < BATCH_SIZE; i++) {
      const { value, done } = iter.next();
      if (done) break;
      batch.push(value);
      queue.delete(value);
    }

    if (batch.length === 0) return;

    activeRequests++;

    // 调用 Store 的批量接口
    store.getThumbnailsBatch(batch).finally(() => {
      activeRequests--;
      // 递归执行下一批
      processQueue();
    });
  }
}

function restoreScroll() {
  if (containerRef.value && store.flatGridScrollTop > 0) {
    targetScrollTop.value = store.flatGridScrollTop;
    scrollTop.value = store.flatGridScrollTop;
    syncNativeScroll();
  }
}

watch(() => props.scrollToFolderHash, async (hash) => {
  if (!hash || !containerRef.value) return;

  // force=true to bypass any stale cached data (e.g. empty array cached during scan)
  const success = await store.loadFolderImages(hash, true);
  if (success) {
    const images = store.imagesByFolder.get(hash) || [];
    // 2. 在跳转动画刚开始时，就提前批量请求前 40 张缩略图
    // 这样当滚动动画结束或瞬移完成时，图片数据很可能已经在内存里了
    const headIds = images.slice(0, 40).map(img => img.id);
    store.getThumbnailsBatch(headIds);
  }

  const block = folderBlockMap.get(hash);
  if (block) {
    const targetTop = Math.min(block.top, maxScrollTop.value);
    const currentTop = scrollTop.value;

    // 计算物理距离
    const distance = Math.abs(targetTop - currentTop);

    // 设定阈值：例如视口高度的 3 倍
    // 如果跳转距离超过 3 屏，则视为”远场”，直接瞬移
    const threshold = containerHeight.value * 3;

    // 首先停止当前可能正在进行的动画
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    if (distance > threshold) {
      // --- 远场：瞬间跳转 ---
      targetScrollTop.value = targetTop;
      scrollTop.value = targetTop;
      syncNativeScroll();
    } else {
      // --- 近场：平滑滚动 ---
      targetScrollTop.value = targetTop;
      startAnimationLoop();
    }

  }
});

let resizeObserver: ResizeObserver | null = null;
onMounted(async () => {
  if (rootRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      containerHeight.value = entry.contentRect.height;
      // 减去右侧操纵杆的专属空间
      const availableW = entry.contentRect.width - SCROLLBAR_WIDTH;

      const defaultGap = 30;
      const maxColumns = Math.max(1, Math.floor((availableW - leftOffset) / (cellSize.value + minGap)));
      let actualColumns = maxColumns;
      let targetGap: number = minGap;

      while (actualColumns > 1) {
        const maxGapForCols = (availableW - leftOffset - actualColumns * cellSize.value) / (actualColumns - 1);
        if (maxGapForCols >= defaultGap) { targetGap = defaultGap; break; }
        else if (maxGapForCols >= minGap) { targetGap = maxGapForCols; break; }
        else actualColumns--;
      }
      if (actualColumns === 1) targetGap = Math.max(minGap, availableW - leftOffset - cellSize.value);

      targetGap = Math.round(targetGap / 2) * 2;

      // Save current folder before columns change shifts the layout under scrollTop
      let anchorHash: string | null = null;
      if (actualColumns !== columns.value && folderBlocks.value.length > 0) {
        const idx = findBlockIndex(scrollTop.value);
        anchorHash = folderBlocks.value[idx]?.hash ?? null;
      }

      columns.value = actualColumns;
      gap.value = targetGap;

      // After updateFolderBlocks runs and the layout is recalculated,
      // scroll to keep the same folder's header visible.
      if (anchorHash) {
        nextTick(() => {
          const block = folderBlockMap.get(anchorHash!);
          if (block) {
            const target = Math.min(block.top, maxScrollTop.value);
            if (Math.abs(target - scrollTop.value) > 4) {
              targetScrollTop.value = target;
              scrollTop.value = target;
              syncNativeScroll();
            }
          }
        });
      }
    });
    resizeObserver.observe(rootRef.value);
  }

  if (store.folderTree.length === 0) await store.loadFolderTree();
  if (store.folders.length === 0) await store.loadFolders();
  updateFolderBlocks();

  // Defer scroll restoration past the ResizeObserver callback. nextTick
  // alone fires before the observer, so columns/totalHeight are still
  // defaults and the restored position shifts when the observer fires.
  nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => restoreScroll());
    });
  });
});

onActivated(() => restoreScroll());
onUnmounted(() => resizeObserver?.disconnect());
</script>

<template>
  <div ref="rootRef" class="flat-grid-root">

    <!-- 滚动核心区：接管滚轮，侦听原生事件 -->
    <div ref="containerRef" class="flat-grid-scroll-container" @wheel.prevent="onWheel" @scroll.passive="onNativeScroll">

      <!-- 纯高占位撑开滚动条基底，供 sticky 使用 -->
      <div class="grid-spacer" :style="{ height: `${totalHeight}px` }">
        <template v-for="item in visibleRenderItems" :key="item.type === 'header' ? 'h_'+item.hash : 'i_'+item.id">

          <!-- 1. Track吸顶模式：轨道固定 top，绝不使用 transform -->
          <div v-if="item.type === 'header'"
               class="folder-header-track"
               :style="{ top: `${item.top}px`, height: `${item.height}px` }">

            <div class="folder-header-sticky" :style="{ height: folderHeaderHeight + 'px' }">
              <div class="folder-icon">📁</div>
              <div class="folder-info">
                <span class="folder-name">{{ item.name }}</span>
<!--                <span class="folder-path">{{ item.path }}</span>-->
              </div>
            </div>
          </div>

          <!-- 2. 图片元素 -->
          <div v-else class="grid-item"
               :style="{ transform: `translate(${item.left}px, ${item.top}px)`, width: cellSize+'px', height: cellSize+'px' }"
               @click="emit('select', item.id)">
            <div class="thumbnail-wrapper">
              <img v-if="store.thumbnailCache.has(item.id)" :src="store.thumbnailCache.get(item.id)" loading="lazy"/>
              <div v-else class="thumbnail-placeholder"></div>
            </div>
          </div>

        </template>
      </div>
    </div>

    <!-- 💡 Picasa 物理手感操纵杆 -->
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
  display: flex; width: 100%; flex: 1; min-height: 0; position: relative; overflow: hidden; background: var(--ui-bg);
}

/* 核心：隐藏系统原生滚动条，但保留 auto 给 sticky 吸附 */
.flat-grid-scroll-container {
  flex: 1;
  overflow-y: auto;
  position: relative;
  overflow-x: hidden;
  /* 隐藏系统自带滚动条 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.flat-grid-scroll-container::-webkit-scrollbar { display: none; }

.grid-spacer { position: absolute; width: 100%; top: 0; left: 0; }

/* 轨道层：纯粹作为吸附范围，不能包含 transform */
.folder-header-track {
  position: absolute; left: 0; right: 0; z-index: 20;
  pointer-events: none; /* 让鼠标穿透，不阻挡图片点击 */
}

/* 原生级无闪烁的吸顶层 */
.folder-header-sticky {
  position: sticky; top: 0;
  pointer-events: auto; /* 恢复自身点击 */
  display: flex; align-items: center; gap: 10px; padding: 0 16px;
  background: var(--ui-bg); border-bottom: 1px solid var(--ui-border); box-sizing: border-box;
}
.folder-name { font-size: 14px; font-weight: 600; color: var(--ui-text); }
.folder-path { font-size: 10px; color: var(--ui-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.grid-item {
  position: absolute; top: 0; left: 0; cursor: pointer;
  contain: layout paint size; will-change: transform;
  /* 让窗口 resize 时图片平滑重排 */
  transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.grid-item:hover { z-index: 10; }

.thumbnail-wrapper {
  width: 100%; height: 100%; overflow: hidden; display: flex; align-items: center; justify-content: center;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
}
.thumbnail-wrapper img {
  max-width: calc(100% - 4px); max-height: calc(100% - 4px); width: auto; height: auto; display: block;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5); transform: translateZ(0);
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.grid-item:hover .thumbnail-wrapper img {
  box-shadow: 0 0 0 1px #4a9eff, 0 4px 12px rgba(0, 0, 0, 0.6);
}
.thumbnail-placeholder { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--ui-text-dim); }
</style>