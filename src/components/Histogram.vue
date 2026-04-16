<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  imageSrc: string;
}

const props = defineProps<Props>();

// Histogram data: 256 bins for R, G, B channels
const histogramData = ref<{ r: number[]; g: number[]; b: number[] }>({
  r: new Array(256).fill(0),
  g: new Array(256).fill(0),
  b: new Array(256).fill(0),
});

// EXIF data
interface ExifData {
  width?: number;
  height?: number;
  fileSize?: string;
  fileType?: string;
  dateTaken?: string;
  camera?: string;
  lens?: string;
  iso?: string;
  aperture?: string;
  shutter?: string;
  focalLength?: string;
  equivalentFocalLength?: string;
}

const exifData = ref<ExifData>({});
const hasExif = computed(() => Object.keys(exifData.value).length > 0);

// Format file size
const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

// Extract EXIF data from image
const extractExif = async (src: string) => {
  if (!src) return;

  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = src;
    });

    // Basic image info
    const newExif: ExifData = {
      width: img.naturalWidth,
      height: img.naturalHeight,
    };

    // Try to get file info and EXIF from backend
    try {
      // Extract file path from img:// URL or convert_file_src URL
      let filePath = '';
      if (src.startsWith('img://')) {
        filePath = decodeURIComponent(src.replace(/^img:\/\//, '').replace(/\+/g, ' '));
      } else if (src.includes('/')) {
        // Extract path from http:// or https:// URL from convert_file_src
        const url = new URL(src);
        filePath = decodeURIComponent(url.pathname);
        // On Windows, remove leading slash if present
        if (filePath.match(/^\/[A-Za-z]:/)) {
          filePath = filePath.slice(1);
        }
      }

      if (filePath) {
        // Get file size
        const fileInfo = await invoke<{ size: number; modified?: number }>('get_file_info', { path: filePath });
        if (fileInfo?.size) {
          newExif.fileSize = formatFileSize(fileInfo.size);
        }
        // Extract file extension from path
        const ext = filePath.split('.').pop()?.toUpperCase() || 'UNKNOWN';
        newExif.fileType = ext;

        // Get EXIF data
        const exifInfo = await invoke<{
          camera?: string;
          lens?: string;
          iso?: string;
          aperture?: string;
          shutter?: string;
          focal_length?: string;
          equivalent_focal_length?: string;
          date_taken?: string;
        }>('get_exif_data', { path: filePath });

        if (exifInfo?.camera) newExif.camera = exifInfo.camera;
        if (exifInfo?.lens) newExif.lens = exifInfo.lens;
        if (exifInfo?.iso) newExif.iso = exifInfo.iso;
        if (exifInfo?.aperture) newExif.aperture = exifInfo.aperture;
        if (exifInfo?.shutter) newExif.shutter = exifInfo.shutter;
        if (exifInfo?.focal_length) newExif.focalLength = exifInfo.focal_length;
        if (exifInfo?.equivalent_focal_length) newExif.equivalentFocalLength = exifInfo.equivalent_focal_length;
        if (exifInfo?.date_taken) newExif.dateTaken = exifInfo.date_taken;
      }
    } catch (e) {
      // Backend may not have this command, ignore
      console.log('Failed to get file info:', e);
    }

    exifData.value = newExif;
  } catch (e) {
    console.error('Failed to extract EXIF:', e);
    exifData.value = {};
  }
};

// Calculate histogram from image
const calculateHistogram = async (src: string) => {
  if (!src) return;

  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = src;
    });

    // Create canvas for pixel analysis
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    // Downsample for performance (max 400px width)
    const scale = Math.min(1, 400 / img.naturalWidth);
    canvas.width = Math.floor(img.naturalWidth * scale);
    canvas.height = Math.floor(img.naturalHeight * scale);

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Reset histogram
    const r = new Array(256).fill(0);
    const g = new Array(256).fill(0);
    const b = new Array(256).fill(0);

    // Calculate histogram (skip alpha channel)
    for (let i = 0; i < data.length; i += 4) {
      r[data[i]]++;
      g[data[i + 1]]++;
      b[data[i + 2]]++;
    }

    // Normalize to 0-100 range for display
    const maxCount = Math.max(
      Math.max(...r),
      Math.max(...g),
      Math.max(...b),
      1
    );

    histogramData.value = {
      r: r.map(v => (v / maxCount) * 100),
      g: g.map(v => (v / maxCount) * 100),
      b: b.map(v => (v / maxCount) * 100),
    };
  } catch (e) {
    console.error('Failed to calculate histogram:', e);
  }
};

// Debounced calculations
let debounceTimer: number | null = null;
watch(() => props.imageSrc, (newSrc) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    calculateHistogram(newSrc);
    extractExif(newSrc);
  }, 100);
}, { immediate: true });

// Generate SVG path for a channel
const getPath = (data: number[], height: number) => {
  if (!data.length) return '';

  const step = 100 / 256; // 100 is viewBox width
  let path = `M 0 ${height}`;

  for (let i = 0; i < 256; i++) {
    const x = i * step;
    const y = height - (data[i] / 100) * height;
    path += ` L ${x} ${y}`;
  }

  path += ` L 100 ${height} Z`;
  return path;
};

const rPath = computed(() => getPath(histogramData.value.r, 40));
const gPath = computed(() => getPath(histogramData.value.g, 40));
const bPath = computed(() => getPath(histogramData.value.b, 40));
</script>

<template>
  <div class="info-panel">
    <!-- Histogram Section -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">RGB Histogram</span>
      </div>
      <div class="histogram-chart">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" class="histogram-svg">
          <!-- Grid lines -->
          <line x1="0" y1="10" x2="100" y2="10" class="grid-line" />
          <line x1="0" y1="20" x2="100" y2="20" class="grid-line" />
          <line x1="0" y1="30" x2="100" y2="30" class="grid-line" />

          <!-- Red channel -->
          <path :d="rPath" class="channel-r" fill="rgba(255, 80, 80, 0.6)" />
          <!-- Green channel -->
          <path :d="gPath" class="channel-g" fill="rgba(80, 255, 80, 0.6)" />
          <!-- Blue channel -->
          <path :d="bPath" class="channel-b" fill="rgba(80, 140, 255, 0.6)" />

          <!-- Border line at bottom -->
          <line x1="0" y1="39.5" x2="100" y2="39.5" class="border-line" />
        </svg>
      </div>
    </div>

    <!-- EXIF Section -->
    <div class="section exif-section" v-if="hasExif">
      <div class="section-header">
        <span class="section-title">EXIF</span>
      </div>
      <div class="exif-content">
        <div class="exif-row" v-if="exifData.width && exifData.height">
          <span class="exif-label">Dimensions</span>
          <span class="exif-value">{{ exifData.width }} × {{ exifData.height }}</span>
        </div>
        <div class="exif-row" v-if="exifData.fileSize">
          <span class="exif-label">Size</span>
          <span class="exif-value">{{ exifData.fileSize }}</span>
        </div>
        <div class="exif-row" v-if="exifData.fileType">
          <span class="exif-label">Type</span>
          <span class="exif-value">{{ exifData.fileType }}</span>
        </div>
        <div class="exif-row" v-if="exifData.camera">
          <span class="exif-label">Camera</span>
          <span class="exif-value">{{ exifData.camera }}</span>
        </div>
        <div class="exif-row" v-if="exifData.lens">
          <span class="exif-label">Lens</span>
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
          <span class="exif-label">Date</span>
          <span class="exif-value">{{ exifData.dateTaken }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.info-panel {
  position: fixed;
  left: 16px;
  bottom: 72px;
  width: 220px;
  max-height: 280px;
  background: rgba(0, 0, 0, 0.8);
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  border: 2px solid rgba(255, 255, 255, 0.3);
  z-index: 50;
  backdrop-filter: blur(8px);
  overflow-y: auto;
}

.section {
  margin-bottom: 12px;
}

.section:last-child {
  margin-bottom: 0;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.section-title {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.7);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.histogram-chart {
  position: relative;
  width: 100%;
  height: 40px;
}

.histogram-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}

.grid-line {
  stroke: rgba(255, 255, 255, 0.1);
  stroke-width: 0.5;
}

.border-line {
  stroke: rgba(255, 255, 255, 0.3);
  stroke-width: 1;
}

.channel-r,
.channel-g,
.channel-b {
  transition: d 0.2s ease;
}

/* EXIF Section */
.exif-section {
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding-top: 10px;
}

.exif-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.exif-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  line-height: 1.4;
}

.exif-label {
  color: rgba(255, 255, 255, 0.5);
}

.exif-value {
  color: rgba(255, 255, 255, 0.85);
  text-align: right;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
