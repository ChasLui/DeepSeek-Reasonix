import { builtinModules } from "node:module";
import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const cliBanner =
  "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; if (typeof globalThis.require === 'undefined') { globalThis.require = __cr(import.meta.url); }";

const external = (id) =>
  nodeBuiltins.has(id) ||
  id === "web-tree-sitter" ||
  id === "react-devtools-core" ||
  id.endsWith(".node") ||
  id.includes("/tree-sitter-grammars/");

const dtsExternal = (id) => external(id) || id === "@reasonix/core-utils";

export default defineConfig([
  {
    input: "src/index.ts",
    platform: "node",
    external,
    output: {
      dir: "dist",
      format: "esm",
      entryFileNames: "index.js",
      cleanDir: true,
      sourcemap: true,
      comments: false,
    },
  },
  {
    input: "src/index.ts",
    platform: "node",
    external: dtsExternal,
    output: {
      dir: "dist",
      format: "esm",
      cleanDir: false,
      sourcemap: true,
      comments: false,
    },
    plugins: [dts({ emitDtsOnly: true, resolver: "tsc", sourcemap: true })],
  },
  {
    input: "src/cli/index.ts",
    platform: "node",
    external,
    output: {
      dir: "dist/cli",
      format: "esm",
      entryFileNames: "index.js",
      cleanDir: true,
      sourcemap: true,
      banner: cliBanner,
      codeSplitting: false,
      comments: false,
    },
  },
  {
    input: "dashboard/app.js",
    platform: "browser",
    output: {
      dir: "dashboard/dist",
      format: "esm",
      entryFileNames: "app.js",
      cleanDir: true,
      sourcemap: true,
      codeSplitting: false,
      comments: false,
    },
  },
]);
