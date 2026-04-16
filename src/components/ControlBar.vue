<!-- components/ControlBar.vue -->
<script setup lang="ts">
// defineProps<{
//   hasFile: boolean;
// }>();

const emit = defineEmits<{
  (e: 'prev'): void;
  (e: 'next'): void;
  (e: 'toggle-fit'): void;
}>();
</script>

<template>
  <div class="h-12 bg-ui-bg flex justify-center items-center gap-10 border-t border-ui-border">
    <button class="nav-btn" @click="emit('prev')">
      <div class="i-mdi-chevron-left text-3xl"></div>
    </button>
    <button class="nav-btn" @click="emit('next')">
      <div class="i-mdi-chevron-right text-3xl"></div>
    </button>
  </div>
</template>

<style scoped>
.nav-btn {
  @apply flex items-center justify-center w-10 h-10 rounded-full border-none bg-transparent text-[var(--ui-text-dim)] cursor-pointer transition-all;
}
/* 使用 CSS 变量控制 Hover */
.nav-btn:hover {
  background-color: var(--btn-hover);
  color: var(--ui-text);
}
.nav-btn:active {
  transform: scale(0.95);
}
</style>