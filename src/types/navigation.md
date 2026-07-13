# Navigation state — ownership contract (Phase 3a)

This document describes who owns each navigation ref today and which writes
must travel through the upcoming `useNavigationStore` in Phase 3b. It exists
so the dual-write sites can be tracked down mechanically when we flip
ownership, without having to re-derive the rules from code archaeology.

## Ownership map (CURRENT, pre-3b)

| Field                     | Owner          | Mirror?                   | Reason                                                                 |
|---------------------------|----------------|---------------------------|------------------------------------------------------------------------|
| `currentImageId`          | `libraryStore` | mirrored in `imageStore` | Library-mode concept; `imageStore` mirror drives the preview watcher.  |
| `currentPath`             | `imageStore`   | none                      | Filesystem-mode concept.                                               |
| `fileList`                | `imageStore`   | none                      | Filesystem-mode nav list.                                              |
| `currentIndex` (computed) | `imageStore`   | none                      | Derived from `currentPath` + `fileList`.                               |
| `libraryImageIds`         | `imageStore`   | none                      | Adjacent-preview bookkeeping; populated by router guard + nav composable. |
| `folderTreeScrollTop`     | `libraryStore` | none                      | UI scroll restoration only.                                            |
| `flatGridScrollTop`       | `libraryStore` | none                      | UI scroll restoration only.                                            |

## Dual-write sites (currentImageId)

Every site that writes **both** stores synchronously must keep doing so
until Phase 3b lands `useNavigationStore`; the migration replaces the
two `=` assignments with a single `useNavigationStore().setCurrent(newId)`.

| File                                | Lines            | Write site                                                  |
|-------------------------------------|------------------|-------------------------------------------------------------|
| `src/views/ImageView.vue`           | 87, 88           | `id` route param watcher                                    |
| `src/router/guards.ts`              | 20, 21           | `openFileGuard` (clears `currentImageId` for filesystem)    |
| `src/router/guards.ts`              | 80, 81           | `openImageGuard` (sets after fetching adjacent ids)         |
| `src/views/LibraryView.vue`         | 85               | `selectImage` action: writes `libraryStore` only. **TODO**: 3b needs to also clear `imageStore.currentImageId` if it ever gets out of sync, but today both are written via the router/viewer path. |

## Read-only sites (mirror reads)

These read `imageStore.currentImageId` purely as a "is library mode active"
probe. They are unaffected by the 3b ownership flip because the
mirror/accessor semantics will be preserved.

| File                                       | Use                                                      |
|--------------------------------------------|----------------------------------------------------------|
| `src/views/ImageView.vue`                  | `:is-library-mode="!!imageStore.currentImageId"` prop    |
| `src/composables/useImageKeyboardNav.ts`   | throttle interval selection                              |
| `src/composables/useHistogramSession.ts`   | resolved source for `loadHistogram`                      |

## Migration handoff (Phase 3c/3d) — DONE

`useNavigationStore().setCurrent(id)` is now the **only** writer of
`currentImageId` in production. Phases completed:

- **3c** — Removed the legacy dual-write fallback. `.env` defaulted to
  `VITE_USE_NAV_STORE=true`. Composable still wrote the store refs
  synchronously as mirrors.
- **3d** — Replaced `imageStore.currentImageId` / `libraryStore.currentImageId`
  with `computed(() => navStore.currentImageId)` mirrors; removed the
  mirror writes from the composable. All internal store writes
  (`nextImage`, `prevImage`, `firstImage`, `lastImage`, `forward10`,
  `backward10`, `loadInitialFile`, `selectImage`, `markDeleted`) and
  external call-sites now flow through `setCurrent()`.

**`VITE_USE_NAV_STORE` flag and `.env*` files — REMOVED.** They were a
transitional safety net during 3b–3d; with the per-store refs being
computed mirrors there is no behavioral split to gate, and `import.meta
.env.VITE_USE_NAV_STORE` is no longer read anywhere in the codebase.

No code outside `src/stores/{image,library}Store.ts`,
`src/composables/useNavigationStore.ts`, and `src/main.ts` should write
`currentImageId` directly. New writers MUST go through
`useNavigationStore().setCurrent(id)`.
