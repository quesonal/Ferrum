import {defineStore} from 'pinia';
import {computed, ref, watch} from 'vue';
import {convertFileSrc} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import {perfMark} from '../perf';
import { useNavigationStore } from '../composables/useNavigationStore';
import {
  checkAssetAccessible,
  getExifData,
  getFileInfo,
  getImageList,
  getSupportedFormats,
  libraryGetImagePath,
  libraryMetaBackfillOne,
  libraryMetaBackfillStart,
  libraryReadExif,
  libraryReadHistogram,
  libraryReadPreview,
} from '../api/commands';
import { invokeSafe } from '../utils/invokeSafe';
import { createTrackedBlobUrl } from '../utils/blobUrl';
import { createBoundedCache } from '../cache/createBoundedCache';
import { exifDtoToUi } from '../types/exif';

interface ImageSupport {
  native: string[];
  transcode: string[];
  raw: string[];
  all: string[];
}

export interface HistogramSource {
  kind: 'library' | 'filesystem';
  id?: string | null;
  path?: string | null;
}

export interface HistogramData {
  r: number[];  // 256 bins, normalized 0-100
  g: number[];
  b: number[];
  width: number;
  height: number;
}

export interface ExifData {
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
  width?: number;
  height?: number;
}

export interface HistogramAndExif {
  histogram: HistogramData;
  exif: ExifData;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)) + ' ' + sizes[i];
}

export const useImageStore = defineStore('image', () => {
  const navStore = useNavigationStore();
  const currentPath = ref<string | null>(null);
  // `currentImageId` is a **read-only mirror** of
  // `useNavigationStore().currentImageId`. Phase 3d collapsed the
  // dual-write storage into a single composable-owned ref; every
  // existing read (`:is-library-mode` prop, `watch(currentImageId, ...)`
  // preview pipeline, `useImageNavigation` etc.) keeps the same
  // `imageStore.currentImageId.value` API. Writes go through
  // `useNavigationStore().setCurrent(id)`. See `src/types/navigation.md`.
  const currentImageId = computed<string | null>(
    () => navStore.currentImageId.value,
  );
  const fileList = ref<string[]>([]);
  const lastDir = ref<string | null>(null);
  // indexByPath gives `currentIndex` O(1) lookup instead of O(n)
  // `indexOf`. Maintained incrementally by a `fileList` watcher — every
  // writer of `fileList.value` reassigns the array (no in-place push /
  // splice), so a single watch rebuild covers all paths. Fast-nav
  // long-press invokes `currentIndex.value` up to 25×/sec; with a 10k
  // file list the old indexOf was a measurable slice of the frame
  // budget.
  const indexByPath = new Map<string, number>();
  watch(fileList, (list) => {
    indexByPath.clear();
    for (let i = 0; i < list.length; i++) {
      indexByPath.set(list[i], i);
    }
  });
  const previewSrc = ref<string | null>(null);
  const previewOrigWidth = ref(0);
  const previewOrigHeight = ref(0);
  let lastPreviewUrl: string | null = null;

  // 预览缓存：FIFO + raw data，imageId → { data: Uint8Array, origWidth, origHeight }
  // cache 永远存原始字节：blob URL 是临时句柄，revoke 后立即失效，存进长生命周期容器
  // 会让下次 cache HIT 把已撤销 URL 推给 <img src> → ERR_FILE_NOT_FOUND。
  // 命中时按需 makeBlobUrl(cached.data)，每次 HIT 出一个新 URL ——
  // 详见 docs/PREVIEW_CACHE_DESIGN_2026-07-06.md + feedback memory。
  // size=10 + FIFO：linear navigation 场景足够，无需 LRU。
  const previewCache = createBoundedCache<{ data: Uint8Array; origWidth: number; origHeight: number }>({
    max: 10,
  });

  function makeBlobUrl(data: Uint8Array): string {
    return createTrackedBlobUrl(data).url;
  }

  // 推迟一帧再 revoke：让 <img> in-flight fetch 完成，
  // 【新增】同时给 Vue 的 Transition(150ms交叉淡化) 留出充足的内存读取时间
  function revokeBlobSafe(url: string) {
    setTimeout(() => URL.revokeObjectURL(url), 50);
  }

  // Library 模式 meta cache（Plan A Phase A4）。
  // 命中 = 0 IPC；未命中 = 2 个 IPC（library_read_histogram 二进制 +
  // library_read_exif JSON），结果归一化后入 cache。
  // size=20：每条 ~3KB（256 bins × 3 通道的归一化数组），
  // 20 条 ≈ 60KB，与 preview cache 10 × ~200KB 完全不在一个量级。
  // FIFO（无需 LRU，linear nav 命中下一张 = 下一张的 prev/next 也预热过）。
  const metaCache = createBoundedCache<HistogramAndExif>({ max: 20 });

  // Phase C2 / C4 — meta_cache backfill state.
  //
  // Startup backfill is triggered from `App.vue` (which awaits the
  // listener setup before calling `startMetaBackfill` so no progress
  // events are dropped). Frontend just listens for progress /
  // completed events and surfaces them as a corner chip — no client-
  // side orchestration needed for the bulk path.
  //
  // `pendingBackfill` is a per-image dedupe set for the lazy path:
  // when loadHistogram misses meta_cache, we fire `library_meta_backfill_one`
  // and immediately fall through to loadHistogramFromDisk for the
  // current frame. The Rust backend now also dedupes via an in-flight
  // HashSet (`LibraryStateInner.in_flight_backfills`), so this is a
  // cheap optimization that avoids one IPC round-trip when a request
  // for the same id is already in flight — not a correctness guarantee.
  const metaBackfillProgress = ref<{ processed: number; total: number } | null>(null);
  const pendingBackfill = new Set<string>();
  let metaBackfillListeners: UnlistenFn[] = [];

  /**
   * Drop a single imageId from metaCache. Called from
   * `libraryStore.markDeleted` after the Rust delete succeeds —
   * belt-and-suspenders so a stale cache row can't be served for an
   * image that no longer exists. Cheap (single Map.delete).
   */
  function deleteMetaCache(imageId: string) {
    if (imageId) metaCache.delete(imageId);
  }

  /**
   * Drop a single imageId from previewCache. Same rationale as
   * `deleteMetaCache`: `watch(currentImageId)` serves the preview
   * path cache-first, so a stale row from a previous file with the
   * same id (re-add hash collision) would be displayed with no
   * further IPC. The bytes don't leak a URL, but the staleness costs
   * more than the one-line `delete()`. See `src/utils/invalidate.ts`
   * for the cross-store rationale.
   */
  function deletePreviewCache(imageId: string) {
    if (imageId) previewCache.delete(imageId);
  }

  // 按目录缓存 asset 可访问性，避免重复 invoke。无 FIFO 上限：
// 目录列表有限（用户主动添加），每条只占 1 byte，且无 revoke 钩子需求。
// BoundedCache 用 Infinity 表示「不设上限」——等价于旧版裸 Map 的行为。
const assetAccessibleCache = createBoundedCache<boolean>({ max: Infinity });
  // currentSrc 改为 ref，由 watcher 异步更新（因为 asset 检查是异步的）
  const currentSrc = ref<string>('');
  // 启动优化标记：当 loadInitialFile 同步设置 currentSrc 后，watcher 不应再覆盖
  let skipNextSrcUpdate = false;

  const currentIndex = computed(() => {
    if (!currentPath.value || fileList.value.length === 0) return -1;
    // O(1) lookup via the indexByPath map maintained by the fileList
    // watcher above. Falls back to -1 if `currentPath` isn't in the list
    // (e.g. just-deleted, before removeFromFileList runs).
    return indexByPath.get(currentPath.value) ?? -1;
  });

  const getDir = (path: string) => {
    return path.substring(0, path.lastIndexOf('/') + 1)
      || path.substring(0, path.lastIndexOf('\\') + 1);
  };

  // 启动期专用：用户从 CLI 传入单个图片路径时同步设置 currentPath + currentSrc，
  // 跳过 watcher 的微任务延迟 + check_asset_accessible IPC（1-10ms + canonicalize）。
  // 用 img:// 直接加载（牺牲少量 asset:// 的 native 优化，换 5-30ms 启动时间）。
  // skipNextSrcUpdate 让 watcher 跳过本次覆盖，保留同步设置的值。
  // 不更新 fileList——后续 loadDirectory() 在后台异步补齐，供 arrow key 导航。
  function loadInitialFile(path: string) {
    skipNextSrcUpdate = true;
    navStore.setCurrent(null);
    clearPreview();
    const normalized = path.replace(/\\/g, '/');
    currentPath.value = path;
    currentSrc.value = convertFileSrc(normalized, 'img');
  }

  // 后台加载目录列表，仅供 arrow key 导航用。不阻塞图片显示。
  async function loadDirectory(path: string) {
    const newDir = getDir(path);
    if (newDir === lastDir.value && fileList.value.length > 0) return;
    lastDir.value = newDir;
    try {
      fileList.value = await getImageList(path);
    } catch (e) {
      console.warn('[imageStore] directory list failed:', e);
      fileList.value = [path];
    }
  }

  async function loadFile(path: string) {
    perfMark('switch::loadFile_start', { is_library: !!currentImageId.value });

    // 仅文件系统打开时清预览（无 imageId）；library 场景 currentImageId 已设，预览由 watch 管理
    if (!currentImageId.value) {
      clearPreview();
    }

    // 1. 立即更新当前路径，触发 ImageViewer 开始请求图片
    currentPath.value = path;
    perfMark('switch::currentPath_set');

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
      fileList.value = await getImageList(dirPath);

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
      fileList.value = await getImageList(path);
    } catch (e) {
      console.error('更新列表失败:', e);
      fileList.value = [path]; // 失败时至少保留当前图片
    }
  }

  // ---- image-switch perf instrumentation (only adds tracing markers) ----
  // Each navigation marker pairs a `nextImage_enter`/`exit` perf mark with
  // the `currentPath.value = fileList[...]` line that actually triggers
  // Vue reactivity + the <img> @load + the Rust protocol handler.
  // Keep these markers cheap: no bodies, just timestamps.

  function nextImage(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const nextIdx = (currentIndex.value + 1) % fileList.value.length;
    perfMark('switch::nextImage_enter', { idx: nextIdx });
    navStore.setCurrent(imageId ?? null);
    currentPath.value = fileList.value[nextIdx];
    perfMark('switch::nextImage_exit');
  }

  // 删除图片后清理 fileList：避免 fileList 仍指向磁盘上已删除的路径，
  // 否则下次 nextImage/prevImage 算 idx 时会拿到不存在的路径。
  // 必须在导航动作执行之后调用：nextImage 用 currentIndex 计算 nextIdx，
  // 若先删除 B 再 nav，B 已不在 list 里，currentIndex=-1，nextImage 直接 return。
  function removeFromFileList(path: string) {
    const idx = fileList.value.indexOf(path);
    if (idx >= 0) {
      fileList.value = fileList.value.filter(p => p !== path);
    }
  }

  function prevImage(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const prevIdx = (currentIndex.value - 1 + fileList.value.length) % fileList.value.length;
    perfMark('switch::prevImage_enter', { idx: prevIdx });
    navStore.setCurrent(imageId ?? null);
    currentPath.value = fileList.value[prevIdx];
    perfMark('switch::prevImage_exit');
  }

  function firstImage(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    perfMark('switch::firstImage_enter', { idx: 0 });
    navStore.setCurrent(imageId ?? null);
    currentPath.value = fileList.value[0];
    perfMark('switch::firstImage_exit');
  }

  function lastImage(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    perfMark('switch::lastImage_enter', { idx: fileList.value.length - 1 });
    navStore.setCurrent(imageId ?? null);
    currentPath.value = fileList.value[fileList.value.length - 1];
    perfMark('switch::lastImage_exit');
  }

  function forward10(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const nextIdx = currentIndex.value + 10 < fileList.value.length ? currentIndex.value + 10 : fileList.value.length - 1;
    perfMark('switch::forward10_enter', { idx: nextIdx });
    navStore.setCurrent(imageId ?? null);
    currentPath.value = fileList.value[nextIdx];
    perfMark('switch::forward10_exit');
  }

  function backward10(imageId?: string) {
    if (fileList.value.length === 0 || currentIndex.value === -1) return;
    const nextIdx = currentIndex.value - 10 > 0 ? currentIndex.value - 10 : 0;
    perfMark('switch::backward10_enter', { idx: nextIdx });
    navStore.setCurrent(imageId ?? null);
    currentPath.value = fileList.value[nextIdx];
    perfMark('switch::backward10_exit');
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
      const freshFormats = await getSupportedFormats();
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
  async function getImageSrc(path: string): Promise<string> {
    const normalized = path.replace(/\\/g, '/');
    const ext = path.split('.').pop()?.toLowerCase() || '';
    // 只有原生格式才尝试 asset://
    if (formats.value.native.includes(ext)) {
      // 按目录缓存 asset 可访问性，避免重复 invoke
      const dir = normalized.replace(/[^/]+$/, '');
      if (!assetAccessibleCache.has(dir)) {
        const dirPath = dir.replace(/\/$/, '').replace(/\//g, '\\');
        const accessible = await checkAssetAccessible(dirPath);
        assetAccessibleCache.set(dir, accessible);
      }
      if (assetAccessibleCache.get(dir)) {
        return convertFileSrc(normalized);
      }
    }
    return convertFileSrc(normalized, 'img');
  }

  // currentPath 变化 → 异步更新 currentSrc（先检查 asset 是否可用，失败则 fallback 到 img）
  watch(currentPath, async (newPath) => {
    if (skipNextSrcUpdate) {
      skipNextSrcUpdate = false;
      return;
    }
    if (!newPath) {
      currentSrc.value = '';
      return;
    }
    currentSrc.value = await getImageSrc(newPath);
  });

  // 从 index_vault 数据库加载预览图（WebP，已转码，秒出）
  // Rust 端 `tauri::ipc::Response` 单次二进制返回，前 8 字节是 [u32 LE width][u32 LE height]，
  // 之后是 WebP bytes；width=0 表示 not-found。避免旧版 `Vec<u8> → JSON number[]` 的序列化开销。
  // 详见 docs/PREVIEW_CACHE_DESIGN_2026-07-06.md「未来：Payload 优化」。
  async function loadPreview(imageId: string): Promise<boolean> {
    perfMark('switch::preview_load_begin', { imageId });
    try {
      const body = await libraryReadPreview(imageId);
      const view = new DataView(body);
      const origWidth = view.getUint32(0, true);
      const origHeight = view.getUint32(4, true);
      const hasImage = origWidth > 0 && body.byteLength > 8;
      perfMark('switch::preview_load_ipc_done', { has_data: hasImage });
      if (currentImageId.value !== imageId) {
        return false;
      }
      if (hasImage) {
        // 复用同一个 ArrayBuffer，零拷贝拿到 image bytes
        const data = new Uint8Array(body, 8);

        // 写 raw data 到 cache：下次访问走 cache HIT（makeBlobUrl 出新 URL，不复用旧 URL）
        previewCache.set(imageId, { data, origWidth, origHeight });
        const newUrl = makeBlobUrl(data);
        const oldUrl = lastPreviewUrl;
        previewSrc.value = newUrl;
        lastPreviewUrl = newUrl;
        previewOrigWidth.value = origWidth;
        previewOrigHeight.value = origHeight;
        // oldUrl 已无任何引用（cache 里只有 raw data），安全 revoke
        if (oldUrl) revokeBlobSafe(oldUrl);
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
      revokeBlobSafe(lastPreviewUrl);
      lastPreviewUrl = null;
    }
  }

  // 存储 library 全部 imageId 列表，用于计算相邻预览
  const libraryImageIds = ref<string[]>([]);

  function setLibraryImageIds(ids: string[]) {
    libraryImageIds.value = ids;
  }

  // ---- Histogram & EXIF ----
  // 父组件（ImageView.vue）通过 loadHistogram(source) 拉取数据，传 props 给 Histogram.vue。
  //
  // Filesystem 模式（/open?path=...）：fetch(getImageSrc(path)) → blob → createImageBitmap →
  //   RGB 累加，与 IPC get_exif_data 并行。完全绕开 canvas taint，slot <img> 不需要
  //   crossorigin="anonymous"。
  //
  // Library 模式（Slice 1 + 3）：走 `metaCache` FIFO（MAX=20）→ 命中 0 IPC；未命中并行发
  //   `library_read_histogram` + `library_read_exif` 两个 IPC，归一化后入 cache。再 miss
  //   → fire-and-forget `library_meta_backfill_one` 让 backend 后台补 meta，当前帧
  //   fallback 到 filesystem 路径。详 metaCache 设计见 docs/META_CACHE_PLAN_RUSTYVIEW_2026-07-10.md
  //   Slice 3 章节。

  async function fetchExif(filePath: string): Promise<ExifData> {
    const result: ExifData = {};
    if (!filePath) return result;
    try {
      const [fileInfo, exifInfo] = await Promise.all([
        invokeSafe(() => getFileInfo(filePath), null, 'get_file_info'),
        invokeSafe(() => getExifData(filePath), null, 'get_exif_data'),
      ]);
      if (fileInfo?.size) result.fileSize = formatFileSize(fileInfo.size);
      result.fileType = filePath.split('.').pop()?.toUpperCase() || 'UNKNOWN';
      Object.assign(result, exifDtoToUi(exifInfo));
    } catch (e) {
      console.warn('[imageStore] fetchExif error:', e);
    }
    return result;
  }

  async function fetchImageBytes(url: string): Promise<Uint8Array | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const blob = await response.blob();
      return new Uint8Array(await blob.arrayBuffer());
    } catch (e) {
      console.warn('[imageStore] fetchImageBytes failed:', url.slice(0, 60), e);
      return null;
    }
  }

  async function computeHistogramFromBytes(bytes: Uint8Array): Promise<HistogramData | null> {
    try {
      const blob = new Blob([bytes]);
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;

        const scale = Math.min(1, 300 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
        canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        const r = new Array(256).fill(0);
        const g = new Array(256).fill(0);
        const b = new Array(256).fill(0);
        for (let i = 0, len = data.length; i < len; i += 4) {
          r[data[i]]++;
          g[data[i + 1]]++;
          b[data[i + 2]]++;
        }
        let maxCount = 10;
        for (let i = 5; i < 250; i++) {
          if (r[i] > maxCount) maxCount = r[i];
          if (g[i] > maxCount) maxCount = g[i];
          if (b[i] > maxCount) maxCount = b[i];
        }
        return {
          r: r.map(v => Math.min(100, (v / maxCount) * 100)),
          g: g.map(v => Math.min(100, (v / maxCount) * 100)),
          b: b.map(v => Math.min(100, (v / maxCount) * 100)),
          width: bitmap.width,
          height: bitmap.height,
        };
      } finally {
        bitmap.close();
      }
    } catch (e) {
      console.warn('[imageStore] computeHistogramFromBytes failed:', e);
      return null;
    }
  }

  async function loadHistogramFromDisk(filePath: string): Promise<HistogramAndExif | null> {
    const url = await getImageSrc(filePath);

    // 并行：拿 bytes + 拉 EXIF。EXIF 失败不影响 histogram 返回。
    const [bytes, exif] = await Promise.all([
      fetchImageBytes(url),
      fetchExif(filePath),
    ]);
    if (!bytes) return null;

    const histogram = await computeHistogramFromBytes(bytes);
    if (!histogram) return null;

    return { histogram, exif: { ...exif, width: histogram.width, height: histogram.height } };
  }

  /**
   * Decode the `library_read_histogram` binary payload (3080 B on hit):
   *
   * ```text
   * offset 0      u32 LE width   ┐
   * offset 4      u32 LE height  ├ 8 B header
   * offset 8      r bins 1024 B  ┘
   * offset 1032   g bins 1024 B
   * offset 2056   b bins 1024 B   ← total 3080 B
   * ```
   *
   * Width=0 is the backend's not-found sentinel (also used when
   * meta_cache is uninitialized) — we return `null` so the caller can
   * fall back to `loadHistogramFromDisk` without further branching.
   *
   * Bins are 256 × `u32` LE counts; we normalize to 0-100 the same way
   * `computeHistogramFromBytes` does (max across mid-band r/g/b at
   * indices [5, 250), so tail bins don't blow out the scale).
   */
  function parseHistogramBinary(buf: ArrayBuffer): HistogramData | null {
    const u8 = new Uint8Array(buf);
    if (u8.byteLength < 8) {
      console.warn('[imageStore] parseHistogramBinary: buf too short (< 8B header)');
      perfMark('histogram::parse_too_short');
      return null;
    }
    const dv = new DataView(buf);
    const width = dv.getUint32(0, true);
    if (width === 0) {
      // Backend's not-found sentinel (also used when meta_cache isn't
      // initialized yet). Caller falls back to loadHistogramFromDisk.
      perfMark('histogram::parse_not_found');
      return null;
    }
    const height = dv.getUint32(4, true);
    // Layout: 8 B header + 3 × 1024 B bin channels = 3080 B.
    // Each channel is 256 × u32 LE (256 × 4 = 1024 B), packed back-to-back.
    const REQUIRED = 8 + 3 * 1024;
    if (u8.byteLength < REQUIRED) {
      console.warn(
        `[imageStore] parseHistogramBinary: width=${width} but buf is ${u8.byteLength}B ` +
        `(need ≥${REQUIRED}B); meta_cache row is truncated — treating as miss`
      );
      perfMark('histogram::parse_truncated');
      return null;
    }

    const readBins = (offset: number): number[] => {
      const bins = new Array<number>(256);
      for (let i = 0; i < 256; i++) {
        bins[i] = dv.getUint32(offset + i * 4, true);
      }
      return bins;
    };

    const rRaw = readBins(8);              // [8, 1032)
    const gRaw = readBins(8 + 1024);       // [1032, 2056)
    const bRaw = readBins(8 + 1024 + 1024);// [2056, 3080)

    let maxCount = 10;
    for (let i = 5; i < 250; i++) {
      if (rRaw[i] > maxCount) maxCount = rRaw[i];
      if (gRaw[i] > maxCount) maxCount = gRaw[i];
      if (bRaw[i] > maxCount) maxCount = bRaw[i];
    }

    return {
      r: rRaw.map(v => Math.min(100, (v / maxCount) * 100)),
      g: gRaw.map(v => Math.min(100, (v / maxCount) * 100)),
      b: bRaw.map(v => Math.min(100, (v / maxCount) * 100)),
      width,
      height,
    };
  }

  /**
   * Library mode fast path. Returns meta-backed `HistogramAndExif`
   * from `meta_cache.sqlite` via 2 IPCs (binary histogram + JSON EXIF),
   * or `null` when meta has no row for this id (or meta is not yet
   * initialized).
   *
   * The returned object is also stored in `metaCache` keyed by
   * `imageId` for subsequent hits (FIFO eviction at max=20).
   */
  async function loadLibraryMeta(source: HistogramSource): Promise<HistogramAndExif | null> {
    if (source.kind !== 'library' || !source.id) return null;

    const id = source.id;

    // 1. Memory cache hit — no IPC, no parse
    const cached = metaCache.get(id);
    if (cached) {
      perfMark('histogram::meta_cache_hit');
      return cached;
    }

    // 2. SQLite hit — 2 IPCs in parallel (binary + JSON), parse, insert
    try {
      const [histBuf, exifRow] = await Promise.all([
        libraryReadHistogram(id),
        libraryReadExif(id),
      ]);

      const histogram = parseHistogramBinary(histBuf);
      if (!histogram) return null; // not-found / uninit / corrupt

      // Merge EXIF into the UI's ExifData shape. width/height come from
      // the histogram row (matches loadHistogramFromDisk behavior).
      // The 8 photo fields come from exifDtoToUi (snake_case → camelCase).
      const exif: ExifData = {
        width: histogram.width,
        height: histogram.height,
        ...exifDtoToUi(exifRow),
      };

      const result: HistogramAndExif = { histogram, exif };

      // FIFO insert; bounded cache auto-evicts oldest past max
      metaCache.set(id, result);

      perfMark('histogram::meta_cache_miss');
      return result;
    } catch (e) {
      console.warn('[imageStore] loadLibraryMeta failed:', e);
      return null;
    }
  }

  async function loadHistogram(source: HistogramSource): Promise<HistogramAndExif | null> {
    // Library fast path: meta_cache.sqlite (Plan A) → 0 IPC on cache hit,
    // 2 IPCs on cold. Falls through to filesystem on miss / uninit.
    if (source.kind === 'library' && source.id) {
      const id = source.id;
      const result = await loadLibraryMeta(source);
      if (result) return result;

      // Miss: fire-and-forget lazy backfill so the next switch
      // back to this id hits meta_cache. Current frame falls
      // through to loadHistogramFromDisk so the user sees no delay.
      if (!pendingBackfill.has(id)) {
        pendingBackfill.add(id);
        // Backend swallows its own errors and warns; this catch
        // is just for the IPC transport (e.g. command not registered).
        invokeSafe(() => libraryMetaBackfillOne(id), undefined, 'library_meta_backfill_one')
          .finally(() => pendingBackfill.delete(id));
      }

      // Library mode: caller only has `id`, not the absolute path,
      // so we resolve it via `library_get_image_path` and run the
      // filesystem fallback. Without this, library-mode meta_cache
      // misses (cold release builds, in-flight backfill, DB uninit)
      // would surface as "no histogram" forever — the only path
      // back to the FS was guarded by `if (!source.path) return null`
      // which is always true here.
      if (!source.path) {
        try {
          const resolved = await libraryGetImagePath(id);
          if (resolved) return loadHistogramFromDisk(resolved);
        } catch (e) {
          console.warn('[imageStore] library_get_image_path failed for miss fallback:', e);
        }
      }
    }

    if (!source.path) return null;
    return loadHistogramFromDisk(source.path);
  }

  /**
   * Phase C4 — kick off the meta_cache backfill loop. Fire-and-forget;
   * the actual work happens in the Rust backend. Called once from
   * `App.vue` after `setupMetaBackfillListeners` resolves, so listener
   * wiring is live before any progress event can fire. Also kept for
   * dev retry / manual triggering from the console.
   */
  async function startMetaBackfill(): Promise<void> {
    try {
      await libraryMetaBackfillStart();
    } catch {
      // meta_cache not initialized (or command missing) — silently
      // swallow. The corner chip just won't appear.
    }
  }

  /**
   * Subscribe to backfill progress / completion events. Idempotent —
   * subsequent calls replace the prior listeners so HMR / route
   * remounts don't accumulate dangling UnlistenFns. Returns an
   * `UnlistenFn[]` for callers that want to detach (none today).
   */
  async function setupMetaBackfillListeners(): Promise<UnlistenFn[]> {
    for (const u of metaBackfillListeners) {
      u();
    }
    metaBackfillListeners = [];

    const u1 = await listen<[number, number]>(
      'library-meta-backfill-progress',
      (event) => {
        const [processed, total] = event.payload;
        if (total === 0) {
          // Empty queue — no UI shown. Backend emits 0/0 just so the
          // frontend has a deterministic "nothing to do" signal.
          metaBackfillProgress.value = null;
          return;
        }
        metaBackfillProgress.value = { processed, total };
      },
    );
    const u2 = await listen('library-meta-backfill-completed', () => {
      metaBackfillProgress.value = null;
    });

    metaBackfillListeners = [u1, u2];
    return metaBackfillListeners;
  }

  function getAdjacentIds(currentId: string): { prev: string | null; next: string | null } {
    const ids = libraryImageIds.value;
    const idx = ids.indexOf(currentId);
    return {
      prev: idx > 0 ? ids[idx - 1] : null,
      next: idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null,
    };
  }

  // Filesystem 模式浏览器层 preload：用 hidden <img> 触发 fetch+decode，
  // 让浏览器缓存相邻图片。下次用户切到这些图时省掉一次往返。
  // Library 模式由上面的 previewCache + library_read_preview 接管，跳过本路径。
  // 上限 MAX_FILESYSTEM_PREFETCH 个，FIFO 淘汰防止内存堆积。
  const MAX_FILESYSTEM_PREFETCH = 4;
  const filesystemPrefetchSet = new Set<string>();
  const filesystemPrefetchQueue: { path: string; img: HTMLImageElement }[] = [];

  async function prefetchFilesystemImage(path: string) {
    if (!path || filesystemPrefetchSet.has(path)) return;

    const img = new Image();
    img.decoding = 'async';
    img.style.position = 'absolute';
    img.style.width = '0';
    img.style.height = '0';
    img.style.opacity = '0';
    img.style.pointerEvents = 'none';
    img.src = await getImageSrc(path);
    document.body.appendChild(img);

    // 加载失败时清掉这个 entry，避免占着缓存名额
    img.onerror = () => {
      const i = filesystemPrefetchQueue.findIndex(e => e.path === path);
      if (i >= 0) {
        filesystemPrefetchQueue[i].img.remove();
        filesystemPrefetchQueue.splice(i, 1);
        filesystemPrefetchSet.delete(path);
      }
    };

    filesystemPrefetchSet.add(path);
    filesystemPrefetchQueue.push({ path, img });

    while (filesystemPrefetchQueue.length > MAX_FILESYSTEM_PREFETCH) {
      const oldest = filesystemPrefetchQueue.shift()!;
      oldest.img.src = '';
      oldest.img.remove();
      filesystemPrefetchSet.delete(oldest.path);
    }
  }

  let prefetchFsTimer: number | null = null;

  function prefetchAdjacentFilesystem() {
    // 只有 FS 模式进行预加载
    if (currentImageId.value) return;
    const list = fileList.value;
    if (list.length === 0) return;
    const cur = currentPath.value;
    if (!cur) return;
    const idx = list.indexOf(cur);
    if (idx < 0) return;

    // 加入防抖逻辑
    // 当用户正在以 100ms 的间隔疯狂按方向键时，不断重置定时器，绝不触发后台加载。
    // 只有当用户在某张图片上停留超过 250ms 时，才默默在后台拉取相邻的图片。
    // 避免 I/O 风暴！
    if (prefetchFsTimer !== null) {
      clearTimeout(prefetchFsTimer);
    }

    prefetchFsTimer = window.setTimeout(async () => {
      prefetchFsTimer = null;
      if (idx + 1 < list.length) await prefetchFilesystemImage(list[idx + 1]);
      if (idx - 1 >= 0) await prefetchFilesystemImage(list[idx - 1]);
    }, 250);
  }

  // 触发点：currentPath 变化（任何导航）+ fileList 变化（cold start 补一次）
  watch(currentPath, prefetchAdjacentFilesystem);
  watch(fileList, prefetchAdjacentFilesystem);

  async function prefetchPreview(imageId: string) {
    if (!imageId) return;
    // 已缓存：FIFO 不重排，直接跳过
    if (previewCache.has(imageId)) return;
    try {
      const body = await libraryReadPreview(imageId);
      const view = new DataView(body);
      const origWidth = view.getUint32(0, true);
      const origHeight = view.getUint32(4, true);
      if (origWidth > 0 && body.byteLength > 8) {
        // subarray(8) 零拷贝拿到 image bytes
        const data = new Uint8Array(body, 8);
        previewCache.set(imageId, { data, origWidth, origHeight });
      }
    } catch { /* prefetch 失败静默忽略 */ }
  }

  // currentImageId 变化 → 优先查缓存，缓存未命中则从后端加载
  watch(currentImageId, async (newId) => {
    if (!newId) {
      clearPreview();
      return;
    }

    perfMark('switch::preview_watch', { newId });
    const cached = previewCache.get(newId);
    if (cached) {
      // 缓存命中：原子替换，无闪烁
      perfMark('switch::preview_cache_hit');
      const oldUrl = lastPreviewUrl;
      // cache 存的是 raw data，每次 HIT 重新 makeBlobUrl，URL 永远是新的活 URL
      const newUrl = makeBlobUrl(cached.data);
      previewSrc.value = newUrl;
      lastPreviewUrl = newUrl;
      previewOrigWidth.value = cached.origWidth;
      previewOrigHeight.value = cached.origHeight;
      // oldUrl 没地方引用了（cache 里只有 raw data），安全 revoke
      if (oldUrl) revokeBlobSafe(oldUrl);
      perfMark('switch::preview_visible');
    } else {
      // 缓存未命中：先清空旧预览（防止显示上一张图的预览），再异步加载
      perfMark('switch::preview_cache_miss');
      clearPreview();
      await loadPreview(newId);
    }
    // 预取相邻预览
    const adj = getAdjacentIds(newId);
    prefetchPreview(adj.prev!);
    prefetchPreview(adj.next!);
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
    loadInitialFile,
    loadDirectory,
    loadFolder,
    loadPreview,
    clearPreview,
    prefetchPreview,
    prefetchAdjacentFilesystem,
    setLibraryImageIds,
    libraryImageIds,
    getAdjacentIds,
    loadHistogram,
    deleteMetaCache,
    deletePreviewCache,
    nextImage,
    prevImage,
    removeFromFileList,
    fileList,
    firstImage,
    lastImage,
    forward10,
    backward10,
    // Phase C2 / C4 — meta_cache backfill
    metaBackfillProgress,
    startMetaBackfill,
    setupMetaBackfillListeners,
  };
});
