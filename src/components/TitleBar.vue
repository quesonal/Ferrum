<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';

defineProps<{ title: string }>();
const emit = defineEmits<{ (e: 'settings'): void }>();

const appWindow = getCurrentWindow();
const isMaximized = ref(false);
const isFullscreen = ref(false);
const isWin11 = ref(false);

const minimize = () => appWindow.minimize();

const toggleMaximize = async () => {
  // 如果当前是全屏状态，直接退出全屏
  const fullscreen = await appWindow.isFullscreen();
  if (fullscreen) {
    await appWindow.setFullscreen(false);
    return;
  }
  // 否则正常切换最大化
  await appWindow.toggleMaximize();
};

const closeApp = () => appWindow.close();

const updateWindowState = async () => {
  isMaximized.value = await appWindow.isMaximized();
  isFullscreen.value = await appWindow.isFullscreen();
};

let unlistenResize: () => void;

onMounted(async () => {
  isWin11.value = await invoke('is_win11');
  await updateWindowState();
  unlistenResize = await appWindow.listen('tauri://resize', updateWindowState);
});

onUnmounted(() => {
  if (unlistenResize) unlistenResize();
});
</script>

<template>
  <div data-tauri-drag-region class="h-8 bg-ui-bg flex justify-between items-center select-none border-b border-ui-border transition-colors duration-300">
    <div class="flex items-center gap-2 pl-3 pointer-events-none opacity-80 overflow-hidden text-ui-text">
      <div class="i-mdi-image-multiple w-4 h-4 text-blue-500 flex-shrink-0"></div>
      <span class="text-xs truncate font-sans">{{ title }}</span>
    </div>

    <div class="flex h-full items-center flex-shrink-0">
      <slot name="extra"></slot>
      <button class="win-btn" @click="emit('settings')">
        <div class="i-mdi-cog"></div>
      </button>
      <button class="win-btn" @click="minimize">
        <div class="i-mdi-minus"></div>
      </button>
      <button class="win-btn" @click="toggleMaximize">
        <div :class="isMaximized || isFullscreen ? 'i-mdi-window-restore' : 'i-mdi-crop-square'"></div>
      </button>
      <button
          class="win-btn hover:!bg-red-500 hover:!text-white"
          :class="{ '!rounded-tr-lg': !isMaximized && !isFullscreen && isWin11 }"
          @click="closeApp"
      >
        <div class="i-mdi-close"></div>
      </button>
    </div>
  </div>
</template>

<style scoped>
</style>