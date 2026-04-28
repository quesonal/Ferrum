<script setup lang="ts">
import {onMounted, ref, watch} from 'vue';
import {useLibraryStore} from '../stores/libraryStore';
import FolderTree from './FolderTree.vue';
import type { FolderNode } from '../types/folderNode';

const props = defineProps<{
  activeFolderHash?: string | null;
}>();

const emit = defineEmits<{
  select: [folderId: string];
}>();

const store = useLibraryStore();

// 拖拽调整宽度
const sidebarWidth = ref(220);
const minWidth = 150;
const maxWidth = 500;
const isResizing = ref(false);

// 从 localStorage 读取保存的宽度
const savedWidth = localStorage.getItem('sidebar-width');
if (savedWidth) {
  sidebarWidth.value = parseInt(savedWidth, 10);
}

onMounted(() => {
  store.loadFolderTree(); // 加载树形结构
  store.loadStats();
});

// 当前选中的路径（用于树形视图）
const selectedPath = ref<string | null>(null);

// 处理树形视图中的选择
function handleTreeSelect(folderHash: string | null, path: string) {
  selectedPath.value = path;
  if (folderHash) {
    emit('select', folderHash);
  }
}

function formatNumber(num: number): string {
  if (num >= 10000) {
    return (num / 10000).toFixed(1) + 'w';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'k';
  }
  return num.toString();
}

// 开始拖拽调整宽度
function startResize(e: MouseEvent) {
  isResizing.value = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const startX = e.clientX;
  const startWidth = sidebarWidth.value;

  function onMouseMove(e: MouseEvent) {
    if (!isResizing.value) return;

    const delta = e.clientX - startX;
    let newWidth = startWidth + delta;

    // 限制最小和最大宽度
    newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));

    sidebarWidth.value = newWidth;
  }

  function onMouseUp() {
    isResizing.value = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // 保存宽度到 localStorage
    localStorage.setItem('sidebar-width', sidebarWidth.value.toString());

    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

watch(() => props.activeFolderHash, (hash) => {
  if (!hash) return;

  // 查找算法：在树形结构中递归寻找匹配 folderHash 的节点，并返回其 path
  const findPathByHash = (nodes: FolderNode[]): string | null => {
    for (const node of nodes) {
      if (node.folderHash === hash) {
        return node.path;
      }
      if (node.children && node.children.length > 0) {
        const foundPath = findPathByHash(node.children);
        if (foundPath) return foundPath;
      }
    }
    return null;
  };

  const path = findPathByHash(store.folderTree);
  if (path) {
    selectedPath.value = path; // 更新本地变量，从而触发 FolderTree 的高亮

    // 可选：如果文件夹层级很深且被折叠了，你可能还需要调用 store 的展开逻辑
    // store.expandToPath(path);
  }
}, { immediate: true });
</script>

<template>
  <div
    class="folder-sidebar"
    :class="{ resizing: isResizing }"
    :style="{ width: sidebarWidth + 'px' }"
  >
    <div class="folder-list">
      <FolderTree
        :nodes="store.folderTree"
        :selected-path="selectedPath"
        @select="handleTreeSelect"
      />

      <div v-if="store.folderTree.length === 0" class="empty-state">
        <p>No folders scanned yet</p>
      </div>
    </div>

    <div v-if="store.stats" class="sidebar-footer">
      <div class="stats">
        <span>{{ formatNumber(store.stats.valid_images) }} images</span>
        <span>{{ store.stats.folder_count }} folders</span>
      </div>
    </div>

    <!-- 拖拽调整宽度的手柄 -->
    <div
      class="resize-handle"
      @mousedown.prevent="startResize"
    />
  </div>
</template>

<style scoped>
.folder-sidebar {
  position: relative;
  height: 100%;
  background: var(--ui-bg);
  border-right: 1px solid var(--ui-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width 0.2s ease;
}

.folder-sidebar.resizing {
  transition: none;
}

/* 拖拽调整宽度的手柄 */
.resize-handle {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s;
  z-index: 10;
}

.resize-handle:hover,
.resizing .resize-handle {
  background: var(--ui-border);
}

.folder-list {
  flex: 1;
  padding: 8px;
  display: flex;
  flex-direction: column;
}

.empty-state {
  padding: 32px 16px;
  text-align: center;
  color: var(--ui-text-dim);
}

.empty-state p {
  margin: 0 0 12px 0;
  font-size: 13px;
}

.sidebar-footer {
  padding: 12px;
  border-top: 1px solid var(--ui-border);
}

.stats {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--ui-text-dim);
}

</style>
