import { LRUCache } from "lru-cache";

export type CacheEvictReason = "lru" | "size" | "ttl" | "manual";

export interface MemoOpts<K extends {}, V extends {}> {
  ttlMs?: number;
  maxEntries?: number;
  maxSizeBytes?: number;
  sizeOf?: (value: V) => number;
  onEvict?: (key: K, value: V, reason: CacheEvictReason) => void;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  sizeBytes: number;
  entries: number;
}

export interface MemoCache<K extends {}, V extends {}> {
  get(key: K, compute: () => V): V;
  peek(key: K): V | undefined;
  set(key: K, value: V): void;
  invalidate(key: K): void;
  invalidateAll(): void;
  stats(): CacheStats;
}

export interface AsyncMemoCache<K extends {}, V extends {}> {
  get(key: K, compute: () => Promise<V>): Promise<V>;
  peek(key: K): V | undefined;
  set(key: K, value: V): void;
  invalidate(key: K): void;
  invalidateAll(): void;
  stats(): CacheStats;
}

export function createLruMemo<K extends {}, V extends {}>(
  opts: MemoOpts<K, V> = {},
): MemoCache<K, V> {
  return createMemo<K, V>(opts);
}

export function createTtlMemo<K extends {}, V extends {}>(opts: MemoOpts<K, V>): MemoCache<K, V> {
  return createMemo<K, V>(opts);
}

export function createTtlMemoAsync<K extends {}, V extends {}>(
  opts: MemoOpts<K, V>,
): AsyncMemoCache<K, V> {
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  const refreshing = new Map<K, Promise<void>>();
  const cache = new LRUCache<K, V>({
    max: opts.maxEntries ?? 100,
    maxSize: opts.maxSizeBytes,
    ttl: opts.ttlMs,
    allowStale: true,
    noDeleteOnStaleGet: true,
    sizeCalculation: opts.maxSizeBytes ? (value) => sizeOfValue(opts, value) : undefined,
    dispose: (value, key, reason) => {
      if (reason === "evict" || reason === "expire") evictions++;
      opts.onEvict?.(key, value, mapDisposeReason(reason));
    },
  });

  return {
    async get(key, compute) {
      const cached = cache.get(key, { allowStale: true });
      if (cached !== undefined) {
        hits++;
        if (cache.getRemainingTTL(key) <= 0 && !refreshing.has(key)) {
          const refresh = compute()
            .then((value) => {
              cache.set(key, value);
            })
            .catch(() => undefined)
            .finally(() => {
              refreshing.delete(key);
            });
          refreshing.set(key, refresh);
        }
        return cached;
      }
      misses++;
      const value = await compute();
      cache.set(key, value);
      return value;
    },
    peek(key) {
      return cache.peek(key);
    },
    set(key, value) {
      cache.set(key, value);
    },
    invalidate(key) {
      cache.delete(key);
    },
    invalidateAll() {
      cache.clear();
      refreshing.clear();
    },
    stats() {
      return {
        hits,
        misses,
        evictions,
        sizeBytes: cache.calculatedSize ?? 0,
        entries: cache.size,
      };
    },
  };
}

function createMemo<K extends {}, V extends {}>(opts: MemoOpts<K, V>): MemoCache<K, V> {
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  const cache = new LRUCache<K, V>({
    max: opts.maxEntries ?? 100,
    maxSize: opts.maxSizeBytes,
    ttl: opts.ttlMs,
    sizeCalculation: opts.maxSizeBytes ? (value) => sizeOfValue(opts, value) : undefined,
    dispose: (value, key, reason) => {
      if (reason === "evict" || reason === "expire") evictions++;
      opts.onEvict?.(key, value, mapDisposeReason(reason));
    },
  });
  return {
    get(key, compute) {
      const cached = cache.get(key);
      if (cached !== undefined) {
        hits++;
        return cached;
      }
      misses++;
      const value = compute();
      cache.set(key, value);
      return value;
    },
    peek(key) {
      return cache.peek(key);
    },
    set(key, value) {
      cache.set(key, value);
    },
    invalidate(key) {
      cache.delete(key);
    },
    invalidateAll() {
      cache.clear();
    },
    stats() {
      return {
        hits,
        misses,
        evictions,
        sizeBytes: cache.calculatedSize ?? 0,
        entries: cache.size,
      };
    },
  };
}

function sizeOfValue<K extends {}, V extends {}>(opts: MemoOpts<K, V>, value: V): number {
  return Math.max(1, opts.sizeOf?.(value) ?? 1);
}

function mapDisposeReason(reason: LRUCache.DisposeReason): CacheEvictReason {
  if (reason === "expire") return "ttl";
  if (reason === "delete" || reason === "set" || reason === "fetch") return "manual";
  return "lru";
}
