import { ref } from 'vue';
import type { Ref } from 'vue';
import { useRouter } from 'vue-router';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow as appWindow } from '@tauri-apps/api/window';
import { MouseAction, useConfigStore } from '../stores/configStore';
import { useImageStore } from '../stores/imageStore';
import { toggleFullscreen } from '../api/commands';
import type ImageViewer from '../components/ImageViewer.vue';
import type { ImageNavigation } from './useImageNavigation';

export type WindowAction =
    | 'toggle-fullscreen'
    | 'toggle-maximize'
    | 'minimize'
    | 'close';

export interface MouseActionsContext {
  viewerRef: Ref<InstanceType<typeof ImageViewer> | null>;
  nav: ImageNavigation;
  fitImage: () => void;
}

/**
 * Pointer + window-chrome input dispatch for the viewer.
 *
 * `onMouseDown` / `onWheel` are ready to bind directly to the layout
 * root. Both read the user's configured `MouseAction` for the pressed
 * button / wheel direction, dispatch it, and then either drag the
 * window (left button, non-consuming action) or forward the wheel to
 * the viewer's zoom (wheel, consuming action) — matching the viewer's
 * original inline handlers exactly.
 *
 * `handleAction` return convention (do not "simplify"):
 *   - string  → a window-chrome action the caller runs via handleWindowAction
 *   - true    → action was handled but is non-consuming (left-drag / wheel-zoom allowed)
 *   - false   → `none`; consume the event, do nothing further
 */
export function useMouseActions(ctx: MouseActionsContext) {
  const router = useRouter();
  const imageStore = useImageStore();
  const configStore = useConfigStore();
  const { nav, viewerRef, fitImage } = ctx;

  const isFullscreen = ref(false);

  const openFileDialog = async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [
          { name: 'Images', extensions: imageStore.formats.all },
          { name: 'RAW Photos', extensions: imageStore.formats.raw },
        ],
      });
      if (file) {
        router.push({ path: '/open', query: { path: file } });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const openFolderDialog = async () => {
    try {
      const folder = await open({ directory: true, multiple: false });
      if (folder) {
        router.push('/');
      }
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  };

  const handleWindowDrag = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') {
      viewerRef.value?.startDrag(e);
    } else {
      appWindow().startDragging();
    }
  };

  async function handleWindowAction(action: WindowAction) {
    switch (action) {
      case 'toggle-fullscreen':
        isFullscreen.value = await toggleFullscreen();
        setTimeout(() => fitImage(), 50);
        break;
      case 'toggle-maximize': {
        const win = appWindow();
        if (isFullscreen.value) {
          await win.setFullscreen(false);
          isFullscreen.value = false;
        }
        await win.toggleMaximize();
        setTimeout(() => fitImage(), 50);
        break;
      }
      case 'minimize':
        await appWindow().minimize();
        break;
      case 'close':
        await appWindow().close();
        break;
    }
  }

  async function handleAction(
    e: MouseEvent | WheelEvent,
    action: MouseAction | string,
  ): Promise<boolean | WindowAction> {
    switch (action) {
      case 'open_file': await openFileDialog(); break;
      case 'open_folder': await openFolderDialog(); break;
      case 'next_image': nav.goNext(); break;
      case 'prev_image': nav.goPrev(); break;
      case 'forward_10': nav.jumpBy(10); break;
      case 'backward_10': nav.jumpBy(-10); break;
      case 'first_image': nav.firstImage(); break;
      case 'last_image': nav.lastImage(); break;
      case 'zoom_in': viewerRef.value?.zoomIn(); break;
      case 'zoom_out': viewerRef.value?.zoomOut(); break;
      case 'zoom': viewerRef.value?.handleWheel(e as WheelEvent); break;
      case 'fit_window': viewerRef.value?.fitToScreen(); break;
      case 'full_screen': return 'toggle-fullscreen';
      case 'maximize': return 'toggle-maximize';
      case 'minimize': return 'minimize';
      case 'exit': return 'close';
      case 'none': return false;
    }
    return true;
  }

  const onMouseDown = async (e: MouseEvent) => {
    let action = configStore.config.mouse_left;
    if (e.button === 1) action = configStore.config.mouse_middle;
    if (e.button === 2) action = configStore.config.mouse_right;
    if (e.button === 3) action = configStore.config.mouse_xbutton1;
    if (e.button === 4) action = configStore.config.mouse_xbutton2;

    const result = await handleAction(e, action);

    if (typeof result === 'string') {
      await handleWindowAction(result);
    } else if (e.button === 0 && result) {
      handleWindowDrag(e);
    }
  };

  const onWheel = async (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      viewerRef.value?.handleWheel(e);
      return;
    }

    const action = e.deltaY < 0
      ? configStore.config.mouse_wheel_up
      : configStore.config.mouse_wheel_down;

    const result = await handleAction(e, action);
    if (typeof result === 'string') {
      await handleWindowAction(result);
    } else if (result === true) {
      viewerRef.value?.handleWheel(e);
    }
  };

  return {
    isFullscreen,
    openFileDialog,
    openFolderDialog,
    onMouseDown,
    onWheel,
  };
}
