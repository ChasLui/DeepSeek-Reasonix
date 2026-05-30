import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setStoreBackend, storeBackend, storeVersionPath } from "../src/storage/select.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "reasonix-sv-"));
}

describe("storage/select", () => {
  it("defaults to jsonl when .store-version is absent (zero behavior change)", () => {
    expect(storeBackend(tmpHome())).toBe("jsonl");
  });

  it("round-trips the backend choice", () => {
    const home = tmpHome();
    setStoreBackend("sqlite", home);
    expect(storeBackend(home)).toBe("sqlite");
    setStoreBackend("jsonl", home);
    expect(storeBackend(home)).toBe("jsonl");
  });

  it("treats any non-'sqlite' content as jsonl (fail-safe)", () => {
    const home = tmpHome();
    writeFileSync(storeVersionPath(home), "garbage\n", "utf8");
    expect(storeBackend(home)).toBe("jsonl");
  });
});
