import { inject } from 'vue';

export interface ConfirmOptions {
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}

/**
 * Promise-returning confirm function injected by `App.vue`. See
 * `src/App.vue:showConfirm` for the canonical implementation; it
 * shows the global `<ConfirmDialog>` and resolves to the user's
 * choice.
 */
export type ShowConfirm = (
  title: string,
  message: string,
  options?: ConfirmOptions,
) => Promise<boolean>;

/**
 * Inject the app-level `showConfirm` function. Returns `null` when
 * the provider is missing (component is mounted outside `App.vue`).
 *
 * Callers that require user confirmation MUST treat `null` as
 * "deny" — fail closed, don't perform the destructive action. The
 * app always provides `showConfirm` in production, so the null
 * branch is a developer-error / unit-test escape hatch.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (!confirm) return;             // fail-closed
 *   const ok = await confirm('Delete?', 'No undo', { danger: true });
 *   if (!ok) return;
 */
export function useConfirm(): ShowConfirm | null {
  const fn = inject<ShowConfirm | null>('showConfirm', null);
  return fn;
}
