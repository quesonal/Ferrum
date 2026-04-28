<script setup lang="ts">
import {computed, ref, useTemplateRef, watch} from 'vue';
import { usePanZoom } from '../composables/usePanZoom';
import ThumbnailNavigator from './ThumbnailNavigator.vue';

const props = defineProps<{
  src: string;
  previewSrc?: string | null;
  previewOrigWidth?: number;
  previewOrigHeight?: number;
}>();
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

const previewFitScale = computed(() => {
  if (!props.previewOrigWidth || !props.previewOrigHeight) return 1;
  const vpw = viewportRef.value?.clientWidth ?? window.innerWidth;
  const vph = viewportRef.value?.clientHeight ?? window.innerHeight;
  if (!vpw || !vph) return 1;
  return Math.min(vpw / props.previewOrigWidth, vph / props.previewOrigHeight);
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

  const targetSlot = slotName === 'A' ? slotA : slotB;
  targetSlot.value.scale = newScale;
  targetSlot.value.x = 0;
  targetSlot.value.y = 0;

  activeSlot.value = slotName;
  pendingSrc.value = null;

  scale.value = newScale;
  translate.value = { x: 0, y: 0 };

  emit('load');
  emit('update:scale', newScale);
};

// 真正完成加载的回调
const handleImageLoad = async (slotName: 'A' | 'B', imgEl: HTMLImageElement) => {
  const slotState = slotName === 'A' ? slotA.value : slotB.value;
  // 如果在加载期间用户已经切到了别的图，直接废弃
  if (pendingSrc.value && slotState.src !== pendingSrc.value) return;

  try {
    // 【核心修复】：强制浏览器在后台完成图像光栅化解码
    // 这样切换时图片像素已经存在于 GPU/内存中，绝对不会闪烁
    await imgEl.decode();
  } catch (e) {
    console.warn('图片解码被中断或失败', e);
  }

  // 解码可能耗时几十毫秒，需要再次确认用户是否已经切图
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

// 将共享的 pan/zoom 状态同步到当前活跃 slot 的独立 transform
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
</script>

<template>
  <div
      ref="viewportRef"
      class="w-full h-full overflow-hidden relative flex justify-center items-center outline-none bg-transparent active:cursor-grabbing"
      @mousemove="onDrag" @mouseup="stopDrag" @mouseleave="stopDrag" @mousedown="startDrag"
  >
    <!-- Slot A -->
    <img
        v-if="slotA.src"
        ref="imgARef"
        :src="slotA.src"
        :style="{
      transform: `translate(${slotA.x}px, ${slotA.y}px) scale(${slotA.scale})`,
    }"
        :class="[
      'max-w-none max-h-none block shadow-2xl instant-img absolute transition-opacity duration-0',
      activeSlot === 'A' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
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
        :style="{
      transform: `translate(${slotB.x}px, ${slotB.y}px) scale(${slotB.scale})`,
    }"
        :class="[
      'max-w-none max-h-none block shadow-2xl instant-img absolute transition-opacity duration-0',
      activeSlot === 'B' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
    ]"
        draggable="false"
        decoding="async"
        @load="handleImageLoad('B', $event.target as HTMLImageElement)"
        @error="handleImageError('B')"
        alt=""
    />

    <!-- 预览图层：按原图比例渲染，与主图同一坐标空间；opacity 切换与主图同 compositor 层，避免背景闪现 -->
    <img
        v-if="previewSrc && previewOrigWidth && previewOrigHeight"
        :src="previewSrc"
        :width="previewOrigWidth"
        :height="previewOrigHeight"
        :style="{ transform: `translate(0px, 0px) scale(${previewFitScale})` }"
        :class="[
          'max-w-none max-h-none block absolute preview-img',
          (!activeSlot || pendingSrc) ? 'opacity-100' : 'opacity-0 pointer-events-none'
        ]"
        draggable="false"
        alt="preview"
    />

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
.preview-img {
  z-index: 5;
  background: transparent;
}

.instant-img {
  will-change: transform;
  image-rendering: -webkit-optimize-contrast;
  image-rendering: auto;
  backface-visibility: hidden;
  -webkit-font-smoothing: antialiased;
}

@media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
  .instant-img {
    image-rendering: auto;
  }
}
</style>