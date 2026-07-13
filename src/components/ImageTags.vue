<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTagStore } from '../stores/tagStore';
import TagPicker from './TagPicker.vue';
import { useRaceCounter } from '../utils/useRaceCounter';

const props = defineProps<{
  imageId: string | null;
}>();

const { t } = useI18n();
const tagStore = useTagStore();

// Per-image tag fetch. A request-version stamp keeps the slow IPC
// `library_get_image_tags` for an old image from overwriting the
// chips row for a newer one. `immediate: true` covers the URL-direct
// visit case (component mounts with `imageId` already set).
// Filesystem mode never sets `currentImageId`, so this component is
// unrendered there and the watcher never runs.
const tagsVersion = useRaceCounter('image-tags:watch');
watch(() => props.imageId, async (id) => {
  if (!id) return;
  const gen = tagsVersion.begin();
  try {
    if (tagStore.tagsForImage.has(id) || tagStore.pendingWrites.has(id)) {
      // Already cached OR mid-write — no fetch needed. (Optimistic
      // writes write directly to the Map in `setTagsForImage`.)
      return;
    }
    await tagStore.loadForImage(id);
    if (!tagsVersion.isLatest(gen)) return;
  } catch (e) {
    if (!tagsVersion.isLatest(gen)) return;
    console.warn('[ImageTags] loadForImage failed:', e);
  }
}, {immediate: true});

const tagPickerVisible = ref(false);
function openTagPicker() {
  tagPickerVisible.value = true;
}

async function removeTagFromImage(tagId: number) {
  const id = props.imageId;
  if (!id) return;
  const current = tagStore.tagsForImage.get(id) ?? [];
  const next = current.filter((t) => t.id !== tagId).map((t) => t.id);
  try {
    await tagStore.setTagsForImage(id, next);
  } catch (e) {
    console.warn('[ImageTags] remove tag failed:', e);
  }
}

const currentImageTags = computed(() => {
  const id = props.imageId;
  if (!id) return [];
  return tagStore.tagsForImage.get(id) ?? [];
});
</script>

<template>
  <!--
    Per-image tags section. Library mode only — filesystem mode never
    sets `currentImageId`, so the parent leaves this unrendered. Chips
    with × to remove; "+ Add Tag" opens the teleported TagPicker.
    mousedown/wheel are stopped on the section so clicks never start an
    image pan / wheel-zoom underneath.
  -->
  <div
      class="tags-panel"
      @mousedown.stop
      @wheel.stop
  >
    <div class="section-header">
      <span class="section-title">{{ t('imageView.tags.title') }}</span>
    </div>
    <div class="tag-list">
      <span
          v-for="tag in currentImageTags"
          :key="tag.id"
          class="tag-chip"
      >
        {{ tag.name }}
        <button
            @click="removeTagFromImage(tag.id)"
            class="tag-remove"
            :title="t('imageView.tags.remove')"
        >
          <div class="i-mdi-close text-xs"></div>
        </button>
      </span>
      <span
          v-if="currentImageTags.length === 0"
          class="tag-empty"
      >
        {{ t('imageView.tags.noTags') }}
      </span>
      <button
          @click="openTagPicker"
          class="tag-add"
      >
        <div class="i-mdi-plus text-xs"></div>
        {{ t('imageView.tags.addTag') }}
      </button>
    </div>

    <TagPicker
        v-model:visible="tagPickerVisible"
        :image-id="imageId"
    />
  </div>
</template>

<style scoped>
/* Tags 分区：扁平区块，glass 由 .sidebar-column 统一提供 */
.tags-panel {
  width: 100%;
  box-sizing: border-box;
  flex: 0 1 auto;
  min-height: 164px;
  color: var(--glass-text);
}

.tags-panel .section-header {
  margin-bottom: 8px;
}
.tags-panel .section-title {
  font-size: 10px;
  color: var(--glass-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  font-weight: 700;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--glass-fill);
  border: 1px solid var(--glass-border);
  color: var(--glass-text);
}

.tag-remove {
  display: inline-flex;
  color: var(--glass-text-dim);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  transition: color 0.2s ease;
}
.tag-remove:hover {
  color: #ff3b30;
}

.tag-empty {
  font-size: 11px;
  color: var(--glass-text-dim);
  font-style: italic;
}

.tag-add {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--glass-fill);
  border: 1px dashed var(--ui-accent);
  color: var(--ui-accent);
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease;
}
.tag-add:hover {
  color: var(--ui-accent-hover);
  border-color: var(--ui-accent-hover);
}
</style>
