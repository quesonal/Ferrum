<script setup lang="ts">
import { ref } from 'vue';
import { useConfigStore } from '../stores/configStore';
import GeneralTab from './settings/GeneralTab.vue';
import MouseTab from './settings/MouseTab.vue';
import TagsTab from './settings/TagsTab.vue';

const emit = defineEmits<{ close: [] }>();
const configStore = useConfigStore();

const tabs = [
  { id: 'general', labelKey: 'settings.tabs.general' },
  { id: 'mouse', labelKey: 'settings.tabs.mouse' },
  { id: 'tags', labelKey: 'settings.tabs.tags' },
] as const;

type TabId = (typeof tabs)[number]['id'];

const activeTab = ref<TabId>('general');

const closeSettings = async () => {
  await configStore.saveConfig();
  emit('close');
};
</script>

<template>
  <div class="fixed inset-x-0 top-8 bottom-0 z-[100] bg-black/60 backdrop-blur-sm flex justify-center items-center" @click.self="emit('close')">
    <div class="bg-ui-bg w-140 max-h-[85vh] min-h-[520px] rounded-xl shadow-2xl border border-ui-border text-ui-text overflow-hidden flex flex-col transition-all">

      <!-- Header -->
      <div class="px-5 py-3 border-b border-ui-border bg-ui-hover flex justify-between items-center flex-none">
        <span class="font-medium">{{ $t('settings.title') }}</span>
        <button class="i-mdi-close text-ui-dim hover:text-ui-text cursor-pointer bg-transparent border-none" @click="emit('close')"></button>
      </div>

      <div class="flex flex-1 overflow-hidden">
        <!-- Sidebar -->
        <div class="w-32 border-r border-ui-border flex flex-col p-2 gap-1 bg-ui-bg/50">
          <button
              v-for="tab in tabs"
              :key="tab.id"
              @click="activeTab = tab.id"
              class="px-3 py-2 rounded-md text-sm text-left border-none cursor-pointer transition-colors bg-transparent"
              :class="activeTab === tab.id ? 'bg-ui-accent-soft text-ui-accent' : 'text-ui-dim hover:bg-ui-hover'"
          >
            {{ $t(tab.labelKey) }}
          </button>
        </div>

        <!-- Content -->
        <div class="flex-1 p-4 overflow-y-auto">
          <GeneralTab v-if="activeTab === 'general'" />
          <MouseTab v-else-if="activeTab === 'mouse'" />
          <TagsTab v-else-if="activeTab === 'tags'" />
        </div>
      </div>

      <!-- Footer -->
      <div class="px-5 py-3 bg-ui-hover flex justify-end gap-3 border-t border-ui-border flex-none">
        <button class="px-4 py-1.5 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 border-none cursor-pointer" @click="closeSettings">{{ $t('settings.done') }}</button>
      </div>
    </div>
  </div>
</template>
