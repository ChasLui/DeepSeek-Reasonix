import { describe, expect, it } from "vitest";
import { sanitizePromptCachePaths } from "../../src/observability/prompt-cache-monitor.js";

describe("sanitizePromptCachePaths", () => {
  it("preserves URL hosts and paths", () => {
    const input = "see https://x.com/api/v1 for details";

    expect(sanitizePromptCachePaths(input)).toBe(input);
  });

  it("redacts Windows paths", () => {
    const input = String.raw`open C:\Users\me\project\file.ts now`;

    expect(sanitizePromptCachePaths(input)).toBe("open [WIN_PATH] now");
  });

  it("redacts absolute Unix paths to basename plus hash", () => {
    const output = sanitizePromptCachePaths("read /home/user/foo/bar.ts now");

    expect(output).toMatch(/^read bar\.ts\.sha=[0-9a-f]{8} now$/);
  });

  it("redacts home-relative paths to first segment plus hash", () => {
    const output = sanitizePromptCachePaths("read ~/foo/bar now");

    expect(output).toMatch(/^read ~\/foo\.sha=[0-9a-f]{8} now$/);
  });
});
