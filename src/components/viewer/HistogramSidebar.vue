<script setup lang="ts">
import Histogram from '../Histogram.vue';
import ImageTags from '../ImageTags.vue';
import type { HistogramData, ExifData } from '../../stores/imageStore';

defineProps<{
  showHistogram: boolean;
  histogramData: HistogramData | null;
  exifData: ExifData;
  isHistogramLoading: boolean;
  currentImageId: string | null;
}>();
</script>

<template>
  <!-- 右侧：侧边栏容器 (包含直方图和传送来的缩略图) -->
  <!-- 停止事件冒泡，防止用户在侧边栏滚动导致图片翻页，或拖拽侧边栏导致窗口移动 -->
  <div
      v-show="showHistogram"
      class="sidebar-column"
      @mousedown.stop
      @wheel.stop
  >
    <Histogram
        v-if="showHistogram"
        :histogram-data="histogramData"
        :exif-data="exifData"
        :is-loading="isHistogramLoading"
    />
    <!--
      Per-image tags section. Library mode only — filesystem mode
      never sets `currentImageId`, so this stays unrendered.
    -->
    <ImageTags
        v-if="currentImageId"
        :image-id="currentImageId"
    />
    <!-- Vue Teleport 会把 ImageViewer 内的缩略图准确渲染到这个 div 里 -->
    <div id="thumbnail-teleport-target"></div>
  </div>
</template>

<style scoped>
/* 现代磨砂质感侧边栏 —— glass 效果作用在整个侧栏，内部三块为扁平分区 */
.sidebar-column {
  width: 264px;
  flex-shrink: 0;
  background: var(--glass-bg);
  border-left: 1px solid var(--glass-border);
  box-shadow: var(--glass-highlight);
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 16px;
  z-index: 30;

  /* 【核心修改】：关闭侧边栏的全局滚动，改为内部滚动 */
  overflow: hidden;

  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  box-sizing: border-box;
}

/* 隐藏侧边栏原生滚动条，保持整洁 */
.sidebar-column::-webkit-scrollbar {
  display: none;
}

#thumbnail-teleport-target {
  /* histogram 用 flex:1 撑开剩余空间，把 tags + 缩略图自然推到底部 */
  flex: 0 1 auto;
}
</style>
