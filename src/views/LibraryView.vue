<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import FolderSidebar from '../components/FolderSidebar.vue';
import FlatImageGrid from '../components/FlatImageGrid.vue';
import { useLibraryStore } from '../stores/libraryStore';
import { useImageStore } from '../stores/imageStore';
import { useNavigationStore } from '../composables/useNavigationStore';
import { useRouter } from 'vue-router';
import { open } from '@tauri-apps/plugin-dialog';

const activeFolderHash = ref<string | null>(null);
const scrollToFolderHash = ref<string | null>(null);

const router = useRouter();
const libraryStore = useLibraryStore();
const imageStore = useImageStore();
const navStore = useNavigationStore();

const openFileDialog = async () => {
  try {
    const file = await open({
      multiple: false,
      filters: [
        {name: 'Images', extensions: imageStore.formats.all},
        {name: 'RAW Photos', extensions: imageStore.formats.raw}
      ]
    });
    if (file) {
      router.push({ path: '/open', query: { path: file } });
    }
  } catch (err) {
    console.error('Failed to open file:', err);
  }
};

const openFolderDialog = async () => {
  try {
    const folder = await open({
      directory: true,
      multiple: false
    });
    if (folder) {
      await libraryStore.scanFolder(folder);
    }
  } catch (err) {
    console.error('Failed to open folder:', err);
  }
};

function onFolderSelect(folderId: string) {
  activeFolderHash.value = folderId;
  // Clicking any folder row clears the tag filter — folder tree
  // is the primary navigation surface; tag mode is a one-block
  // overlay that exits on a folder click.
  if (libraryStore.currentTagId !== null) {
    libraryStore.clearTagFilter();
  }
  // Reset to null then set to trigger FlatImageGrid's scrollToFolderHash watcher
  scrollToFolderHash.value = null;
  requestAnimationFrame(() => {
    scrollToFolderHash.value = folderId;
  });
}

// Phase B3: tag row click. Loads the filtered set and points
// FlatImageGrid at the synthetic block.
async function onTagSelect(tagId: number) {
  // Find the tag name in tagStore (FolderSidebar has it but we
  // re-fetch for canonical order — cheap IPC, ~5ms).
  // Note: we don't import tagStore here to keep the dependency
  // graph small; the name is supplied via the tag-strip's row
  // hover if needed. For the synthetic header, pass null and the
  // store will resolve via library_list_tags inside loadImagesByTag.
  activeFolderHash.value = libraryStore.tagHash(tagId);
  scrollToFolderHash.value = null;
  await libraryStore.loadImagesByTag(tagId);
  requestAnimationFrame(() => {
    scrollToFolderHash.value = libraryStore.tagHash(tagId);
  });
}

function onFolderChange(folderHash: string) {
  activeFolderHash.value = folderHash;
}

async function onImageSelect(imageId: string) {
  // Owned by `useNavigationStore` (Phase 3b). The router push below
  // triggers `openImageGuard`, which also writes `currentImageId`
  // through `navStore.setCurrent()` — see the sequence in
  // `src/router/guards.ts`. The early set here lets the grid's
  // selection highlight stay in sync with the route even while the
  // guard's IPC hasn't resolved yet.
  navStore.setCurrent(imageId);
  router.push(`/image/${imageId}`);
}

function scrollToFolder(hash: string) {
  activeFolderHash.value = hash;
  scrollToFolderHash.value = hash;
  libraryStore.loadFolderImages(hash);
}

defineExpose({ scrollToFolder });

const handleKeydown = (e: KeyboardEvent) => {
  // F5: Refresh library
  if (e.key === 'F5') {
    e.preventDefault();
    if (libraryStore.currentFolderId) {
      libraryStore.loadFolderImages(libraryStore.currentFolderId);
    }
    return;
  }
  // Ctrl+O: Open folder dialog
  if (e.ctrlKey && !e.shiftKey && e.key === 'o') {
    e.preventDefault();
    openFolderDialog();
    return;
  }
  // Ctrl+Shift+O: Open file dialog
  if (e.ctrlKey && e.shiftKey && e.key === 'O') {
    e.preventDefault();
    openFileDialog();
    return;
  }
};

onMounted(async () => {
  await libraryStore.loadFolderTree();
  await libraryStore.loadFolders();
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});

// shallowRef on both ends means identity-change is enough — no deep diff.
watch([() => libraryStore.images, () => libraryStore.flatImages], ([folderImages, allImages]) => {
  const src = allImages.length > 0 ? allImages : folderImages;
  imageStore.setLibraryImageIds(src.map(img => img.id));
});

const libraryWidth = ref(280);
</script>

<template>
  <div class="library-view">
    <FolderSidebar
        v-if="libraryStore.sidebarVisible"
        :style="{ width: libraryWidth + 'px' }"
        :active-folder-hash="activeFolderHash"
        @select="onFolderSelect"
        @select-tag="onTagSelect"
    />

    <div class="flex-1 flex flex-col overflow-hidden">
      <FlatImageGrid
          :scroll-to-folder-hash="scrollToFolderHash"
          @select="onImageSelect"
          @folderChange="onFolderChange"
      />
    </div>
  </div>
</template>

<style scoped>
.library-view {
  flex: 1;
  display: flex;
  overflow: hidden;
}
</style>
