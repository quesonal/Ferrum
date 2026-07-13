<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTagStore } from '../../stores/tagStore';
import { useConfirm } from '../../composables/useConfirm';

const tagStore = useTagStore();
const { t } = useI18n();

// showConfirm is provided by App.vue. Used here for the destructive
// "delete tag" action — Tag CRUD otherwise just surfaces Rust errors
// via console.warn. `useConfirm()` returns null outside the app
// shell, so we fail closed (refuse to delete).
const showConfirm = useConfirm();

// Load tags lazily on first mount (this tab is v-if'd, so mount ==
// first entry). Slice 2 has no other consumer for `tagStore.tags`; if
// a later slice needs them at app boot, move this to App.vue / main.ts.
onMounted(async () => {
  if (tagStore.tags.length === 0) {
    await tagStore.loadAll();
  }
});

const newTagName = ref('');
const newTagInputRef = ref<HTMLInputElement | null>(null);
const editingTagId = ref<number | null>(null);
const editingTagName = ref('');
const editingInputRef = ref<HTMLInputElement | null>(null);

async function createTag() {
  const name = newTagName.value.trim();
  if (!name) return;
  try {
    await tagStore.create(name);
    newTagName.value = '';
    newTagInputRef.value?.focus();
  } catch (e) {
    console.warn('[settings] create tag failed:', e);
  }
}

async function startEditTag(id: number, currentName: string) {
  editingTagId.value = id;
  editingTagName.value = currentName;
  await nextTick();
  editingInputRef.value?.focus();
  editingInputRef.value?.select();
}

async function commitEditTag() {
  const id = editingTagId.value;
  const name = editingTagName.value.trim();
  if (id === null) return;
  if (!name) {
    cancelEditTag();
    return;
  }
  editingTagId.value = null;
  try {
    await tagStore.rename(id, name);
  } catch (e) {
    console.warn('[settings] rename tag failed:', e);
  }
}

function cancelEditTag() {
  editingTagId.value = null;
  editingTagName.value = '';
}

async function deleteTag(id: number, name: string) {
  if (!showConfirm) {
    console.warn('[settings] showConfirm not provided; refusing to delete without confirmation');
    return;
  }
  const ok = await showConfirm(
    t('settings.tags.deleteConfirmTitle'),
    t('settings.tags.deleteConfirmMessage', { name }),
    { danger: true, confirmText: t('settings.tags.delete') },
  );
  if (!ok) return;
  try {
    await tagStore.remove(id);
  } catch (e) {
    console.warn('[settings] delete tag failed:', e);
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 min-h-0">
    <h3 class="text-xs font-bold text-ui-dim uppercase mb-2">{{ $t('settings.tags.newTag') }}</h3>
    <div class="flex gap-2">
      <input
          ref="newTagInputRef"
          v-model="newTagName"
          type="text"
          :placeholder="$t('settings.tags.newTagPlaceholder')"
          class="flex-1 bg-ui-hover text-ui-text border border-ui-border rounded px-2 py-1 text-sm outline-none focus:border-blue-500"
          @keyup.enter="createTag"
      />
      <button
          @click="createTag"
          :disabled="!newTagName.trim()"
          class="px-3 py-1 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 border-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {{ $t('settings.tags.create') }}
      </button>
    </div>

    <h3 class="text-xs font-bold text-ui-dim uppercase mt-4 mb-2">{{ $t('settings.tabs.tags') }}</h3>
    <div v-if="tagStore.loading" class="text-sm text-ui-dim">...</div>
    <div v-else-if="tagStore.tags.length === 0" class="text-sm text-ui-dim italic">
      {{ $t('settings.tags.empty') }}
    </div>
    <div v-else class="flex flex-col gap-1 overflow-y-auto min-h-0">
      <!--
        Edit row is a single shared input rendered above the list
        (intentionally NOT inside `v-for`). Vue auto-promotes
        `ref` inside `v-for` to an array, which broke focus +
        select when only the row under edit shows an input.
      -->
      <div
          v-if="editingTagId !== null"
          class="flex gap-2 items-center bg-blue-600/15 border border-blue-500 rounded px-3 py-1.5"
      >
        <span class="text-sm text-ui-dim flex-none">{{ $t('settings.tags.renamePrompt') }}:</span>
        <input
            ref="editingInputRef"
            v-model="editingTagName"
            type="text"
            class="flex-1 bg-ui-bg text-ui-text border border-ui-border rounded px-2 py-0.5 text-sm outline-none focus:border-blue-500"
            @keyup.enter="commitEditTag"
            @keyup.esc="cancelEditTag"
        />
        <button
            @click="commitEditTag"
            class="px-2 py-0.5 text-sm bg-blue-600 text-white rounded border-none cursor-pointer"
        >{{ $t('settings.tags.save') }}</button>
        <button
            @click="cancelEditTag"
            class="px-2 py-0.5 text-sm bg-ui-hover text-ui-text rounded border-none cursor-pointer"
        >×</button>
      </div>
      <div
          v-for="tag in tagStore.tags"
          :key="tag.id"
          class="flex items-center justify-between bg-ui-hover/40 rounded px-3 py-1.5 group"
      >
        <span
            class="flex-1 text-sm cursor-pointer"
            :class="editingTagId === tag.id ? 'text-blue-400 font-medium' : ''"
            @click="startEditTag(tag.id, tag.name)"
        >{{ tag.name }}</span>

        <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
              @click="startEditTag(tag.id, tag.name)"
              class="p-1 rounded hover:bg-ui-hover text-ui-dim hover:text-ui-text border-none bg-transparent cursor-pointer"
              :title="$t('settings.tags.rename')"
          >
            <div class="i-mdi-pencil"></div>
          </button>
          <button
              @click="deleteTag(tag.id, tag.name)"
              class="p-1 rounded hover:bg-ui-hover text-ui-dim hover:text-red-500 border-none bg-transparent cursor-pointer"
              :title="$t('settings.tags.delete')"
          >
            <div class="i-mdi-delete"></div>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
