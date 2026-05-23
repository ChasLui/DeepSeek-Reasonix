import { LRUCache } from "lru-cache";

export interface FileCacheStat {
  dev?: number;
  ino?: number;
  mtimeMs: number;
  size: number;
  ctimeMs?: number;
}

export interface FileCacheEntry {
  raw: Buffer;
  sha256: string;
  encoding: "utf8" | "binary";
}

export interface FileCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  sizeBytes: number;
  entries: number;
}

export interface FileReadCacheOptions {
  maxEntries?: number;
  maxSizeBytes?: number;
  entrySizeLimitBytes?: number;
}

interface StoredFileCacheEntry extends FileCacheEntry {
  absPath: string;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 * 1024;
const DEFAULT_ENTRY_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

export class FileReadCache {
  private readonly cache: LRUCache<string, StoredFileCacheEntry>;
  private readonly keysByPath = new Map<string, Set<string>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly disabled: boolean;
  private readonly entrySizeLimitBytes: number;

  constructor(opts: FileReadCacheOptions = {}) {
    const maxSizeBytes =
      readPositiveIntEnv("REASONIX_FILE_CACHE_BYTES") ??
      opts.maxSizeBytes ??
      DEFAULT_MAX_SIZE_BYTES;
    this.disabled = process.env.REASONIX_FILE_CACHE === "0";
    this.entrySizeLimitBytes = opts.entrySizeLimitBytes ?? DEFAULT_ENTRY_SIZE_LIMIT_BYTES;
    this.cache = new LRUCache<string, StoredFileCacheEntry>({
      max: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
      maxSize: maxSizeBytes,
      sizeCalculation: (entry) => entry.raw.byteLength,
      dispose: (entry, key, reason) => {
        this.removePathKey(entry.absPath, key);
        if (reason === "evict" || reason === "expire") this.evictions++;
        if (process.env.REASONIX_CACHE_DEBUG === "1") {
          process.stderr.write(`file-cache evict ${entry.absPath} (${reason})\n`);
        }
      },
    });
  }

  get(absPath: string, stat: FileCacheStat): FileCacheEntry | null {
    if (this.disabled) return null;
    const key = fileCacheKey(absPath, stat);
    const hit = this.cache.get(key);
    if (!hit) {
      this.misses++;
      return null;
    }
    this.hits++;
    return { raw: hit.raw, sha256: hit.sha256, encoding: hit.encoding };
  }

  set(
    absPath: string,
    stat: FileCacheStat,
    raw: Buffer,
    sha256: string,
    encoding: "utf8" | "binary",
  ): void {
    if (this.disabled || raw.byteLength > this.entrySizeLimitBytes) return;
    const key = fileCacheKey(absPath, stat);
    this.cache.set(key, { absPath, raw, sha256, encoding });
    let keys = this.keysByPath.get(absPath);
    if (!keys) {
      keys = new Set();
      this.keysByPath.set(absPath, keys);
    }
    keys.add(key);
  }

  invalidate(absPath: string): void {
    if (this.disabled) return;
    const keys = this.keysByPath.get(absPath);
    if (!keys) return;
    for (const key of keys) this.cache.delete(key);
    this.keysByPath.delete(absPath);
  }

  invalidateAll(): void {
    this.cache.clear();
    this.keysByPath.clear();
  }

  stats(): FileCacheStats {
    if (this.disabled) {
      return { hits: 0, misses: 0, evictions: 0, sizeBytes: 0, entries: 0 };
    }
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      sizeBytes: this.cache.calculatedSize ?? 0,
      entries: this.cache.size,
    };
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  private removePathKey(absPath: string, key: string): void {
    const keys = this.keysByPath.get(absPath);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.keysByPath.delete(absPath);
  }
}

function fileCacheKey(absPath: string, stat: FileCacheStat): string {
  return [
    absPath,
    stat.dev ?? "",
    stat.ino ?? "",
    stat.mtimeMs,
    stat.ctimeMs ?? "",
    stat.size,
  ].join("|");
}

function readPositiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
