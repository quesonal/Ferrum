<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useImageStore } from '../stores/imageStore';

const { t } = useI18n();
const imageStore = useImageStore();
const { metaBackfillProgress } = storeToRefs(imageStore);

const visible = computed(() => metaBackfillProgress.value !== null);
const label = computed(() => {
  const p = metaBackfillProgress.value;
  if (!p) return '';
  return t('metaBackfill.indexing', { processed: p.processed, total: p.total });
});
</script>

<template>
  <Transition name="chip">
    <div v-if="visible" class="meta-backfill-chip" role="status" aria-live="polite">
      <span class="i-mdi-database-refresh mr-1"></span>
      <span>{{ label }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.meta-backfill-chip {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 100; /* above ControlBar, below modal z-150 */
  padding: 0.4rem 0.7rem;
  background: var(--toast-bg);
  color: var(--ui-text);
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  font-size: 11px;
  line-height: 1;
  display: flex;
  align-items: center;
  backdrop-filter: blur(4px);
  pointer-events: none; /* informational only; never blocks input */
  user-select: none;
}

.chip-enter-active,
.chip-leave-active {
  transition: opacity 200ms ease;
}
.chip-enter-from,
.chip-leave-to {
  opacity: 0;
}
</style>