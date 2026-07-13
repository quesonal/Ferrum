/**
 * Tracked blob URL helper.
 *
 * Wraps `URL.createObjectURL(new Blob(...))` and pairs every URL
 * with a `dispose()` that defers the `revokeObjectURL` to the next
 * macrotask (50 ms). The defer matters for two reasons:
 *
 *   1. The browser may still be fetching the URL from an in-flight
 *      `<img src>` request when we want to revoke; revoking too
 *      early surfaces as `ERR_FILE_NOT_FOUND`. Deferring one tick
 *      lets the fetch complete.
 *   2. Vue's image cross-fade transition keeps a hidden `<img>`
 *      bound to the old URL for ~150 ms after the visible one
 *      swaps; revoking during that window races with the layout.
 *
 * `dispose` is idempotent — repeated calls are a no-op. This lets
 * callers stash the handle in a cache and revoke it on eviction
 * without coordinating who "owns" the URL.
 *
 * Why the `dispose` pattern instead of just `revokeObjectURL`:
 * `URL.createObjectURL` is fire-and-forget; there's no built-in
 * lifetime. Wrapping each create with a paired disposer means a
 * cache can plug into the lifetime by holding the disposer in a
 * parallel Map — that's exactly the `thumbnailCache` leak fix in
 * PR 4b, which only works if the create site returns the disposer.
 */
export interface TrackedBlobUrl {
  url: string;
  dispose: () => void;
}

export function createTrackedBlobUrl(
  data: Uint8Array | readonly number[],
  mimeType: string = 'image/webp',
): TrackedBlobUrl {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  let disposed = false;
  return {
    url,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      setTimeout(() => URL.revokeObjectURL(url), 50);
    },
  };
}
