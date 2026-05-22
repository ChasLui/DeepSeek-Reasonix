# 为 Reasonix 做贡献

感谢你的关注。Reasonix 是一个小而有主见的代码库，主要由
[@esengine](https://github.com/esengine) 维护；欢迎提交 PR，
但请先阅读本文，以缩短来回沟通的成本。

## 环境搭建

```sh
git clone https://github.com/esengine/reasonix
cd reasonix
npm install
npm run dev          # tsx src/cli/index.ts — 实时运行源码
```

Node ≥ 22。开发期间无需全局安装。

技术栈、目录结构、脚本详见 [`REASONIX.md`](./REASONIX.md)。

## 提议变更

- **Bug 修复** — 直接开 PR，请附上复现步骤。
- **新功能 / 行为变更** — 先开 issue 对齐范围与方案。Reasonix
  力求保持精简；那些没有事先沟通、直接到来的"我们可以加 X"式 PR
  通常会被拒绝或缩减范围。
- **外部 MCP server、插件、预设** — 薄封装可以接受；庞杂的集成
  最好作为依赖 `reasonix` 的独立包来托管。

## 代码规范

这些规范由 review 强制执行，并尽可能由
`tests/comment-policy.test.ts` 保障 —— 该测试在 `npm run verify`
下运行，并作为 pre-push 的门禁。

### 注释 —— 默认不写

仅当**为什么**不显而易见、且删掉注释会让未来的读者困惑时才写注释。
合理的例子：

- 隐藏的约束（`// Yoga miscounts wrap → must clamp to width-1`）
- 针对特定 bug 的 workaround
- 类型系统无法表达的微妙不变量

不要写：

- **代码做了什么。** 命名已经说明了。不要在 `if (x > 0)` 上方写
  `// when x is positive`。
- **模块级长篇大论。** 文件顶部多段式的 docstring 是累赘。最多两行。
- **对话历史。** 不要写 "user reported X"、"screenshot showed Y"、
  "v0.13.2 introduced Z"。这些属于 commit / PR 文本。
- **分节横幅。** `// ─── helpers ───` 是噪声；按 export 分组即可。
- **重述参数文档。** 对于 `function pad(f, top, right, bottom, left)`，
  不要写 `@param top - top padding`。

如果注释确有必要，**一行几乎总是足够**。需要 4 行以上的注释通常意味着
代码本身需要先变得更清晰（重命名、抽取、简化），再考虑加注释。

### TypeScript

- Strict 模式。没有 `// biome-ignore` 和理由就不允许用 `any`。
- 优先用窄类型而非选项包；如果一个函数接收 5 个以上可选 flag，
  就拆分职责。
- 不要仅仅为了让两个文件共享类型而重新导出类型 —— 把类型移到
  拥有该概念的文件里。

### 优先用库，而非手写

如果某个问题有维护良好的 npm 库，就用它。本项目踩过的具体坑：

- 视觉宽度 / unicode 宽度 → `string-width`
- 字素分割 → `Intl.Segmenter`
- ANSI 剥离 → 用 `string-width` 自带的能力
- 颜色 → 用 `theme.ts` 常量，不要在组件代码里写裸 hex

如果某个库缺了某种 case，向上游提 issue 并加一层薄封装 ——
不要 fork 一份本地表。

### 文件

- 每个文件单一职责。当已有文件已经很大时，新代码放进新文件。
- 文件头注释：零行或一行。
- 不要写 `index.ts` 重新导出，除非它能切实缩小公开接口。
- 不要创建新的 `*.md` 文档文件，除非有明确要求。

### 错误 / 兜底

- 不要为"内部"错误加 try/catch。相信你自己的代码。
- 不要校验类型系统已经证明的东西。
- 边界代码（用户输入、网络、文件系统）需要校验；其余则信任。
- 不要用"优雅兜底"悄悄掩盖 bug。Log + crash 优于静默输出错误结果。

### 测试

- 测试那些靠读代码难以验证的东西：不变量、边界 case、回归。
- 不要测试类型签名或"函数返回 X"（类型系统会做这件事）。
- 不要为了刷覆盖率而写测试。

### Git / commit

- 祈使语气，加 scope 标签，说"为什么"而非"做了什么"。模式参见
  近期的 `git log`（`feat(ui): …`、`fix(loop): …`、`chore(release): …`）。
- 一个 commit 一个逻辑变更；重构与功能分开提交。
- 不要加 `Co-Authored-By: Claude` trailer。

## PR 要求

- 从 `main` 拉分支。一个 PR 一个逻辑变更。
- `npm run verify` 必须在本地通过（lint + typecheck + tests +
  comment-policy 门禁）。pre-push hook 会运行它；CI 在 Node 22 上运行。
- 不要动 `CHANGELOG.md` —— release notes 由维护者在发版时根据 commit
  历史撰写。在工作进行期间，PR 描述才是权威记录。

## 代码评审

Reasonix 偏好直接、快速的评审。请预期：

- 对那些解释*做了什么*而非*为什么*的注释，会有行级别的反驳。
- 对在出现两个真实调用点之前就引入的新抽象 / flag，会有反驳。
- 对那些维护良好的 npm 库已能解决、却手写实现的问题，会有反驳。

这些都不针对个人 —— 这是代码库保持精简的方式。

## 发版（维护者）

1. 升 `package.json` 版本号。
2. 在 `CHANGELOG.md` 加 `## [X.Y.Z] — <date>`，附上根据自上个 tag
   以来 `git log` 手写的摘要。
3. 提交 `chore(release): X.Y.Z — <one-line summary>`。
4. `git tag -a vX.Y.Z -m "..."`，推送 commit + tag。
5. 等 CI 变绿，然后 `npm publish`。

## 报告安全问题

详见 [`SECURITY.zh-CN.md`](./SECURITY.zh-CN.md)。简而言之：不要开公开 issue，
请私下邮件联系维护者。
