# Reasonix 架构

## 设计哲学

Reasonix **有主见，不追求通用**。每一处抽象都由 DeepSeek 特有的行为或
经济特性来证成。如果某个东西是通用的，我们就不收录它。

产品的北极星指标：**便宜到可以一直开着的编码 agent**。一个在后台项目上
悄悄每月烧掉 $200 的工具，没人会用。下面每个子系统都对这个目标负责。

## 四大支柱

### 支柱 1 —— Cache-First Loop

**问题。** DeepSeek 对缓存命中的输入按约 miss 价格的 10% 计费。自动前缀
缓存只在与上一次请求的*精确*字节前缀匹配时才激活。大多数 agent 循环每轮
都重排、重写或注入新鲜的时间戳 —— 实践中的缓存命中率：<20%。

**方案。** 将上下文划分为三个区域：

```
┌─────────────────────────────────────────┐
│ IMMUTABLE PREFIX                        │ ← 会话内固定
│   system + tool_specs + few_shots        │   缓存命中候选
├─────────────────────────────────────────┤
│ APPEND-ONLY LOG                         │ ← 单调增长
│   [assistant₁][tool₁][assistant₂]...    │   保留先前轮次的前缀
├─────────────────────────────────────────┤
│ VOLATILE SCRATCH                        │ ← 每轮重置
│   R1 thought, transient plan state      │   永不上送
└─────────────────────────────────────────┘
```

**不变量：**
1. 前缀每会话计算一次、哈希、并钉住。
2. 日志条目按追加顺序序列化；不重写。
3. Scratch 在其任何信息被折叠进日志之前，先经支柱 2 蒸馏。

**指标。** `prompt_cache_hit_tokens / (hit + miss)` 按轮次暴露并按会话聚合。
在 TUI 顶栏的 cache cell 中可见。

#### 并行工具分发

每个工具声明 `parallelSafe?: boolean`（默认 `false`）。循环分发器把连续的
parallel-safe 调用分组成块，并通过 `Promise.allSettled` 并发竞速；第一个
非 parallel-safe 的调用结束当前块并单独运行（串行屏障 —— 保留
read-after-write 顺序）。无论哪个调用先 settle，工具结果的产出和历史追加
仍按声明顺序落地，因此模型看到的形状与完全串行分发时相同。

| 环境变量 | 默认值 | 效果 |
|---|---|---|
| `REASONIX_PARALLEL_MAX` | `3`（硬上限 `16`） | 最大块大小。 |
| `REASONIX_TOOL_DISPATCH=serial` | 未设置 | 强制串行分发 —— 逃生舱。 |

内置的 opt-in：只读文件系统（`read_file`、`list_directory`、
`directory_tree`、`search_files`、`search_content`、`get_file_info`）、
web（`web_search`、`web_fetch`）、`recall_memory`、`semantic_search`、
隔离的子循环（`run_skill`、`spawn_subagent`）、内存中的 job 查询
（`job_output`、`list_jobs`）。有变更 / 副作用的工具保持默认。MCP 桥接的
工具默认 `false` —— 第三方工具仅在 server 明确声明并行安全时才 opt in。

## 思考模式契约

DeepSeek 思考模式文档快照（2026-05-25，
https://api-docs.deepseek.com/zh-cn/guides/thinking_mode）定义了 Reasonix
视为协议契约的请求 / 响应形状，而不是 UI 偏好。

v4-flash 实测支持：2026-05-25 live attestation 中，`thinking.type=enabled`、
`thinking.type=disabled` 和省略 thinking 控制三种请求都返回 HTTP 200 且包含
非空 `reasoning_content`。因此 Reasonix 保持
`thinkingModeForModel("deepseek-v4-flash")` 为 enabled，并保持
`isThinkingModeModel("deepseek-v4-flash")` 为 true。

**Inv-A —— 工具调用回传。** 含 `tool_calls` 的 assistant 轮次在后续 chat
调用中必须保留 `reasoning_content`，否则下一次 DeepSeek 请求可能返回 400。
Reasonix 通过 `buildAssistantMessage`（位于 `src/loop/messages.ts`）、
`stampMissingReasoningForThinkingMode`（位于 `src/loop/healing.ts`）、
`replaceTailAssistantMessage`（位于 `src/loop.ts`）和 scavenge（位于
`src/repair/scavenge.ts`）共同保留这个字段。

**Inv-B —— 采样参数沉默。** 在思考模式下，DeepSeek 会静默忽略
`temperature`、`top_p`、`presence_penalty`、`frequency_penalty`，而不是拒绝请求。
`buildPayload`（位于 `src/client.ts`）故意保留这些字段，让 Reasonix payload
仍可与 OpenAI 风格工具链做 diff，同时依赖服务端的不报错契约。

**Inv-C —— 第三方端点兼容。** Azure 兼容端点可能拒绝 DeepSeek 专有的
`extra_body.thinking.type`，所以 `_isAzureEndpoint`（位于 `src/client.ts`）会切除
该字段。其它第三方端点也走同一兼容路径：当 `thinkingModeForModel()`（位于
`src/loop/thinking.ts`）返回 `undefined` 时跳过该字段。

Last attested against DeepSeek docs: 2026-05-26 (URL above).

## API surface

DeepSeek 对话补全与 FIM 补全文档快照（2026-05-26，
https://api-docs.deepseek.com/zh-cn/api/create-chat-completion 与
https://api-docs.deepseek.com/zh-cn/api/create-completion）是请求形状的唯一来源。
公开模型面只暴露 `deepseek-v4-flash` 与 `deepseek-v4-pro`；pricing 文档把
`deepseek-chat` 与 `deepseek-reasoner` 标记为未来弃用的兼容名称，分别映射到
v4-flash 的非思考和思考模式。因此 Reasonix 从面向用户的 picker 与 `/model`
写入路径中移除 legacy id，但保留老配置、老 transcript、pricing replay 和
thinking-mode guard 所需的兼容别名。

`src/client.ts` 是唯一请求形状边界。它直接映射当前 DeepSeek 参数：
`response_format`、`stop`、默认开启 streamed usage 的 `stream_options`、
`tool_choice`、function tool 的 `strict`、`logprobs`、`top_logprobs` 与
`user_id`。它也验证便宜且无歧义的客户端约束：`tools.length <= 128`、
`top_logprobs` 必须搭配 `logprobs=true`，以及 `user_id` 必须符合 DeepSeek
允许字符集和 512 字符上限。stop sequence 的行为等服务端语义仍由上游负责。

beta chat-prefix 是独立入口：`chatPrefix()` 路由到
`/beta/chat/completions`，要求最后一条消息是带 `prefix: true` 的 assistant
消息，并在发送前剥离 thinking 控制。`reasonix doctor` 包含 `api-prefix`
检查，跑同一条最小 prefix 路径；beta endpoint 可达性由真实消费者路径验证，
而不是靠字符串拼接。

beta FIM 是另一条独立入口：`completeFim()` 路由到 `/beta/completions`，映射
legacy completion 字段 `prompt`、`suffix`、`echo`、`logprobs`、`max_tokens`、
`stop`、`temperature` 与 `top_p`，并固定 `stream: false`。它不会发送 chat
`messages` 或 thinking 控制。

Usage 统计会保留 DeepSeek 的
`completion_tokens_details.reasoning_tokens`，并一路传到 client、core event、
transcript replay、telemetry、server API、TUI 和 dashboard。JSON mode 只做
观测：当 `finish_reason="stop"` 且 `content` 为空时记录 telemetry，但
`buildPayload` 不抛错，因为 API 把 JSON-output prompt 质量视为调用方责任。

### 支柱 2 —— Tool-Call Repair

**问题。** 经验观察到的 DeepSeek 失败模式：
- 工具调用 JSON 在 `<think>` 内部产出，最终消息里缺失。
- 当 schema 有 >10 个参数或深层嵌套对象时，参数被丢弃。
- 同一工具用完全相同的参数反复调用（call-storm）。
- 因 `max_tokens` 在结构中途命中而导致 JSON 截断。
- 参数形状接近但错误：可选字段填 `null`、字符串化数组
  （`"[\"a\"]"`）、期望数组处放 `{}` 占位符、期望数组处放裸字符串、
  容器 CWD 的 `/root/<file>` 路径、训练后的 markdown 自动链接泄漏进路径
  字段（`[notes.md](http://notes.md)`）。

**方案。** 修复分两层运行：

**A 层 —— 调用级流水线**（`src/repair/index.ts`，在每个 assistant 轮次
运行）：

1. **`flatten`** —— 有 >10 个叶子参数或深度 >2 的 schema 在
   `ToolRegistry.register()` 时自动检测，并以点记法形式呈现给模型。
   `dispatch()` 在调用用户的 `fn` 之前把参数重新嵌套回去。
2. **`scavenge`** —— 正则 + JSON 解析器扫描 `reasoning_content`，找出模型
   忘记在 `tool_calls` 里产出的任何工具调用。
3. **`truncation`** —— 检测不平衡的 JSON，并通过补全括号或请求续写补全
   来修复。
4. **`path-normalize`** —— 从路径状参数中剥离开头的 `/root`（DeepSeek 在
   仓库位于 `/root/<repo>` 的容器 CWD 上训练）；重写为项目相对路径。
5. **`storm`** —— 在滑动窗口内出现相同的 `(tool, args)` 元组 → 抑制该调用，
   注入一个反思轮次。

**B 层 —— 分发时的 arg-shape 修复**（`src/repair/schema-walk.ts` +
`src/repair/arg-shape.ts`，每次 `tools.dispatch()` 调用运行一次）：

关键的反转是：**先校验再修复**，而非先预处理再校验。预处理 pass 编码了
关于"什么坏了"的先验，并冒着静默损坏的风险（例如把一个恰好看起来像 JSON
数组的 `writeFile.content` 给搅乱了）。让校验器先抱怨，然后修复只花费在
schema 不认可的那些确切的 issue 路径上。

顺序：

1. **Autolink 解包** —— 退化的 `[X](http(s)://X)` 在任意字符串字段中坍缩
   为 `X`。真正的 markdown 链接（`[click](https://example.com)`）会通过，
   因为链接文本 ≠ URL host。
2. **`validate(schema, args)` → `Issue[]`** —— 轻量级 JSONSchema walker
   （`required-missing` / `type-mismatch` / `array-expected`）。
3. 对每个 issue（**最深优先**处理，以在兄弟变更间保持路径稳定），按固定
   顺序应用 `SHAPE_REPAIRS`：
   1. `stripNullOnOptional` —— 在可选键处丢弃 `null`。**拒绝处理数组
      索引** —— 删除元素会改变批处理语义；留给工具处理。
   2. `coerceNumericString` —— 对 `type: integer/number` 字段把 `"50"` →
      `50`。恢复了工具过去在其 `fn` 体内假装的宽松行为。
   3. `parseStringifiedArray` —— 当值能 JSON-parse 成数组时，把
      `'["a","b"]'` → `["a","b"]`。**必须先于** wrap-bare-string，这样
      `'["a","b"]'` 才不会变成 `['["a","b"]']`。
   4. `unwrapEmptyPlaceholderObject` —— 数组字段处的 `{}` → `[]`。
   5. `wrapBareString` —— 数组字段处的 `"foo"` → `["foo"]`。
4. 重新校验。残余 issue 返回一个模型可读的错误，列出每个
   `path: expected X, got Y`，以便模型在下一轮自我纠正。

walker 覆盖 JSONSchema 的 `type`（string 或 string-array）、`required`、
嵌套 `properties` 和 `array.items`，外加 `enum` 成员关系。`oneOf` /
`anyOf` / `allOf` 未建模 —— host 侧 gate 是尽力而为。

**Opt-out。** 自带运行时清理器的工具（`submit_plan`、`revise_plan`、
`mark_step_complete`、`ask_choice`、`todo_write`、`spawn_subagent`）声明
`lenientArgs: true` —— 它们的分发跳过 gate，让工具的 `fn` 对混合形状的
数组和 enum 兜底保持权威。**Autolink 扫描仍会运行**于路径状字段（见下方
scoping）—— 那是带不变量的，值得这个 tradeoff。

**Autolink 范围。** `unwrapDegenerateAutolinks` 只触碰那些其直接键，或其
所在数组的父键在 `PATH_FIELD_NAMES` 中的字符串（`path` / `paths` /
`source` / `destination` / `file_path` / `filepath` / `src` / `dst` /
`target`）。这防止了对 `write_file.content`、`submit_plan.plan` 以及其他
可能合法包含 markdown 链接的自由文本字段的静默损坏。解包返回去除空白后的
链接文本（而非原始匹配文本），因此像
`[src/fo o.ts](http://src/foo.ts)` 这样的拆域形式会解析为 `src/foo.ts`。

**遥测。** `ToolRegistry.getRepairStats()` 暴露
`{ [toolName]: { [repairKind]: count } }`。`unregister(name)` 和
`resetRepairStats([name])` 会清空它 —— 对带 MCP 热增 / 热删的长生命周期
registry 很重要。

**宽松 JSON 兜底（`jsonrepair`）。** 修复支柱中每个严格的 `JSON.parse`
失败都用 `tryParseLoose`（`src/repair/json-coerce.ts`）包裹：先严格，再
`jsonrepair`（ISC），然后再次严格解析。单引号对象、Python `True/False/None`、
尾随逗号、智能引号、围栏 ```json``` 块以及截断的 JSON 全都变得可恢复。
受益的失败边界：`tools.dispatch()` 参数解析、`scavenge`、
`parseStringifiedArray`、`truncation` 残余。每次救援都被计为
`jsonrepair-fallback`，使其命中率可观测。分发路径额外守护
`isPlainObjectValue` —— jsonrepair 宽松到能把裸文本强转成 JSON 字符串，
而那不是有效的 tool-args 形状。

### 支柱 3 —— 成本控制 *(v0.6)*

**问题。** 默认使用前沿模型（v4-pro，约 12× flash 成本）并在上下文中累积
完整工具结果的编码 agent，对活跃用户来说是每月 $150-$250。大多数轮次不
需要前沿推理；大多数会话为只用过一次的工具结果重复付费。

**方案。** 四个互补的机制，常见情况下都不需要手动调优：

#### 4.1 分层默认（flash 优先）

三个预设权衡**模型层级**与**推理强度**：

| 预设 | 模型 | 强度 | 成本 |
|---|---|---|---:|
| `flash` | `v4-flash` | `max` | 1× |
| `auto`（默认） | 困难轮次 `v4-flash` → `v4-pro` | `max` | 1–3× |
| `pro` | `v4-pro` | `max` | ~12× |

所有辅助调用 —— `forceSummaryAfterIterLimit`、子 agent spawn、截断修复
重试 —— 无论用户的预设如何，都硬编码为 `v4-flash + effort=high`。没有理由
为"把这些工具结果改写成散文"或为 `explore` 子 agent 的 grep 链支付 pro
费率。

#### 4.2 轮末自动压缩

日志中每个超过 `TURN_END_RESULT_CAP_TOKENS`（3000）的工具结果，会在轮次
结束时收缩到该上限。读取它的那一轮模型拥有完整文本；后续轮次看到的是
紧凑摘要，需要时可重新读取。一次额外的 `read_file` 调用，远比把 12KB 拖过
未来每个 prompt 便宜得多。

一个主动的 40% 上下文比例阈值，会在长的多迭代轮次内、在 80% 应急阈值触发
之前抢先运行同样的收缩。

#### 4.3 `/pro` 单轮预备

预判任务困难的用户输入 `/pro`；**下一**轮在 `v4-pro` 上运行，然后自动
解除。无预设抖动，无遗忘的回退。预备状态以 header 中黄色的
`⇧ pro armed` 药丸标显示。

#### 4.4 失败信号自动升级

循环按轮次计数可见的"flash 在挣扎"事件：
- `edit_file` / `write_file` 的 SEARCH-not-found 错误
- ToolCallRepair 触发（scavenge / truncation-fix / storm-break）

一旦计数达到 `FAILURE_ESCALATION_THRESHOLD`（3），**当前轮次的剩余部分**
在 `v4-pro` 上运行。通过黄色警告行宣告 —— 没有静默的成本惊喜。计数器 +
升级标志在每个轮次开始时重置。

轮次处于 pro 时，header 显示红色的 `⇧ pro escalated` 药丸标。

#### 4.5 读取去重

当模型重新读取本会话已读过的文件时，`read_file` 返回一行存根
（`unchanged since an earlier read … content is still above`），而非重新
转储正文 —— 节省重新转储的 token。该存根仅在三个条件成立时触发，因此它
绝不会把模型指向不存在的内容：

1. **相同的产出视图 + 相同内容。** 去重键绑定到文件的 `dev:ino` 加上解析
   后的视图（range / head / tail / full / outline / aggressive）。新鲜度由
   将被产出、在同一 fd 上读取的字节的 `sha256` 判断 —— 而非 mtime（同样
   大小的编辑或恢复的时间戳能击败它）。
2. **先前的输出仍在活跃日志中。** 这是与 §4.2 的交互：一旦某次读取的输出
   被轮末压缩收缩或被历史折叠丢弃，存根就会撒谎，因此该条目被作废（循环
   在每次 `compactInPlace` 时都调用进去重状态）。无法在分发截断中存活的
   大型读取从不被记录。
3. **未被强制 / 未被禁用。** `read_file force:true` 总是重新转储；
   `REASONIX_DEDUP=0` 或 `config.filesystem.dedupEnabled:false` 会完全禁用
   该层。

状态由每个 `CacheFirstLoop` 独占，因此 ACP 会话、桌面 tab 和子 agent 从不
共享读取历史。一个并行块内的并发相同读取按声明顺序认领，且全部完整转储，
使输出在 replay 间字节相同（支柱 1）。

#### 成本透明度

每轮和会话成本在 StatsPanel 中着色：
- `turn $0.003` —— 绿色 <$0.05，黄色 $0.05–0.20，红色 ≥$0.20
- `session $0.12` —— 同样的刻度 ×10

### 支柱 4 —— 输出压缩 *(v0.48)*

受 `rtk` 启发的逐命令输出过滤器，位于 `runCommand` 和模型的工具结果通道
之间。模型很少需要 `git status` 或一个通过的 `npm test` 的字节精确输出 ——
它需要的是**形状**（多少文件改动、哪些测试失败、lint 错误聚集在哪里）。
支柱 4 把字节 blob 换成结构化摘要，并把原文 tee 到磁盘
`~/.local/share/reasonix/tee/<ts>_<slug>.log`，把路径以 `[full: …]` 形式
浮现出来，使模型可以按需 `read_file` 它。

**过滤器 registry（`src/compact/registry.ts`）。** 无状态分发 —— 每个过滤器
声明一个 `argv → bool` 匹配器和一个 `(input) → string|null` reducer。
首个匹配胜出；返回 `null` 是直通；抛出会被记录到 stderr、计为
`fallback`，模型得到未触动的原始内容 —— 明确避免静默掩盖。幂等注册意味着
`registerShellTools` 可以在每次工作区切换时重新注册而不产生重复 id。

**Tier-1 过滤器（高频命令）。**

| id | 输入形状 | 输出形状 | 典型缩减 |
|----|-------------|--------------|-------------------|
| `git-status` | porcelain 或 verbose status | `M:3 A:1 ?:2` + 文件列表 | 70-90% |
| `git-log` | full / oneline | 每个 commit 的 `<sha> <subject>` | 60-85% |
| `git-diff` | unified diff | hunk + 折叠的未变更块 | 50-80% |
| `vitest` / `jest` | runner 输出 | 仅失败带堆栈 | 通过时 90-99%，失败时 70% |
| `pytest` | session 输出 | 仅失败部分 | 85-95% |
| `cargo-test` / `go-test` | runner 输出 | 仅失败 | 85-95% |
| `eslint` / `biome` / `tsc` | 诊断 | 按文件分组 + 顶部规则 | 60-85% |
| `ls` / `tree` / `find` | 列表 | 扩展名计数 + 截断的开头 | 60-80% |

约 50 行以下的列表直通不变 —— 压缩开销不值得为省 5 个 token 而付出。

**Tee + 保留。** `src/compact/tee.ts` 写入原始 blob（封顶 5 MB 带截断
标记）并在 100 个文件处 FIFO 修剪目录。`REASONIX_TEE=0` 禁用持久化；
`REASONIX_TEE=<dir>` 覆盖位置（测试中使用）。当 home 不可写时，路径解析
回退到 `tmpdir()`。

**截断 tee 回写。** `runCommand` 内部的 32 KB 字节上限以前会直接丢弃尾部。
有了支柱 4，它在 `RunCommandResult.rawOutput` 中保留完整的截断前缓冲区，
由分发层 tee。截断标记现在以 `[full: <path>]` 结尾，使模型能恢复它实际
需要的字节。

**读取侧：aggressive 模式。** `read_file` 对 .ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.go/.rs
接受 `level: "aggressive"` —— 基于正则的正文剥离器，把函数/类坍缩为
`{ … }`（Python 中为 `: ...`），同时保留签名行和稳定的行数。尽力而为，
绝不 AST。尾部提示告诉模型如何用 `level=minimal` 重新读取。

**Kill switch。** `REASONIX_COMPACT=0` 绕过整层（返回字节精确的原始内容）。
`REASONIX_COMPACT_EXCLUDE=git,tree` 跳过指定的 `argv[0]` 头。`config.json`
有 `compact: { enabled, exclude, tee }` 镜像。过滤器抛出被静默吞掉 → 原始
输出，确保该层永远不会破坏一个轮次。

**遥测。** `getCompactionStats()` 返回一个
`Map<filterId, { hits, savedBytes }>`，在每次成功的 compact 调用时填充。
`fallback` 有自己的 id，因此行为异常的过滤器可观测而不会让循环崩溃。

### 结构化载荷编码 —— TOON

TOON 紧邻支柱 4，作为载荷的结构化数据路径。协议信封保持 JSON（OpenAI
兼容的请求体、JSON-RPC、JSONL 记录、原生工具 schema，以及模型生成的
`arguments`），但这些信封内部的结构化载荷可以是 TOON。

`src/toon/codec.ts` 钉住 TOON 选项（`indent=2`、逗号分隔符、
`keyFolding=off`），使相同的值产生相同的字节。工具结果使用
`src/toon/encode-result.ts`：`ToolRegistry` 编码对象返回值，以及本身是
合法 JSON 对象/数组的字符串返回值；MCP 文本块在 `flattenMcpResult` 中
经过同样的重编码步骤。纯文本仍是纯文本，且载荷在截断之前、进入只追加的
`role:"tool"` 日志之前就被编码，因此后续轮次重发相同的字节。

以前重新解析 JSON 工具结果的消费者，现在都走 `decodeToolResultObject`
（`rejectedReason`、工具摘要、生命周期检查、计划步骤完成、计划模式拒绝
卡片、子 agent markdown 解包，以及内核错误分类）。解码器优先接受 TOON，
并对 `{` / `[` 前缀采用 JSON 优先处理，使旧的控制信封仍可读。

前缀载荷在 `mode=prefix|all` 时使用 `src/toon/prompt-payload.ts`：
`@mention` 展开、记忆摘要、skills 索引，以及 `.gitignore` 块都作为
确定性的围栏 `toon` 块产出。`codeSystemPrompt()` 和聊天 prompt 构建器
通过它们的 rebuild 闭包接收当前的 TOON 模式，因此 `/new` 和 `/cwd`
重建相同的结构化区段，而非丢失或重复它们。
`ImmutablePrefix.computeFingerprint()` 刻意保持基于 JSON，因为该哈希是
内部的缓存漂移防护，而非面向模型的载荷。

整体重写的内部状态也可以使用 TOON：计划状态、计划归档、待定编辑、检查点、
语义索引元数据，以及 `.toon` 配置文件都优先读 `.toon` 并回退到旧的
`.json`。JSONL 流和语义索引数据行保持 JSONL，因为它们是只追加的行协议。

该层对载荷默认开启。`REASONIX_TOON=results|prefix|all` 或 `config.toon`
（旧的 `config.json` 回退）可以收窄它，而 `REASONIX_TOON=0`、`toon: false`
或 `toon: { enabled: false }` 是字节兼容的 kill switch。`doctor` 报告活跃的
TOON 模式，`/status` 行从 `src/toon/stats.ts` 读取编码/解码遥测。基于
prompt 的"工具 schema 即 TOON"仍受基准测试门控，因为它会绕过原生
function calling；默认的载荷编码器不改变那条协议边界。

## 持久化代码图索引（lexical+symbol+edge）

`src/index/code-graph/` 是代码关系工具的 JSON 支撑的快速路径，不是第五支柱，
也不替代 `src/code-query/` 中基于 tree-sitter 的即时路径。设计追踪见
`docs/plans/2026-05-24-codegraph-borrow-ral.md`。

`reasonix code-index rebuild` 在 `.reasonix/index/code-graph/` 下写入确定性
工件：`nodes.json`、`edges.json`、`bm25.json`、`files-stamps.json`。四个文件
携带相同的确定性 `graphHash`；loader 从工件载荷重算它，让混合或被编辑过的
工件以 fail-closed 方式被拒，而非提供部分图状态。进程内 load cache 的签名
包含工件 `ctimeMs`，因此同样大小的重写不会绕过该校验。doctor 工件统计在
报告计数前会校验相同的 node、edge 和 BM25 schema。builder 在索引热路径使用
轻量级的源码扫描器；较旧的 tree-sitter 关系路径保持作为兼容预言机和兜底，
在工件缺失、stale 检查超时或某种关系不被图支持时使用。

运行时查找目前只为 `find_references` 的 `callers` 和 `callees` 加速；
`imports`、`importers` 和 `detect_changes(includeCallers)` 保持在即时路径，
直到图存储了足够的 import 元数据和增量 stale 语义、达到字节兼容为止。
`REASONIX_CODE_GRAPH=0` 绕过整层；`REASONIX_CODE_GRAPH_BODY=1` 是写入节点
`signature` / `docstring` 字段的前置条件。遥测和 doctor 输出只报告计数、
大小、耗时和 stale 比例。

## 模块布局

```
src/
├── client.ts               # DeepSeek client (fetch + SSE)
├── loop.ts                 # Pillar 1 + 3 — CacheFirstLoop
├── repair/                 # Pillar 2 pipeline
│   ├── index.ts
│   ├── scavenge.ts
│   ├── flatten.ts
│   ├── truncation.ts
│   └── storm.ts
├── prompt-fragments.ts     # TUI_FORMATTING_RULES, NEGATIVE_CLAIM_RULE —
│                           #   reused by main + subagent + skill prompts
├── code/prompt.ts          # reasonix code main system prompt
├── compact/                # Pillar 4 — per-command output filter + tee
│   ├── registry.ts         # registerCompactor / applyCompactor + stats
│   ├── defaults.ts         # one-shot Tier-1 registration
│   ├── tee.ts              # raw-output FIFO snapshot store
│   └── filters/            # git, test-runner, linter, listing (ANSI via npm strip-ansi)
├── tools/                  # Tool implementations
│   ├── filesystem.ts       # read / list / search / edit / write
│   ├── shell.ts            # run_command + run_background (JobRegistry)
│   ├── jobs.ts             # background-process registry
│   ├── memory.ts           # remember / forget / list user memories
│   ├── skills.ts           # list + invoke SKILL.md playbooks
│   ├── subagent.ts         # spawn_subagent — flash+high by default
│   ├── plan.ts             # submit_plan (review gate)
│   └── web.ts              # web_search, web_fetch (multi-engine: Mojeek, SearXNG or Metaso)
├── mcp/                    # MCP client + bridge (stdio + SSE)
├── index/code-graph/       # JSON code-graph fast path for relation tools
├── memory.ts               # ImmutablePrefix / AppendOnlyLog / VolatileScratch
├── project-memory.ts       # REASONIX.md loader
├── user-memory.ts          # ~/.reasonix/memory/ store (project + global)
├── skills.ts               # built-in explore + research skills
├── session.ts              # JSONL session persistence
├── telemetry.ts            # cost + cache-hit accounting + SessionSummary
├── tokenizer.ts            # DeepSeek V3 tokenizer (ported)
├── usage.ts                # ~/.reasonix/usage.jsonl roll-up
├── types.ts                # ChatMessage, ToolCall, ToolSpec
├── index.ts                # library barrel
└── cli/
    ├── index.ts            # commander entry
    ├── resolve.ts          # config + CLI flag precedence
    ├── commands/           # chat, code, run, stats, sessions, ...
    └── ui/
        ├── App.tsx                  # root Ink component (~1984 LOC, was 2931)
        ├── LiveRows.tsx             # spinner rows (OngoingTool / Status / ...)
        ├── EventLog.tsx             # Historical row rendering
        ├── StatsPanel.tsx           # top bar + cost badges
        ├── PromptInput.tsx          # cursor-aware multi-line input
        ├── PlanConfirm.tsx          # submit_plan review modal
        ├── ShellConfirm.tsx         # run_command approval modal
        ├── EditConfirm.tsx          # per-edit review modal
        ├── markdown.tsx             # Ink-native markdown renderer
        ├── edit-history.ts          # EditHistoryEntry + formatters
        ├── useEditHistory.ts        # /undo, /history, /show state machine
        ├── useCompletionPickers.ts  # slash, @, slash-arg pickers
        ├── useSessionInfo.ts        # balance + models + updates fetch
        ├── useSubagent.ts           # subagent sink wiring
        └── slash/                   # /-command implementation
            ├── types.ts             # SlashContext, SlashResult, ...
            ├── commands.ts          # SLASH_COMMANDS data + parse + suggest
            ├── helpers.ts           # git, memory, token formatters
            ├── dispatch.ts          # registry + handleSlash lookup
            └── handlers/            # per-topic: basic, mcp, memory,
                                     # skill, admin, observability, edits,
                                     # jobs, sessions, model (/pro lives here)
```

文件按设计保持精简：`cli/ui/` 下最大的模块是 2K 行（App.tsx），
`slash/handlers/` 下每个 handler ≤200 行，`cli/ui/` 下每个 hook ≤310 行。
新增一个 slash 命令意味着编辑一个 handler 文件和一行 registry。

## 设计演进

- **v0.0.x** —— 支柱 1 端到端，修复流水线完成，Ink TUI 脚手架。
- **v0.1** —— 发布 τ-bench 数据，流式润色，transcript replay。
- **v0.3** —— MCP client（stdio + SSE），会话持久化。
- **v0.4.x** —— 带 SEARCH/REPLACE 编辑的 `reasonix code`、review/auto
  gate、后台 job、hook。
- **v0.5.x** —— V4 模型支持、skill、memory、子 agent、可操作的错误消息。
- **v0.6** ——
  - **成本控制**（flash 优先默认、自动压缩、`/pro` 单次、失败触发的升级、
    成本药丸标）。
  - `deepseek-chat` / `deepseek-reasoner` 计划弃用 —— 所有面向用户的界面
    更新为 `v4-flash` / `v4-pro`。
  - 共享 prompt 片段（`TUI_FORMATTING_RULES`、`NEGATIVE_CLAIM_RULE`）。
  - UI 重构：App.tsx 拆分为 6 个 hook/组件，slash.ts 拆分为 13 个分主题
    模块。
- **v0.31** *(当前)* —— `branch` + `harvest` 功能被完全移除（并行采样
  选择器和支柱 2 的 plan-state 提取器）；二者都很少物有所值，且让 slash
  界面臃肿。

## 明确的非目标

- 把多 agent 编排作为一等概念（子 agent 是成本削减机制，而非协调原语）。
- RAG / 向量检索。
- 支持非 DeepSeek 后端（一个 OpenAI 兼容的 shim 今天可通过 `--model`
  覆盖工作，但未经测试）。
- Web UI / SaaS。
- 不带用户可见宣告的自动成本升级。每一次 pro 层模型调用都会被浮现；
  静默升级被考虑过并被否决。
