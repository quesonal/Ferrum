<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide } from 'vue';
import { RouterView, useRouter, useRoute } from 'vue-router';
import TitleBar from './components/TitleBar.vue';
import SettingsModal from './components/SettingsModal.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import MetaBackfillIndicator from './components/MetaBackfillIndicator.vue';
import { useConfigStore } from './stores/configStore';
import { useImageStore } from './stores/imageStore';
import { useLibraryStore } from './stores/libraryStore';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow as appWindow } from '@tauri-apps/api/window';
import { showMainWindow } from './api/commands';
import { takeInitialFile } from './api/windowEnv';
import { perfMark, perfBegin, perfEnd, flushPerf, isPerfEnabled } from './perf';
import { useWindowDragRegion } from './composables/useWindowDragRegion';

const router = useRouter();
const route = useRoute();
const configStore = useConfigStore();
const imageStore = useImageStore();
const libraryStore = useLibraryStore();

// Read the initial-file path once at setup. `takeInitialFile()` clears
// the global, so all three call sites (setupFileOpenHandler,
// triggerReady, onMounted) must read from this cached value.
const initialFilePath = takeInitialFile();
const { preventDefaultDragStart } = useWindowDragRegion();

const showSettings = ref(false);
const isFullscreen = ref(false);

const currentTitle = computed(() => {
  if (route.name === 'library') {
    if (libraryStore.currentTagId !== null) {
      return `#${libraryStore.tagFilterTagName ?? libraryStore.currentTagId}`;
    }
    return libraryStore.currentFolder?.name || 'Ferrum';
  }
  return imageStore.currentPath || 'Ferrum';
});

// Global keyboard handler for Alt key
// Only prevent Alt behavior when an image is loaded
const handleKeydown = (e: KeyboardEvent) => {
  if (e.target instanceof HTMLInputElement) return;

  // Ctrl+W / Cmd+W: close window
  if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
    e.preventDefault();
    appWindow().close();
    return;
  }

  // Only block Alt when viewing an image (not on library)
  // This is to prevent Windows screenshot overlay from capturing
  if (e.key === 'Alt' && imageStore.currentPath) {
    e.preventDefault();
  }
};

// Handle file open from OS
async function setupFileOpenHandler() {
  if (initialFilePath) {
    router.push({ path: '/open', query: { path: initialFilePath } });
    setTimeout(() => {
      triggerReady();
    }, 5000);
  } else {
    triggerReady();
    libraryStore.loadFolders();
    libraryStore.loadFolderTree();
  }

  // Listen for open-file events (from OS file associations)
  await listen<string[]>('open-file', async (event) => {
    const filePath = event.payload.find(arg => !arg.endsWith('.exe') && arg.length > 3);
    if (filePath) {
      router.push({ path: '/open', query: { path: filePath } });
    } else {
      triggerReady();
    }
  });

  // Handle drag-drop files
  await appWindow().onDragDropEvent(async (event) => {
    if (event.payload.type === 'drop' && event.payload.paths.length > 0) {
      const path = event.payload.paths[0];
      if (imageStore.isSupported(path)) {
        router.push({ path: '/open', query: { path: path } });
      }
    }
  });
}

// Window visibility trigger
const hasShownWindow = ref(false);
const readyPromise = ref<Promise<void> | null>(null);

function triggerReady() {
  if (hasShownWindow.value) return readyPromise.value;
  hasShownWindow.value = true;

  // Remove skeleton immediately — don't wait for async
  document.getElementById('app')?.classList.add('ready');
  const skeleton = document.getElementById('startup-skeleton');
  if (skeleton) {
    skeleton.style.opacity = '0';
    setTimeout(() => skeleton.remove(), 100);
  }

  perfBegin("trigger_ready");
  perfMark("trigger_ready_invoke_send");
  readyPromise.value = showMainWindow().catch((e) => {
    console.error('Failed to show window:', e);
  });
  perfMark("trigger_ready_invoke_return");
  perfEnd("trigger_ready");
  perfMark("window_ready", {
    mode: initialFilePath ? 'single' : 'library',
  });

  if (isPerfEnabled()) {
    void flushPerf();
  }

  return readyPromise.value;
}

let unlistenResize: (() => void) | undefined;

provide('triggerReady', triggerReady);

// Global confirm dialog state. Components inject `showConfirm` to get a
// Promise<boolean> — single instance mounted at root keeps the dialog
// usable from anywhere (image view, library, settings, ...).
interface ConfirmOptions {
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}
const confirmState = ref<{
  visible: boolean;
  title: string;
  message: string;
  resolve: ((v: boolean) => void) | null;
  options: ConfirmOptions;
}>({
  visible: false,
  title: '',
  message: '',
  resolve: null,
  options: {},
});

function showConfirm(title: string, message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    confirmState.value = { visible: true, title, message, resolve, options };
  });
}

function onConfirmDialogConfirm() {
  confirmState.value.resolve?.(true);
  confirmState.value.resolve = null;
  confirmState.value.visible = false;
}
function onConfirmDialogCancel() {
  confirmState.value.resolve?.(false);
  confirmState.value.resolve = null;
  confirmState.value.visible = false;
}

provide('showConfirm', showConfirm);

onMounted(async () => {
  perfBegin("onmounted");
  perfMark("onmounted_start");

  perfBegin("config_load");
  await configStore.loadConfig();
  perfEnd("config_load");

  perfMark("initial_path_resolved", { has_path: !!initialFilePath });

  isFullscreen.value = await appWindow().isFullscreen();
  unlistenResize = await appWindow().listen('tauri://resize', async () => {
    isFullscreen.value = await appWindow().isFullscreen();
  });

  await setupFileOpenHandler();

  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('dragstart', preventDefaultDragStart);

  perfBegin("formats_init");
  imageStore.initFormats();
  perfEnd("formats_init");

  // Phase C4 — subscribe to meta_cache backfill progress FIRST, then
  // trigger the backfill. Awaiting listeners guarantees the wiring is
  // live before any `library-meta-backfill-progress` event can be
  // emitted (previously this was a fire-and-forget `void` call and the
  // backend's auto-trigger could race ahead, dropping the 0/N tick on
  // the floor). `startMetaBackfill` itself is fire-and-forget — it
  // returns immediately after `spawn_meta_backfill` queues the loop.
  await imageStore.setupMetaBackfillListeners();
  await imageStore.startMetaBackfill();

  perfEnd("onmounted");
  perfMark("onmounted_done");
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('dragstart', preventDefaultDragStart);
  unlistenResize?.();
});
</script>

<template>
  <div
      class="fixed inset-0 flex flex-col overflow-hidden select-none text-[var(--ui-text)]"
      :style="{
        backgroundColor: configStore.config.background_color
      }"
      @dragstart.prevent
  >
    <TitleBar
        v-if="!isFullscreen"
        class="flex-none z-50"
        :title="currentTitle"
        @settings="showSettings = true"
    />

    <RouterView class="flex-1 overflow-hidden" />

    <Transition name="fade">
      <SettingsModal v-if="showSettings" @close="showSettings = false"/>
    </Transition>

    <ConfirmDialog
      :visible="confirmState.visible"
      :title="confirmState.title"
      :message="confirmState.message"
      :danger="confirmState.options.danger"
      :confirm-text="confirmState.options.confirmText"
      :cancel-text="confirmState.options.cancelText"
      @confirm="onConfirmDialogConfirm"
      @cancel="onConfirmDialogCancel"
    />

    <MetaBackfillIndicator />
  </div>
</template>

<style>
:root {
  --ui-bg: #222222;
  --ui-border: rgba(255, 255, 255, 0.1);
  --ui-border-faint: rgba(255, 255, 255, 0.03);
  --ui-shadow: rgba(0, 0, 0, 0.5);
  --ui-shadow-strong: rgba(0, 0, 0, 0.6);
  --ui-row-hover: rgba(255, 255, 255, 0.04);
  --tree-indent: 12px;
  --ui-text: #eeeeee;
  --ui-text-dim: #999999;
  --btn-hover: rgba(255, 255, 255, 0.1);
  --toast-bg: rgba(0, 0, 0, 0.6);
  /* HiDPI optimization */
  --border-width: 1px;
  --outline-width: 2px;
}

:root.light {
  --ui-bg: #f3f3f3;
  --ui-border: rgba(0, 0, 0, 0.1);
  --ui-border-faint: rgba(0, 0, 0, 0.03);
  --ui-shadow: rgba(0, 0, 0, 0.18);
  --ui-shadow-strong: rgba(0, 0, 0, 0.25);
  --ui-row-hover: rgba(0, 0, 0, 0.03);
  --tree-indent: 12px;
  --ui-text: #333333;
  --ui-text-dim: #666666;
  --btn-hover: rgba(0, 0, 0, 0.05);
  --toast-bg: rgba(255, 255, 255, 0.8);
}

@media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
  :root {
    --border-width: 0.5px;
  }
}
</style>
