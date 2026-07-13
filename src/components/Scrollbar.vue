<!-- components/Scrollbar.vue -->
<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  maxSpeed?: number; // 操纵杆推到底时的最高限速 (px/帧)，默认 150 (相当于 9000px/秒)
}>();

const emit = defineEmits<{
  'scroll-step': [velocity: number];
  'jump-top': [];
  'jump-bottom': [];
}>();

const trackRef = ref<HTMLElement | null>(null);
const thumbRef = ref<HTMLElement | null>(null);

const isDragging = ref(false);
const thumbOffset = ref(0);
let startY = 0;
let maxTravel = 100;

let currentVelocity = 0;
let rafId: number | null = null;

const MAX_SPEED = props.maxSpeed || 150;

function startDrag(e: PointerEvent) {
  isDragging.value = true;
  startY = e.clientY;

  if (trackRef.value && thumbRef.value) {
    maxTravel = (trackRef.value.clientHeight - thumbRef.value.clientHeight) / 2;
  }

  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', endDrag);
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'ns-resize';

  if (!rafId) loop();
}

function onDrag(e: PointerEvent) {
  if (!isDragging.value) return;

  let deltaY = e.clientY - startY;

  if (deltaY > maxTravel) deltaY = maxTravel;
  if (deltaY < -maxTravel) deltaY = -maxTravel;

  thumbOffset.value = deltaY;

  const ratio = deltaY / maxTravel;
  const sign = Math.sign(ratio);
  const curve = Math.pow(Math.abs(ratio), 2);

  currentVelocity = sign * curve * MAX_SPEED;
}

function endDrag() {
  isDragging.value = false;
  thumbOffset.value = 0;
  currentVelocity = 0;

  window.removeEventListener('pointermove', onDrag);
  window.removeEventListener('pointerup', endDrag);
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
}

function loop() {
  if (isDragging.value && currentVelocity !== 0) {
    emit('scroll-step', currentVelocity);
  }

  if (isDragging.value) {
    rafId = requestAnimationFrame(loop);
  } else {
    rafId = null;
  }
}
</script>

<template>
  <div class="absolute right-0 top-0 bottom-0 w-[18px] bg-ui-bg border-l border-ui-border flex flex-col z-50 select-none box-border">

    <!-- 顶部直达按钮 -->
    <button
        class="w-full h-7 p-0 bg-transparent border-none flex items-center justify-center text-ui-dim cursor-pointer transition-colors hover:bg-ui-hover hover:text-ui-text shrink-0"
        @click="emit('jump-top')"
        :title="$t('scrollbar.scrollToTop')"
    >
      <div class="i-mdi-chevron-up text-sm"></div>
    </button>

    <!-- 操纵杆轨道 -->
    <div class="flex-1 relative flex justify-center items-center bg-black/10 shadow-inner w-full overflow-hidden" ref="trackRef">

      <!-- 滑块 (Thumb) -->
      <div
          class="w-3 h-12 rounded bg-ui-dim opacity-60 hover:opacity-100 active:bg-ui-text active:opacity-90 border border-ui-border flex flex-col items-center justify-center gap-[3px] shadow-sm cursor-ns-resize will-change-transform"
          ref="thumbRef"
          :style="{
          transform: `translateY(${thumbOffset}px)`,
          transition: isDragging ? 'none' : 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)'
        }"
          @pointerdown.stop="startDrag"
      >
        <!-- 操纵杆防滑纹理 (适配主题的刻痕) -->
        <div class="w-1.5 h-[2px] bg-ui-bg rounded-full opacity-80"></div>
        <div class="w-1.5 h-[2px] bg-ui-bg rounded-full opacity-80"></div>
        <div class="w-1.5 h-[2px] bg-ui-bg rounded-full opacity-80"></div>
      </div>

    </div>

    <!-- 底部直达按钮 -->
    <button
        class="w-full h-7 p-0 bg-transparent border-none flex items-center justify-center text-ui-dim cursor-pointer transition-colors hover:bg-ui-hover hover:text-ui-text shrink-0"
        @click="emit('jump-bottom')"
        :title="$t('scrollbar.scrollToBottom')"
    >
      <div class="i-mdi-chevron-down text-sm"></div>
    </button>

  </div>
</template>