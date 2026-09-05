# 开发指南

[English](../development.md) | [简体中文](development.md)

## 要求

- **macOS 或 Linux**（x64 和 arm64）
- **Bun**（runtime、SQLite、test runner、binary compiler）
- **tmux**（helper session 管理）

`jq` 对 shell 示例有用，但 runtime 本身不依赖它。

端到端 gate 还要求对应 driver 的 helper CLI 已完成认证。可用 `command -v claude`、`command -v codex` 和 `command -v kimi` 检查二进制；认证状态则应通过各 CLI 自己的状态命令或一次无害请求确认。

## 仓库布局

```text
src/
  cli.ts                   # 进程入口
  command-contract.ts      # 命令注册与 dispatch
  commands/                # launch、wait、session-ops
  drivers/                 # agent-specific adapters
  *.ts                     # 核心模块（state、daemon、wakeup 等）
tests/                     # Bun 测试
scripts/
  install.sh               # 公开安装脚本：release binary + global skills
  deploy-local.sh          # 安装本地 binary + 全局 hard-copy skills
  closure-gate.sh          # 端到端验证 gate
  package-skill.ts         # Skill packaging（docs + runtime bundle）
  skill-package.ts         # Packaging helpers
skill/
  SKILL.md                 # Agent-facing skill 文档
  references/              # 平台专属说明
  bundle/                  # 生成的 runtime tarball（git-ignored）
docs/                      # 公开文档
dist/                      # 构建输出（git-ignored）
```

## 文档 i18n

英文是默认公开文档语言。简体中文翻译放在对应位置：

- `README.md` 和 `README.zh-CN.md`
- `docs/*.md` 和 `docs/zh-CN/*.md`

修改面向用户的文档时，请在同一个改动里同步两种语言；如果某次改动只适用于一种语言，请明确说明。

## 源码 vs 已安装 runtime

这个仓库是源码树。已安装 runtime 是由源码编译出的二进制。

| | 源码树 | 已安装 runtime |
| --- | --- | --- |
| 位置 | 当前 git repo | `~/.ahelpa/bin/ahelpa` |
| 修改 | `src/`、`skill/`、`tests/`、`docs/` | 不要直接 patch |
| 运行 | `bun run src/cli.ts <cmd>` | `ahelpa <cmd>` |
| 测试 | `bun test` | `bun run closure:gate` |

`bun run src/cli.ts` 适合开发中快速验证，但不能替代部署后的真实 binary 测试。

## 常用命令

```bash
bun test                       # 跑测试
bun run typecheck              # tsc --noEmit 覆盖 src/ 和 tests/
bun run build                  # 编译到 dist/ahelpa
bun run package:skill          # 构建带 runtime bundle 的 skill package
bash scripts/deploy-local.sh   # 部署 runtime + 全局 hard-copy skills
ahelpa install-skill           # 从公开 repo 刷新 global skill
bun run closure:gate           # 端到端 closure gate
```

## Build 和 package

仓库不跟踪编译后的 binary bundle。构建 binary：

```bash
bun run build
```

这会把 `src/cli.ts` 编译成 `dist/ahelpa`。

构建完整 skill package：

```bash
bun run package:skill
```

输出：

- `dist/ahelpa` — 编译后的 binary
- `skill/bundle/ahelpa-<platform>.tar.gz` — skill distribution 用 runtime tarball（platform 如 `darwin-arm64`、`linux-x64`）
- `dist/ahelpa.skill` — 打包后的 skill

这些都是 git-ignored 生成物。

## 部署

本地安装编译后的 binary，并刷新全局 skills：

```bash
bash scripts/deploy-local.sh
```

脚本会复制 binary 到 `~/.ahelpa/bin/ahelpa`，然后运行：

```bash
ahelpa install-skill --source ./skill
```

`install-skill` 会把安装交给 `npx skills@latest`，不重新实现 agent skill 安装逻辑。策略固定为：全局作用域、hard-copy 模式、显式安装 `codex` + `claude-code` + `kimi-code-cli`。请确保 `~/.ahelpa/bin` 在 `PATH` 中。

公开安装使用 release installer：

```bash
curl -fsSL https://raw.githubusercontent.com/alterxyz/ahelpa/main/scripts/install.sh | bash
```

公开安装脚本会按当前 OS/arch 从 GitHub Releases 下载对应 tarball（如 `ahelpa-darwin-arm64.tar.gz`），然后调用 `ahelpa install-skill`。

## 测试

普通代码改动：

```bash
bun test
```

Bun test preload 会在调用方没有显式设置时分配临时 `AHELPA_HOME` 和 `AHELPA_TMP_DIR`，并在测试结束后删除这些目录。因此 unit/integration test 不会把 session 状态、archive、FIFO 或任务文件写进用户正在使用的 ahelpa runtime。

## Closure gate

影响已安装 runtime 行为的改动，需要跑端到端 gate。它先运行测试、类型检查和构建，再用编译后的 `dist/ahelpa` 验证三个 supported driver。Codex 和 Kimi 使用稳定的 `tests/fixtures/closure` 工作区，Claude Code 使用仓库根目录；任务只允许访问指定任务文件和结果目录。

脚本为 gate 单独设置 `AHELPA_HOME` 和 `AHELPA_TMP_DIR`，因此它的 SQLite 状态、daemon、archive、FIFO 和任务文件不会干扰用户正在运行的 ahelpa session。helper CLI 仍使用正常的 OS home 和既有认证状态。

```bash
bun run closure:gate
```

每个 driver 必须满足：

- `launch` 启动 session 并返回有效 JSON
- `wait` 报告成功完成，且 `check` 确认该状态
- helper 将要求的精确内容写入指定的 `summary.md`
- `kill` 回收 tmux session，且 `check` 确认 session 已不再活跃

超时、任务文本回显和账号错误都会使 gate 失败。日志仅用于诊断，daemon 已回收 tmux 时也可以读取。检查失败时仍会尝试终止本轮启动的 helper，不处理其他 session。输出中的 evidence 目录保留 summary 和命令结果。 gate 先将自己的结果目录复制到 evidence，再移除自己在 fixture 中创建的交接文件，最后只停止本轮隔离的 daemon。

Kimi 还会在 `kill` 和 `resume` 后完成第二个任务。gate 要求保留原生 session ID、恢复后的 helper 处于等待新任务的 `needs_attention` 状态，并在新 summary 中准确写出第一轮记住的上下文标记。

验证已安装 binary 时，可指定可执行文件的绝对路径，使用同一套检查：

```bash
AHELPA_GATE_CLI="$HOME/.ahelpa/bin/ahelpa" bun run closure:gate
```

**前置条件**：`claude`、`codex` 和 `kimi` 三个 helper CLI 都需要在本机完成登录。如果 helper CLI 在认证阶段失败，先修复该 CLI 的登录状态，再把 gate 结果当真。

## 添加 driver

Driver 位于 `src/drivers/`。新 driver 需要实现 `src/drivers/types.ts` 中的 `AgentDriver` 接口：

- `name` 和 `sessionPrefix` — 身份
- `buildLaunchCommand` — 启动 agent CLI 的 shell command
- `prepareForTask` — 任务投递前处理启动 prompt
- `afterTaskSubmitted` — 任务提交后的确认或 nudge
- `detectStatus` — 基于暗号检测状态，通常委托 `sentinels.ts`

最后在 `src/drivers/registry.ts` 中注册。

## 不要提交什么

- 本地 runtime 输出（`~/.ahelpa/`）
- 生成物（`dist/`、`skill/bundle/`）
- 环境文件（`.env`、credentials）
- 本地数据库和日志
- 项目内 session artifacts（`.ahelpa/`）
