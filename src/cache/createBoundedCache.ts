/**
 * Bounded FIFO cache used throughout the frontend. Three
 * responsibilities in one shape:
 *
 *   1. **Bounded size** — entries added past `max` evict the oldest
 *      (Map insertion order). `max === 0` (or `Infinity`) means no cap;
 *      `onEvict` still fires when entries are removed via `delete()` or
 *      `clear()`.
 *   2. **`onEvict` hook** — called once per evicted entry with the
 *      stored value. The hook's job is to release expensive per-value
 *      resources (`URL.revokeObjectURL`, async cancellation, etc.).
 *      Hook is **not** called when a value is overwritten in place
 *      without exceeding `max`.
 *   3. **Single concrete primitive** — Phase 4a's plan is to replace
 *      four hand-rolled FIFO caches (`previewCache`, `metaCache`,
 *      `thumbnailCache`, `assetAccessibleCache`) with this. After
 *      every reader writes through the same primitive, the "is this
 *      cache FIFO vs LRU?" question disappears.
 *
 * ## Not an LRU
 *
 * All current callers are linear scans / prefetch windows where the
 * hottest keys (next/prev) get touched within a few hundred
 * milliseconds. FIFO + small size (10–20) hits every hot key; LRU
 * only earns its bookkeeping cost in much larger caches. If a future
 * caller needs LRU, add an `evictionStrategy` parameter — not a
 * knee-jerk today.
 *
 * ## Reactivity
 *
 * The returned object **is** a `Map<string, V>` (subclass, not a proxy
 * over one), so callers that need reactivity can wrap it in
 * `shallowReactive(cache)` exactly like they used to wrap a raw Map.
 * Vue's collection handlers recognise `Map` instances via the
 * internal [[MapData]] slot, which a subclass inherits — that's why
 * `thumbnailCache` consumers (`FlatImageGrid.vue`) keep their
 * `.has()` / `.get()` reactivity intact after the swap.
 */

export interface BoundedCacheConfig<V> {
  /**
   * Maximum entries before FIFO eviction kicks in. `0` or `Infinity`
   * disables the cap.
   */
  max: number;
  /**
   * Cleanup hook run on every evicted entry. Receives the stored value
   * and the key. Not called when a `set()` overwrites an existing key
   * without exceeding `max` — that's an intentional refresh, not an
   * eviction.
   */
  onEvict?: (value: V, key: string) => void;
}

export interface BoundedCache<V> extends Map<string, V> {
  /**
   * Maximum entries before FIFO eviction kicks in. `0` or `Infinity`
   * disables the cap.
   */
  readonly max: number;
}

class BoundedCacheImpl<V> extends Map<string, V> {
  readonly max: number;
  private readonly bounded: boolean;
  private readonly onEvict?: (value: V, key: string) => void;

  constructor(config: BoundedCacheConfig<V>) {
    super();
    this.max = config.max;
    this.bounded = Number.isFinite(config.max) && config.max > 0;
    this.onEvict = config.onEvict;
  }

  private evictOldest(): void {
    const iterator = this.keys();
    const first = iterator.next();
    if (first.done) return;
    const key = first.value;
    const value = this.get(key);
    super.delete(key);
    if (this.onEvict && value !== undefined) this.onEvict(value, key);
  }

  override set(key: string, value: V): this {
    const existing = super.get(key);
    if (existing !== undefined) {
      // Refresh in place. Map keeps insertion order; no eviction.
      // onEvict is intentionally NOT called — see contract above.
      super.set(key, value);
      return this;
    }
    super.set(key, value);
    if (this.bounded) {
      while (this.size > this.max) {
        this.evictOldest();
      }
    }
    return this;
  }

  override delete(key: string): boolean {
    const value = super.get(key);
    if (value === undefined) return false;
    super.delete(key);
    if (this.onEvict) this.onEvict(value, key);
    return true;
  }

  override clear(): void {
    if (this.onEvict) {
      for (const [key, value] of this) this.onEvict(value, key);
    }
    super.clear();
  }
}

export function createBoundedCache<V>(
  config: BoundedCacheConfig<V>,
): BoundedCache<V> {
  return new BoundedCacheImpl<V>(config);
}