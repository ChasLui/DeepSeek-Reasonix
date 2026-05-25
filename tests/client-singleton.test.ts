import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetClientSingletonForTests,
  getOrCreateDeepSeekClient,
} from "../src/client-singleton.js";

describe("getOrCreateDeepSeekClient", () => {
  afterEach(() => {
    _resetClientSingletonForTests();
    vi.unstubAllEnvs();
  });

  it("reuses clients with the same resolved apiKey and baseUrl", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-singleton");

    const a = getOrCreateDeepSeekClient({ baseUrl: "https://api.deepseek.com/" });
    const b = getOrCreateDeepSeekClient({ baseUrl: "https://api.deepseek.com" });

    expect(a).toBe(b);
  });

  it("does not reuse clients with different api keys or base URLs", () => {
    const a = getOrCreateDeepSeekClient({
      apiKey: "sk-a",
      baseUrl: "https://api.deepseek.com",
    });
    const b = getOrCreateDeepSeekClient({
      apiKey: "sk-b",
      baseUrl: "https://api.deepseek.com",
    });
    const c = getOrCreateDeepSeekClient({
      apiKey: "sk-a",
      baseUrl: "https://proxy.example.com",
    });

    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("_resetForTests clears the singleton map", () => {
    const a = getOrCreateDeepSeekClient({ apiKey: "sk-a" });
    _resetClientSingletonForTests();
    const b = getOrCreateDeepSeekClient({ apiKey: "sk-a" });

    expect(a).not.toBe(b);
  });

  it("keeps commit, doctor, and run off the singleton path", () => {
    for (const file of [
      "src/cli/commands/commit.ts",
      "src/cli/commands/doctor.ts",
      "src/cli/commands/run.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), file), "utf8")).not.toContain(
        "getOrCreateDeepSeekClient",
      );
    }
  });

  it("uses singleton only from long-session entry points", () => {
    for (const file of [
      "src/cli/ui/App.tsx",
      "src/cli/commands/acp.ts",
      "src/cli/commands/desktop.ts",
      "src/code/setup.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), file), "utf8")).toContain(
        "getOrCreateDeepSeekClient",
      );
    }
  });
});
