<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue';
import { usePanZoom } from '../composables/usePanZoom';
import ThumbnailNavigator from './ThumbnailNavigator.vue';

const props = defineProps<{ src: string }>();
const emit = defineEmits(['update:scale', 'load']);

// --- 状态 ---
const slotA = ref({ src: '', scale: 1, x: 0, y: 0 });
const slotB = ref({ src: '', scale: 1, x: 0, y: 0 });
const activeSlot = ref<'A' | 'B' | null>(null);

// 跟踪当前想要显示的图片（防止快速连续按下一张时发生错乱）
const pendingSrc = ref<string | null>(null);

const viewportRef = useTemplateRef<HTMLElement>('viewportRef');
const imgARef = useTemplateRef<HTMLImageElement>('imgARef');
const imgBRef = useTemplateRef<HTMLImageElement>('imgBRef');

const activeImgRef = computed(() => {
  if (activeSlot.value === 'A') return imgARef.value;
  if (activeSlot.value === 'B') return imgBRef.value;
  return null;
});

const {
  scale, translate, setMinScale, fitToScreen, minScale,
  onDrag, stopDrag, zoomIn, zoomOut, startDrag, handleWheel, getConstrainedTranslate
} = usePanZoom({
  viewportRef,
  imgRef: activeImgRef
});

// --- 缩略图导航相关状态 ---
const imageNaturalSize = ref({ width: 0, height: 0 });
const viewportSize = ref({ width: 0, height: 0 });

const showThumbnail = computed(() => {
  return !!(props.src && imageNaturalSize.value.width > 0 && scale.value > minScale.value);
});

const updateViewportSize = () => {
  if (viewportRef.value) {
    viewportSize.value = {
      width: viewportRef.value.clientWidth,
      height: viewportRef.value.clientHeight
    };
  }
};

const handleThumbnailNavigate = (newTranslateX: number, newTranslateY: number) => {
  translate.value = getConstrainedTranslate(newTranslateX, newTranslateY, scale.value);
};

const calculateAndSetMinScale = (imgWidth: number, imgHeight: number) => {
  const vpw = viewportRef.value?.clientWidth ?? window.innerWidth;
  const vph = viewportRef.value?.clientHeight ?? window.innerHeight;
  const fitScaleX = vpw / imgWidth;
  const fitScaleY = vph / imgHeight;
  const fitScale = Math.min(fitScaleX, fitScaleY);
  const newMinScale = Math.min(fitScale, 1);
  setMinScale(newMinScale);
  return newMinScale;
};

// 监听外界传入的新图片地址
watch(() => props.src, (newPath) => {
  if (!newPath) {
    activeSlot.value = null;
    slotA.value.src = '';
    slotB.value.src = '';
    pendingSrc.value = null;
    return;
  }

  const currentSlot = activeSlot.value;
  const currentSrc = currentSlot === 'A' ? slotA.value.src : (currentSlot === 'B' ? slotB.value.src : null);

  if (newPath === currentSrc) return;

  // 1. 确定下一个槽位
  const nextSlotName = currentSlot === 'A' ? 'B' : 'A';
  const nextSlotState = nextSlotName === 'A' ? slotA : slotB;
  const nextImgRef = nextSlotName === 'A' ? imgARef : imgBRef;

  // 2. 核心修复逻辑：
  // 如果下一个槽位的 src 已经是我们要的地址，且图片已经加载完成（complete）
  // 浏览器不会再次触发 @load，我们需要手动调用处理函数进行切换
  if (nextSlotState.value.src === newPath) {
    if (nextImgRef.value && nextImgRef.value.complete) {
      applyImageToSlot(nextSlotName, nextImgRef.value);
      return;
    }
  }

  // 3. 正常赋值流程
  pendingSrc.value = newPath;
  nextSlotState.value.src = newPath;
}, { immediate: true });

const applyImageToSlot = (slotName: 'A' | 'B', imgEl: HTMLImageElement) => {
  const vpw = viewportRef.value?.clientWidth ?? window.innerWidth;
  const vph = viewportRef.value?.clientHeight ?? window.innerHeight;

  imageNaturalSize.value = {
    width: imgEl.naturalWidth,
    height: imgEl.naturalHeight
  };
  updateViewportSize();
  calculateAndSetMinScale(imgEl.naturalWidth, imgEl.naturalHeight);

  const sX = vpw / imgEl.naturalWidth;
  const sY = vph / imgEl.naturalHeight;
  const newScale = Math.min(sX, sY, 1);

  scale.value = newScale;
  translate.value = { x: 0, y: 0 };

  activeSlot.value = slotName;
  pendingSrc.value = null;

  emit('load');
  emit('update:scale', newScale);
};

// 真正完成加载的回调（由背后隐藏的 DOM <img> 触发）
const handleImageLoad = (slotName: 'A' | 'B', imgEl: HTMLImageElement) => {
  const slotState = slotName === 'A' ? slotA.value : slotB.value;
  if (pendingSrc.value && slotState.src !== pendingSrc.value) return;
  applyImageToSlot(slotName, imgEl);
};

// 如果图片损坏或加载失败，清空 pending 锁防止卡死
const handleImageError = (slotName: 'A' | 'B') => {
  const slotState = slotName === 'A' ? slotA.value : slotB.value;
  if (slotState.src === pendingSrc.value) {
    pendingSrc.value = null;
  }
};

defineExpose({
  zoomIn, zoomOut, handleWheel, startDrag,
  fitToScreen: () => {
    const img = activeImgRef;
    if (img) fitToScreen(img.value);
  },
});
</script>

<template>
  <div
      ref="viewportRef"
      class="w-full h-full overflow-hidden relative flex justify-center items-center outline-none bg-transparent active:cursor-grabbing"
      @mousemove="onDrag" @mouseup="stopDrag" @mouseleave="stopDrag" @mousedown="startDrag"
  >
    <img
        v-if="slotA.src"
        v-show="activeSlot === 'A'"
        ref="imgARef"
        :src="slotA.src"
        :style="{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
        }"
        class="max-w-none max-h-none block shadow-2xl instant-img absolute"
        draggable="false"
        decoding="sync"
        @load="handleImageLoad('A', $event.target as HTMLImageElement)"
        @error="handleImageError('A')"
        alt="" />

    <img
        v-if="slotB.src"
        v-show="activeSlot === 'B'"
        ref="imgBRef"
        :src="slotB.src"
        :style="{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
        }"
        class="max-w-none max-h-none block shadow-2xl instant-img absolute"
        draggable="false"
        decoding="sync"
        @load="handleImageLoad('B', $event.target as HTMLImageElement)"
        @error="handleImageError('B')"
        alt="" />

    <slot name="empty" v-if="!activeSlot"></slot>

    <!-- 缩略图导航器 -->
    <ThumbnailNavigator
        :visible="showThumbnail"
        :image-src="props.src"
        :natural-width="imageNaturalSize.width"
        :natural-height="imageNaturalSize.height"
        :viewport-width="viewportSize.width"
        :viewport-height="viewportSize.height"
        :scale="scale"
        :translate-x="translate.x"
        :translate-y="translate.y"
        @navigate="handleThumbnailNavigate"
    />
  </div>
</template>

<style scoped>
.instant-img {
  will-change: transform;
  image-rendering: -webkit-optimize-contrast;
  image-rendering: crisp-edges;
  backface-visibility: hidden;
  -webkit-font-smoothing: antialiased;
}

@media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
  .instant-img {
    image-rendering: auto;
  }
}
</style>