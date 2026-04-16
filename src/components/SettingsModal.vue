<script setup lang="ts">
import {AppTheme, MouseAction, ScanMode, useConfigStore} from '../stores/configStore';
import {useLibraryStore} from '../stores/libraryStore';
import { storeToRefs } from 'pinia';
import {ref} from "vue";
import {open} from '@tauri-apps/plugin-dialog';

const emit = defineEmits<{ (e: 'close'): void; }>();
const configStore = useConfigStore();
const libraryStore = useLibraryStore();
const { config } = storeToRefs(configStore);

const activeTab = ref<'general' | 'mouse'>('general');

const actionOptions = [
  { label: '无操作', value: MouseAction.None },
  { label: '全屏', value: MouseAction.FullScreen },
  { label: '最大化', value: MouseAction.Maximize },
  { label: '最小化', value: MouseAction.Minimize },
  { label: '退出', value: MouseAction.Exit },
  { label: '打开文件', value: MouseAction.OpenFile },
  { label: '打开文件夹', value: MouseAction.OpenFolder },
  { label: '下一张', value: MouseAction.NextImage },
  { label: '上一张', value: MouseAction.PrevImage },
  { label: '首张图片', value: MouseAction.FirstImage },
  { label: '末尾图片', value: MouseAction.LastImage },
  { label: '向后10张图片', value: MouseAction.Forward10 },
  { label: '向前10张图片', value: MouseAction.Backward10 },
  { label: '放大', value: MouseAction.ZoomIn },
  { label: '缩小', value: MouseAction.ZoomOut },
  { label: '显示Exif（TODO）', value: MouseAction.ShowExif },
  { label: '适应窗口', value: MouseAction.FitWindow },
];

const saveAndClose = async () => {
  await configStore.saveConfig();
  emit('close');
};

const resetBgColor = () => {
  config.value.background_color = config.value.theme === 'light' ? '#ffffff' : '#1a1a1a';
};

const predefinedColors = ['#1a1a1a', '#000000', '#ffffff', '#e5e7eb'];

const scanningFolders = ref<Set<string>>(new Set());

const addScanFolder = async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    title: '选择扫描文件夹',
  });
  if (selected && typeof selected === 'string') {
    if (!config.value.scan_folders.includes(selected)) {
      config.value.scan_folders.push(selected);
    }
    // 在后台触发扫描，不阻塞 UI
    scanningFolders.value.add(selected);
    libraryStore.scanFolder(selected, true, config.value.scan_mode)
      .then(() => {
        scanningFolders.value.delete(selected);
      })
      .catch(() => {
        scanningFolders.value.delete(selected);
      });
  }
};

const removeScanFolder = (index: number) => {
  config.value.scan_folders.splice(index, 1);
};
</script>

<template>
  <div class="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex justify-center items-center" @click.self="emit('close')">
    <div class="bg-ui-bg w-140 h-110 rounded-lg shadow-2xl border border-ui-border text-ui-text overflow-hidden flex flex-col transition-colors">

      <!-- Header -->
      <div class="px-5 py-3 border-b border-ui-border bg-ui-hover flex justify-between items-center flex-none">
        <span class="font-medium">Settings</span>
        <button class="i-mdi-close text-ui-dim hover:text-ui-text cursor-pointer bg-transparent border-none" @click="emit('close')"></button>
      </div>

      <div class="flex flex-1 overflow-hidden">
        <!-- Sidebar -->
        <div class="w-32 border-r border-ui-border flex flex-col p-2 gap-1 bg-ui-bg/50">
          <button
              v-for="tab in [['general', 'General'], ['mouse', 'Mouse']]"
              @click="activeTab = tab[0] as any"
              class="px-3 py-2 rounded-md text-sm text-left border-none cursor-pointer transition-colors"
              :class="activeTab === tab[0] ? 'bg-blue-600 text-white' : 'text-ui-dim hover:bg-ui-hover'"
          >
            {{ tab[1] }}
          </button>
        </div>

        <!-- Content -->
        <div class="flex-1 p-6 overflow-y-auto">
          <!-- General Tab -->
          <div v-if="activeTab === 'general'" class="flex flex-col gap-6">
            <div class="flex flex-col gap-2">
              <label class="text-xs text-ui-dim uppercase tracking-wider">Theme</label>
              <div class="flex bg-ui-hover p-1 rounded-lg">
                <button
                    class="flex-1 py-1.5 text-sm rounded-md border-none cursor-pointer transition-all flex items-center justify-center gap-2"
                    :class="config.theme === AppTheme.Dark ? 'bg-ui-bg shadow text-ui-text' : 'bg-transparent text-ui-dim'"
                    @click="config.theme = AppTheme.Dark"
                >
                  <div class="i-mdi-weather-night"></div> Dark
                </button>
                <button
                    class="flex-1 py-1.5 text-sm rounded-md border-none cursor-pointer transition-all flex items-center justify-center gap-2"
                    :class="config.theme === AppTheme.Light ? 'bg-ui-bg shadow text-ui-text' : 'bg-transparent text-ui-dim'"
                    @click="config.theme = AppTheme.Light"
                >
                  <div class="i-mdi-white-balance-sunny"></div> Light
                </button>
              </div>
            </div>

            <div class="flex flex-col gap-2">
              <div class="flex justify-between items-end">
                <label class="text-xs text-ui-dim uppercase tracking-wider">Image Canvas Background</label>
                <button class="text-xs text-blue-500 border-none bg-transparent cursor-pointer hover:underline" @click="resetBgColor">Reset to default</button>
              </div>

              <div class="flex items-center gap-3">
                <input
                    type="color"
                    v-model="config.background_color"
                    class="w-8 h-8 rounded cursor-pointer border-none bg-transparent p-0"
                />
                <div class="flex gap-2">
                  <button
                      v-for="color in predefinedColors"
                      :key="color"
                      class="w-6 h-6 rounded-full border border-gray-500/30 cursor-pointer hover:scale-110 transition-transform"
                      :style="{ backgroundColor: color }"
                      @click="config.background_color = color"
                  ></button>
                </div>
              </div>
            </div>

            <!-- Default Zoom Mode -->
            <div class="flex flex-col gap-2">
              <label class="text-xs text-ui-dim uppercase tracking-wider">Default Zoom Mode</label>
              <select
                  v-model="config.default_fit_mode"
                  class="bg-ui-hover text-ui-text border border-ui-border rounded px-3 py-2 text-sm outline-none"
              >
                <option value="contain">Fit to Window (Contain)</option>
                <option value="original">Original Size (100%)</option>
              </select>
            </div>

            <!-- Show Control Bar -->
            <div class="flex items-center justify-between border-t border-ui-border pt-4">
              <label class="text-sm text-ui-text">Show Bottom Control Bar</label>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="config.show_control_bar" class="sr-only peer">
                <div class="w-11 h-6 bg-gray-500/50 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <!-- Show Histogram & EXIF -->
            <div class="flex items-center justify-between border-t border-ui-border pt-4">
              <label class="text-sm text-ui-text">Show Histogram & EXIF</label>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="config.show_histogram" class="sr-only peer">
                <div class="w-11 h-6 bg-gray-500/50 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <!-- Scan Mode -->
            <div class="flex flex-col gap-2 border-t border-ui-border pt-4">
              <label class="text-xs text-ui-dim uppercase tracking-wider">Scan Mode</label>
              <select
                  v-model="config.scan_mode"
                  class="bg-ui-hover text-ui-text border border-ui-border rounded px-3 py-2 text-sm outline-none"
              >
                <option :value="ScanMode.Auto">Auto (Everything → WalkDir)</option>
                <option :value="ScanMode.Everything">Everything (Fastest, requires Everything)</option>
                <option :value="ScanMode.Mft">MFT (Fast, requires admin)</option>
                <option :value="ScanMode.WalkDir">WalkDir (Compatible)</option>
              </select>
              <span class="text-xs text-ui-dim">
                <template v-if="config.scan_mode === ScanMode.Auto">
                  Automatically select the best available method
                </template>
                <template v-else-if="config.scan_mode === ScanMode.Everything">
                  Requires VoidTools Everything to be installed and running
                </template>
                <template v-else-if="config.scan_mode === ScanMode.Mft">
                  Requires administrator privileges on Windows
                </template>
                <template v-else>
                  Standard filesystem scanning, works everywhere
                </template>
              </span>
            </div>

            <!-- Scan Folders -->
            <div class="flex flex-col gap-2 border-t border-ui-border pt-4">
              <div class="flex justify-between items-center">
                <label class="text-xs text-ui-dim uppercase tracking-wider">Scan Folders</label>
                <button
                    @click="addScanFolder"
                    :disabled="libraryStore.isLoading"
                    class="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-500 border-none cursor-pointer flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div class="i-mdi-plus text-xs"></div> Add
                </button>
              </div>
              <div v-if="config.scan_folders.length === 0" class="text-xs text-ui-dim italic">
                No folders configured. Add folders for quick access.
              </div>
              <div v-else class="flex flex-col gap-1 max-h-32 overflow-y-auto">
                <div
                    v-for="(folder, index) in config.scan_folders"
                    :key="folder"
                    class="flex items-center justify-between bg-ui-hover rounded px-2 py-1.5 text-sm"
                    :class="{ 'opacity-70': scanningFolders.has(folder) }"
                >
                  <span class="truncate flex-1 mr-2" :title="folder">{{ folder }}</span>
                  <div class="flex items-center gap-1">
                    <div v-if="scanningFolders.has(folder)" class="i-mdi-loading animate-spin text-blue-500"></div>
                    <button
                        @click="removeScanFolder(index)"
                        :disabled="scanningFolders.has(folder)"
                        class="text-ui-dim hover:text-red-500 border-none bg-transparent cursor-pointer p-1 disabled:opacity-30"
                    >
                      <div class="i-mdi-delete text-sm"></div>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Mouse Tab -->
          <div v-if="activeTab === 'mouse'" class="flex flex-col gap-4">
            <h3 class="text-xs font-bold text-ui-dim uppercase mb-2">Mouse Buttons</h3>
            <div v-for="key in [['mouse_left', 'Left Click'], ['mouse_right', 'Right Click'], ['mouse_middle', 'Middle Click'], ['mouse_xbutton1', 'Side Button 1 (Back)'], ['mouse_xbutton2', 'Side Button 2 (Forward)']]" :key="key[0]" class="flex items-center justify-between">
              <span class="text-sm">{{ key[1] }}</span>
              <select v-model="(config as any)[key[0]]" class="bg-ui-hover text-ui-text border border-ui-border rounded px-2 py-1 text-sm w-40 outline-none">
                <option v-for="opt in actionOptions" :value="opt.value">{{ opt.label }}</option>
              </select>
            </div>

            <h3 class="text-xs font-bold text-ui-dim uppercase mt-4 mb-2">Mouse Wheel</h3>
            <div v-for="key in [['mouse_wheel_up', 'Wheel Up'], ['mouse_wheel_down', 'Wheel Down']]" :key="key[0]" class="flex items-center justify-between">
              <span class="text-sm">{{ key[1] }}</span>
              <select v-model="(config as any)[key[0]]" class="bg-ui-hover text-ui-text border border-ui-border rounded px-2 py-1 text-sm w-40 outline-none">
                <option v-for="opt in actionOptions" :value="opt.value">{{ opt.label }}</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-5 py-3 bg-ui-hover flex justify-end gap-3 border-t border-ui-border flex-none">
        <button class="px-4 py-1.5 rounded text-sm text-ui-dim hover:bg-ui-hover transition-colors border-none bg-transparent cursor-pointer" @click="emit('close')">Cancel</button>
        <button class="px-4 py-1.5 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 border-none cursor-pointer" @click="saveAndClose">Save</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
</style>