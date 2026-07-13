<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, inject } from 'vue';
import ImageViewer from '../components/ImageViewer.vue';
import ControlBar from '../components/ControlBar.vue';
import HistogramSidebar from '../components/viewer/HistogramSidebar.vue';
import { useImageStore } from '../stores/imageStore';
import { useLibraryStore } from '../stores/libraryStore';
import { useConfigStore } from '../stores/configStore';
import { getCurrentWindow as appWindow } from '@tauri-apps/api/window';
import { perfMark } from '../perf';
import { useImageNavigation } from '../composables/useImageNavigation';
import { useNavigationStore } from '../composables/useNavigationStore';
import { useImageKeyboardNav } from '../composables/useImageKeyboardNav';
import { useDeleteConfirm } from '../composables/useDeleteConfirm';
import { useHistogramSession } from '../composables/useHistogramSession';
import { useMouseActions } from '../composables/useMouseActions';
import { useRaceCounter } from '../utils/useRaceCounter';

const imageStore = useImageStore();
const libraryStore = useLibraryStore();
const configStore = useConfigStore();
const navStore = useNavigationStore();

const triggerReady = inject<() => Promise<void> | undefined>('triggerReady');

const props = defineProps<{
  id?: string;
  openPath?: string;
}>();

const viewerRef = ref<InstanceType<typeof ImageViewer> | null>(null);
const showZoomToast = ref(false);
let zoomToastTimer: number | null = null;
const currentScale = ref(1);

const showSidebar = computed(() => configStore.config.show_histogram);

function fitImage() {
  if (imageStore.currentPath) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => viewerRef.value?.fitToScreen());
    });
  }
}

const nav = useImageNavigation();
const mouse = useMouseActions({ viewerRef, nav, fitImage });
const { triggerDelete } = useDeleteConfirm(nav);
const { isFastNavigating, triggerNav } = useImageKeyboardNav({
  nav,
  zoomIn: () => viewerRef.value?.zoomIn(),
  zoomOut: () => viewerRef.value?.zoomOut(),
  fitToScreen: () => viewerRef.value?.fitToScreen(),
  fitImage,
  requestDelete: (permanent) => void triggerDelete(permanent),
});
const { histogramData, exifData, isHistogramLoading } = useHistogramSession(isFastNavigating);

watch(showSidebar, async () => {
  await nextTick();
  requestAnimationFrame(() => {
    viewerRef.value?.fitToScreen();
  });
});

watch(() => props.openPath, async (newPath) => {
  if (newPath) {
    perfMark('switch::openPath_watch', { path: newPath });
    try {
      await imageStore.loadFile(newPath);
      await nextTick();
      fitImage();
    } catch (e) {
      console.error('Failed to load file from openPath:', e);
    }
  }
});

const idWatchVersion = useRaceCounter('image-view:id-watch');
watch(() => props.id, async (newId, oldId) => {
  if (!newId || newId === oldId) return;

  const gen = idWatchVersion.begin();
  perfMark('switch::id_param_watch', { newId, gen });

  try {
    const path = await libraryStore.getImagePath(newId);
    if (!idWatchVersion.isLatest(gen)) return;

    // Routed through `useNavigationStore()` so `currentImageId` has a
    // single canonical write site. Under flag-off this triggers the
    // legacy dual-write path registered in `main.ts`; under flag-on it
    // becomes a single-source-of-truth write. See
    // `src/types/navigation.md`.
    navStore.setCurrent(newId);

    if (path) {
      await imageStore.loadFile(path);
    }
  } catch (e) {
    console.error('Failed to load image from id watch:', e);
  }
});

watch(() => configStore.config.show_control_bar, () => {
  nextTick(() => fitImage());
});

watch(currentScale, () => {
  showZoomToast.value = true;
  if (zoomToastTimer) clearTimeout(zoomToastTimer);
  zoomToastTimer = window.setTimeout(() => {
    showZoomToast.value = false;
  }, 1500);
});

function handleResize() {
  if (imageStore.currentPath) {
    viewerRef.value?.fitToScreen();
  }
}

async function onImageLoad() {
  perfMark('switch::onImageLoad');
  if (triggerReady) await triggerReady();
  fitImage();
}

onMounted(async () => {
  await nextTick();
  fitImage();
  window.addEventListener('resize', handleResize);
  await appWindow().listen('tauri://resize', () => {
    if (imageStore.currentPath) {
      setTimeout(() => viewerRef.value?.fitToScreen(), 50);
    }
  });
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
});
</script>

<template>
  <!-- 主容器变为 Row 布局 -->
  <div class="image-view-layout" @mousedown="mouse.onMouseDown" @wheel.prevent="mouse.onWheel" @contextmenu.prevent>

    <!-- 左侧：图像主舞台 -->
    <div class="main-content">
      <ImageViewer
          ref="viewerRef"
          :src="imageStore.currentSrc"
          :preview-src="imageStore.previewSrc"
          :preview-orig-width="imageStore.previewOrigWidth"
          :preview-orig-height="imageStore.previewOrigHeight"
          :fast-navigating="isFastNavigating"
          :sidebar-visible="showSidebar"
          :is-library-mode="!!imageStore.currentImageId"
          @load="onImageLoad"
          @update:scale="(val) => currentScale = val"
      />

      <ControlBar
          v-if="imageStore.currentPath && configStore.config.show_control_bar"
          @prev="triggerNav('prev')"
          @next="triggerNav('next')"
      />

      <Transition name="fade">
        <div v-if="showZoomToast" class="zoom-toast">
          {{ Math.round(currentScale * 100) }}%
        </div>
      </Transition>
    </div>

    <HistogramSidebar
        :show-histogram="showSidebar"
        :histogram-data="histogramData"
        :exif-data="exifData"
        :is-histogram-loading="isHistogramLoading"
        :current-image-id="libraryStore.currentImageId"
    />

  </div>
</template>

<style scoped>
/* 核心布局变更为左右分栏 */
.image-view-layout {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
  position: relative;
  background: transparent;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.zoom-toast {
  position: absolute;
  bottom: 60px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--toast-bg);
  color: var(--ui-text);
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 14px;
  pointer-events: none;
  z-index: 100;
}
</style>
