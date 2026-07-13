<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue';
import {useI18n} from 'vue-i18n';
import {useTagStore, type Tag} from '../stores/tagStore';
import {useModalKeyboardGuard} from '../composables/useModalKeyboardGuard';

interface Props {
  visible: boolean;
  imageId: string | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
}>();

const {t} = useI18n();
const tagStore = useTagStore();

// Currently-attached tag ids for `props.imageId`. We start from
// the cached entry (if any) so re-opening the picker for the same
// image preserves the user's previous selection mid-edit.
const selectedIds = ref<Set<number>>(new Set());
const search = ref('');

// Tag list filtered by search (case-insensitive substring match on
// the trimmed query). Empty query → show all tags.
const filteredTags = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return tagStore.tags;
  return tagStore.tags.filter((t) => t.name.toLowerCase().includes(q));
});

// Tags currently attached to the image being edited. Loaded from
// cache when modal opens, falling back to a fetch.
const attachedTags = computed<Tag[]>(() => {
  if (!props.imageId) return [];
  return tagStore.tagsForImage.get(props.imageId) ?? [];
});

// When the picker opens for an image, ensure we have fresh tags
// for that image in the cache (so the checkbox pre-selection
// reflects reality). The first time we open, this is an IPC hit;
// subsequent opens come from `tagsForImage` cache (0 IPC).
watch(
  () => props.visible,
  async (visible) => {
    if (!visible || !props.imageId) return;
    if (!tagStore.tags.length) {
      await tagStore.loadAll();
    }
    const cached = tagStore.tagsForImage.get(props.imageId);
    if (!cached) {
      try {
        await tagStore.loadForImage(props.imageId);
      } catch (e) {
        console.warn('[TagPicker] loadForImage failed:', e);
      }
    }
    const ids = new Set<number>();
    for (const t of tagStore.tagsForImage.get(props.imageId) ?? []) {
      ids.add(t.id);
    }
    selectedIds.value = ids;
    search.value = '';
    await nextTick();
    searchInputRef.value?.focus();
  },
  {immediate: true},
);

// Inline-create: when the typed search doesn't match any existing
// tag, the input row exposes a "+ Create 'foo'" affordance. We
// stash the typed name in `newTagName` and create on Apply.
const newTagName = ref('');
const creating = ref(false);

const canCreateNew = computed(() => {
  const q = search.value.trim();
  if (!q) return false;
  // Don't propose a duplicate (case-insensitive) of an existing tag.
  return !tagStore.tags.some(
    (t) => t.name.toLowerCase() === q.toLowerCase(),
  );
});

async function createNewTag() {
  const q = search.value.trim();
  if (!q) return;
  creating.value = true;
  try {
    const id = await tagStore.create(q);
    selectedIds.value.add(id);
    newTagName.value = q;
    search.value = '';
  } catch (e) {
    console.warn('[TagPicker] create tag failed:', e);
  } finally {
    creating.value = false;
  }
}

function toggleTag(id: number) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id);
  } else {
    selectedIds.value.add(id);
  }
  // Force reactivity for Set add/delete (shallowReactive on outer
  // Map, but Set mutation isn't tracked).
  selectedIds.value = new Set(selectedIds.value);
}

async function apply() {
  if (!props.imageId) return;
  const ids = [...selectedIds.value];
  try {
    await tagStore.setTagsForImage(props.imageId, ids);
    emit('update:visible', false);
  } catch (e) {
    console.warn('[TagPicker] setTagsForImage failed:', e);
  }
}

function cancel() {
  emit('update:visible', false);
}

const searchInputRef = ref<HTMLInputElement | null>(null);

useModalKeyboardGuard({
  visible: () => props.visible,
  onEscape: cancel,
  onEnter: apply,
  // When focus is in the search input, let Enter fall through to the
  // input's default behavior (don't accidentally trigger apply while
  // the user is typing a new tag name).
  shouldLetEnterThrough: () => document.activeElement === searchInputRef.value,
});
</script>

<template>
  <Teleport to="body">
    <Transition name="tag-picker-fade">
      <div
          v-if="visible"
          class="fixed inset-x-0 top-8 bottom-0 z-[160] bg-black/60 backdrop-blur-sm flex justify-center items-center"
          @click.self="cancel"
      >
        <div
            class="bg-ui-bg w-100 max-w-[90vw] max-h-[80vh] rounded-xl shadow-2xl border border-ui-border text-ui-text overflow-hidden flex flex-col"
            role="dialog"
            aria-modal="true"
        >
          <div class="px-5 py-3 border-b border-ui-border flex items-center gap-2">
            <div class="i-mdi-tag-multiple text-ui-accent text-xl"></div>
            <h3 class="font-medium text-base m-0 flex-1">{{ t('tagPicker.title') }}</h3>
            <span v-if="attachedTags.length" class="text-xs text-ui-dim">
              {{ t('tagPicker.selectedCount', {n: selectedIds.size}) }}
            </span>
          </div>

          <div class="px-4 py-3 border-b border-ui-border">
            <input
                ref="searchInputRef"
                v-model="search"
                type="text"
                :placeholder="t('tagPicker.searchPlaceholder')"
                class="w-full bg-ui-hover text-ui-text border border-ui-border rounded px-3 py-1.5 text-sm outline-none focus:border-ui-accent"
            />
            <button
                v-if="canCreateNew"
                @click="createNewTag"
                :disabled="creating"
                class="mt-2 w-full text-left text-sm text-ui-accent hover:text-ui-accent-hover bg-transparent border border-dashed border-ui-accent rounded px-3 py-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              + {{ t('tagPicker.createNew', {name: search.trim()}) }}
            </button>
          </div>

          <div class="flex-1 overflow-y-auto px-2 py-2 min-h-0">
            <div v-if="tagStore.tags.length === 0" class="text-sm text-ui-dim italic px-3 py-2">
              {{ t('settings.tags.empty') }}
            </div>
            <div v-else-if="filteredTags.length === 0" class="text-sm text-ui-dim italic px-3 py-2">
              {{ t('tagPicker.noMatches') }}
            </div>
            <label
                v-for="tag in filteredTags"
                :key="tag.id"
                class="flex items-center gap-2 px-3 py-1.5 rounded hover:bg-ui-hover cursor-pointer"
            >
              <input
                  type="checkbox"
                  :checked="selectedIds.has(tag.id)"
                  @change="toggleTag(tag.id)"
                  class="accent-[var(--ui-accent)] cursor-pointer"
              />
              <span class="text-sm flex-1">{{ tag.name }}</span>
              <span v-if="tag.color" class="w-3 h-3 rounded-full shrink-0" :style="{backgroundColor: tag.color}"></span>
            </label>
          </div>

          <div class="px-5 py-3 bg-ui-hover flex justify-end gap-2 border-t border-ui-border">
            <button
                @click="cancel"
                class="px-4 py-1.5 rounded text-sm bg-transparent text-ui-text hover:bg-ui-border border-none cursor-pointer"
            >
              {{ t('tagPicker.cancel') }}
            </button>
            <button
                @click="apply"
                class="px-4 py-1.5 rounded text-sm bg-ui-accent text-white hover:bg-ui-accent-hover border-none cursor-pointer"
            >
              {{ t('tagPicker.apply') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tag-picker-fade-enter-active,
.tag-picker-fade-leave-active {
  transition: opacity 0.15s ease;
}
.tag-picker-fade-enter-from,
.tag-picker-fade-leave-to {
  opacity: 0;
}
</style>
