import { afterEach, describe, expect, it, vi } from "vitest";
import { WebFetchCache } from "../../src/cache/web-fetch.js";
import { ToolRegistry } from "../../src/tools.js";
import { registerWebTools, webFetch } from "../../src/tools/web.js";

describe("WebFetchCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("lets webFetch reuse a successful response within the TTL", async () => {
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache({ ttlMs: 1_000 });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<html><head><title>Demo</title></head><body><p>Hello world.</p></body></html>",
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
    ) as unknown as typeof fetch;
    try {
      const first = await webFetch("https://example.com/demo", {
        cache,
        maxChars: 500,
      });
      const second = await webFetch("https://example.com/demo", {
        cache,
        maxChars: 500,
      });

      expect(first.text).toBe(second.text);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses maxChars as part of the cache key", async () => {
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache({ ttlMs: 1_000 });
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body><p>abcdef</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    try {
      await webFetch("https://example.com/demo", { cache, maxChars: 3 });
      await webFetch("https://example.com/demo", { cache, maxChars: 6 });

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(cache.stats()).toMatchObject({ hits: 0, misses: 2, entries: 2 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("expires entries after the configured TTL", async () => {
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache({ ttlMs: 1 });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(`<html><body><p>call ${calls}</p></body></html>`, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;
    try {
      const first = await webFetch("https://example.com/ttl", {
        cache,
        maxChars: 500,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await webFetch("https://example.com/ttl", {
        cache,
        maxChars: 500,
      });

      expect(first.text).toContain("call 1");
      expect(second.text).toContain("call 2");
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not cache responses marked no-store", async () => {
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache({ ttlMs: 1_000 });
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body><p>private</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        }),
    ) as unknown as typeof fetch;
    try {
      await webFetch("https://example.com/no-store", { cache, maxChars: 500 });
      await webFetch("https://example.com/no-store", { cache, maxChars: 500 });

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(cache.stats()).toMatchObject({ hits: 0, misses: 2, entries: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips URLs with credential-like query parameters", async () => {
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache({ ttlMs: 1_000 });
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body><p>secret</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    try {
      const url = "https://example.com/private?access_token=secret";
      await webFetch(url, { cache, maxChars: 500 });
      await webFetch(url, { cache, maxChars: 500 });

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(cache.stats()).toMatchObject({
        hits: 0,
        misses: 0,
        entries: 0,
        skipped: 4,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    "token",
    "code",
    "state",
    "bearer",
    "jwt",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Signature",
    "assertion",
    "sasl",
  ])("skips sensitive query parameter %s", (key) => {
    const cache = new WebFetchCache({ ttlMs: 1_000 });
    const url = `https://example.com/private?${key}=secret`;
    const page = { url, title: "private", text: "secret", truncated: false };

    cache.set(url, 500, page);

    expect(cache.get(url, 500)).toBeNull();
    expect(cache.stats()).toMatchObject({
      hits: 0,
      misses: 0,
      entries: 0,
      skipped: 2,
    });
  });

  it("skips URLs with credential-like fragment parameters", async () => {
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache({ ttlMs: 1_000 });
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body><p>callback</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    try {
      const url = "https://example.com/callback#access_token=secret";
      await webFetch(url, { cache, maxChars: 500 });
      await webFetch(url, { cache, maxChars: 500 });

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(cache.stats()).toMatchObject({
        hits: 0,
        misses: 0,
        entries: 0,
        skipped: 4,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes non-sensitive URL fragments out of the cache key", async () => {
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache({ ttlMs: 1_000 });
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body><p>fragment</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    try {
      await webFetch("https://example.com/page#section-a", {
        cache,
        maxChars: 500,
      });
      await webFetch("https://example.com/page#section-b", {
        cache,
        maxChars: 500,
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes www / trailing slash / query order to one cache key", async () => {
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache({ ttlMs: 1_000 });
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body><p>same page</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    try {
      await webFetch("https://www.example.com/page/?b=2&a=1", {
        cache,
        maxChars: 500,
      });
      await webFetch("https://example.com/page/?a=1&b=2", {
        cache,
        maxChars: 500,
      });
      await webFetch("https://www.example.com/page?b=2&a=1", {
        cache,
        maxChars: 500,
      });
      await webFetch("https://example.com/page?a=1&b=2", {
        cache,
        maxChars: 500,
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(cache.stats()).toMatchObject({ hits: 3, misses: 1, entries: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("short-circuits off when REASONIX_WEB_FETCH_CACHE=0", async () => {
    vi.stubEnv("REASONIX_WEB_FETCH_CACHE", "0");
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache();
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body><p>Hello world.</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    try {
      await webFetch("https://example.com/off", { cache, maxChars: 500 });
      await webFetch("https://example.com/off", { cache, maxChars: 500 });

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(cache.stats()).toEqual({
        hits: 0,
        misses: 0,
        evictions: 0,
        sizeBytes: 0,
        entries: 0,
        skipped: 0,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("wires the loop-owned cache through web_fetch dispatch context", async () => {
    const originalFetch = globalThis.fetch;
    const cache = new WebFetchCache({ ttlMs: 1_000 });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<html><head><title>Demo</title></head><body><p>Hello world.</p></body></html>",
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
    ) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry);
      await registry.dispatch("web_fetch", JSON.stringify({ url: "https://example.com/demo" }), {
        webFetchCache: cache,
      });
      await registry.dispatch("web_fetch", JSON.stringify({ url: "https://example.com/demo" }), {
        webFetchCache: cache,
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
