import {defineStore} from 'pinia';
import {computed, ref} from 'vue';
import {convertFileSrc, invoke} from '@tauri-apps/api/core';

interface ImageSupport {
  native: string[];
  transcode: string[];
  raw: string[];
  all: string[];
}

export const useImageStore = defineStore('image', () => {
  const currentPath = ref<string | null>(null);
  const fileList = ref<string[]>([]);
  const lastDir = ref<string | null>(null);

  const currentSrc = computed(() => {
    if (!currentPath.value) return '';
    return convertFileSrc(currentPath.value, 'img');
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

  function nextImage() {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const nextIdx = (currentIndex.value + 1) % fileList.value.length;
    currentPath.value = fileList.value[nextIdx];
  }

  function prevImage() {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    // 处理负数索引
    const prevIdx = (currentIndex.value - 1 + fileList.value.length) % fileList.value.length;
    currentPath.value = fileList.value[prevIdx];
  }

  function firstImage() {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    currentPath.value = fileList.value[0];
  }

  function lastImage() {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    currentPath.value = fileList.value[fileList.value.length - 1];
  }

  function forward10() {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const nextIdx = currentIndex.value + 10 < fileList.value.length ? currentIndex.value + 10 : fileList.value.length;
    currentPath.value = fileList.value[nextIdx]
  }

  function backward10() {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const nextIdx = currentIndex.value - 10 > 0 ? currentIndex.value - 10 : 0;
    currentPath.value = fileList.value[nextIdx]
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

  return {
    formats,
    initFormats,
    isSupported,
    currentPath,
    currentSrc,
    loadFile,
    loadFolder,
    nextImage,
    prevImage,
    fileList,
    firstImage,
    lastImage,
    forward10,
    backward10
  };
});