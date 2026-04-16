import {defineStore} from 'pinia';
import {computed, markRaw, ref, shallowReactive, shallowRef} from 'vue';
import {invoke} from '@tauri-apps/api/core';
import type {FolderNode} from '../types/folderNode';

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
  cover_image_id?: string;
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

export interface ScanRequest {
  folder_path: string;
  recursive: boolean;
  scan_mode: string;
}

export const useLibraryStore = defineStore('library', () => {
  // State
  const flatGridScrollTop = ref(0);
  const folderTreeScrollTop = ref(0);

  const folders = shallowRef<FolderInfo[]>([]);
  const folderTree = shallowRef<FolderNode[]>([]);  // 层级嵌套的文件夹树

  const visibleTreeNodes = shallowRef<FlatTreeNode[]>([]);

  const imagesByFolder = shallowReactive(new Map<string, FlatImageEntry[]>());
  const expandedNodes = ref<Set<string>>(new Set());
  const thumbnailCache = shallowReactive(new Map<string, string>());

  let folderTreeLoadingPromise: Promise<void> | null = null;
  const isLoading = ref(false);

  const currentFolderId = ref<string | null>(null);
  const images = ref<ImageEntry[]>([]);
  const currentImageId = ref<string | null>(null);
  const stats = ref<LibraryStats | null>(null);
  const scanProgress = ref<{ current: number; total: number } | null>(null);

  // Flat view state (Picasa-style all images view)
  const flatImages = shallowRef<FlatImageEntry[]>([]);
  const totalImageCount = ref<number>(0);
  const flatViewLoading = ref<boolean>(false);
  // const maxCacheSize = 2000;

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
      const isExpanded = expandedNodes.value.has(node.path);

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
    const data = await invoke<FolderInfo[]>('library_get_folders');
    folders.value = markRaw(data);
  }

  /**
   * 加载层级嵌套的文件夹树结构
   */
  async function loadFolderTree() {
    if (folderTreeLoadingPromise) return folderTreeLoadingPromise;
    folderTreeLoadingPromise = (async () => {
      try {
        const tree = await invoke<FolderNode[]>('library_get_folder_tree');
        folderTree.value = markRaw(sortFolderTree(tree));
        if (expandedNodes.value.size === 0) {
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

  async function scanFolder(folderPath: string, recursive = true, scanMode = 'auto') {
    try {
      isLoading.value = true;
      scanProgress.value = {current: 0, total: 0};

      const count = await invoke<number>('library_scan_folder', {
        request: {folder_path: folderPath, recursive, scan_mode: scanMode} as ScanRequest
      });

      // Refresh folders and tree after scan
      await loadFolders();
      await loadFolderTree();

      return count;
    } catch (e) {
      console.error('Failed to scan folder:', e);
      return 0;
    } finally {
      isLoading.value = false;
      scanProgress.value = null;
    }
  }

  async function loadImages(folderId: string, offset = 0, limit = 100) {
    try {
      isLoading.value = true;
      currentFolderId.value = folderId;

      const newImages = await invoke<ImageEntry[]>('library_get_images', {
        folderHash: folderId,
        offset,
        limit
      });

      if (offset === 0) {
        images.value = newImages;
      } else {
        images.value.push(...newImages);
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
        invoke<FlatImageEntry[]>('library_get_all_images', {offset, limit}),
        invoke<number>('library_get_total_image_count')
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
  async function loadFolderImages(folderHash: string): Promise<boolean> {
    if (imagesByFolder.has(folderHash)) return true;
    try {
      const newImages = await invoke<FlatImageEntry[]>('library_get_images', {folderHash, offset: 0, limit: 50000});
      imagesByFolder.set(folderHash, markRaw(newImages));
      return true;
    } catch (e) {
      return false;
    }
  }

  async function loadStats() {
    try {
      stats.value = await invoke<LibraryStats>('library_get_stats');
    } catch (e) {
      console.error('Failed to load stats:', e);
    }
  }

  async function getThumbnail(imageId: string): Promise<string | null> {
    if (thumbnailCache.has(imageId)) return thumbnailCache.get(imageId)!;
    try {
      const data = await invoke<number[] | null>('library_read_thumbnail', {imageId});
      if (data && data.length > 0) {
        const url = URL.createObjectURL(new Blob([new Uint8Array(data)], {type: 'image/webp'}));
        thumbnailCache.set(imageId, url);
        return url;
      }
    } catch (e) {
    }
    return null;
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
    return expandedNodes.value.has(path);
  }

  function toggleNodeExpanded(path: string) {
    if (expandedNodes.value.has(path)) expandedNodes.value.delete(path);
    else expandedNodes.value.add(path);
    updateVisibleTree(); // 重算打平数组
  }

  function expandNode(path: string): void {
    expandedNodes.value.add(path);
  }

  function collapseNode(path: string): void {
    expandedNodes.value.delete(path);
  }

  // Recursively expand all nodes in the tree
  function expandAllNodes(nodes: FolderNode[]) {
    const traverse = (nList: FolderNode[]) => {
      for (const n of nList) {
        if (n.children && n.children.length > 0) {
          expandedNodes.value.add(n.path);
          traverse(n.children);
        }
      }
    };
    traverse(nodes);
    updateVisibleTree();
  }

  // Clear all expanded state
  function clearExpandedNodes(): void {
    expandedNodes.value.clear();
  }

  function selectImage(imageId: string) {
    currentImageId.value = imageId;
  }

  function nextImage() {
    if (images.value.length === 0) return;
    const currentIdx = currentImageIndex.value;
    if (currentIdx < images.value.length - 1) {
      currentImageId.value = images.value[currentIdx + 1].id;
    }
  }

  function prevImage() {
    if (images.value.length === 0) return;
    const currentIdx = currentImageIndex.value;
    if (currentIdx > 0) {
      currentImageId.value = images.value[currentIdx - 1].id;
    }
  }

  async function markDeleted(imageId: string) {
    try {
      const success = await invoke<boolean>('library_mark_deleted', {imageId});
      if (success) {
        // Remove from local list
        images.value = images.value.filter(img => img.id !== imageId);
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
      const result = await invoke<string>('library_compact');
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
      const result = await invoke<Option<string>>('library_get_image_path', {imageId});
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
  };
});

// Tauri Option type is represented as T | null in TypeScript
type Option<T> = T | null;
