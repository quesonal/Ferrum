<script setup lang="ts">
import {computed, ref, onBeforeUnmount, watch, onMounted} from 'vue';

interface Props {
  isLoading?: boolean;
  imageSrc: string;
  naturalWidth: number;
  naturalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  translateX: number;
  translateY: number;
}

const props = withDefaults(defineProps<Props>(), { isLoading: false });
const emit = defineEmits<{
  navigate: [x: number, y: number];
  zoom: [direction: 'in' | 'out', thumbX: number, thumbY: number];
}>();

// 缩略图固定交互区域大小
const MAX_THUMB_WIDTH = 200;
const MAX_THUMB_HEIGHT = 150;

// 拖动状态
const isDragging = ref(false);
const isAnimating = ref(false);
const dragStartPos = ref({ x: 0, y: 0 });
const dragStartTranslate = ref({ x: 0, y: 0 });

// 本地临时坐标。拖拽时蓝框位置由它决定
const targetTranslate = ref({ x: 0, y: 0 });
const localTranslate = ref({ x: 0, y: 0 });
let animationFrameId: number | null = null;

const clampTranslate = (tx: number, ty: number) => {
  const { naturalWidth, naturalHeight, viewportWidth, viewportHeight, scale } = props;

  const displayedWidth = naturalWidth * scale;
  const displayedHeight = naturalHeight * scale;

  const maxTx = Math.max(0, (displayedWidth - viewportWidth) / 2);
  const maxTy = Math.max(0, (displayedHeight - viewportHeight) / 2);

  return {
    x: Math.max(-maxTx, Math.min(maxTx, tx)),
    y: Math.max(-maxTy, Math.min(maxTy, ty))
  };
};

const activeTranslate = computed(() => {
  return (isDragging.value || isAnimating.value)
      ? { x: localTranslate.value.x, y: localTranslate.value.y }
      : { x: props.translateX, y: props.translateY };
})

// 计算缩略图实际尺寸（保持比例）
const thumbSize = computed(() => {
  const { naturalWidth, naturalHeight } = props;
  if (!naturalWidth || !naturalHeight) return { width: 0, height: 0, scale: 1 };

  const scaleX = MAX_THUMB_WIDTH / naturalWidth;
  const scaleY = MAX_THUMB_HEIGHT / naturalHeight;
  const scale = Math.min(scaleX, scaleY, 1);

  return { width: naturalWidth * scale, height: naturalHeight * scale, scale };
});

// 计算视窗框在缩略图中的位置和大小
const viewportRect = computed(() => {
  const { naturalWidth, naturalHeight, viewportWidth, viewportHeight, scale } = props;
  if (!naturalWidth || !naturalHeight) return null;

  const imgX = (-viewportWidth / 2 - activeTranslate.value.x) / scale + naturalWidth / 2;
  const imgY = (-viewportHeight / 2 - activeTranslate.value.y) / scale + naturalHeight / 2;
  const imgW = viewportWidth / scale;
  const imgH = viewportHeight / scale;

  const x = Math.max(0, imgX);
  const y = Math.max(0, imgY);
  const w = Math.min(naturalWidth, imgX + imgW) - x;
  const h = Math.min(naturalHeight, imgY + imgH) - y;

  const thumbScale = thumbSize.value.scale;
  return {
    x: x * thumbScale,
    y: y * thumbScale,
    width: w * thumbScale,
    height: h * thumbScale
  };
});

// fit 时视窗框覆盖整个缩略图，去掉白边避免边缘出现一条白线
const isViewportFull = computed(() => {
  const r = viewportRect.value;
  if (!r || !thumbSize.value.width || !thumbSize.value.height) return false;
  return r.x <= 0.5
      && r.y <= 0.5
      && Math.abs(r.width - thumbSize.value.width) <= 0.5
      && Math.abs(r.height - thumbSize.value.height) <= 0.5;
});

// 将缩略图坐标转换为 translate 值
const thumbPosToTranslate = (thumbX: number, thumbY: number) => {
  const { naturalWidth, naturalHeight, scale } = props;
  const thumbScale = thumbSize.value.scale;
  const targetImgX = thumbX / thumbScale;
  const targetImgY = thumbY / thumbScale;

  return {
    x: (naturalWidth / 2 - targetImgX) * scale,
    y: (naturalHeight / 2 - targetImgY) * scale
  };
};

const startSmoothingLoop = () => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  isAnimating.value = true;

  const loop = () => {
    const dx = targetTranslate.value.x - localTranslate.value.x;
    const dy = targetTranslate.value.y - localTranslate.value.y;

    if (!isDragging.value && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      localTranslate.value = { x: targetTranslate.value.x, y: targetTranslate.value.y };
      emit('navigate', localTranslate.value.x, localTranslate.value.y);
      isAnimating.value = false;
      return;
    }

    const smoothingFactor = 0.35;
    localTranslate.value = {
      x: localTranslate.value.x + dx * smoothingFactor,
      y: localTranslate.value.y + dy * smoothingFactor
    };

    emit('navigate', localTranslate.value.x, localTranslate.value.y);
    animationFrameId = requestAnimationFrame(loop);
  };

  loop();
};

const handleMouseDown = (e: MouseEvent) => {
  if (props.isLoading) return;
  isDragging.value = true;

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const clickXOuter = e.clientX - rect.left;
  const clickYOuter = e.clientY - rect.top;

  const offsetX = (MAX_THUMB_WIDTH - thumbSize.value.width) / 2;
  const offsetY = (MAX_THUMB_HEIGHT - thumbSize.value.height) / 2;

  const clickX = clickXOuter - offsetX;
  const clickY = clickYOuter - offsetY;

  const rawTranslate = thumbPosToTranslate(clickX, clickY);
  const clampedTranslate = clampTranslate(rawTranslate.x, rawTranslate.y);

  targetTranslate.value = { x: clampedTranslate.x, y: clampedTranslate.y };
  localTranslate.value = { x: clampedTranslate.x, y: clampedTranslate.y };
  dragStartTranslate.value = { x: clampedTranslate.x, y: clampedTranslate.y };
  dragStartPos.value = { x: e.clientX, y: e.clientY };

  emit('navigate', clampedTranslate.x, clampedTranslate.y);

  startSmoothingLoop();

  window.addEventListener('mousemove', handleWindowMouseMove, { capture: true });
  window.addEventListener('mouseup', handleWindowMouseUp, { capture: true });
  window.addEventListener('blur', stopDragging);
};

const handleWindowMouseMove = (e: MouseEvent) => {
  if (!isDragging.value) return;
  if (e.buttons === 0) {
    stopDragging();
    return;
  }
  e.stopPropagation();
  e.preventDefault();

  const deltaX = e.clientX - dragStartPos.value.x;
  const deltaY = e.clientY - dragStartPos.value.y;
  const thumbScale = thumbSize.value.scale;
  const deltaTranslateX = -(deltaX / thumbScale) * props.scale;
  const deltaTranslateY = -(deltaY / thumbScale) * props.scale;

  const rawTargetX = dragStartTranslate.value.x + deltaTranslateX;
  const rawTargetY = dragStartTranslate.value.y + deltaTranslateY;

  targetTranslate.value = clampTranslate(rawTargetX, rawTargetY);
};

const handleWindowMouseUp = (e: MouseEvent) => {
  e.stopPropagation();
  stopDragging();
};

const handleWheel = (e: WheelEvent) => {
  if (props.isLoading) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const clickXOuter = e.clientX - rect.left;
  const clickYOuter = e.clientY - rect.top;

  const offsetX = (MAX_THUMB_WIDTH - thumbSize.value.width) / 2;
  const offsetY = (MAX_THUMB_HEIGHT - thumbSize.value.height) / 2;

  const thumbX = clickXOuter - offsetX;
  const thumbY = clickYOuter - offsetY;

  const direction = e.deltaY < 0 ? 'in' : 'out';
  emit('zoom', direction, thumbX, thumbY);
};

const stopDragging = () => {
  if (!isDragging.value) return;
  isDragging.value = false;
  targetTranslate.value = { x: localTranslate.value.x, y: localTranslate.value.y };

  window.removeEventListener('mousemove', handleWindowMouseMove, { capture: true });
  window.removeEventListener('mouseup', handleWindowMouseUp, { capture: true });
  window.removeEventListener('blur', stopDragging);
};

// ==========================================
// 更可靠的动画禁用机制
// ==========================================
const suppressTransition = ref(true);
let layoutTimeout: number | null = null;
let fallbackTimeout: number | null = null;

// 挂载后给予 100ms 的“无敌帧”
// 完美吸收掉父组件 fitToScreen(双rAF 33ms) 带来的 scale 延迟突变
onMounted(() => {
  layoutTimeout = window.setTimeout(() => {
    suppressTransition.value = false;
  }, 100);
});

// 1. 图源只要一变，立刻禁用过渡动画
watch(() => props.imageSrc, () => {
  suppressTransition.value = true;

  if (fallbackTimeout) clearTimeout(fallbackTimeout);
  if (layoutTimeout) clearTimeout(layoutTimeout);

  // 兜底机制：万一新图尺寸巧合般一致，导致布局 watcher 没触发，
  // 我们最多等 500ms 强制恢复动画，以免影响后续用户的滚轮缩放体验
  fallbackTimeout = window.setTimeout(() => {
    suppressTransition.value = false;
  }, 500);
});

// 2. 监听外部“排版结果”：等待父组件的异步计算真正落定。
// 7 个 ref 的多源监听。写法上比 watch(() => [...], cb, { deep: true })
// 更高效：不需要每次构造临时数组，也不需要 deep diff 每个元素；
// Vue 跟踪每个 getter 的依赖，只有发生变化的源会触发回调。
watch(
  () => [
    props.scale,
    props.translateX,
    props.translateY,
    props.naturalWidth,
    props.naturalHeight,
    props.viewportWidth,
    props.viewportHeight,
  ],
  () => {
    if (suppressTransition.value) {
      // 采用防抖：确保父组件分步更新上述属性时不会被提前放开动画
      // 等到一切数据稳定，留出足够帧数给浏览器做无动画渲染后，再恢复能力
      if (layoutTimeout) clearTimeout(layoutTimeout);
      layoutTimeout = window.setTimeout(() => {
        suppressTransition.value = false;
      }, 60); // 延迟约 4 帧，确保 DOM 已经吸附到正确位置
    }
  },
);

watch(() => props.isLoading, (newVal) => {
  if (newVal) {
    suppressTransition.value = true;
    if (isDragging.value) stopDragging();
    if (isAnimating.value) {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      isAnimating.value = false;
    }
  }
});

onBeforeUnmount(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (layoutTimeout) clearTimeout(layoutTimeout);
  if (fallbackTimeout) clearTimeout(fallbackTimeout);
  window.removeEventListener('mousemove', handleWindowMouseMove, { capture: true });
  window.removeEventListener('mouseup', handleWindowMouseUp, { capture: true });
  window.removeEventListener('blur', stopDragging);
});
</script>

<template>
  <div
      class="thumbnail-navigator"
      :class="{'is-dragging': isDragging}"
  >
    <div
        class="interaction-area"
        @mousedown.stop.prevent="handleMouseDown"
        @mousemove.stop
        @mouseup.stop
        @wheel.stop.prevent="handleWheel"
        @dblclick.stop
    >
      <div
          v-if="isLoading"
          class="thumbnail-skeleton"
          :style="{ width: `${thumbSize.width}px`, height: `${thumbSize.height}px` }"
      />

      <div
          v-else
          class="thumbnail-content"
          :key="imageSrc"
          :style="{ width: `${thumbSize.width}px`, height: `${thumbSize.height}px` }"
      >
        <img
            :src="imageSrc"
            class="thumbnail-image"
            draggable="false"
            alt="Thumbnail"
        />

        <div
            v-if="viewportRect"
            class="dim-overlay"
            :class="{ 'is-dragging': isDragging, 'no-transition': suppressTransition }"
            :style="{
                clipPath: `polygon(
                  0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
                  ${viewportRect.x}px ${viewportRect.y}px,
                  ${viewportRect.x}px ${viewportRect.y + viewportRect.height}px,
                  ${viewportRect.x + viewportRect.width}px ${viewportRect.y + viewportRect.height}px,
                  ${viewportRect.x + viewportRect.width}px ${viewportRect.y}px,
                  ${viewportRect.x}px ${viewportRect.y}px
                )`
              }"
        />

        <div
            v-if="viewportRect"
            class="viewport-rect"
            :class="{ 'is-dragging': isDragging, 'is-full': isViewportFull, 'no-transition': suppressTransition }"
            :style="{
                transform: `translate3d(${viewportRect.x}px, ${viewportRect.y}px, 0)`,
                width: `${viewportRect.width}px`,
                height: `${viewportRect.height}px`
              }"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.thumbnail-navigator {
  width: 100%;
  box-sizing: border-box;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  user-select: none;
}

.interaction-area {
  width: 200px;
  height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: crosshair;
}

.interaction-area:active {
  cursor: grabbing;
}

.thumbnail-content {
  position: relative;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.5);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}

.thumbnail-skeleton {
  border-radius: 4px;
  background: var(--glass-fill);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  animation: thumbnail-skeleton-pulse 1.2s ease-in-out infinite alternate;
}

@keyframes thumbnail-skeleton-pulse {
  0% { opacity: 0.35; }
  100% { opacity: 0.7; }
}

.thumbnail-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  opacity: 0.9;
  pointer-events: none;
}

.dim-overlay {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.6);
  pointer-events: none;
  transition: clip-path 0.25s cubic-bezier(0.25, 1, 0.5, 1);
}

.viewport-rect {
  position: absolute;
  left: 0;
  top: 0;
  border: 1.5px solid #ffffff;
  background: var(--ui-accent-soft);
  pointer-events: none;
  border-radius: 2px;
  will-change: transform;
  transition: transform 0.25s cubic-bezier(0.25, 1, 0.5, 1),
  width 0.2s ease,
  height 0.2s ease,
  border-color 0.2s ease;
}

.viewport-rect.is-full {
  border-color: transparent;
}

/* 🚀 增加 !important 保障强制清除 transition 优先级 */
.viewport-rect.is-dragging,
.dim-overlay.is-dragging,
.viewport-rect.no-transition,
.dim-overlay.no-transition {
  transition: none !important;
}
</style>