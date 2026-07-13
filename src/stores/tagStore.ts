import {defineStore} from 'pinia';
import {ref, shallowReactive, shallowRef} from 'vue';
import {
  libraryListTags,
  libraryGetImageTags,
  librarySetImageTags,
  libraryCreateTag,
  libraryRenameTag,
  libraryDeleteTag,
} from '../api/commands';

/**
 * Tag data shape — mirrors the Rust `Tag` struct exposed by the
 * `library_list_tags` Tauri command (Phase A5 backend). Field names
 * stay snake_case to match what serde emits; the UI converts as
 * needed. `source` is one of `"user"` / `"ai"` (extensible).
 */
export interface Tag {
  id: number;
  name: string;
  source: string;
  confidence: number | null;
  parent_id: number | null;
  color: string | null;
  sort_order: number;
  created_at: number;
  /**
   * Number of images carrying this tag. Populated by `library_list_tags`
   * via a backend GROUP BY; sent as `-1` (sentinel) from
   * `library_get_image_tags` where it would be misleading. The UI
   * hides the badge entirely when `image_count < 0`.
   */
  image_count: number;
}

/**
 * Pinia store for the tag vocabulary + per-image tag membership.
 *
 * Phase A5 backend commands are the source of truth; this store is a
 * thin cache + facade. Wired into:
 *   - Settings → Tags tab (Phase B1) — uses `tags` / `create` /
 *     `rename` / `remove`.
 *   - ImageView tag chips (Phase B2) — uses `tagsForImage` /
 *     `loadForImage` / `setTagsForImage`.
 *   - FolderSidebar tag tree (Phase B3) — reuses `tags` for the list.
 *
 * Per-image cache uses `shallowReactive(Map)` so writes notify
 * subscribers (chips re-render) but the Tag[] values themselves
 * stay non-reactive — same shallowRef pattern as `tags`.
 */
export const useTagStore = defineStore('tag', () => {
  const tags = shallowRef<Tag[]>([]);
  const loading = ref(false);

  // Per-image tag cache: image_id (string) → Tag[] attached to it.
  // Empty array means "fetched and had no tags"; key absent means
  // "not fetched yet". Order backend-side by `sort_order ASC, id ASC`.
  const tagsForImage = shallowReactive(new Map<string, Tag[]>());

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      tags.value = await libraryListTags();
    } finally {
      loading.value = false;
    }
  }

  async function loadForImage(imageId: string): Promise<Tag[]> {
    const got = await libraryGetImageTags(imageId);
    tagsForImage.set(imageId, got);
    return got;
  }

  /**
   * Replace an image's tag set in one transaction (server-side).
   *
   * Per-image writes are SERIALIZED: each new write chains on the
   * promise returned by the previous one (`writeChain`). This is
   * what `removeTagFromImage` (ImageView's chips × button) needs
   * — rapid clicks fire two IPCs in parallel; without serialization
   * the cache can end up showing a tag the backend removed because
   * the first IPC's optimistic update survived while its slow
   * in-flight tail didn't get the chance to delete on success.
   *
   * `pendingWrites` is a state-mirror for the watcher — the chips
   * row uses `pendingWrites.has(id)` to skip its own refetch while
   * a write is in flight. On success we only `delete pendingWrites`
   * if our `tagIds` is still the latest entry; a newer write's
   * optimistic update may have already overwritten ours.
   *
   * On error we revert the optimistic update ONLY if our `tagIds`
   * is still the latest pending entry — otherwise a newer write's
   * optimistic state was already correct, and we'd otherwise wipe
   * it. Re-fetch happens on the next watcher tick for the same id.
   */
  const pendingWrites = new Map<string, number[]>();
  const writeChain = new Map<string, Promise<unknown>>();

  async function setTagsForImage(
    imageId: string,
    tagIds: number[],
  ): Promise<void> {
    // 1. Optimistic update + register ourselves as the latest write.
    const optimistic = tags.value.filter((t) => tagIds.includes(t.id));
    tagsForImage.set(imageId, optimistic);
    pendingWrites.set(imageId, tagIds);

    // 2. Chain the IPC after the previous write for this image.
    //    `catch(() => {})` keeps the chain alive if a write throws.
    const prev = writeChain.get(imageId) ?? Promise.resolve();
    const myWrite = prev.then(() =>
      librarySetImageTags(imageId, tagIds),
    );
    writeChain.set(imageId, myWrite.catch(() => {}));

    // 3. Await; revert / clear guarded by "still latest".
    try {
      await myWrite;
    } catch (e) {
      if (pendingWrites.get(imageId) === tagIds) {
        pendingWrites.delete(imageId);
        tagsForImage.delete(imageId);
      }
      throw e;
    }
    if (pendingWrites.get(imageId) === tagIds) {
      pendingWrites.delete(imageId);
    }
  }

  /**
   * Drop a cached image's tag set. Call from `libraryStore.markDeleted`
   * (Belt-and-suspenders: even if backend hasn't reported yet, we
   * stop showing tags for a deleted id).
   */
  function invalidateImage(imageId: string): void {
    tagsForImage.delete(imageId);
  }

  /**
   * Create a new tag. Returns the new id. Throws on failure —
   * `library_create_tag` surfaces the case-insensitive UNIQUE
   * violation as a string error (see meta_cache.rs `create_tag`),
   * so callers can show the message verbatim.
   */
  async function create(name: string): Promise<number> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('tag name is empty');
    }
    const id = await libraryCreateTag(trimmed, 'user');
    await loadAll();
    return id;
  }

  async function rename(id: number, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('tag name is empty');
    }
    await libraryRenameTag(id, trimmed);
    await loadAll();
  }

  async function remove(id: number): Promise<void> {
    await libraryDeleteTag(id);
    await loadAll();
  }

  return {
    tags,
    loading,
    tagsForImage,
    pendingWrites,
    loadAll,
    loadForImage,
    setTagsForImage,
    invalidateImage,
    create,
    rename,
    remove,
  };
});