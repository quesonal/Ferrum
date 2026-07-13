import {
  computed,
  nextTick,
  onActivated,
  onMounted,
  onUnmounted,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
  type ShallowRef,
} from 'vue';
import { useLibraryStore } from '../stores/libraryStore';
import type { FolderBlock } from './useFolderBlocks';

export const GRID_LEFT_OFFSET = 16;
const SCROLLBAR_WIDTH = 18;
const MAX_SCROLL_SPEED_PER_FRAME = 120;
const MIN_GRID_GAP = 8;

interface VirtualScrollerOptions {
  scrollToFolderHash: MaybeRefOrGetter<string | null | undefined>;
  onFolderChange: (folderHash: string) => void;
  columns: Ref<number>;
  gap: Ref<number>;
  verticalGap: Ref<number>;
  cellSize: Ref<number>;
  totalHeight: Ref<number>;
  folderBlocks: ShallowRef<FolderBlock[]>;
  folderBlockMap: Map<string, FolderBlock>;
  updateFolderBlocks: () => void;
  findBlockIndex: (top: number) => number;
}

export function useVirtualScroller(options: VirtualScrollerOptions) {
  const store = useLibraryStore();
  const rootRef = ref<HTMLElement | null>(null);
  const containerRef = ref<HTMLElement | null>(null);
  const containerHeight = ref(0);
  const scrollTop = ref(0);
  const targetScrollTop = ref(0);
  const maxScrollTop = computed(() => Math.max(0, options.totalHeight.value - containerHeight.value));
  let animFrameId: number | null = null;
  let resizeObserver: ResizeObserver | null = null;

  function syncNativeScroll() {
    if (containerRef.value) {
      containerRef.value.scrollTop = Math.round(scrollTop.value);
    }
    store.flatGridScrollTop = scrollTop.value;
  }

  function startAnimationLoop() {
    if (animFrameId) return;

    const loop = () => {
      const diff = targetScrollTop.value - scrollTop.value;
      if (Math.abs(diff) < 1) {
        scrollTop.value = targetScrollTop.value;
        syncNativeScroll();
        animFrameId = null;
        return;
      }

      let step = diff * 0.15;
      if (Math.abs(step) > MAX_SCROLL_SPEED_PER_FRAME) {
        step = Math.sign(step) * MAX_SCROLL_SPEED_PER_FRAME;
      }
      scrollTop.value += step;
      syncNativeScroll();
      animFrameId = requestAnimationFrame(loop);
    };
    animFrameId = requestAnimationFrame(loop);
  }

  function onJoystickStep(velocity: number) {
    const nextTop = Math.max(0, Math.min(maxScrollTop.value, targetScrollTop.value + velocity));
    targetScrollTop.value = nextTop;
    scrollTop.value = nextTop;
    syncNativeScroll();
  }

  function scrollToTop() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    if (options.folderBlocks.value.length === 0 && store.folderTree.length > 0) {
      options.updateFolderBlocks();
    }

    const firstBlock = options.folderBlocks.value[0];
    if (!firstBlock) {
      targetScrollTop.value = 0;
      scrollTop.value = 0;
      syncNativeScroll();
      return;
    }

    targetScrollTop.value = firstBlock.top;
    scrollTop.value = firstBlock.top;
    syncNativeScroll();
    store.loadFolderImages(firstBlock.hash);
    options.onFolderChange(firstBlock.hash);
  }

  function scrollToBottom() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    const blocks = options.folderBlocks.value;
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock) {
      targetScrollTop.value = maxScrollTop.value;
      scrollTop.value = maxScrollTop.value;
      syncNativeScroll();
      return;
    }

    const target = Math.min(lastBlock.top, maxScrollTop.value);
    targetScrollTop.value = target;
    scrollTop.value = target;
    syncNativeScroll();
    store.loadFolderImages(lastBlock.hash);
    options.onFolderChange(lastBlock.hash);
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    targetScrollTop.value = Math.max(
      0,
      Math.min(maxScrollTop.value, targetScrollTop.value + event.deltaY),
    );
    startAnimationLoop();
  }

  function onNativeScroll(event: Event) {
    const top = (event.target as HTMLElement).scrollTop;
    if (Math.abs(top - scrollTop.value) > 2) {
      scrollTop.value = top;
      targetScrollTop.value = top;
    }
  }

  function restoreScroll() {
    if (containerRef.value && store.flatGridScrollTop > 0) {
      targetScrollTop.value = store.flatGridScrollTop;
      scrollTop.value = store.flatGridScrollTop;
      syncNativeScroll();
    }
  }

  watch(maxScrollTop, newMax => {
    if (targetScrollTop.value > newMax) {
      targetScrollTop.value = newMax;
      scrollTop.value = Math.min(scrollTop.value, newMax);
      syncNativeScroll();
    }
  });

  watch(
    () => toValue(options.scrollToFolderHash),
    async hash => {
      if (!hash || !containerRef.value) return;

      if (!store.isTagBlockHash(hash)) {
        const success = await store.loadFolderImages(hash, true);
        if (success) {
          const ids = (store.imagesByFolder.get(hash) || []).slice(0, 40).map(image => image.id);
          store.getThumbnailsBatch(ids);
        }
      } else {
        const ids = (store.imagesByFolder.get(hash) || []).slice(0, 40).map(image => image.id);
        store.getThumbnailsBatch(ids);
      }

      const block = options.folderBlockMap.get(hash);
      if (!block) return;

      const target = Math.min(block.top, maxScrollTop.value);
      const distance = Math.abs(target - scrollTop.value);
      const threshold = containerHeight.value * 3;
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }

      targetScrollTop.value = target;
      if (distance > threshold) {
        scrollTop.value = target;
        syncNativeScroll();
      } else {
        startAnimationLoop();
      }
    },
  );

  onMounted(async () => {
    if (rootRef.value) {
      resizeObserver = new ResizeObserver(entries => {
        const entry = entries[0];
        containerHeight.value = entry.contentRect.height;
        const availableWidth = entry.contentRect.width - SCROLLBAR_WIDTH;
        const defaultGap = 30;
        let actualColumns = Math.max(
          1,
          Math.floor((availableWidth - GRID_LEFT_OFFSET) / (options.cellSize.value + MIN_GRID_GAP)),
        );
        let targetGap = MIN_GRID_GAP;

        while (actualColumns > 1) {
          const maxGap = (
            availableWidth - GRID_LEFT_OFFSET - actualColumns * options.cellSize.value
          ) / (actualColumns - 1);
          if (maxGap >= defaultGap) {
            targetGap = defaultGap;
            break;
          }
          if (maxGap >= MIN_GRID_GAP) {
            targetGap = maxGap;
            break;
          }
          actualColumns--;
        }
        if (actualColumns === 1) {
          targetGap = Math.max(
            MIN_GRID_GAP,
            availableWidth - GRID_LEFT_OFFSET - options.cellSize.value,
          );
        }
        targetGap = Math.round(targetGap / 2) * 2;

        let anchorHash: string | null = null;
        if (actualColumns !== options.columns.value && options.folderBlocks.value.length > 0) {
          const index = options.findBlockIndex(scrollTop.value);
          anchorHash = options.folderBlocks.value[index]?.hash ?? null;
        }

        options.columns.value = actualColumns;
        options.gap.value = targetGap;
        options.verticalGap.value = targetGap;

        if (anchorHash) {
          const anchor = anchorHash;
          nextTick(() => {
            const block = options.folderBlockMap.get(anchor);
            if (!block) return;
            const target = Math.min(block.top, maxScrollTop.value);
            if (Math.abs(target - scrollTop.value) > 4) {
              targetScrollTop.value = target;
              scrollTop.value = target;
              syncNativeScroll();
            }
          });
        }
      });
      resizeObserver.observe(rootRef.value);
    }

    if (store.folderTree.length === 0) await store.loadFolderTree();
    if (store.folders.length === 0) await store.loadFolders();
    options.updateFolderBlocks();

    nextTick(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(restoreScroll);
      });
    });
  });

  onActivated(restoreScroll);
  onUnmounted(() => resizeObserver?.disconnect());

  return {
    rootRef,
    containerRef,
    containerHeight,
    scrollTop,
    maxScrollTop,
    onJoystickStep,
    scrollToTop,
    scrollToBottom,
    onWheel,
    onNativeScroll,
  };
}
