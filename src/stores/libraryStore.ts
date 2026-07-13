import {defineStore} from 'pinia';
import {computed, markRaw, reactive, ref, shallowReactive, shallowRef} from 'vue';
import type {FolderNode} from '../types/folderNode';
import {listen} from "@tauri-apps/api/event";
import {useNavigationStore} from '../composables/useNavigationStore';
import {useTagStore} from './tagStore';
import { createTrackedBlobUrl } from '../utils/blobUrl';
import { createBoundedCache } from '../cache/createBoundedCache';
import { useRaceCounter } from '../utils/useRaceCounter';
import { useInflightKey } from '../utils/useInflightKey';
import { invalidateImage } from '../utils/invalidate';
import {
  libraryCompact,
  libraryGetAllImages,
  libraryGetFolderTree,
  libraryGetFolders,
  libraryGetImagePath,
  libraryGetImages,
  libraryGetImagesByIds,
  libraryGetStats,
  libraryGetTotalImageCount,
  libraryListImagesByTag,
  libraryListTags,
  libraryMarkDeleted,
  libraryReadThumbnail,
  libraryReadThumbnailsBatch,
  libraryRemoveSource,
  libraryScanFolder,
} from '../api/commands';

export interface GroupedFolder {
  hash: string;
  name: string;
  path: string;
  images: FlatImageEntry[];
}

// Types from backend
export interface FolderInfo {
  id: string;
  name: string;
  path: string;
  image_count: number;
  cover_image_id: string | null;
}

export interface ImageEntry {
  id: string;
  filename: string;
  folder_path: string;
  width: number;
  height: number;
  timestamp: number;
  has_large: boolean;
}

export interface FlatImageEntry {
  id: string;
  filename: string;
  folder_path: string;
  folder_name: string;
  folder_hash: string;
  width: number;
  height: number;
  timestamp: number;
  has_large: boolean;
}

export interface FlatTreeNode {
  node: FolderNode;
  level: number;
  isExpanded: boolean;
  hasChildren: boolean;
}

export interface LibraryStats {
  total_images: number;
  valid_images: number;
  deleted_images: number;
  folder_count: number;
}

export const useLibraryStore = defineStore('library', () => {
  // State
  const flatGridScrollTop = ref(0);
  const folderTreeScrollTop = ref(0);
  const sidebarVisible = ref(true);

  const folders = shallowRef<FolderInfo[]>([]);
  const folderTree = shallowRef<FolderNode[]>([]);  // 层级嵌套的文件夹树

  const visibleTreeNodes = shallowRef<FlatTreeNode[]>([]);

  const MAX_THUMBNAIL_CACHE_SIZE = 3000;

  const imagesByFolder = shallowReactive(new Map<string, FlatImageEntry[]>());
  const expandedNodes = reactive<Set<string>>(new Set());
  // thumbnailCache stores **blob URLs** — unlike the other caches,
  // this one needs an onEvict hook to call URL.revokeObjectURL on every
  // evicted URL. getThumbnailsBatch used to skip this path and leak
  // URLs after the cache filled past its cap. The factory handles
  // eviction uniformly across both single (`getThumbnail`) and batch
  // (`getThumbnailsBatch`) writers.
  // shallowReactive preserves the v-for reactivity in
  // FlatImageGrid.vue, which reads .has / .get per render-item.
  const thumbnailCache = shallowReactive(
    createBoundedCache<string>({
      max: MAX_THUMBNAIL_CACHE_SIZE,
      onEvict: (url) => URL.revokeObjectURL(url),
    }),
  );

  // Per-folder-hash in-flight dedupe + version for `loadFolderImages`.
// Replaces the previous hand-rolled
// `pendingRequests: Set<string>` + `loadVersions: Map<folderHash,
// number>` pair. The factory combines the dedupe gate
// (`tryBegin` returns null on conflict) with the stale-stamp check
// (`isLatest`) so the caller has one shape to follow.
  function loadFolderImagesKey(folderHash: string) {
    return useInflightKey(`library:load-folder-images:${folderHash}`);
  }

  // Per-tag-filter-load request version. Replaces the previous
  // module-scoped `loadImagesByTagGen` counter. Stamped by
  // `loadImagesByTag` and invalidated by `clearTagFilter` so any
  // in-flight load drops its writes when the filter changes.
  // Doesn't need a dedupe gate (concurrent clicks on the same tag
  // row are rare and idempotent), so `useRaceCounter` is enough.
  const loadImagesByTagVersion = useRaceCounter('library:load-images-by-tag');

  let folderTreeLoadingPromise: Promise<void> | null = null;
  const isLoading = ref(false);

  const navStore = useNavigationStore();
  const currentFolderId = ref<string | null>(null);
  // shallowRef: every writer reassigns the array (no in-place mutation),
  // so the reference-identity watch in LibraryView.vue fires without
  // needing `{ deep: true }` — deep-tracking on a 10k-entry library list
  // triggered per-render diffs that cost real FPS during paging.
  const images = shallowRef<ImageEntry[]>([]);
  // `currentImageId` is a **read-only mirror** of
  // `useNavigationStore().currentImageId`. Phase 3d collapsed the
  // dual-write storage into a single composable-owned ref; library
  // reads use the same `libraryStore.currentImageId.value` API as
  // before so every existing call-site (router guards, navigation
  // composables, `useHistogramSession` etc.) keeps working without
  // changes. Writes go through `useNavigationStore().setCurrent(id)`.
  // See `src/types/navigation.md`.
  const currentImageId = computed<string | null>(
    () => navStore.currentImageId.value,
  );
  const stats = ref<LibraryStats | null>(null);
  const scanProgress = ref<{ current: number; total: number } | null>(null);

  // Flat view state (Picasa-style all images view)
  const flatImages = shallowRef<FlatImageEntry[]>([]);
  const totalImageCount = ref<number>(0);
  const flatViewLoading = ref<boolean>(false);
  // const maxCacheSize = 2000;

  // --- Tag filter state (Phase B3) ---
  //
  // When `currentTagId !== null`, FlatImageGrid renders a single
  // synthetic block whose hash is `tag:<id>` and whose image list is
  // `tagFilteredImages`. The same array is mirrored into
  // `imagesByFolder` under that hash so `getCurrentFolderIds()` in
  // ImageView picks it up naturally for prev/next cycling.
  const currentTagId = ref<number | null>(null);
  const tagFilteredImages = shallowRef<FlatImageEntry[]>([]);
  const tagFilterTagName = ref<string | null>(null);
  // Race-counter: any in-flight loadImagesByTag whose stamp has been
  // superseded is a no-op for state writes. Without this, a slow IPC
  // can resurrect a filter the user already cleared by clicking
  // another tag row or a folder row.
  // Pairs with `loadImagesByTagVersion` declared above.

  function toFlatImageEntries(
    entries: readonly ImageEntry[],
    fallbackFolderHash?: string,
  ): FlatImageEntry[] {
    const foldersByPath = new Map(
      folders.value.map((folder) => [folder.path.replace(/[\\/]$/, ''), folder]),
    );
    const fallbackFolder = fallbackFolderHash
      ? folders.value.find((folder) => folder.id === fallbackFolderHash)
      : undefined;

    return entries.map((entry) => {
      const folderPath = entry.folder_path.replace(/[\\/]$/, '');
      const folder = foldersByPath.get(folderPath) ?? fallbackFolder;
      return {
        ...entry,
        folder_name: folder?.name ?? '',
        folder_hash: folder?.id ?? fallbackFolderHash ?? '',
      };
    });
  }

  function updateVisibleTree() {
    const flatList: FlatTreeNode[] = [];

    // 使用非递归的深度优先遍历(迭代法)防止2万级深度栈溢出
    const stack: { node: FolderNode; level: number }[] = [];

    // 逆序压栈以保证正序出栈
    for (let i = folderTree.value.length - 1; i >= 0; i--) {
      stack.push({node: folderTree.value[i], level: 0});
    }

    while (stack.length > 0) {
      const {node, level} = stack.pop()!;
      const hasChildren = node.children && node.children.length > 0;
      const isExpanded = expandedNodes.has(node.path);

      flatList.push({node, level, isExpanded, hasChildren});

      // 如果当前节点展开且有子节点，将子节点逆序压栈
      if (isExpanded && hasChildren) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push({node: node.children[i], level: level + 1});
        }
      }
    }

    // markRaw 避免 Vue 拦截这数万个对象的属性
    visibleTreeNodes.value = markRaw(flatList);
  }

  // Getters
  const currentFolder = computed(() =>
    folders.value.find(f => f.id === currentFolderId.value)
  );

  const currentImage = computed(() =>
    images.value.find(img => img.id === currentImageId.value)
  );

  const currentImageIndex = computed(() =>
    images.value.findIndex(img => img.id === currentImageId.value)
  );

  // 缓存 groupedImages 结果，避免频繁重算
  let cachedGroupedImages: GroupedFolder[] = [];
  let lastFlatImagesLength = 0;
  let lastFolderTreeHash = '';

  /**
   * 按照 folderTree 顺序排列的分组图片
   * 包含所有文件夹（包括没图片的空占位），确保布局稳定
   * 使用缓存避免频繁重算
   */
  const groupedImages = computed<GroupedFolder[]>(() => {
    // 简单判断数据是否有变化：flatImages 长度和 folderTree 结构
    const currentTreeHash = folderTree.value.map(n => n.path).join('|');
    const flatLength = flatImages.value.length;

    if (flatLength === lastFlatImagesLength && currentTreeHash === lastFolderTreeHash && cachedGroupedImages.length > 0) {
      return cachedGroupedImages;
    }

    lastFlatImagesLength = flatLength;
    lastFolderTreeHash = currentTreeHash;

    const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
    // 第一步：从 flatImages 中收集有图片的文件夹
    const groups: Map<string, { name: string; path: string; images: FlatImageEntry[] }> = new Map();

    flatImages.value.forEach(img => {
      const p = (img.folder_path || '').replace(/[\\/]$/, '');
      if (!groups.has(img.folder_hash)) {
        groups.set(img.folder_hash, {name: img.folder_name, path: p, images: []});
      }
      groups.get(img.folder_hash)!.images.push(img);
    });

    // 第二步：按照 folderTree 的顺序排列（包含所有文件夹，没图片的显示为空）
    const result: GroupedFolder[] = [];

    const collectInTreeOrder = (nodes: FolderNode[]) => {
      nodes.forEach(n => {
        const h = n.folderHash;
        if (h) {
          // 优先使用已加载的数据，没有则创建空占位
          if (groups.has(h)) {
            const group = groups.get(h)!;
            result.push({hash: h, ...group});
          } else {
            // 创建空占位，保持布局稳定
            result.push({
              hash: h,
              name: n.name,
              path: n.path,
              images: []
            });
          }
        }
        if (n.children?.length) collectInTreeOrder(n.children);
      });
    };

    if (folderTree.value.length > 0) {
      collectInTreeOrder(folderTree.value);
    } else {
      // fallback: folderTree 未加载时按路径排序
      cachedGroupedImages = Array.from(groups.entries())
        .map(([hash, d]) => ({hash, ...d}))
        .sort((a, b) => collator.compare(a.path, b.path));
      return cachedGroupedImages;
    }

    cachedGroupedImages = result;
    return result;
  });

  // Actions
  async function loadFolders() {
    const data = await libraryGetFolders();
    folders.value = markRaw(data);
  }

  /**
   * 加载层级嵌套的文件夹树结构
   */
  async function loadFolderTree() {
    if (folderTreeLoadingPromise) return folderTreeLoadingPromise;
    folderTreeLoadingPromise = (async () => {
      try {
        const tree = await libraryGetFolderTree();
        folderTree.value = markRaw(sortFolderTree(tree));
        if (expandedNodes.size === 0) {
          expandAllNodes(folderTree.value);
        } else {
          updateVisibleTree(); // 数据加载完后初始化视图树
        }
      } finally {
        folderTreeLoadingPromise = null;
      }
    })();
    return folderTreeLoadingPromise;
  }

  /**
   * 递归排序文件夹树，使用与 FlatImageGrid 相同的排序逻辑
   */
  function sortFolderTree(nodes: FolderNode[]): FolderNode[] {
    const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
    const sorted = [...nodes].sort((a, b) => collator.compare(a.path, b.path));
    sorted.forEach(node => {
      if (node.children?.length > 0) node.children = sortFolderTree(node.children);
    });
    return sorted;
  }

  async function update_folder_data() {
    await Promise.all([
      loadFolders(),
      loadFolderTree()
    ]);

    // 2. 如果当前正在看扫描中的文件夹，增量拉取新图片
    if (currentFolderId.value) {
      await loadFolderImages(currentFolderId.value, true);
    }
    // Flat view: no cache clearing needed. The visibleRenderItems computed
    // already detects stale data per-block (loadedImages.length < block.imageCount
    // for updated folders, !loadedImages for new folders) and triggers reloads.
    // Clearing imagesByFolder caused every block to flash empty simultaneously
    // and raced with in-flight loadFolderImages requests.
  }

  listen('library-db-updated', async () => {
    await update_folder_data()
  });

  // 监听增量更新
  listen('library-db-incremental-update', async () => {
    await update_folder_data()
  });

  listen('library-scan-progress', (event) => {
    const [current, total] = event.payload as [number, number];
    scanProgress.value = { current, total };
  });

  async function scanFolder(folderPath: string, recursive = true, scanMode = 'auto') {
    isLoading.value = true;
    try {
      await libraryScanFolder({folder_path: folderPath, recursive, scan_mode: scanMode});
      // 最终扫描完成后的刷新
      await loadFolderTree();
    } finally {
      isLoading.value = false;
    }
  }

  async function loadImages(folderId: string, offset = 0, limit = 100) {
    try {
      isLoading.value = true;
      currentFolderId.value = folderId;

      const newImages = await libraryGetImages(folderId, offset, limit);

      if (offset === 0) {
        images.value = newImages;
      } else {
        // shallowRef requires reassignment — no in-place push.
        images.value = [...images.value, ...newImages];
      }
    } catch (e) {
      console.error('Failed to load images:', e);
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Load all images from all folders (Picasa-style flat view)
   */
  async function loadAllImages(offset = 0, limit = 500) {
    try {
      flatViewLoading.value = true;

      const [newImages, total] = await Promise.all([
        libraryGetAllImages(offset, limit),
        libraryGetTotalImageCount()
      ]);

      totalImageCount.value = total;

      if (offset === 0) {
        flatImages.value = newImages;
      } else {
        flatImages.value.push(...newImages);
      }
    } catch (e) {
      console.error('Failed to load all images:', e);
    } finally {
      flatViewLoading.value = false;
    }
  }

  /**
   * Load more images for flat view (pagination)
   */
  async function loadMoreFlatImages() {
    if (flatViewLoading.value) return;
    if (flatImages.value.length >= totalImageCount.value) return;

    await loadAllImages(flatImages.value.length, 500);
  }

  /**
   * Load images for a specific folder and prepend to flatImages
   * This ensures the folder's images are visible immediately when clicking on it
   */
  async function loadFolderImages(folderHash: string, force = false): Promise<boolean> {
    // 如果不是强制更新且已有数据，则跳过
    if (!force && imagesByFolder.has(folderHash)) {
      return true;
    }

// Per-folder-hash request version + in-flight dedupe. Replaces
    // the previous hand-rolled `loadVersions: Map<folderHash,
    // number>` + `pendingRequests: Set<folderHash>` pair. `tryBegin`
    // combines dedupe-and-stamp into one call — returns `null` when
    // another request for this folder is already in flight.
    const key = loadFolderImagesKey(folderHash);
    const stamp = key.tryBegin();
    if (stamp === null) {
      return true;
    }

    try {
      const newImages = toFlatImageEntries(
        await libraryGetImages(folderHash, 0, 50000),
        folderHash,
      );
      // Only apply if this is still the latest request for this folder
      if (!key.isLatest(stamp)) {
        return true;
      }
      imagesByFolder.set(folderHash, markRaw(newImages));
      return true;
    } catch (e) {
      console.error('loadFolderImages failed:', folderHash, e);
      return false;
    } finally {
      key.end();
    }
  }

  async function loadStats() {
    try {
      stats.value = await libraryGetStats();
    } catch (e) {
      console.error('Failed to load stats:', e);
    }
  }

  async function removeLibrarySource(folderPath: string) {
    isLoading.value = true;
    try {
      // 1. 调用后端标记删除数据库记录
      await libraryRemoveSource(folderPath);

      // 2. 刷新本地元数据
      await Promise.all([
        loadFolders(),
        loadFolderTree()
      ]);

      // 3. 如果当前正在看这个路径下的图片，清空视图缓存
      // 这里可以简单地清空 imagesByFolder 里的对应键值
      for (const [hash, _] of imagesByFolder.entries()) {
        // 保留 synthetic tag blocks（hash 以 `tag:` 开头）。tag filter
        // 与 folder 维度正交，删除一个 source 不应让用户先前选中的
        // tag 视图消失；如果 tag 集里的图实际被这次删除清空了，UI
        // 会自然显示空 grid，用户可重新点回 tag 或切换。
        if (hash.startsWith('tag:')) continue;
        imagesByFolder.delete(hash);
      }

      // 4. 失效该 source 下所有图片的 tag 缓存。tagStore 不能直接知道
      //    哪些 id 来自这个 path，所以保守地清空全部 per-image tag
      //    map —— memory 占用小（仅 imageId → Tag[]，且仅含 visited
      //    图片），下一次 watch currentImageId 触发的 loadForImage 会
      //    按需回填。
      useTagStore().tagsForImage.clear();

      console.log(`Source removed: ${folderPath}`);
    } catch (e) {
      console.error('Failed to remove source:', e);
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Phase B3: load images attached to a tag and put the result both
   * in `tagFilteredImages` (the rendered block source) and
   * `imagesByFolder['tag:<id>']` (so `getCurrentFolderIds()` in
   * ImageView can drive prev/next navigation).
   *
   * `tagName` is the UI label rendered in the block header (e.g.
   * "#Travel"). We fetch it via a parallel `library_list_tags` if
   * the caller didn't supply it.
   *
   * Race-aware: if the user re-clicks a different tag, clicks a
   * folder (which clears the filter), or `clearTagFilter()` is
   * called while we're awaiting IPC, the version is invalidated by
   * the newer call / clear path and we discard our writes.
   */
  async function loadImagesByTag(tagId: number, tagName?: string): Promise<void> {
    const stamp = loadImagesByTagVersion.begin();
    try {
      flatViewLoading.value = true;
      // Fetch ids and the tag name concurrently. `tagName` is
      // optional in the call site (the sidebar row may already have
      // the name from `tagStore.tags`), but `library_list_tags` is
      // cheap and ensures the header reflects the canonical name.
      const [ids, allTags] = await Promise.all([
        libraryListImagesByTag(tagId, 0, 10000),
        tagName ? Promise.resolve(null) : libraryListTags(),
      ]);
      if (!loadImagesByTagVersion.isLatest(stamp)) return;
      const resolvedName = tagName ?? (allTags?.find((t) => t.id === tagId)?.name ?? null);

      // Resolve ids → entries (filename/folder_path/etc.)
      const entries = ids.length > 0
        ? toFlatImageEntries(await libraryGetImagesByIds(ids))
        : [];
      if (!loadImagesByTagVersion.isLatest(stamp)) return;

      // Update store state.
      currentTagId.value = tagId;
      tagFilterTagName.value = resolvedName;
      tagFilteredImages.value = entries;
      const tagHash = `tag:${tagId}`;
      if (entries.length > 0) {
        imagesByFolder.set(tagHash, markRaw(entries));
      } else {
        imagesByFolder.delete(tagHash);
      }
    } catch (e) {
      if (!loadImagesByTagVersion.isLatest(stamp)) return;
      console.error('[library] loadImagesByTag failed:', tagId, e);
    } finally {
      if (loadImagesByTagVersion.isLatest(stamp)) {
        flatViewLoading.value = false;
      }
    }
  }

  function clearTagFilter(): void {
    // Invalidate any in-flight loadImagesByTag so it drops its writes.
    loadImagesByTagVersion.invalidate();
    flatViewLoading.value = false;
    if (currentTagId.value !== null) {
      imagesByFolder.delete(`tag:${currentTagId.value}`);
    }
    currentTagId.value = null;
    tagFilteredImages.value = [];
    tagFilterTagName.value = null;
  }

  /** Stable synthetic hash for a tag id, e.g. `tag:42`. */
  function tagHash(tagId: number): string {
    return `tag:${tagId}`;
  }

  /** True if `hash` is the synthetic block for the active tag. */
  function isTagBlockHash(hash: string): boolean {
    return hash.startsWith('tag:');
  }

  async function getThumbnail(imageId: string): Promise<string | null> {
    if (thumbnailCache.has(imageId)) return thumbnailCache.get(imageId)!;

    try {
      const data = await libraryReadThumbnail(imageId);
      if (data && data.length > 0) {
        // BoundedCache auto-evicts oldest + revokes the URL via onEvict.
        const url = createTrackedBlobUrl(data).url;
        thumbnailCache.set(imageId, url);
        return url;
      }
    } catch (e) {}
    return null;
  }

  async function getThumbnailsBatch(imageIds: string[]) {
    // 过滤掉已经缓存过的
    const missingIds = imageIds.filter(id => !thumbnailCache.has(id));
    if (missingIds.length === 0) return;

    try {
      // 调用 Rust 批量接口 (一次性获取所有二进制数据)
      const results = await libraryReadThumbnailsBatch(missingIds);

      // 批量转换为 Blob URL 并存入缓存。
      // 历史 bug：这段代码直接 set 但从不调用 URL.revokeObjectURL，
      // 一旦 cache 超过 3000 后 set 会触发 Map 自带的容量限制时漏掉 revoke —
      // 现在的 BoundedCache 在 factory 内部统一 evict + revoke，bug 修复。
      Object.entries(results).forEach(([id, data]) => {
        if (data && data.length > 0) {
          const url = createTrackedBlobUrl(data).url;
          thumbnailCache.set(id, url);
        }
      });
    } catch (e) {
      console.error('Batch thumbnail load failed:', e);
    }
  }

  // function addToCache(imageId: string, url: string) {
  //   // Evict oldest if cache is full
  //   if (thumbnailCache.value.size >= maxCacheSize) {
  //     const firstKey = thumbnailCache.value.keys().next().value;
  //     if (firstKey) {
  //       const oldUrl = thumbnailCache.value.get(firstKey);
  //       if (oldUrl) URL.revokeObjectURL(oldUrl);
  //       thumbnailCache.value.delete(firstKey);
  //     }
  //   }
  //
  //   thumbnailCache.value.set(imageId, url);
  // }
  //
  // function clearCache() {
  //   // Revoke all blob URLs
  //   for (const url of thumbnailCache.value.values()) {
  //     URL.revokeObjectURL(url);
  //   }
  //   thumbnailCache.value.clear();
  // }

  // Tree node expansion state management
  function isNodeExpanded(path: string): boolean {
    return expandedNodes.has(path);
  }

  function toggleNodeExpanded(path: string) {
    if (expandedNodes.has(path)) expandedNodes.delete(path);
    else expandedNodes.add(path);
    updateVisibleTree(); // 重算打平数组
  }

  function expandNode(path: string): void {
    expandedNodes.add(path);
  }

  function collapseNode(path: string): void {
    expandedNodes.delete(path);
  }

  // Recursively expand all nodes in the tree
  function expandAllNodes(nodes: FolderNode[]) {
    const traverse = (nList: FolderNode[]) => {
      for (const n of nList) {
        if (n.children && n.children.length > 0) {
          expandedNodes.add(n.path);
          traverse(n.children);
        }
      }
    };
    traverse(nodes);
    updateVisibleTree();
  }

  // Clear all expanded state
  function clearExpandedNodes(): void {
    expandedNodes.clear();
  }

  function selectImage(imageId: string) {
    navStore.setCurrent(imageId);
  }

  function nextImage() {
    if (images.value.length === 0) return;
    const currentIdx = currentImageIndex.value;
    if (currentIdx < images.value.length - 1) {
      navStore.setCurrent(images.value[currentIdx + 1].id);
    }
  }

  function prevImage() {
    if (images.value.length === 0) return;
    const currentIdx = currentImageIndex.value;
    if (currentIdx > 0) {
      navStore.setCurrent(images.value[currentIdx - 1].id);
    }
  }

  async function markDeleted(imageId: string) {
    try {
      const success = await libraryMarkDeleted(imageId);
      if (success) {
        // 从 images (当前页) / flatImages (扁平视图) / imagesByFolder (按目录分组) 三处剔除。
        // 原版只清 images，会留下 dangling pointer：下次 flatView 或按目录分组渲染时
        // 会显示已删除的图片，点击后 library_get_image_path 返回 None → 空白。
        images.value = images.value.filter(img => img.id !== imageId);
        flatImages.value = flatImages.value.filter(img => img.id !== imageId);
        for (const [folderHash, list] of imagesByFolder.entries()) {
          const filtered = list.filter(img => img.id !== imageId);
          if (filtered.length !== list.length) {
            imagesByFolder.set(folderHash, filtered);
          }
        }
        if (currentImageId.value === imageId) {
          navStore.setCurrent(null);
        }
        // Cross-store cache cleanup. Each per-image cache (meta,
        // thumbnail blob URL, tag chips) is dropped here so a
        // re-add of the same file path with the same id collision
        // doesn't resurrect stale rows from the in-memory maps.
        // See src/utils/invalidate.ts for the per-cache rationale.
        invalidateImage(imageId);
      }
      return success;
    } catch (e) {
      console.error('Failed to mark deleted:', e);
      return false;
    }
  }

  async function compact() {
    try {
      isLoading.value = true;
      const result = await libraryCompact();
      await loadStats();
      return result;
    } catch (e) {
      console.error('Failed to compact:', e);
      return 'Failed';
    } finally {
      isLoading.value = false;
    }
  }

  async function getImagePath(imageId: string): Promise<string | null> {
    try {
      const result = await libraryGetImagePath(imageId);
      return result;
    } catch (e) {
      console.error('Failed to get image path:', e);
      return null;
    }
  }

  return {
    // State
    folders,
    folderTree,
    currentFolderId,
    images,
    currentImageId,
    stats,
    isLoading,
    scanProgress,
    thumbnailCache,
    expandedNodes,
    flatImages,
    totalImageCount,
    flatViewLoading,
    visibleTreeNodes,
    imagesByFolder,
    flatGridScrollTop,
    folderTreeScrollTop,
    sidebarVisible,
    currentTagId,
    tagFilteredImages,
    tagFilterTagName,

    // Getters
    currentFolder,
    currentImage,
    currentImageIndex,
    groupedImages,

    // Actions
    loadFolders,
    loadFolderTree,
    scanFolder,
    loadImages,
    loadAllImages,
    loadMoreFlatImages,
    loadFolderImages,
    loadStats,
    getThumbnail,
    getThumbnailsBatch,
    // clearCache,
    selectImage,
    nextImage,
    prevImage,
    markDeleted,
    compact,
    getImagePath,
    isNodeExpanded,
    toggleNodeExpanded,
    expandNode,
    collapseNode,
    expandAllNodes,
    clearExpandedNodes,
    updateVisibleTree,
    removeLibrarySource,
    loadImagesByTag,
    clearTagFilter,
    tagHash,
    isTagBlockHash,
  };
});
