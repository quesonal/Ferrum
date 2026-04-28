import {defineStore} from 'pinia';
import {computed, ref, watch} from 'vue';
import {convertFileSrc, invoke} from '@tauri-apps/api/core';

interface ImageSupport {
  native: string[];
  transcode: string[];
  raw: string[];
  all: string[];
}

export const useImageStore = defineStore('image', () => {
  const currentPath = ref<string | null>(null);
  const currentImageId = ref<string | null>(null);
  const fileList = ref<string[]>([]);
  const lastDir = ref<string | null>(null);
  const previewSrc = ref<string | null>(null);
  const previewOrigWidth = ref(0);
  const previewOrigHeight = ref(0);
  let lastPreviewUrl: string | null = null;

  const currentSrc = computed(() => {
    if (!currentPath.value) return '';
    return getImageSrc(currentPath.value);
  });

  const currentIndex = computed(() => {
    if (!currentPath.value || fileList.value.length === 0) return -1;
    return fileList.value.indexOf(currentPath.value);
  });

  const getDir = (path: string) => {
    return path.substring(0, path.lastIndexOf('/') + 1)
      || path.substring(0, path.lastIndexOf('\\') + 1);
  };

  async function loadFile(path: string) {
    // 仅文件系统打开时清预览（无 imageId）；library 场景 currentImageId 已设，预览由 watch 管理
    if (!currentImageId.value) {
      clearPreview();
    }

    // 1. 立即更新当前路径，触发 ImageViewer 开始请求图片
    currentPath.value = path;

    const newDir = getDir(path);

    // 2. 如果文件夹已经扫描过，直接返回，不再重新扫描
    if (newDir === lastDir.value && fileList.value.length > 0) {
      return;
    }

    lastDir.value = newDir;
    updateImageList(path);
  }

  async function loadFolder(dirPath: string) {
    clearPreview();

    // 1. 更新最后访问的文件夹
    lastDir.value = dirPath;

    // 2. 获取该文件夹中的图片列表
    try {
      fileList.value = await invoke<string[]>('get_image_list', {path: dirPath});

      // 3. 如果有图片，加载第一张
      if (fileList.value.length > 0) {
        currentPath.value = fileList.value[0];
      }
    } catch (e) {
      console.error('加载文件夹失败:', e);
      fileList.value = [];
    }
  }

  async function updateImageList(path: string) {
    try {
      fileList.value = await invoke<string[]>('get_image_list', {path});
    } catch (e) {
      console.error('更新列表失败:', e);
      fileList.value = [path]; // 失败时至少保留当前图片
    }
  }

  function nextImage(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const nextIdx = (currentIndex.value + 1) % fileList.value.length;
    currentImageId.value = imageId ?? null;
    currentPath.value = fileList.value[nextIdx];
  }

  function prevImage(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const prevIdx = (currentIndex.value - 1 + fileList.value.length) % fileList.value.length;
    currentImageId.value = imageId ?? null;
    currentPath.value = fileList.value[prevIdx];
  }

  function firstImage(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    currentImageId.value = imageId ?? null;
    currentPath.value = fileList.value[0];
  }

  function lastImage(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    currentImageId.value = imageId ?? null;
    currentPath.value = fileList.value[fileList.value.length - 1];
  }

  function forward10(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const nextIdx = currentIndex.value + 10 < fileList.value.length ? currentIndex.value + 10 : fileList.value.length - 1;
    currentImageId.value = imageId ?? null;
    currentPath.value = fileList.value[nextIdx];
  }

  function backward10(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const nextIdx = currentIndex.value - 10 > 0 ? currentIndex.value - 10 : 0;
    currentImageId.value = imageId ?? null;
    currentPath.value = fileList.value[nextIdx];
  }

  const FORMATS_CACHE_KEY = 'ferrum:formats';

  // 尝试从 localStorage 加载缓存的格式列表
  function loadFormatsFromCache(): ImageSupport | null {
    try {
      const cached = localStorage.getItem(FORMATS_CACHE_KEY);
      if (cached) {
        return JSON.parse(cached) as ImageSupport;
      }
    } catch (e) {
      console.warn('Failed to load formats from cache:', e);
    }
    return null;
  }

  // 默认格式列表（硬编码，确保即使没有缓存也能基本工作）
  const defaultFormats: ImageSupport = {
    native: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'],
    transcode: ['tga', 'tiff', 'tif', 'dds', 'jxl', 'qoi', 'exr'],
    raw: ['rw2', 'arw', 'nef', 'cr2', 'cr3', 'dng', 'orf', 'raf'],
    all: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp',
          'tga', 'tiff', 'tif', 'dds', 'jxl', 'qoi', 'exr',
          'rw2', 'arw', 'nef', 'cr2', 'cr3', 'dng', 'orf', 'raf']
  };

  // 初始化：优先使用缓存或默认值，异步更新
  const formats = ref<ImageSupport>(loadFormatsFromCache() ?? defaultFormats);

  // 初始化格式列表（异步更新缓存）
  async function initFormats() {
    try {
      const freshFormats = await invoke<ImageSupport>('get_supported_formats');
      formats.value = freshFormats;
      // 缓存到 localStorage
      localStorage.setItem(FORMATS_CACHE_KEY, JSON.stringify(freshFormats));
    } catch (e) {
      console.error('Failed to fetch formats:', e);
      // 失败时保持现有值（缓存或默认）
    }
  }

  // 校验文件是否支持
  function isSupported(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    return formats.value.all.includes(ext);
  }

  // 根据扩展名选择协议：原生格式用 asset://（系统直读），需转码格式用 img://（自定义协议转 WebP）
  function getImageSrc(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const ext = path.split('.').pop()?.toLowerCase() || '';
    if (formats.value.native.includes(ext)) {
      return convertFileSrc(normalized);
    }
    return convertFileSrc(normalized, 'img');
  }

  // 从 index_vault 数据库加载预览图（WebP，已转码，秒出）
  async function loadPreview(imageId: string): Promise<boolean> {
    try {
      const result = await invoke<{ data: number[]; orig_width: number; orig_height: number } | null>(
        'library_read_preview', { imageId }
      );
      if (currentImageId.value !== imageId) return false;
      if (result && result.data && result.data.length > 0) {
        const newUrl = URL.createObjectURL(
          new Blob([new Uint8Array(result.data)], { type: 'image/webp' })
        );
        // 始终让新 preview 先就位，再废弃旧的。
        // 废弃操作不 await：即使在导航频繁的场景下，
        // 旧 blob 也会在 GC 时被回收，不需要同步回收造成白屏。
        const oldUrl = lastPreviewUrl;
        previewSrc.value = newUrl;
        lastPreviewUrl = newUrl;
        previewOrigWidth.value = result.orig_width;
        previewOrigHeight.value = result.orig_height;
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        return true;
      }
    } catch (e) {
      console.error('Failed to load preview:', e);
    }
    return false;
  }

  function clearPreview() {
    previewSrc.value = null;
    previewOrigWidth.value = 0;
    previewOrigHeight.value = 0;
    if (lastPreviewUrl) {
      URL.revokeObjectURL(lastPreviewUrl);
      lastPreviewUrl = null;
    }
  }

  // currentImageId 变化说明在看另一张图，加载新预览
  // 只在这里清 preview，不要在 watch(currentPath) 里清
  watch(currentImageId, async (newId) => {
    clearPreview();
    if (newId) {
      await loadPreview(newId);
    }
  });

  return {
    formats,
    initFormats,
    isSupported,
    getImageSrc,
    currentPath,
    currentImageId,
    currentSrc,
    previewSrc,
    previewOrigWidth,
    previewOrigHeight,
    loadFile,
    loadFolder,
    loadPreview,
    clearPreview,
    nextImage,
    prevImage,
    fileList,
    firstImage,
    lastImage,
    forward10,
    backward10
  };
});