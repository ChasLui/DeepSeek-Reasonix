import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // vite/vitest's bundled builtin list predates node:sqlite, so it neither strips
  // the prefix correctly nor treats it as external — it tries to load it as a file
  // and fails. Shim it to a virtual module that pulls the real builtin via
  // createRequire at runtime. Test-only; production (tsup/tsx) never goes through vite.
  plugins: [
    {
      name: "reasonix-node-sqlite-shim",
      enforce: "pre",
      resolveId(id: string) {
        if (id === "node:sqlite" || id === "sqlite")
          return "\0reasonix:node-sqlite";
        return null;
      },
      load(id: string) {
        if (id !== "\0reasonix:node-sqlite") return null;
        return [
          'import { createRequire } from "node:module";',
          "const nodeRequire = createRequire(import.meta.url);",
          'const sqlite = nodeRequire("node:sqlite");',
          "export const DatabaseSync = sqlite.DatabaseSync;",
          "export const StatementSync = sqlite.StatementSync;",
        ].join("\n");
      },
    },
  ],
  resolve: {
    alias: {
      "@": resolve(here, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup-lang.ts"],
    environment: "node",
    globals: false,
    // Forks pool — per-file process isolation, so tokenizer BPE / tree-sitter
    // wasms / sqlite native handles can't accumulate in a single shared heap.
    // Threads default OOMs on 16-core boxes where 15 workers × ~300MB blows
    // past Node's 4GB heap cap.
    pool: "forks",
    poolOptions: {
      forks: { maxForks: 8, minForks: 1 },
    },
    // One retry absorbs Windows scheduler hiccups in jobs.test.ts / loop.test.ts /
    // bundle-smoke (real spawns + tokenizer cold load). A real failure still re-fails.
    retry: 1,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
