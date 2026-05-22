# Reasonix —— 工作知识

TypeScript 项目。DeepSeek 原生的编码 agent，cache-first 循环。
MIT 许可证。需要 Node ≥22。

## 技术栈

- **语言** — TS 5.6+，ES2022，ESM（`"type": "module"`）
- **CLI** — Commander.js + Ink 5（React 18）TUI
- **测试** — Vitest 2.x
- **Lint / 格式化** — Biome 1.9（2 空格缩进、双引号、始终带分号、100 宽度）
- **构建** — tsup（打包），`tsx`（dev 运行器）
- **MCP** — stdio + SSE 传输，测试中用进程内 fake

## 目录结构

| 路径 | 内容 |
|---|---|
| `src/cli/` | CLI 入口 + 命令（`chat.tsx`、`code.tsx`、`diff.ts` 等）+ `ui/` 中的 Ink TUI |
| `src/tools/` | 工具定义（filesystem、shell、MCP、plan、subagent、web、workspace） |
| `src/mcp/` | MCP 客户端、传输（stdio、SSE）、registry、spec |
| `src/repair/` | 工具调用修复流水线（flatten、scavenge、storm、truncation） |
| `src/index/` | 语义向量索引 |
| `src/code/` | SEARCH/REPLACE 编辑块解析器 + apply gate |
| `src/core/` | 事件日志内核 —— `events.ts`（Event 联合类型）、`reducers.ts`（纯投影）、`eventize.ts` |
| `src/ports/` | 端口接口 —— ModelClient、ToolHost、EventSink、MemoryStore、HookRunner、CheckpointStore |
| `src/adapters/` | 端口的具体适配器（如 `event-sink-jsonl.ts`、`event-source-jsonl.ts`） |
| `src/frame/` | 帧编译器（单元格网格 → ANSI），供 TUI 日志渲染器使用 |
| `src/memory/` | 项目 / 会话 / 用户 / 运行时记忆存储 |
| `src/transcript/` | Transcript 日志（写入）、diff、replay |
| `src/telemetry/` | 用量记录 + 跨会话统计 |
| `src/server/` | Dashboard HTTP server + REST API |
| `tests/` | Vitest 测试，扁平的 `*.test.ts` |
| `examples/` | `basic-chat.ts`、`mcp-server-demo.ts` 等 |
| `benchmarks/` | Harvest + tau-bench 测试框架 |
| `dashboard/` | 编译后的 dashboard SPA 资源 |
| `data/` | Tokenizer 数据（`deepseek-tokenizer.json.gz`） |
| `dist/` | 构建产物 —— **请勿编辑** |
| `.github/` | CI + issue / PR 模板 |

## 命令

```sh
npm run build       # tsup → dist/
npm run dev         # tsx src/cli/index.ts
npm run chat        # tsx src/cli/index.ts chat
npm run test        # vitest run
npm run test:watch  # vitest
npm run lint        # biome check src tests
npm run lint:fix    # biome check --write src tests
npm run format      # biome format --write src tests
npm run typecheck   # tsc --noEmit
```

`prepublishOnly`：lint → typecheck → test → build。

## 约定

- **Import** — 仅类型导入用显式的 `import type`（Biome `useImportType: warn`）。项目内用直接相对导入，不用 barrel 重新导出。
- **Export** — 仅命名导出；不用 `export default`。入口：`src/index.ts`。
- **测试** — vitest `describe`/`it`/`expect`，不用全局变量。命名：`<module>.test.ts`，扁平放在 `tests/` 中。
- **JSX** — Ink 组件用 `.tsx`。tsconfig 中 `jsx: "react"`。
- **TypeScript** — `strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`。工具接收 `ToolCallContext`（abort signal）。
- **MCP** — 所有传输都实现 `McpTransport` 接口。工具在启动时通过 registry 注册。
- **Changelog** — Keep a Changelog 格式。Semver。

## 注意事项

- **这就是 Reasonix 本身** — 对 `src/loop.ts`、`src/repair/`、`src/tools/`、`src/mcp/` 的修改会影响每一个会话。发布前先测试。
- **SEARCH 必须逐字节匹配** — `src/code/edit-blocks.ts` 中的 edit-gate 强制精确匹配。尾随空白或缩进错误 = 不匹配。
- **`dist/`** 由 `tsup` 生成。切勿手动编辑。
- **`.reasonix/semantic/`** 是自动生成的向量索引。切勿手动编辑。
- **`sessions/` 和 `.reasonix/sessions/`** 是用户私有的，已被 git 忽略（依据 `.gitignore`）。
