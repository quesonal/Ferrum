<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue';
import {useImageStore} from './stores/imageStore';
import {useLibraryStore} from './stores/libraryStore';
import {MouseAction, useConfigStore} from './stores/configStore';
import {open} from '@tauri-apps/plugin-dialog';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {convertFileSrc, invoke} from "@tauri-apps/api/core";
import {listen} from '@tauri-apps/api/event';

import TitleBar from './components/TitleBar.vue';
import ControlBar from './components/ControlBar.vue';
import ImageViewer from './components/ImageViewer.vue';
import SettingsModal from './components/SettingsModal.vue';
import FolderSidebar from './components/FolderSidebar.vue';
import FlatImageGrid from './components/FlatImageGrid.vue';
import Histogram from './components/Histogram.vue';

const appWindow = getCurrentWindow();
const imageStore = useImageStore();
const libraryStore = useLibraryStore();
const configStore = useConfigStore();

// --- State Management ---
const hasShownWindow = ref(false);
const currentScale = ref(1);
const showSettings = ref(false);
const showLibrary = ref(true); // Toggle between library and single image mode

const displaySrc = computed(() => imageStore.currentPath ? convertFileSrc(imageStore.currentPath, 'img') : '');

const triggerReady = async () => {
  if (hasShownWindow.value) return;

  requestAnimationFrame(async () => {
    await invoke('show_main_window');
    hasShownWindow.value = true;

    document.getElementById('app')?.classList.add('ready');

    const skeleton = document.getElementById('startup-skeleton');
    if (skeleton) {
      skeleton.style.opacity = '0';
      setTimeout(() => skeleton.remove(), 100);
    }
  });
};

// --- Toast Logic ---
const showZoomToast = ref(false);
let zoomToastTimer: number | null = null;

watch(currentScale, () => {
  showZoomToast.value = true;
  if (zoomToastTimer) clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => {
    showZoomToast.value = false;
  }, 1500) as unknown as number;
});

const viewerRef = ref<InstanceType<typeof ImageViewer> | null>(null);
const flatGridRef = ref<InstanceType<typeof FlatImageGrid> | null>(null);
const scrollToFolderHash = ref<string | null>(null);

// --- Layout ---
watch(() => configStore.config.show_control_bar, async () => {
  await nextTick();
  if (viewerRef.value && imageStore.currentPath) {
    viewerRef.value.fitToScreen();
  }
});

// --- File Operations ---
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
      showLibrary.value = false;
      await imageStore.loadFile(file);
    }
  } catch (err) {
    console.error(err);
  }
};

const openFolderDialog = async () => {
  try {
    const folder = await open({
      directory: true,
      multiple: false
    });
    if (folder) {
      showLibrary.value = true;
    }
  } catch (err) {
    console.error('Failed to open folder:', err);
  }
};

// --- Library Operations ---
function onFolderSelect(folderId: string) {
  // Scroll to folder in FlatImageGrid
  // Reset first to ensure watch triggers even if clicking the same folder
  scrollToFolderHash.value = null;
  requestAnimationFrame(() => {
    scrollToFolderHash.value = folderId;
  });
}

function onImageSelect(imageId: string) {
  libraryStore.selectImage(imageId);
  // Load image and switch to browse mode (full ImageViewer)
  libraryStore.getImagePath(imageId).then(path => {
    if (path) {
      imageStore.loadFile(path);
      showLibrary.value = false;
    }
  });
}

function backToLibrary() {
  showLibrary.value = true;
}

function toggleLibrary() {
  showLibrary.value = !showLibrary.value;
}

// --- Mouse Actions ---
const handleAction = async (action: MouseAction) => {
  if (action === MouseAction.None) return true;

  switch (action) {
    case MouseAction.NextImage:
      imageStore.nextImage();
      break;
    case MouseAction.PrevImage:
      imageStore.prevImage();
      break;
    case MouseAction.ZoomIn:
      viewerRef.value?.zoomIn();
      break;
    case MouseAction.ZoomOut:
      viewerRef.value?.zoomOut();
      break;
    case MouseAction.FullScreen:
      const isFull = await appWindow.isFullscreen();
      await appWindow.setFullscreen(!isFull);
      break;
    case MouseAction.Maximize:
      await appWindow.toggleMaximize();
      break;
    case MouseAction.Minimize:
      await appWindow.minimize();
      break;
    case MouseAction.Exit:
      await appWindow.close();
      break;
    case MouseAction.OpenFile:
      await openFileDialog();
      break;
    case MouseAction.OpenFolder:
      await openFolderDialog();
      break;
    case MouseAction.FirstImage:
      imageStore.firstImage();
      break;
    case MouseAction.LastImage:
      imageStore.lastImage();
      break;
    case MouseAction.Forward10:
      imageStore.forward10();
      break;
    case MouseAction.Backward10:
      imageStore.backward10();
      break;
    case MouseAction.FitWindow:
      viewerRef.value?.fitToScreen();
      break;
  }
  return false;
};

const onMouseDown = async (e: MouseEvent) => {
  let action = MouseAction.None;
  if (e.button === 0) action = configStore.config.mouse_left;
  if (e.button === 1) action = configStore.config.mouse_middle;
  if (e.button === 2) action = configStore.config.mouse_right;
  if (e.button === 3) action = configStore.config.mouse_xbutton1;
  if (e.button === 4) action = configStore.config.mouse_xbutton2;

  const unhandled = await handleAction(action);

  if (e.button === 0 && unhandled) {
    handleWindowDrag(e);
  }
};

const onWheel = async (e: WheelEvent) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    viewerRef.value?.handleWheel(e);
    return;
  }

  const action = e.deltaY < 0
      ? configStore.config.mouse_wheel_up
      : configStore.config.mouse_wheel_down;

  const unhandled = await handleAction(action);

  if (unhandled) {
    viewerRef.value?.handleWheel(e);
  }
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.target instanceof HTMLInputElement) return;

  switch (e.key) {
    case 'ArrowRight':
      imageStore.nextImage();
      break;
    case 'ArrowLeft':
      imageStore.prevImage();
      break;
    case 'ArrowUp':
      viewerRef.value?.zoomIn();
      break;
    case 'ArrowDown':
      viewerRef.value?.zoomOut();
      break;
    case '0':
      viewerRef.value?.fitToScreen();
      break;
    case 'Escape':
      if (showLibrary.value) {
        backToLibrary();
      } else {
        appWindow.close();
      }
      break;
    case 'l':
      showLibrary.value = !showLibrary.value;
      break;
    case 'g':
      if (!showLibrary.value) backToLibrary();
      break;
  }
};

const handleWindowDrag = (e: MouseEvent) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'IMG') {
    viewerRef.value?.startDrag(e);
  } else {
    appWindow.startDragging();
  }
};

const handleResize = () => {
  if (viewerRef.value && imageStore.currentPath) {
    viewerRef.value.fitToScreen();
  }
};

// --- Lifecycle ---
onMounted(async () => {
  await configStore.loadConfig();

  const initialPath = (window as any).__INITIAL_FILE__;

  if (initialPath) {
    triggerReady();
    showLibrary.value = false;
    imageStore.loadFile(initialPath);
  } else {
    triggerReady();
    showLibrary.value = true;
  }

  imageStore.initFormats();

  await listen<string[]>("open-file", async (event) => {
    const filePath = event.payload.find(arg => !arg.endsWith('.exe') && arg.length > 3);
    if (filePath) {
      showLibrary.value = false;
      imageStore.loadFile(filePath);
    } else if (!hasShownWindow.value) {
      triggerReady();
    }
  });

  await appWindow.onDragDropEvent(async (event) => {
    if (event.payload.type === 'drop' && event.payload.paths.length > 0) {
      const path = event.payload.paths[0];
      if (imageStore.isSupported(path)) {
        showLibrary.value = false;
        await imageStore.loadFile(path);
      }
    }
  });

  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('dragstart', (e) => e.preventDefault());
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('keydown', handleKeydown);
  // Don't clear cache here - let individual components manage their own lifecycle
});
</script>

<template>
  <div
      class="flex flex-col w-screen h-screen overflow-hidden select-none text-[var(--ui-text)]"
      :style="{
        backgroundColor: configStore.config.background_color,
        visibility: hasShownWindow ? 'visible' : 'hidden',
        opacity: hasShownWindow ? 1 : 0,
        transition: 'opacity 0.2s ease'
      }"
  >
    <TitleBar
        class="flex-none z-50"
        :title="showLibrary ? 'Ferrum' : (imageStore.currentPath || 'Ferrum')"
        @settings="showSettings = true"
    >
      <template #extra>
        <button
          class="library-toggle"
          :class="{ active: showLibrary }"
          @click="toggleLibrary"
          title="Toggle Library (L)"
        >
          📚 Library
        </button>
      </template>
    </TitleBar>

    <!-- Library Mode -->
    <div v-if="showLibrary" class="library-view">
      <FolderSidebar
        @select="onFolderSelect"
      />
      <div class="library-content">
        <!-- Flat View: All Images -->
        <FlatImageGrid
          ref="flatGridRef"
          :scroll-to-folder-hash="scrollToFolderHash"
          @select="onImageSelect"
        />
      </div>
    </div>

    <!-- Single Image Mode -->
    <template v-else>
      <div class="flex-1 overflow-hidden relative group" @mousedown="onMouseDown" @wheel.prevent="onWheel"
           @contextmenu.prevent>
        <ImageViewer
            ref="viewerRef"
            :src="displaySrc"
            @load="triggerReady"
            @update:scale="(val) => currentScale = val"
        >
        </ImageViewer>

        <Transition name="fade">
          <div
              v-if="displaySrc && showZoomToast"
              class="absolute top-4 right-4 z-40 cursor-pointer"
              @click="viewerRef?.fitToScreen()"
              @mousedown.stop
              title="Click to fit"
          >
          <span
              class="bg-ui-bg/60 backdrop-blur-md text-ui-text text-sm font-mono px-3 py-1.5 rounded-md border border-ui-border shadow-lg hover:bg-ui-bg/80 transition-colors">
            {{ (currentScale * 100).toFixed(0) }}%
          </span>
          </div>
        </Transition>
      </div>

      <ControlBar
          v-if="imageStore.currentPath && configStore.config.show_control_bar"
          class="flex-none z-50"
          @prev="imageStore.prevImage"
          @next="imageStore.nextImage"
      />

      <!-- RGB Histogram -->
      <Histogram
          v-if="imageStore.currentPath && configStore.config.show_histogram"
          :image-src="displaySrc"
      />
    </template>

    <Transition name="fade">
      <SettingsModal v-if="showSettings" @close="showSettings = false"/>
    </Transition>
  </div>
</template>

<style>
:root {
  --ui-bg: #222222;
  --ui-border: rgba(255, 255, 255, 0.1);
  --ui-text: #eeeeee;
  --ui-text-dim: #999999;
  --btn-hover: rgba(255, 255, 255, 0.1);
  --toast-bg: rgba(0, 0, 0, 0.6);
  /* HiDPI 优化变量 */
  --border-width: 1px;
  --outline-width: 2px;
}

:root.light {
  --ui-bg: #f3f3f3;
  --ui-border: rgba(0, 0, 0, 0.1);
  --ui-text: #333333;
  --ui-text-dim: #666666;
  --btn-hover: rgba(0, 0, 0, 0.05);
  --toast-bg: rgba(255, 255, 255, 0.8);
}

/* HiDPI 屏幕优化：使用更精细的边框 */
@media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
  :root {
    --border-width: 0.5px;
  }
}

.library-toggle {
  margin-left: 12px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  color: var(--ui-text-dim);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
  flex-shrink: 0;
  white-space: nowrap;
}

.library-toggle:hover,
.library-toggle.active {
  background: var(--btn-hover);
  color: var(--ui-text);
  border-color: #4a9eff;
}

.library-view {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.library-content {
  flex: 1;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}
</style>
