# src/cache/

One factory, four call-sites, one eviction strategy.

## `createBoundedCache.ts`

FIFO Map subclass. `max` caps the entry count; `onEvict` (optional)
fires for every evicted value with `(value, key)`. `Infinity` (or
`0`) disables the cap; the hook still fires for `delete()` and
`clear()`.

**Not** an LRU. All current callers are linear scans / prefetch
windows where the hottest keys (next/prev) get touched within a
few hundred ms; FIFO + small size (10–20) hits every hot key.
If a future caller needs LRU, add an `evictionStrategy` parameter
— don't reach for one today.

## Why `extends Map`, not "return a plain object"

This is load-bearing, not a stylistic choice. `thumbnailCache` is
consumed by `FlatImageGrid.vue`'s v-for via `.has(image.id)` /
`.get(image.id)`, and that component depends on Vue reactivity
re-rendering when an entry is added. `shallowReactive(cache)` only
wires that reactivity if Vue recognises `cache` as a `Map`
instance — Vue's collection handlers (the things that fire on
`set` / `delete` / `clear`) are bound to the [[MapData]] internal
slot, which a subclass inherits but a plain `Object.create({...})`
does not. A first version of this file used `Object.create`
(`9da8412`); the `thumbnailCache` swap in `d0373b5` caught it
when a v-for that had worked with a raw `Map` silently stopped
re-rendering on cache hits.

The test for "is this Map-shaped enough for `shallowReactive`?":

  - `cache instanceof Map` must be `true` (Vue's collection
    handlers check this).
  - `super.set(...)` / `super.delete(...)` must be the actual
    Map internal calls — that's why the subclass's `set` calls
    `super.set(key, value)` and then mutates `size` via the
    while-loop on the inherited property.

If you ever feel the urge to "simplify" this back to a plain
object, don't. The test for the v-for re-rendering is *runtime*
behaviour, not a typecheck; vue-tsc will happily pass a broken
version.

## Call-sites

| Caller | Max | Holds | onEvict |
|--------|-----|-------|---------|
| `imageStore.previewCache` | 10 | raw preview bytes | — |
| `imageStore.metaCache` | 20 | histogram + EXIF | — |
| `imageStore.assetAccessibleCache` | Infinity | dir → bool | — |
| `libraryStore.thumbnailCache` | 3000 | blob URL | `URL.revokeObjectURL(url)` |

Raw-data caches (`previewCache`, `metaCache`) deliberately do not
have an `onEvict` hook — they store bytes, not resources, and
FIFO eviction just drops the bytes. `thumbnailCache` stores blob
URLs and *must* revoke them on evict; see `feedback_blob_revoke_defer.md`
in project memory for the bug class this prevents.

`assetAccessibleCache` is `Infinity` because the dir list is
user-curated and bounded; no eviction makes sense. The factory
supports `Infinity` for this without a special-case.

## Cross-store invalidation

`src/utils/invalidate.ts → invalidateImage(id)` clears
`previewCache` + `metaCache` + `thumbnailCache` + tag association
in one call. Called from `libraryStore.markDeleted` after the
Rust delete succeeds — see the doc on that function for the
per-cache "why" of clearing each.
