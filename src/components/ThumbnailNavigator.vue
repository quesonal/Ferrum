<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';

interface Props {
  visible: boolean;
  imageSrc: string;
  naturalWidth: number;
  naturalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  translateX: number;
  translateY: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'navigate', x: number, y: number): void;
}>();

// 缩略图最大尺寸
const MAX_THUMB_WIDTH = 200;
const MAX_THUMB_HEIGHT = 150;

// 拖动状态
const isDragging = ref(false);
const isAnimating = ref(false);
const navigatorRef = ref<HTMLElement | null>(null);

const dragStartPos = ref({ x: 0, y: 0 });
const dragStartTranslate = ref({ x: 0, y: 0 });

// 【核心新增】：本地临时坐标。拖拽时蓝框位置由它决定，不看父组件脸色
const targetTranslate = ref({ x: 0, y: 0 });
const localTranslate = ref({ x: 0, y: 0 });
let animationFrameId: number | null = null;

const clampTranslate = (tx: number, ty: number) => {
  const { naturalWidth, naturalHeight, viewportWidth, viewportHeight, scale } = props;

  // 图片在屏幕上的实际显示尺寸
  const displayedWidth = naturalWidth * scale;
  const displayedHeight = naturalHeight * scale;

  // 计算允许移动的最大偏移量
  // 如果图片比视窗还小，则不允许移动（边界设为0）
  const maxTx = Math.max(0, (displayedWidth - viewportWidth) / 2);
  const maxTy = Math.max(0, (displayedHeight - viewportHeight) / 2);

  // 限制 x 和 y 在 [-max, max] 范围内
  return {
    x: Math.max(-maxTx, Math.min(maxTx, tx)),
    y: Math.max(-maxTy, Math.min(maxTy, ty))
  };
};

// 当前生效的坐标（拖拽时用本地零延迟坐标，不拖拽时用父组件传来的真实坐标）
const activeTranslate = computed(() => {
  return (isDragging.value || isAnimating.value)
      ? { x: localTranslate.value.x, y: localTranslate.value.y }
      : { x: props.translateX, y: props.translateY };
})

// 计算缩略图尺寸（保持比例）
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

  const displayedWidth = naturalWidth * scale;
  const displayedHeight = naturalHeight * scale;

  const offsetX = (displayedWidth - viewportWidth) / 2 - activeTranslate.value.x;
  const offsetY = (displayedHeight - viewportHeight) / 2 - activeTranslate.value.y;

  const thumbScale = thumbSize.value.scale;

  return {
    x: (offsetX / scale) * thumbScale,
    y: (offsetY / scale) * thumbScale,
    width: (viewportWidth / scale) * thumbScale,
    height: (viewportHeight / scale) * thumbScale
  };
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
    // 计算当前位置与目标位置的距离
    const dx = targetTranslate.value.x - localTranslate.value.x;
    const dy = targetTranslate.value.y - localTranslate.value.y;

    // 【核心修复】：只有在“没有拖拽” 且 “距离极其接近”时，才允许关闭动画引擎
    if (!isDragging.value && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      localTranslate.value = { x: targetTranslate.value.x, y: targetTranslate.value.y };
      emit('navigate', localTranslate.value.x, localTranslate.value.y);
      isAnimating.value = false;
      return; // 此时才真正结束循环
    }

    // 平滑插值：每次移动剩余距离的 35%
    const smoothingFactor = 0.35;
    localTranslate.value = {
      x: localTranslate.value.x + dx * smoothingFactor,
      y: localTranslate.value.y + dy * smoothingFactor
    };

    // 将平滑后的坐标传给主图
    emit('navigate', localTranslate.value.x, localTranslate.value.y);

    // 请求下一帧，保持引擎运转
    animationFrameId = requestAnimationFrame(loop);
  };

  loop();
};

// 开始拖动
const handleMouseDown = (e: MouseEvent) => {
  isDragging.value = true;

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

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

  // 【核心修复：防线一】只要窗口失去焦点（比如系统截图介入），立刻强制中断拖拽
  window.addEventListener('blur', stopDragging);
};

// 拖动中
const handleWindowMouseMove = (e: MouseEvent) => {
  if (!isDragging.value) return;

  // 【核心修复：防线二】
  // e.buttons 表示当前鼠标按下的物理按键。0 表示没有任何按键按下。
  // 如果处于拖拽状态，但系统检测到鼠标左键其实没按下，说明发生了“事件吞噬”
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

  // 使用上一轮加的边界限制
  targetTranslate.value = clampTranslate(rawTargetX, rawTargetY);
};

// 结束拖动
const handleWindowMouseUp = (e: MouseEvent) => {
  e.stopPropagation();
  stopDragging();
};

const stopDragging = () => {
  if (!isDragging.value) return;
  isDragging.value = false;

  // 移除所有全局监听器
  window.removeEventListener('mousemove', handleWindowMouseMove, { capture: true });
  window.removeEventListener('mouseup', handleWindowMouseUp, { capture: true });
  window.removeEventListener('blur', stopDragging);
};

onBeforeUnmount(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  window.removeEventListener('mousemove', handleWindowMouseMove, { capture: true });
  window.removeEventListener('mouseup', handleWindowMouseUp, { capture: true });
  // 【新增清理】
  window.removeEventListener('blur', stopDragging);
});
</script>

<template>
  <Transition name="thumbnail-fade">
    <div
        v-if="visible"
        ref="navigatorRef"
        class="thumbnail-navigator"
        :style="{
          width: `${thumbSize.width}px`,
          height: `${thumbSize.height}px`
        }"
        :class="{'is-dragging': isDragging}"
        @mousedown.stop.prevent="handleMouseDown"
        @mousemove.stop
        @mouseup.stop
        @wheel.stop
        @dblclick.stop
    >
      <img
          :src="imageSrc"
          class="thumbnail-image"
          draggable="false"
          alt="Thumbnail"
      />
      <!-- 变暗遮罩：非视口区域变淡 -->
      <div
          v-if="viewportRect"
          class="dim-overlay"
          :style="{
            clipPath: `polygon(
              0% 0%,
              100% 0%,
              100% 100%,
              0% 100%,
              0% 0%,
              ${viewportRect.x}px ${viewportRect.y}px,
              ${viewportRect.x}px ${viewportRect.y + viewportRect.height}px,
              ${viewportRect.x + viewportRect.width}px ${viewportRect.y + viewportRect.height}px,
              ${viewportRect.x + viewportRect.width}px ${viewportRect.y}px,
              ${viewportRect.x}px ${viewportRect.y}px
            )`
          }"
      />
      <!-- 视窗框 -->
      <div
          v-if="viewportRect"
          class="viewport-rect"
          :class="{ 'is-dragging': isDragging }"
          :style="{
            transform: `translate3d(${viewportRect.x}px, ${viewportRect.y}px, 0)`,
            width: `${viewportRect.width}px`,
            height: `${viewportRect.height}px`
          }"
      />
    </div>
  </Transition>
</template>

<style scoped>
/* 样式与原来保持一致即可，没有变化 */
.thumbnail-navigator {
  position: fixed;
  right: 16px;
  bottom: 72px;
  background: rgba(0, 0, 0, 0.75);
  border-radius: 8px;
  overflow: hidden; /* 这里已经有 hidden 了，所以框超出自然会被裁切 */
  cursor: crosshair;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  border: 2px solid rgba(255, 255, 255, 0.3);
  z-index: 50;
  transition: all 0.2s ease;
  user-select: none;
}

.thumbnail-navigator:hover {
  border-color: rgba(255, 255, 255, 0.5);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6);
}

.thumbnail-navigator.is-dragging {
  cursor: grabbing;
  border-color: #60a5fa;
}

.thumbnail-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  opacity: 0.85;
  pointer-events: none;
}

.dim-overlay {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.55);
  pointer-events: none;
  transition: clip-path 0.25s cubic-bezier(0.25, 1, 0.5, 1);
}

.viewport-rect {
  position: absolute;
  left: 0;
  top: 0;
  border: 1px solid #ffffff;
  background: rgba(96, 165, 250, 0.25);
  pointer-events: none;
  /*box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.5),
      inset 0 0 0 1px rgba(255, 255, 255, 0.3),
      0 0 8px rgba(96, 165, 250, 0.5);*/
  border-radius: 2px;
  will-change: transform;
  transition: transform 0.25s cubic-bezier(0.25, 1, 0.5, 1),
  width 0.2s ease,
  height 0.2s ease;
}

.viewport-rect.is-dragging {
  transition: none;
}

.thumbnail-fade-enter-active,
.thumbnail-fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.thumbnail-fade-enter-from,
.thumbnail-fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>