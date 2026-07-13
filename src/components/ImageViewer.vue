<script setup lang="ts">
import { computed, ref, useTemplateRef, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { usePanZoom } from '../composables/usePanZoom';
import ThumbnailNavigator from './ThumbnailNavigator.vue';
import { perfBegin, perfEnd, perfMark } from '../perf';

const props = defineProps<{
  src: string;
  previewSrc?: string | null;
  previewOrigWidth?: number;
  previewOrigHeight?: number;
  fastNavigating?: boolean;
  sidebarVisible?: boolean;
  isLibraryMode?: boolean;
}>();

const emit = defineEmits(['update:scale', 'load']);

const slotA = ref({ src: '', scale: 1, x: 0, y: 0 });
const slotB = ref({ src: '', scale: 1, x: 0, y: 0 });
const activeSlot = ref<'A' | 'B' | null>(null);

const pendingSrc = ref<string | null>(null);
let pendingSrcTimeout: number | null = null;

function startPendingTimeout() {
  clearPendingTimeout();
  pendingSrcTimeout = window.setTimeout(() => {
    if (pendingSrc.value) pendingSrc.value = null;
  }, 3000);
}

function clearPendingTimeout() {
  if (pendingSrcTimeout !== null) {
    clearTimeout(pendingSrcTimeout);
    pendingSrcTimeout = null;
  }
}

const viewportRef = useTemplateRef<HTMLElement>('viewportRef');
const imgARef = useTemplateRef<HTMLImageElement>('imgARef');
const imgBRef = useTemplateRef<HTMLImageElement>('imgBRef');
const activeImgRef = computed(() => activeSlot.value === 'A' ? imgARef.value : (activeSlot.value === 'B' ? imgBRef.value : null));

const {
  scale, translate, setMinScale, fitToScreen,
  onDrag, stopDrag, zoomIn, zoomOut, zoomAtPoint, startDrag, handleWheel, getConstrainedTranslate
} = usePanZoom({ viewportRef, imgRef: activeImgRef });

const imageNaturalSize = ref({ width: 0, height: 0 });
const viewportSize = ref({ width: 0, height: 0 });

const updateViewportSize = () => {
  if (viewportRef.value) {
    viewportSize.value = { width: viewportRef.value.clientWidth, height: viewportRef.value.clientHeight };
  }
};

const hasValidPreview = computed(() => {
  return !!(props.previewSrc && props.previewOrigWidth && props.previewOrigHeight);
});

// 将 缩略图图源 + 尺寸 + Scale 打包为一个原子状态，彻底杜绝数据撕裂
const thumbnailResolvedState = computed(() => {
  // 1. 快速长按翻页中：显示骨架屏，传安全值即可
  if (props.fastNavigating) {
    return {
      src: '',
      w: imageNaturalSize.value.width || 1,
      h: imageNaturalSize.value.height || 1,
      scale: scale.value,
      x: translate.value.x,
      y: translate.value.y
    };
  }

  // 2. 切图等待解码期间（核心修复点）：
  // 我们已经有了新图的预览数据，直接预测它即将被 fitToScreen 的理想 Scale。
  // 这样传给子组件，子组件就会用全新的数据直接渲染，不会出现“旧框套新图”的跳变！
  if (pendingSrc.value && hasValidPreview.value) {
    const vpw = viewportSize.value.width || window.innerWidth;
    const vph = viewportSize.value.height || window.innerHeight;
    const predictedScale = Math.min(vpw / props.previewOrigWidth!, vph / props.previewOrigHeight!, 1);

    return {
      src: props.previewSrc!,
      w: props.previewOrigWidth!,
      h: props.previewOrigHeight!,
      scale: predictedScale,
      x: 0, // 新图加载完毕时必定居中
      y: 0
    };
  }

  // 3. 稳定状态（无图加载，或者文件系统模式无预览图）：回退到真实的槽位数据
  const stableSrc = props.previewSrc
      ? props.previewSrc
      : (activeSlot.value === 'A' ? slotA.value.src : (activeSlot.value === 'B' ? slotB.value.src : props.src));

  return {
    src: stableSrc,
    w: imageNaturalSize.value.width || 1,
    h: imageNaturalSize.value.height || 1,
    scale: scale.value,
    x: translate.value.x,
    y: translate.value.y
  };
});

// 只要有可用的预测数据，就不进入 loading 避免闪烁骨架屏
const isThumbnailLoading = computed(() => {
  if (props.fastNavigating) return true;
  if (hasValidPreview.value) return false;
  return !!pendingSrc.value;
});

const isActiveSlotVisible = computed(() => {
  if (hasValidPreview.value && (props.fastNavigating || pendingSrc.value)) {
    return false;
  }
  return true;
});

const previewFitScale = computed(() => {
  if (!props.previewOrigWidth || !props.previewOrigHeight) return 1;
  const vpw = viewportSize.value.width || window.innerWidth;
  const vph = viewportSize.value.height || window.innerHeight;
  if (!vpw || !vph) return 1;
  return Math.min(vpw / props.previewOrigWidth, vph / props.previewOrigHeight);
});

const handleThumbnailNavigate = (newTranslateX: number, newTranslateY: number) => {
  translate.value = getConstrainedTranslate(newTranslateX, newTranslateY, scale.value);
};

const handleThumbnailZoom = (direction: 'in' | 'out', thumbX: number, thumbY: number) => {
  const MAX_THUMB_WIDTH = 200;
  const MAX_THUMB_HEIGHT = 150;
  // 使用同步后的统一尺寸状态，防止除0和缩放错乱
  const natW = thumbnailResolvedState.value.w;
  const natH = thumbnailResolvedState.value.h;
  if (!natW || !natH) return;

  const thumbScale = Math.min(MAX_THUMB_WIDTH / natW, MAX_THUMB_HEIGHT / natH, 1);
  const naturalX = thumbX / thumbScale;
  const naturalY = thumbY / thumbScale;

  const viewportX = (naturalX - natW / 2) * scale.value + translate.value.x;
  const viewportY = (naturalY - natH / 2) * scale.value + translate.value.y;

  zoomAtPoint(direction, { x: viewportX, y: viewportY });
};

const calculateAndSetMinScale = (imgWidth: number, imgHeight: number) => {
  const vpw = viewportRef.value?.clientWidth ?? window.innerWidth;
  const vph = viewportRef.value?.clientHeight ?? window.innerHeight;
  const fitScale = Math.min(vpw / imgWidth, vph / imgHeight);
  const newMinScale = Math.min(fitScale, 1);
  setMinScale(newMinScale);
  return newMinScale;
};

function loadFullImage(newPath: string) {
  perfMark('switch::viewer_src_changed', { slot_hint: activeSlot.value });
  const currentSlot = activeSlot.value;
  const currentSrc = currentSlot === 'A' ? slotA.value.src : (currentSlot === 'B' ? slotB.value.src : null);

  if (newPath === currentSrc) return;

  const nextSlotName = currentSlot === 'A' ? 'B' : 'A';
  const nextSlotState = nextSlotName === 'A' ? slotA : slotB;
  const nextImgRef = nextSlotName === 'A' ? imgARef : imgBRef;

  if (nextSlotState.value.src === newPath) {
    if (nextImgRef.value && nextImgRef.value.complete) {
      perfMark('switch::reuse_slot', { slot: nextSlotName });
      perfMark('fs_cycle::prefetch_hit', { slot: nextSlotName });
      applyImageToSlot(nextSlotName, nextImgRef.value);
      return;
    }
    if (nextImgRef.value && !nextImgRef.value.complete) {
      perfMark('switch::slot_in_flight', { slot: nextSlotName });
      return;
    }
  }

  pendingSrc.value = newPath;
  startPendingTimeout();
  nextSlotState.value.src = newPath;
  perfMark('fs_cycle::slot_assigned', { slot: nextSlotName, cold: true });
}

watch([() => props.src, () => props.fastNavigating], ([newPath, isFast], oldValues) => {
  const oldPath = oldValues ? oldValues[0] : undefined;
  const oldFast = oldValues ? oldValues[1] : undefined;

  if (!newPath) {
    pendingSrc.value = null;
    clearPendingTimeout();
    return;
  }

  if (isFast && props.isLibraryMode) {
    pendingSrc.value = null;
    return;
  }

  if (newPath !== oldPath || (oldFast === true && !isFast)) {
    loadFullImage(newPath);
  }
}, { immediate: true });

const applyImageToSlot = (slotName: 'A' | 'B', imgEl: HTMLImageElement) => {
  perfBegin('switch::apply_image_to_slot', { slot: slotName });
  const vpw = viewportRef.value?.clientWidth ?? window.innerWidth;
  const vph = viewportRef.value?.clientHeight ?? window.innerHeight;

  imageNaturalSize.value = { width: imgEl.naturalWidth, height: imgEl.naturalHeight };
  updateViewportSize();
  calculateAndSetMinScale(imgEl.naturalWidth, imgEl.naturalHeight);

  const newScale = Math.min(vpw / imgEl.naturalWidth, vph / imgEl.naturalHeight, 1);
  const targetSlot = slotName === 'A' ? slotA : slotB;

  targetSlot.value.scale = newScale;
  targetSlot.value.x = 0;
  targetSlot.value.y = 0;

  activeSlot.value = slotName;
  pendingSrc.value = null;
  clearPendingTimeout();

  scale.value = newScale;
  translate.value = { x: 0, y: 0 };

  emit('load');
  emit('update:scale', newScale);
  perfEnd('switch::apply_image_to_slot');
  perfMark('switch::visible', { slot: slotName });
  perfMark('fs_cycle::visible', { slot: slotName, w: imgEl.naturalWidth, h: imgEl.naturalHeight });
};

const handleImageLoad = async (slotName: 'A' | 'B', imgEl: HTMLImageElement) => {
  const slotRef = slotName === 'A' ? slotA : slotB;
  const intendedSrc = slotRef.value.src;

  if (pendingSrc.value !== intendedSrc) return;

  perfBegin('switch::handle_image_load', { slot: slotName });
  perfMark('switch::decode_begin', { slot: slotName, w: imgEl.naturalWidth, h: imgEl.naturalHeight });

  try {
    await imgEl.decode();
  } catch (e) {
    console.warn('图片解码被中断或失败', e);
  }

  perfMark('switch::decode_end', { slot: slotName });

  if (pendingSrc.value !== intendedSrc) {
    perfEnd('switch::handle_image_load');
    return;
  }

  if (props.fastNavigating && props.isLibraryMode) {
    perfEnd('switch::handle_image_load');
    return;
  }

  if (imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0) {
    perfEnd('switch::handle_image_load');
    return;
  }

  applyImageToSlot(slotName, imgEl);
  perfEnd('switch::handle_image_load');
};

const handleImageError = (slotName: 'A' | 'B') => {
  const slotRef = slotName === 'A' ? slotA : slotB;
  if (slotRef.value.src === pendingSrc.value) {
    pendingSrc.value = null;
    clearPendingTimeout();
  }
};

watch([scale, translate], () => {
  if (activeSlot.value === 'A') {
    slotA.value.scale = scale.value;
    slotA.value.x = translate.value.x;
    slotA.value.y = translate.value.y;
  } else if (activeSlot.value === 'B') {
    slotB.value.scale = scale.value;
    slotB.value.x = translate.value.x;
    slotB.value.y = translate.value.y;
  }
});

defineExpose({
  zoomIn, zoomOut, handleWheel, startDrag,
  fitToScreen: () => {
    const img = activeImgRef.value;
    if (img) fitToScreen(img);
  },
});

const isTeleportReady = ref(false);
onMounted(() => {
  updateViewportSize();
  window.addEventListener('resize', updateViewportSize);
  nextTick(() => {
    isTeleportReady.value = true;
  });
});
onUnmounted(() => {
  window.removeEventListener('resize', updateViewportSize);
});
</script>

<template>
  <div
      ref="viewportRef"
      class="image-viewer-root w-full h-full overflow-hidden relative flex justify-center items-center outline-none bg-transparent active:cursor-grabbing"
      @mousemove="onDrag" @mouseup="stopDrag" @mouseleave="stopDrag" @mousedown="startDrag"
  >
    <!-- Slot A -->
    <img
        v-if="slotA.src"
        ref="imgARef"
        :src="slotA.src"
        :style="{ transform: `translate(${slotA.x}px, ${slotA.y}px) scale(${slotA.scale})` }"
        :class="[
          'max-w-none max-h-none block shadow-2xl instant-img absolute',
          (activeSlot === 'A' && isActiveSlotVisible) ? 'opacity-100 z-10 transition-none' : 'opacity-0 z-0 pointer-events-none transition-opacity duration-200 ease-out'
        ]"
        draggable="false"
        decoding="async"
        @load="handleImageLoad('A', $event.target as HTMLImageElement)"
        @error="handleImageError('A')"
        alt=""
    />

    <!-- Slot B -->
    <img
        v-if="slotB.src"
        ref="imgBRef"
        :src="slotB.src"
        :style="{ transform: `translate(${slotB.x}px, ${slotB.y}px) scale(${slotB.scale})` }"
        :class="[
          'max-w-none max-h-none block shadow-2xl instant-img absolute',
          (activeSlot === 'B' && isActiveSlotVisible) ? 'opacity-100 z-10 transition-none' : 'opacity-0 z-0 pointer-events-none transition-opacity duration-200 ease-out'
        ]"
        draggable="false"
        decoding="async"
        @load="handleImageLoad('B', $event.target as HTMLImageElement)"
        @error="handleImageError('B')"
        alt=""
    />

    <Transition name="preview-fade">
      <div
          v-if="hasValidPreview && (!activeSlot || pendingSrc || fastNavigating)"
          :key="previewSrc || 'empty'"
          class="absolute inset-0 flex justify-center items-center pointer-events-none z-20"
      >
        <img
            :src="previewSrc!"
            :width="previewOrigWidth"
            :height="previewOrigHeight"
            :style="{ transform: `translate(0px, 0px) scale(${previewFitScale})` }"
            class="max-w-none max-h-none block shadow-2xl preview-img pointer-events-none"
            draggable="false"
            alt="preview"
        />
      </div>
    </Transition>

    <slot name="empty" v-if="!activeSlot"></slot>

    <!-- 传入完全同步后的最新原子化状态数据 -->
    <Teleport to="#thumbnail-teleport-target" v-if="isTeleportReady">
      <ThumbnailNavigator
          :key="src"
          :is-loading="isThumbnailLoading"
          :image-src="thumbnailResolvedState.src"
          :natural-width="thumbnailResolvedState.w"
          :natural-height="thumbnailResolvedState.h"
          :viewport-width="viewportSize.width"
          :viewport-height="viewportSize.height"
          :scale="thumbnailResolvedState.scale"
          :translate-x="thumbnailResolvedState.x"
          :translate-y="thumbnailResolvedState.y"
          @navigate="handleThumbnailNavigate"
          @zoom="handleThumbnailZoom"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.image-viewer-root {
  contain: layout paint;
}

.preview-img {
  z-index: 5;
  background: transparent;
  will-change: transform;
}

.instant-img {
  backface-visibility: hidden;
}
</style>