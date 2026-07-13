import { onUnmounted, toValue, watch, type MaybeRefOrGetter } from 'vue';

/**
 * Block keys from reaching siblings while a modal is open.
 *
 * Used by `ConfirmDialog`, `TagPicker`, and any future modal that
 * needs to keep ImageView's bubble-phase listener from firing
 * navigation / shortcuts mid-confirm. Listens in the *capture* phase
 * so it runs before ImageView's bubble handler.
 *
 * Behavior while `visible` is true:
 *   - Escape → `onEscape` (always)
 *   - Enter  → `onEnter` (unless `shouldLetEnterThrough` returns true)
 *   - Tab    → fall through (let focus cycle the modal's controls)
 *   - everything else → swallowed (`stopPropagation` + `preventDefault`)
 *
 * The listener is attached on visible=true and removed on visible=
 * false; `onUnmounted` is a safety net for components that get torn
 * down while open.
 *
 * The `onEscape` / `onEnter` callbacks are read lazily on every
 * keypress, so re-renders that produce new function references stay
 * in sync without re-registering the listener.
 */
export interface ModalKeyboardGuardOptions {
  visible: MaybeRefOrGetter<boolean>;
  onEscape: () => void;
  onEnter?: () => void;
  /**
   * Return true to let Enter pass through to the focused element
   * (e.g. a text input that needs default Enter behavior). When
   * false or omitted, Enter is intercepted and routed to `onEnter`.
   */
  shouldLetEnterThrough?: () => boolean;
}

export function useModalKeyboardGuard(options: ModalKeyboardGuardOptions): void {
  function handleKeydown(e: KeyboardEvent) {
    if (!toValue(options.visible)) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      options.onEscape();
      return;
    }
    if (e.key === 'Enter') {
      if (options.shouldLetEnterThrough?.()) return;
      if (options.onEnter) {
        e.preventDefault();
        e.stopPropagation();
        options.onEnter();
      }
      return;
    }
    if (e.key === 'Tab') return;

    e.stopPropagation();
    e.preventDefault();
  }

  watch(
    () => toValue(options.visible),
    (visible) => {
      if (visible) {
        window.addEventListener('keydown', handleKeydown, true);
      } else {
        window.removeEventListener('keydown', handleKeydown, true);
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown, true);
  });
}
