import { computed, ref, type ComputedRef } from 'vue';

/**
 * Single-source-of-truth navigation state for library-mode navigation.
 *
 * Phase 3b introduced this composable behind a `VITE_USE_NAV_STORE`
 * feature flag; Phase 3c flipped the flag default to `true` and
 * removed the legacy dual-write fallback; Phase 3d replaced the
 * per-store `currentImageId` `ref()` declarations with
 * `computed(() => navStore.currentImageId)` mirrors and removed the
 * synchronous mirror-write plumbing. After Phase 3d the flag and
 * `.env` / `.env.development` files are no longer needed and were
 * removed.
 *
 * Result: `useNavigationStore().setCurrent(id)` is now the **only**
 * path that mutates the canonical `currentImageId` ref. Stores expose
 * a derived `currentImageId` so every existing read keeps working
 * unchanged. See `src/types/navigation.md` for the ownership map.
 */

const currentImageId = ref<string | null>(null);

interface UseNavigationStore {
  /** Library-mode current image id. Owner of this state. */
  currentImageId: ComputedRef<string | null>;
  /**
   * Set the current image id. Always safe to call; the canonical write
   * site for navigation state.
   */
  setCurrent: (imageId: string | null) => void;
}

export function useNavigationStore(): UseNavigationStore {
  return {
    currentImageId: computed(() => currentImageId.value),
    setCurrent(imageId: string | null) {
      currentImageId.value = imageId;
    },
  };
}
