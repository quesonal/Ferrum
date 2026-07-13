<script setup lang="ts">
import {onMounted, ref, watch} from 'vue';
import {useLibraryStore} from '../stores/libraryStore';
import {useTagStore} from '../stores/tagStore';
import {useI18n} from 'vue-i18n';
import FolderTree from './FolderTree.vue';
import type { FolderNode } from '../types/folderNode';

const props = defineProps<{
  activeFolderHash?: string | null;
}>();

const emit = defineEmits<{
  select: [folderId: string];
  'select-tag': [tagId: number];
}>();

const store = useLibraryStore();
const tagStore = useTagStore();
const {t} = useI18n();

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
  // Lazily fetch the tag vocabulary for the Tags sidebar row.
  // Phase B1 already loads it when Settings → Tags is opened; if
  // the user lands on /library first, this catch-up keeps the row
  // populated without showing a Settings modal first.
  if (tagStore.tags.length === 0) {
    tagStore.loadAll().catch((e) => {
      console.warn('[sidebar] tagStore.loadAll failed:', e);
    });
  }
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

// Tag row click. Re-click on the active tag clears the filter (no
// second emit, no scroll) — the row is its own toggle.
function handleTagClick(tagId: number) {
  if (store.currentTagId === tagId) {
    store.clearTagFilter();
    emit('select', ''); // signal LibraryView to also clear folder highlight
    return;
  }
  emit('select-tag', tagId);
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
        <p>{{ $t('library.noFolders') }}</p>
      </div>

      <!--
        Tags section (Phase B3). Renders below the folder tree as
        a peer list. Active tag → blue highlight identical to the
        folder tree active style. Re-click clears the filter.
      -->
      <div v-if="tagStore.tags.length > 0" class="tags-section">
        <div class="tags-section-title">{{ t('library.tagsSection.title') }}</div>
        <div
            v-for="tag in tagStore.tags"
            :key="tag.id"
            class="tag-row"
            :class="{ active: store.currentTagId === tag.id }"
            @click="handleTagClick(tag.id)"
        >
          <span
              class="tag-dot"
              :style="tag.color ? {backgroundColor: tag.color} : {}"
              :class="{ 'tag-dot-default': !tag.color }"
          ></span>
          <span class="tag-name">#{{ tag.name }}</span>
          <!--
            image_count is fetched from `library_list_tags` via a
            backend GROUP BY; `-1` is a sentinel that means "this
            came from `library_get_image_tags`, no aggregation was
            done" — render nothing in that case to avoid showing
            a fake count next to a chip row.
          -->
          <span
              v-if="tag.image_count >= 0"
              class="tag-count"
              :title="$t('library.tagsSection.imageCount', {count: tag.image_count})"
          >{{ tag.image_count >= 10000 ? formatNumber(tag.image_count) : tag.image_count }}</span>
        </div>
      </div>
    </div>

    <div v-if="store.stats" class="sidebar-footer">
      <div class="stats">
        <span>{{ formatNumber(store.stats.valid_images) }} {{ $t('library.images') }}</span>
        <span>{{ store.stats.folder_count }} {{ $t('library.folders') }}</span>
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
  overflow-y: auto;
  min-height: 0;
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

.tags-section {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tags-section-title {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--ui-text-dim);
  letter-spacing: 0.06em;
  padding: 6px 8px 4px;
}

.tag-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--ui-text);
  cursor: pointer;
  user-select: none;
  transition: background-color 0.1s;
}

.tag-row:hover {
  background-color: var(--btn-hover);
}

.tag-row.active {
  background-color: #2563eb; /* blue-600, matches FolderTree active row */
  color: white;
}

.tag-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tag-dot-default {
  background-color: var(--ui-text-dim);
  opacity: 0.5;
}

.tag-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-count {
  flex-shrink: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-dim);
  /* Subtle pill so the number reads as a secondary metadata badge
     rather than part of the tag name. */
  padding: 1px 6px;
  border-radius: 9999px;
  background-color: var(--btn-hover);
  min-width: 18px;
  text-align: center;
}

.tag-row.active .tag-count {
  /* Lift the badge out of the blue background. */
  background-color: rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.85);
}
</style>
