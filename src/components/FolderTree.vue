<script setup lang="ts">
import {computed, ref, onMounted, onUnmounted, onActivated, nextTick} from 'vue';
import {useLibraryStore} from '../stores/libraryStore';

// const props = defineProps<{ selectedPath?: string | null }>();
defineProps<{ selectedPath?: string | null }>();
const emit = defineEmits<{ select: [folderHash: string | null, path: string] }>();
const store = useLibraryStore();

const containerRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const containerHeight = ref(600);

// 虚拟列表常量（确保每个条目高度固定）
const ITEM_HEIGHT = 30;
const BUFFER_COUNT = 10; // 上下缓冲节点数

// 监听滚动
function onScroll(e: Event) {
  const top = (e.target as HTMLElement).scrollTop;
  scrollTop.value = top;
  store.folderTreeScrollTop = top;
}

function restoreScroll() {
  if (containerRef.value && store.folderTreeScrollTop > 0) {
    containerRef.value.scrollTop = store.folderTreeScrollTop;
    scrollTop.value = store.folderTreeScrollTop;
  }
}

// 容器自适应
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  if (containerRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      containerHeight.value = entries[0].contentRect.height;
    });
    resizeObserver.observe(containerRef.value);
  }

  if (store.visibleTreeNodes.length === 0 && store.folderTree.length > 0) {
    if (store.expandedNodes.size === 0) store.expandAllNodes(store.folderTree);
    else store.updateVisibleTree();
  }
});

onMounted(() => {
  if (containerRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      containerHeight.value = entries[0].contentRect.height;
    });
    resizeObserver.observe(containerRef.value);
  }

  // 初始加载展开逻辑
  if (store.visibleTreeNodes.length === 0 && store.folderTree.length > 0) {
    if (store.expandedNodes.size === 0) store.expandAllNodes(store.folderTree);
    else store.updateVisibleTree();
  }

  // 【新增】恢复滚动位置
  nextTick(() => {
    restoreScroll();
  });
});

onActivated(() => {
  restoreScroll();
});

onUnmounted(() => resizeObserver?.disconnect());

// 计算可见区域需要渲染的节点
const visibleList = computed(() => {
  const nodes = store.visibleTreeNodes;
  const startIdx = Math.max(0, Math.floor(scrollTop.value / ITEM_HEIGHT) - BUFFER_COUNT);
  const endIdx = Math.min(nodes.length, Math.ceil((scrollTop.value + containerHeight.value) / ITEM_HEIGHT) + BUFFER_COUNT);

  return nodes.slice(startIdx, endIdx).map((item, index) => ({
    ...item,
    absoluteIndex: startIdx + index,
    top: (startIdx + index) * ITEM_HEIGHT
  }));
});

// 总高度撑开滚动条
const totalHeight = computed(() => store.visibleTreeNodes.length * ITEM_HEIGHT);

const treeContainerStyle = computed(() => {
  if (store.visibleTreeNodes.length === 0) {
    return { height: '0px', overflowY: 'hidden' as const };
  }
  if (totalHeight.value > containerHeight.value) {
    return { height: '100%', overflowY: 'auto' as const };
  }
  return { height: `${totalHeight.value}px`, overflowY: 'hidden' as const };
});

function handleSelect(hash: string | null, path: string) {
  emit('select', hash, path);
}

function formatCount(count: number): string {
  if (count >= 10000) {
    return (count / 10000).toFixed(1) + 'w';
  }
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + 'k';
  }
  return count.toString();
}
</script>

<template>
  <div class="virtual-tree-container" ref="containerRef" @scroll.passive="onScroll" :style="treeContainerStyle">
    <div class="tree-spacer" :style="{ height: `${totalHeight}px` }">
      <!-- 绝对定位的虚拟节点 -->
      <div v-for="item in visibleList" :key="item.node.path"
           class="tree-node"
           :class="{ 'is-selected': item.node.path === selectedPath }"
           :style="{ transform: `translateY(${item.top}px)`, paddingLeft: `${item.level * 12 + 8}px` }"
           @click="handleSelect(item.node.folderHash, item.node.path)">

        <span class="expand-icon" :class="{ 'is-hidden': !item.hasChildren }"
              @click.stop="store.toggleNodeExpanded(item.node.path)">
          {{ item.isExpanded ? '▼' : '▶' }}
        </span>

        <span class="folder-icon">{{ item.hasChildren ? '📁' : '📂' }}</span>

        <div class="folder-info">
          <span class="folder-name" :title="item.node.path">{{ item.node.name }}</span>
          <span class="image-count">
            {{ formatCount(item.node.totalImageCount) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-tree-container {
  flex: 1;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  will-change: scroll-position;
}

.tree-spacer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  width: 100%;
}

.tree-node {
  position: absolute;
  left: 0;
  right: 0;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  box-sizing: border-box;
  padding-right: 12px;
  user-select: none;
  contain: layout paint size; /* 极致渲染性能 */
  will-change: transform;
}

.tree-node:hover {
  background: var(--btn-hover);
}

.tree-node.is-selected {
  background: rgba(74, 158, 255, 0.15);
}

.expand-icon {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--ui-text-dim);
  border-radius: 3px;
}

.expand-icon:hover {
  background: rgba(128, 128, 128, 0.2);
  color: var(--ui-text);
}

.expand-icon.is-hidden {
  opacity: 0;
  pointer-events: none;
}

.folder-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.folder-info {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  overflow: hidden;
}

.folder-name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ui-text);
}

.image-count {
  font-size: 11px;
  color: var(--ui-text-dim);
  margin-left: 8px;
  flex-shrink: 0;
}
</style>