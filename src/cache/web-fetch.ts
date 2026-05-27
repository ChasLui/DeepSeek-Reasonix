import { LRUCache } from "lru-cache";
import type { PageContent } from "../tools/web.js";

export interface WebFetchCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  sizeBytes: number;
  entries: number;
  skipped: number;
}

export interface WebFetchCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxSizeBytes?: number;
  entrySizeLimitBytes?: number;
}

interface StoredWebFetchEntry {
  page: PageContent;
  sizeBytes: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_ENTRY_SIZE_LIMIT_BYTES = 512 * 1024;
const SENSITIVE_QUERY_EXACT_KEYS = new Set([
  "api-key",
  "api_key",
  "apikey",
  "assertion",
  "auth",
  "authorization",
  "bearer",
  "code",
  "id-token",
  "id_token",
  "idtoken",
  "jwt",
  "key",
  "password",
  "passwd",
  "refresh-token",
  "refresh_token",
  "refreshtoken",
  "sasl",
  "secret",
  "session",
  "sig",
  "signature",
  "state",
  "token",
]);
const SENSITIVE_QUERY_RE =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|authorization|session|password|passwd|secret|signature|sig|bearer|jwt|assertion|sasl|(?:^|[_-])(?:key|token)(?:$|[_-]))/i;

export class WebFetchCache {
  private readonly cache: LRUCache<string, StoredWebFetchEntry>;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private skipped = 0;
  private readonly disabled: boolean;
  private readonly entrySizeLimitBytes: number;

  constructor(opts: WebFetchCacheOptions = {}) {
    const ttlMs =
      readPositiveIntEnv("REASONIX_WEB_FETCH_CACHE_TTL_MS") ?? opts.ttlMs ?? DEFAULT_TTL_MS;
    const maxSizeBytes =
      readPositiveIntEnv("REASONIX_WEB_FETCH_CACHE_BYTES") ??
      opts.maxSizeBytes ??
      DEFAULT_MAX_SIZE_BYTES;
    this.disabled = process.env.REASONIX_WEB_FETCH_CACHE === "0";
    this.entrySizeLimitBytes = opts.entrySizeLimitBytes ?? DEFAULT_ENTRY_SIZE_LIMIT_BYTES;
    this.cache = new LRUCache<string, StoredWebFetchEntry>({
      max: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
      maxSize: maxSizeBytes,
      ttl: ttlMs,
      sizeCalculation: (entry) => entry.sizeBytes,
      dispose: (_entry, _key, reason) => {
        if (reason === "evict" || reason === "expire") this.evictions++;
        if (process.env.REASONIX_CACHE_DEBUG === "1") {
          process.stderr.write(`web-fetch-cache evict (${reason})\n`);
        }
      },
    });
  }

  get(url: string, maxChars: number): PageContent | null {
    if (this.disabled) return null;
    const key = webFetchCacheKey(url, maxChars);
    if (!key) {
      this.skipped++;
      return null;
    }
    const hit = this.cache.get(key);
    if (!hit) {
      this.misses++;
      return null;
    }
    this.hits++;
    return copyPage(hit.page);
  }

  set(url: string, maxChars: number, page: PageContent): void {
    if (this.disabled) return;
    const key = webFetchCacheKey(url, maxChars);
    if (!key) {
      this.skipped++;
      return;
    }
    const sizeBytes = estimatePageSize(page);
    if (sizeBytes > this.entrySizeLimitBytes) {
      this.skipped++;
      return;
    }
    this.cache.set(key, { page: copyPage(page), sizeBytes });
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  stats(): WebFetchCacheStats {
    if (this.disabled) {
      return {
        hits: 0,
        misses: 0,
        evictions: 0,
        sizeBytes: 0,
        entries: 0,
        skipped: 0,
      };
    }
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      sizeBytes: this.cache.calculatedSize ?? 0,
      entries: this.cache.size,
      skipped: this.skipped,
    };
  }

  get enabled(): boolean {
    return !this.disabled;
  }
}

export function shouldCacheWebFetchResponse(resp: Response): boolean {
  const cacheControl = resp.headers.get("cache-control")?.toLowerCase() ?? "";
  if (cacheControl.includes("no-store") || cacheControl.includes("private")) return false;
  return true;
}

function webFetchCacheKey(rawUrl: string, maxChars: number): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  for (const key of url.searchParams.keys()) {
    if (isSensitiveCacheParamName(key)) return null;
  }
  if (hasSensitiveFragmentParam(url.hash)) return null;
  url.hash = "";
  normalizeForCacheKey(url);
  return `${url.href}|${maxChars}`;
}

function normalizeForCacheKey(url: URL): void {
  if (url.hostname.startsWith("www.")) url.hostname = url.hostname.slice(4);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.searchParams.size > 1) {
    const pairs = Array.from(url.searchParams.entries()).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    url.search = "";
    for (const [name, value] of pairs) url.searchParams.append(name, value);
  }
}

function hasSensitiveFragmentParam(hash: string): boolean {
  if (!hash) return false;
  const fragment = hash.slice(1);
  for (const part of fragment.split(/[&;?/]/)) {
    if (!part) continue;
    const [rawName = ""] = part.split("=", 1);
    if (isSensitiveCacheParamName(rawName)) return true;
  }
  return false;
}

function isSensitiveCacheParamName(rawName: string): boolean {
  const name = decodeUrlPart(rawName).trim().toLowerCase();
  if (!name) return false;
  if (name.startsWith("x-amz-")) return true;
  return SENSITIVE_QUERY_EXACT_KEYS.has(name) || SENSITIVE_QUERY_RE.test(name);
}

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function estimatePageSize(page: PageContent): number {
  const title = page.title ?? "";
  return (
    Buffer.byteLength(page.url, "utf8") +
    Buffer.byteLength(title, "utf8") +
    Buffer.byteLength(page.text, "utf8") +
    1
  );
}

function copyPage(page: PageContent): PageContent {
  return {
    url: page.url,
    title: page.title,
    text: page.text,
    truncated: page.truncated,
  };
}

function readPositiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
