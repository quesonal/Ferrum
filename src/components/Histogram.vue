<script setup lang="ts">
import { computed } from 'vue';
import type { HistogramData, ExifData } from '../stores/imageStore';

interface Props {
  histogramData: HistogramData | null;
  exifData: ExifData;
  isLoading: boolean;
}

const props = defineProps<Props>();

const hasHistogram = computed(() => {
  const d = props.histogramData;
  return !!(d && (d.r.some(v => v > 0) || d.g.some(v => v > 0)));
});

const hasExif = computed(() => Object.keys(props.exifData).length > 0);

// 生成平滑的 SVG Path
const getPath = (data: number[] | undefined) => {
  if (!data || data.length === 0) return '';
  const step = 100 / 255;
  let path = `M 0 100 `;
  for (let i = 0; i < 256; i++) {
    path += `L ${i * step} ${100 - data[i]} `;
  }
  path += `L 100 100 Z`;
  return path;
};

const rPath = computed(() => getPath(props.histogramData?.r));
const gPath = computed(() => getPath(props.histogramData?.g));
const bPath = computed(() => getPath(props.histogramData?.b));
</script>

<template>
  <div class="info-panel">
    <!-- 直方图区域 -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">{{ $t('exif.rgbHistogram', 'RGB Histogram') }}</span>
      </div>

      <div class="histogram-chart">
        <!-- 骨架屏 (加载中或无数据时) -->
        <Transition name="fade">
          <div v-if="isLoading || !hasHistogram" class="skeleton-chart absolute-inset">
            <div class="skeleton-bar" v-for="i in 12" :key="i" :style="{ height: `${Math.random() * 60 + 20}%`, animationDelay: `${i * 0.05}s` }"></div>
          </div>
        </Transition>

        <!-- 真实的直方图 -->
        <Transition name="fade">
          <svg v-show="!isLoading && hasHistogram" viewBox="0 0 100 100" preserveAspectRatio="none" class="histogram-svg absolute-inset">
            <!-- 背景网格辅助线 -->
            <line x1="0" y1="25" x2="100" y2="25" class="grid-line" />
            <line x1="0" y1="50" x2="100" y2="50" class="grid-line" />
            <line x1="0" y1="75" x2="100" y2="75" class="grid-line" />

            <!-- RGB 混合通道 (采用 blend-mode 滤色混合，重叠部分变为白色/青色/洋红，对标专业修图软件) -->
            <g class="histogram-group">
              <path :d="rPath" class="channel-r" />
              <path :d="gPath" class="channel-g" />
              <path :d="bPath" class="channel-b" />
            </g>
            <line x1="0" y1="99.5" x2="100" y2="99.5" class="border-line" />
          </svg>
        </Transition>
      </div>
    </div>

    <!-- EXIF 区域 -->
    <div class="section exif-section">
      <div class="section-header">
        <span class="section-title">{{ $t('exif.title', 'Metadata') }}</span>
      </div>

      <div class="exif-content">
        <!-- 骨架屏 -->
        <template v-if="isLoading || !hasExif">
          <div class="exif-row" v-for="i in 5" :key="i">
            <span class="skeleton-text" :style="{ width: `${30 + (i%3) * 10}%` }"></span>
            <span class="skeleton-text" :style="{ width: `${40 + (i%2) * 20}%` }"></span>
          </div>
        </template>

        <!-- 真实数据 -->
        <template v-else>
          <div class="exif-row" v-if="exifData.width && exifData.height">
            <span class="exif-label">{{ $t('exif.dimensions', 'Dimensions') }}</span>
            <span class="exif-value highlight">{{ exifData.width }} × {{ exifData.height }}</span>
          </div>
          <div class="exif-row" v-if="exifData.fileSize">
            <span class="exif-label">{{ $t('exif.size', 'Size') }}</span>
            <span class="exif-value">{{ exifData.fileSize }}</span>
          </div>
          <div class="exif-row" v-if="exifData.fileType">
            <span class="exif-label">{{ $t('exif.type', 'Type') }}</span>
            <span class="exif-value badge">{{ exifData.fileType }}</span>
          </div>
          <div class="exif-row" v-if="exifData.camera">
            <span class="exif-label">{{ $t('exif.camera', 'Camera') }}</span>
            <span class="exif-value">{{ exifData.camera }}</span>
          </div>
          <div class="exif-row" v-if="exifData.lens">
            <span class="exif-label">{{ $t('exif.lens', 'Lens') }}</span>
            <span class="exif-value">{{ exifData.lens }}</span>
          </div>
          <div class="exif-row" v-if="exifData.iso">
            <span class="exif-label">ISO</span>
            <span class="exif-value">{{ exifData.iso }}</span>
          </div>
          <div class="exif-row" v-if="exifData.aperture">
            <span class="exif-label">Aperture</span>
            <span class="exif-value">{{ exifData.aperture }}</span>
          </div>
          <div class="exif-row" v-if="exifData.shutter">
            <span class="exif-label">Shutter</span>
            <span class="exif-value">{{ exifData.shutter }}</span>
          </div>
          <div class="exif-row" v-if="exifData.focalLength || exifData.equivalentFocalLength">
            <span class="exif-label">Focal Length</span>
            <span class="exif-value">
              <template v-if="exifData.focalLength">{{ exifData.focalLength }}</template>
              <template v-if="exifData.focalLength && exifData.equivalentFocalLength"> / </template>
              <template v-if="exifData.equivalentFocalLength">{{ exifData.equivalentFocalLength }}</template>
            </span>
          </div>
          <div class="exif-row" v-if="exifData.dateTaken">
            <span class="exif-label">{{ $t('exif.date', 'Date') }}</span>
            <span class="exif-value">{{ exifData.dateTaken }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 直方图分区：扁平区块，glass 由父级 .sidebar-column 统一提供。
   flex:1 占据侧栏剩余空间，内部数据过多时自身滚动。 */
.info-panel {
  width: 100%;
  box-sizing: border-box;

  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto; /* 数据过多时内部滚动 */

  color: var(--glass-text);
  transition: all 0.3s ease;
}

.info-panel::-webkit-scrollbar {
  width: 4px;
}
.info-panel::-webkit-scrollbar-track {
  background: transparent;
}
.info-panel::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}
.info-panel::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.35);
}

.section {
  margin-bottom: 16px;
}
.section:last-child {
  margin-bottom: 0;
}

.section-header {
  margin-bottom: 8px;
}
.section-title {
  font-size: 10px;
  color: var(--glass-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  font-weight: 700;
}

/* 直方图布局 */
.histogram-chart {
  position: relative;
  width: 100%;
  height: 60px;
  /* 必须保持深色：RGB 路径用 mix-blend-mode: screen，需要暗背景才能正确叠加显色，
     故此处不接入 glass token，浅色主题下也维持深色 */
  background: rgba(0, 0, 0, 0.3);
  border-radius: 6px;
  overflow: hidden;
}

.absolute-inset {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}

.grid-line {
  stroke: rgba(255, 255, 255, 0.06);
  stroke-width: 1;
}

.border-line {
  stroke: rgba(255, 255, 255, 0.15);
  stroke-width: 2;
}

/* 专业级光学混合效果 */
.histogram-group {
  mix-blend-mode: screen; /* 核心魔法：RGB 叠加变白 */
}
.channel-r { fill: #ff3b30; transition: d 0.3s cubic-bezier(0.25, 1, 0.5, 1); }
.channel-g { fill: #34c759; transition: d 0.3s cubic-bezier(0.25, 1, 0.5, 1); }
.channel-b { fill: #007aff; transition: d 0.3s cubic-bezier(0.25, 1, 0.5, 1); }

/* 直方图骨架屏动画 */
.skeleton-chart {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 0 4px;
}
.skeleton-bar {
  width: 6%;
  background: var(--glass-fill);
  border-radius: 2px 0 0 0;
  animation: pulse-y 1s ease-in-out infinite alternate;
}

@keyframes pulse-y {
  0% { opacity: 0.3; transform: scaleY(0.8); transform-origin: bottom; }
  100% { opacity: 0.8; transform: scaleY(1.2); transform-origin: bottom; }
}

/* EXIF 数据列表 */
.exif-section {
  border-top: 1px solid var(--glass-border);
  padding-top: 12px;
}

.exif-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.exif-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 11px;
  line-height: 1.5;
}

.exif-label {
  color: var(--glass-text-dim);
  flex-shrink: 0;
}

.exif-value {
  color: var(--glass-text);
  text-align: right;
  max-width: 65%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums; /* 数字等宽，更好看 */
}

.exif-value.highlight {
  font-weight: 600;
  color: var(--glass-text);
}

.exif-value.badge {
  background: var(--glass-fill);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  letter-spacing: 0.5px;
}

/* EXIF 骨架屏 */
.skeleton-text {
  display: block;
  height: 10px;
  border-radius: 4px;
  background: var(--glass-fill);
  animation: pulse 1.5s ease-in-out infinite alternate;
}

@keyframes pulse {
  0% { opacity: 0.4; }
  100% { opacity: 1; }
}

/* Vue 过渡动画 */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>