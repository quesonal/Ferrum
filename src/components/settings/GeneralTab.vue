<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { AppTheme, ScanMode, useConfigStore } from '../../stores/configStore';
import ToggleRow from './ToggleRow.vue';
import ScanFoldersSection from './ScanFoldersSection.vue';

const configStore = useConfigStore();
const { config } = storeToRefs(configStore);
const { locale } = useI18n();

const switchLanguage = async (lang: string) => {
  locale.value = lang;
  document.documentElement.lang = lang === 'zh-CN' ? 'zh-CN' : 'en';
  await configStore.setLanguage(lang);
};

const resetBgColor = () => {
  config.value.background_color = config.value.theme === 'light' ? '#ffffff' : '#1a1a1a';
};

const predefinedColors = ['#1a1a1a', '#000000', '#ffffff', '#e5e7eb'];
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-2">
      <label class="text-xs text-ui-dim uppercase tracking-wider">{{ $t('settings.theme') }}</label>
      <div class="flex bg-ui-hover p-1 rounded-lg">
        <button
            class="flex-1 py-1.5 text-sm rounded-md border-none cursor-pointer transition-all flex items-center justify-center gap-2"
            :class="config.theme === AppTheme.Dark ? 'bg-ui-bg shadow text-ui-text' : 'bg-transparent text-ui-dim'"
            @click="config.theme = AppTheme.Dark"
        >
          <div class="i-mdi-weather-night"></div> {{ $t('settings.dark') }}
        </button>
        <button
            class="flex-1 py-1.5 text-sm rounded-md border-none cursor-pointer transition-all flex items-center justify-center gap-2"
            :class="config.theme === AppTheme.Light ? 'bg-ui-bg shadow text-ui-text' : 'bg-transparent text-ui-dim'"
            @click="config.theme = AppTheme.Light"
        >
          <div class="i-mdi-white-balance-sunny"></div> {{ $t('settings.light') }}
        </button>
      </div>
    </div>

    <!-- Language Switcher -->
    <div class="flex flex-col gap-2 border-t border-ui-border pt-3">
      <label class="text-xs text-ui-dim uppercase tracking-wider">{{ $t('settings.language') }}</label>
      <select
          :value="locale"
          @change="switchLanguage(($event.target as HTMLSelectElement).value)"
          class="bg-ui-hover text-ui-text border border-ui-border rounded px-3 py-2 text-sm outline-none"
      >
        <option value="en">English</option>
        <option value="zh-CN">中文</option>
      </select>
    </div>

    <div class="flex flex-col gap-2">
      <div class="flex justify-between items-end">
        <label class="text-xs text-ui-dim uppercase tracking-wider">{{ $t('settings.canvasBackground') }}</label>
        <button class="text-xs text-blue-500 border-none bg-transparent cursor-pointer hover:underline" @click="resetBgColor">{{ $t('settings.resetDefault') }}</button>
      </div>

      <div class="flex items-center gap-3">
        <div class="relative w-10 h-10 shrink-0">
          <input
              type="color"
              v-model="config.background_color"
              class="absolute inset-0 w-full h-full cursor-pointer border-none bg-transparent p-0
                   [&::-webkit-color-swatch-wrapper]:p-0
                   [&::-webkit-color-swatch]:rounded-full
                   [&::-webkit-color-swatch]:border-2
                   [&::-webkit-color-swatch]:border-ui-border"
          />
        </div>
        <div class="flex gap-2.5">
          <button
              v-for="color in predefinedColors"
              :key="color"
              class="w-7 h-7 rounded-full border border-white/10 cursor-pointer hover:scale-110 active:scale-95 transition-all shadow-sm"
              :class="{ 'ring-2 ring-blue-500 ring-offset-2 ring-offset-ui-bg': config.background_color === color }"
              :style="{ backgroundColor: color }"
              @click="config.background_color = color"
          ></button>
        </div>
      </div>
    </div>

    <ToggleRow v-model="config.show_control_bar" :label="$t('settings.showControlBar')" />
    <ToggleRow v-model="config.show_histogram" :label="$t('settings.showHistogram')" />
    <ToggleRow
        v-model="config.delete_confirm"
        :label="$t('settings.confirmBeforeDelete')"
        :hint="$t('settings.confirmBeforeDeleteHint')"
    />

    <!-- Scan Mode -->
    <div class="flex flex-col gap-2 border-t border-ui-border pt-3">
      <label class="text-xs text-ui-dim uppercase tracking-wider">{{ $t('settings.scanMode') }}</label>
      <select
          v-model="config.scan_mode"
          class="bg-ui-hover text-ui-text border border-ui-border rounded px-3 py-2 text-sm outline-none"
      >
        <option :value="ScanMode.Auto">{{ $t('settings.scanModeOptions.auto') }}</option>
        <option :value="ScanMode.Everything">{{ $t('settings.scanModeOptions.everything') }}</option>
        <option :value="ScanMode.Mft">{{ $t('settings.scanModeOptions.mft') }}</option>
        <option :value="ScanMode.WalkDir">{{ $t('settings.scanModeOptions.walkdir') }}</option>
      </select>
      <span class="text-xs text-ui-dim">
        <template v-if="config.scan_mode === ScanMode.Auto">
          {{ $t('settings.scanModeDescriptions.auto') }}
        </template>
        <template v-else-if="config.scan_mode === ScanMode.Everything">
          {{ $t('settings.scanModeDescriptions.everything') }}
        </template>
        <template v-else-if="config.scan_mode === ScanMode.Mft">
          {{ $t('settings.scanModeDescriptions.mft') }}
        </template>
        <template v-else>
          {{ $t('settings.scanModeDescriptions.walkdir') }}
        </template>
      </span>
    </div>

    <ScanFoldersSection />
  </div>
</template>
