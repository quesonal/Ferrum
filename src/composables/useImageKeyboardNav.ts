import { ref, onMounted, onUnmounted } from 'vue';
import type { Ref } from 'vue';
import { useLibraryStore } from '../stores/libraryStore';
import { perfMark } from '../perf';
import type { ImageNavigation } from './useImageNavigation';

export interface ImageKeyboardNavContext {
  nav: ImageNavigation;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToScreen: () => void;
  fitImage: () => void;
  requestDelete: (permanent: boolean) => void;
}

/**
 * Owns keyboard-driven viewer navigation: the long-press throttle /
 * debounce state machine, `isFastNavigating`, and the global
 * keydown/keyup listeners.
 *
 * `isFastNavigating` is surfaced so the viewer can suppress full-image
 * loading during long-press (preview layer takes over). `triggerNav`
 * is returned for the ControlBar prev/next buttons.
 */
export function useImageKeyboardNav(ctx: ImageKeyboardNavContext) {
  const libraryStore = useLibraryStore();

  const isFastNavigating = ref(false);
  let navDebounceTimer: number | null = null;
  const NAV_DEBOUNCE_MS = 400;
  let lastNavTime = -Infinity;
  // Throttle 按 mode 分档：library 模式有 previewCache（HIT 10-30μs），可以 15fps 跟得上；
  // filesystem 模式每次走 asset:// / img:// 完整解码（尤其 img:// 转码格式），用 10fps 给 decode 余量。
  const MIN_NAV_INTERVAL_MS_LIB = 67;
  const MIN_NAV_INTERVAL_MS_FS = 100;

  function triggerNav(direction: 'prev' | 'next', opts: { repeat?: boolean } = {}) {
    // fs_cycle::trigger = cycle 起点。fs_cycle::visible（在 ImageViewer.applyImageToSlot）
    // 是终点，两者时间差 = 单次翻页延迟。Perfetto 里看两者间距即可判断是否跟上节奏。
    perfMark('fs_cycle::trigger', { direction, repeat: !!opts.repeat });

    if (opts.repeat) {
      isFastNavigating.value = true;
    }

    const now = performance.now();
    const throttle = libraryStore.currentImageId ? MIN_NAV_INTERVAL_MS_LIB : MIN_NAV_INTERVAL_MS_FS;
    if (!opts.repeat || now - lastNavTime >= throttle) {
      if (direction === 'next') ctx.nav.goNext();
      else ctx.nav.goPrev();
      lastNavTime = now;
    } else {
      // 节奏被 throttle 拦下：用户按键频率 > throttle，nav 队列堆积。
      // 看这条 marker 密度就知道跟不上有多严重。
      perfMark('fs_cycle::throttle_skip', { gap: Math.round(now - lastNavTime) });
    }

    // 兜底 debounce：keyup 才是 fast=false 的主路径（见 handleKeyup）。
    // 保留 debounce 是为了：keyup 漏触发（焦点丢失 / 切到其他应用 / OS 异常）
    // 仍然能在 ~400ms 静默后退出 fast 模式。
    // 400ms 阈值比 OS auto-repeat 最慢的呼吸间隔（实测 ~150ms）大很多，
    // 不会误判；但比用户正常松开到按第二次的间隔（>500ms）小，仍是合理兜底。
    if (opts.repeat || isFastNavigating.value) {
      if (navDebounceTimer !== null) clearTimeout(navDebounceTimer);
      navDebounceTimer = window.setTimeout(() => {
        navDebounceTimer = null;
        isFastNavigating.value = false;
      }, NAV_DEBOUNCE_MS);
    }
  }

  // 主路径：用户真实松开方向键 → 立即退出 fast 模式。
  // 之前只用 150ms debounce 会被 Windows OS auto-repeat 的 ~150ms 呼吸间隔误判，
  // 周期性 fire → loadFullImage → 白屏。详见 docs/FAST_NAV_KEYUP_FIX_2026-07-06.md。
  function handleKeyup(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      isFastNavigating.value = false;
      if (navDebounceTimer !== null) {
        clearTimeout(navDebounceTimer);
        navDebounceTimer = null;
      }
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;

    switch (e.key) {
      case 'ArrowLeft':
        if (!e.ctrlKey && !e.altKey) {
          e.preventDefault();
          triggerNav('prev', { repeat: e.repeat });
        }
        break;
      case 'ArrowRight':
        if (!e.ctrlKey && !e.altKey) {
          e.preventDefault();
          triggerNav('next', { repeat: e.repeat });
        }
        break;
      case 'ArrowUp':
        ctx.zoomIn();
        break;
      case 'ArrowDown':
        ctx.zoomOut();
        break;
      case 'Escape':
        ctx.nav.backToLibrary();
        break;
      case 'Delete':
        // 忽略 Ctrl/Alt/Meta + Del（系统 / IME 等可能用到），只响应单独 Del 与 Shift+Del
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        ctx.requestDelete(e.shiftKey);
        break;
      case 'Home':
        ctx.nav.firstImage();
        break;
      case 'End':
        ctx.nav.lastImage();
        break;
      case '0':
        ctx.fitToScreen();
        break;
      case 'l':
      case 'g':
        ctx.nav.backToLibrary();
        break;
      case 'f':
      case 'F':
        if (!e.ctrlKey && !e.metaKey) ctx.fitImage();
        break;
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('keyup', handleKeyup);
  });

  onUnmounted(() => {
    if (navDebounceTimer !== null) {
      clearTimeout(navDebounceTimer);
      navDebounceTimer = null;
    }
    window.removeEventListener('keydown', handleKeydown);
    window.removeEventListener('keyup', handleKeyup);
  });

  return {
    isFastNavigating: isFastNavigating as Ref<boolean>,
    triggerNav,
  };
}
