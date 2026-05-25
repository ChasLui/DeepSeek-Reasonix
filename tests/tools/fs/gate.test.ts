import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
});

describe("noFollowFlag", () => {
  it("uses the macOS platform value", async () => {
    expect(await noFollowFlagFor("darwin", 0x100)).toBe(0x100);
  });

  it("uses the Linux platform value from node:fs", async () => {
    expect(await noFollowFlagFor("linux", 0x8000)).toBe(0x8000);
  });

  it("is undefined on Windows", async () => {
    expect(await noFollowFlagFor("win32", 0x8000)).toBeUndefined();
  });
});

describe("openForWriteNoFollow", () => {
  it("rejects symlink writes on POSIX", async () => {
    if (process.platform === "win32") return;
    const tmp = mkdtempSync(join(tmpdir(), "reasonix-fs-gate-"));
    const target = join(tmp, "target.txt");
    const link = join(tmp, "link.txt");
    writeFileSync(target, "before");
    symlinkSync(target, link);
    const { openForWriteNoFollow } = await import("../../../src/tools/fs/gate.js");

    await expect(openForWriteNoFollow(link)).rejects.toMatchObject({ code: "ELOOP" });
    rmSync(tmp, { recursive: true, force: true });
  });
});

async function noFollowFlagFor(
  platform: NodeJS.Platform,
  noFollow: number,
): Promise<number | undefined> {
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
      ...actual,
      constants: {
        ...actual.constants,
        O_NOFOLLOW: noFollow,
      },
    };
  });
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const { noFollowFlag } = await import("../../../src/tools/fs/gate.js");
  return noFollowFlag();
}
