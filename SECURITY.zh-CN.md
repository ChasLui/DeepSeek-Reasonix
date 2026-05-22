# 安全策略

如果你在 Reasonix 中发现安全问题，请私下报告，而不要开公开 issue
或讨论帖。

## 如何报告

邮件至 <359807859@qq.com>，请包含：

- 对问题的清晰描述
- 复现步骤（最小复现即可）
- 你观察到该问题的版本（`reasonix --version`）和平台

你会在几天内收到确认，并在维护者能落地修复时尽快得到修复或缓解方案。
如果你希望在修复发布时的 release notes 中获得署名，请在报告中说明 ——
默认是静默打补丁。

## 支持的版本

只有 npm 上 `reasonix` 最新发布的 minor 版本会被积极维护。如果你用的是
更旧的版本，请先在最新版本上复现，再报告。

## 范围

**范围内：**

- 已发布的 `reasonix` npm 包及其 CLI / TUI
- `dashboard/` 下随附的 dashboard SPA，以及为其提供服务的本地 HTTP server
- `src/` 中的 shell 沙箱、edit gate 和工具分发器

**范围外：**

- 通过 `--mcp` 挂载的第三方 MCP server（请向那些项目报告）
- 用户自己的 DeepSeek API key、环境或 shell profile 的配置错误
- 上游 Node.js 或 DeepSeek API 本身的漏洞
- 通过故意超大的 prompt 或工具输入发起的拒绝服务（Reasonix 是单用户
  CLI；不存在需要防御的多租户边界）

## 加固提示

给运行 Reasonix 的用户的几条实用提醒：

- API key 存放在 `~/.reasonix/config.json`。请把该文件当作任何其他凭据
  存储一样对待。
- `run_command` 和 `!` shell 快捷方式遵循权限允许列表；安全默认值是对任何
  未预先批准的操作执行 `ask`。不要在保存着你担心泄露的机密的机器上设置
  `editMode: yolo`。
- Hook（`PreToolUse` 等）会执行用户配置的任意 shell 脚本。在你并非作者的
  目录中运行 Reasonix 之前，请审计 `.reasonix/settings.json`。
