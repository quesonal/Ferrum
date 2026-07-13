<script setup lang="ts">
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { open } from '@tauri-apps/plugin-dialog';
import { useI18n } from 'vue-i18n';
import { useConfigStore } from '../../stores/configStore';
import { useLibraryStore } from '../../stores/libraryStore';

const configStore = useConfigStore();
const libraryStore = useLibraryStore();
const { config } = storeToRefs(configStore);
const { t } = useI18n();

const scanningFolders = ref<Set<string>>(new Set());
const removingFolders = ref<Set<string>>(new Set());

const triggerScan = async (path: string) => {
  scanningFolders.value.add(path);
  libraryStore.scanFolder(path, true, config.value.scan_mode)
      .finally(() => {
        scanningFolders.value.delete(path);
      });
};

const addScanFolder = async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    title: t('settings.addFolder'),
  });
  if (selected) {
    if (!config.value.scan_folders.includes(selected)) {
      config.value.scan_folders.push(selected);
      triggerScan(selected);
    }
  }
};

const removeScanFolder = async (index: number) => {
  const folderPath = config.value.scan_folders[index];

  // 1. 视觉反馈：开始移除
  removingFolders.value.add(folderPath);

  try {
    // 2. 调用 Store 里的清理逻辑
    await libraryStore.removeLibrarySource(folderPath);

    // 3. 从配置列表中真正移除
    config.value.scan_folders.splice(index, 1);

    // 4. 保存配置
    await configStore.saveConfig();
  } finally {
    removingFolders.value.delete(folderPath);
  }
};
</script>

<template>
  <!-- Scan Folders -->
  <div class="flex flex-col gap-3 pt-2 border-t border-ui-border/30">
    <div class="flex justify-between items-center">
      <label class="text-[10px] font-bold text-ui-dim uppercase tracking-widest">{{ $t('settings.librarySources') }}</label>
      <button
          @click="addScanFolder"
          class="text-[11px] px-3 py-1 rounded-full bg-blue-600 text-white hover:bg-blue-500 border-none cursor-pointer flex items-center gap-1.5 transition-colors shadow-lg shadow-blue-900/20"
      >
        <div class="i-mdi-plus"></div> {{ $t('settings.addFolder') }}
      </button>
    </div>

    <!-- 优化 3：使用 TransitionGroup 实现流畅列表动画 -->
    <div class="bg-ui-hover/50 rounded-xl border border-ui-border/50 min-h-24 p-2">
      <div v-if="config.scan_folders.length === 0" class="flex flex-col items-center justify-center h-20 text-ui-dim opacity-50">
        <div class="i-mdi-folder-open text-2xl mb-1"></div>
        <span class="text-xs italic">{{ $t('settings.noFolders') }}</span>
      </div>

      <TransitionGroup name="list" tag="div" class="flex flex-col gap-1.5">
        <div
            v-for="(folder, index) in config.scan_folders"
            :key="folder"
            class="flex items-center justify-between bg-ui-bg rounded-lg px-3 py-2 text-sm border border-ui-border/50 group"
            :class="{ 'opacity-60 grayscale-[0.5]': scanningFolders.has(folder) }"
        >
          <div class="flex flex-col min-w-0 overflow-hidden">
            <span class="truncate font-medium" :title="folder">{{ folder.split(/[\\/]/).pop() }}</span>
            <span class="text-[10px] text-ui-dim truncate opacity-70" :title="folder">{{ folder }}</span>
          </div>

          <div class="flex items-center gap-1 shrink-0 ml-4">
            <!-- Rescan 按钮 -->
            <button
                @click="triggerScan(folder)"
                :disabled="scanningFolders.has(folder)"
                class="p-1.5 rounded-md hover:bg-ui-hover text-ui-dim hover:text-blue-400 transition-colors border-none bg-transparent cursor-pointer disabled:cursor-not-allowed"
                :title="$t('settings.rescan')"
            >
              <div v-if="scanningFolders.has(folder)" class="i-mdi-loading animate-spin text-blue-500"></div>
              <div v-else class="i-mdi-refresh"></div>
            </button>

            <button
                @click="removeScanFolder(index)"
                :disabled="scanningFolders.has(folder)"
                class="p-1.5 rounded-md hover:bg-ui-hover text-ui-dim hover:text-red-500 transition-colors border-none bg-transparent cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                :title="$t('settings.removeSource')"
            >
              <div class="i-mdi-delete"></div>
            </button>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>
