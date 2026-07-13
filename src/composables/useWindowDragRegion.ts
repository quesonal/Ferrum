/**
 * Tauri 2 frameless-window drag helpers.
 *
 * The app is frameless (see `App.vue` + `tauri.conf.json`), so the
 * OS-level "drag the window by its title bar" gesture has to be
 * wired up explicitly:
 *
 *   - On the title bar itself, the OS needs a `data-tauri-drag-region`
 *     attribute on the element the user grabs. Spread
 *     `dragRegionAttrs` into that root via `v-bind`.
 *   - For everything else, the browser's *native* HTML drag-and-drop
 *     (image drag, link drag, text selection drag) is undesirable in
 *     a viewer: it pulls ghost images out of the WebView. We block it
 *     at the window level with a single `dragstart` listener that
 *     always `preventDefault()`s. Use `installGlobalDragStartGuard()`
 *     once at the app root.
 *
 * The two are complementary, not redundant: the title bar wants the
 * OS drag gesture; the rest of the UI wants the OS drag gesture
 * *suppressed*. Keeping both concerns in one place makes the policy
 * obvious and prevents drift if we add new draggable surfaces later.
 */
export function useWindowDragRegion() {
  /**
   * Spread onto the title bar root. Equivalent to writing
   * `data-tauri-drag-region=""` literally but kept as a constant so
   * the OS contract lives in one place.
   */
  const dragRegionAttrs = {
    'data-tauri-drag-region': '',
  } as const;

  /**
   * Handler that swallows the browser's native drag-and-drop. Use
   * with `window.addEventListener('dragstart', preventDefaultDragStart)`
   * at the app shell. No-op in environments without `window` (defensive
   * for SSR / unit tests).
   */
  function preventDefaultDragStart(e: DragEvent): void {
    e.preventDefault();
  }

  return { dragRegionAttrs, preventDefaultDragStart };
}
