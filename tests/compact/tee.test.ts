import { promises as fs } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetTeeCache, teeRawOutput } from "../../src/compact/tee.js";

let tmp: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(os.tmpdir(), "reasonix-tee-"));
  resetTeeCache();
});

afterEach(async () => {
  process.env = { ...origEnv };
  resetTeeCache();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("teeRawOutput", () => {
  it("writes raw output to override dir and returns absolute path", async () => {
    const p = await teeRawOutput("git status --porcelain", "M src/foo.ts\n", {
      overrideDir: tmp,
    });
    expect(p).not.toBeNull();
    expect(p!.startsWith(tmp)).toBe(true);
    const contents = await fs.readFile(p!, "utf8");
    expect(contents).toContain("M src/foo.ts");
  });

  it("returns null on empty input", async () => {
    const p = await teeRawOutput("ls", "", { overrideDir: tmp });
    expect(p).toBeNull();
  });

  it("returns null when disabled flag is set", async () => {
    const p = await teeRawOutput("ls", "some output", {
      overrideDir: tmp,
      disabled: true,
    });
    expect(p).toBeNull();
  });

  it("REASONIX_TEE=0 disables the layer entirely", async () => {
    process.env.REASONIX_TEE = "0";
    resetTeeCache();
    // No overrideDir → resolveTeeDir checks env first.
    const p = await teeRawOutput("ls", "stuff");
    expect(p).toBeNull();
  });

  it("caps gigantic input at the 5 MB ceiling with a truncation marker", async () => {
    const big = "x".repeat(6 * 1024 * 1024);
    const p = await teeRawOutput("dump", big, { overrideDir: tmp });
    expect(p).not.toBeNull();
    const stat = await fs.stat(p!);
    // 5 MiB ceiling + ~40 bytes of marker
    expect(stat.size).toBeLessThan(5 * 1024 * 1024 + 100);
    const tail = await fs.readFile(p!, "utf8");
    expect(tail).toMatch(/tee truncated/);
  });

  it("filename slug is filesystem-safe", async () => {
    const p = await teeRawOutput("npx vitest run tests/foo.test.ts", "ok", {
      overrideDir: tmp,
    });
    expect(p).not.toBeNull();
    // No spaces, no slashes after the trailing "/", lowercase only.
    const name = p!.split(/[\\/]/).pop()!;
    expect(name).toMatch(/^\d+_[a-z0-9._-]+\.log$/);
  });
});
