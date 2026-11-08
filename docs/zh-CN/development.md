# 开发指南

[English](../development.md) | [简体中文](development.md)

## 要求

- **macOS 或 Linux**（x64 和 arm64）
- **Bun 1.4.2**（runtime、SQLite、test runner、binary compiler；`packageManager` 与 CI 固定此版本，`bun-types` 同步）
- **tmux**（helper session 管理）

`jq` 对 shell 示例有用，但 runtime 本身不依赖它。

安装 skill 还需要 Node.js >=22.20.0 和可正常运行的 `npx`，与 [skills CLI 的要求](https://github.com/vercel-labs/skills/blob/v1.7.0/package.json) 一致。两个安装入口都会检查这些条件；公开安装脚本会在下载或替换 runtime 前完成检查。编译后的 ahelpa runtime 不依赖 Node.js。

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

例外：`docs/backends/*.md` 里的候选卡只有英文。它们是带日期、面向 agent 的第三方产品证据，不是面向用户的文档，翻译只会产生漂移。`docs/backends.md` 本身仍然保持双语。

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

公开安装脚本把 `latest` 解析为具体 tag，从同一 release 下载平台归档和 `SHASUMS256.txt`。替换前会校验 SHA-256，确认归档中只有普通文件 `ahelpa`，并验证可执行文件的版本与 tag 一致。替换在目标目录内原子完成；旧二进制保留为 `ahelpa.backup.*`。runtime 与 skill 固定到同一 tag。skill 安装随后执行；该步骤失败时，新 runtime 和旧二进制备份仍会保留。

安装参数：

| 环境变量 | 用途 |
| --- | --- |
| `AHELPA_VERSION` | 指定 release tag；默认 `latest` 只解析一次 |
| `AHELPA_BIN_DIR` | runtime 安装目录 |
| `AHELPA_REPO` | release 与 skill 来源，格式为 `owner/repository` |
| `AHELPA_ARCHIVE_URL` | 自定义归档 URL，必须同时指定下列一种校验参数 |
| `AHELPA_SHA256` | 可信的归档 SHA-256 摘要 |
| `AHELPA_CHECKSUM_URL` | 包含对应平台归档条目的替代校验清单 |

两种校验参数只能选一种。缺少清单的旧 release 必须显式提供可信摘要或替代清单，不会默默跳过校验。自定义归档版本必须与 `AHELPA_VERSION` 一致，该版本同时决定 skill 来源。

### Release 工作流

Tag 工作流使用 macOS 与 Linux 的两种架构原生 runner，检查类型与安装 fixture，并对编译后及解包后的二进制做冒烟验证。publish job 等四个平台全部完成后生成校验清单，再创建或继续 draft GitHub Release。release 在资产上传完成前保持 draft；已发布版本不允许通过重跑工作流覆盖，应使用新版本 tag。tag 必须匹配 `package.json`。

构建使用固定的 Bun 1.4.2。Checkout v5、upload-artifact v6 和 download-artifact v7 声明使用 Node 24，以适配 [GitHub Actions 停用 Node 20](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/) 后的环境。

macOS 矩阵使用 `macos-15` 与 `macos-15-intel`：[macOS 13 已退役](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/)，[macOS 14 将于 2026-11-02 退役](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/)。面向旧版用户分发新安装脚本前，应先发布带校验清单的 release。

## 测试

普通代码改动：

```bash
bun test
```

Bun test preload 会在调用方没有显式设置时分配临时 `AHELPA_HOME` 和 `AHELPA_TMP_DIR`，并在测试结束后删除这些目录。因此 unit/integration test 不会把 session 状态、archive、FIFO 或任务文件写进用户正在使用的 ahelpa runtime。

## Closure gate

影响已安装 runtime 行为的改动，需要跑端到端 gate。它先运行测试、类型检查和构建，再用编译后的 `dist/ahelpa` 验证选中的 driver。场景依次为 Claude 默认 advisor、Claude 显式 worker、Codex 默认 worker。Kimi 真机场景走计费 provider，只在设置 `AHELPA_GATE_KIMI=1` 时运行；前三项同时校验 launch 返回和 check 保存的准确角色/模型/effort，使用各自独立的结果标记与证据目录。Codex 和 Kimi 使用稳定的 `tests/fixtures/closure` 工作区，Claude Code 使用仓库根目录；任务只允许访问指定任务文件和结果目录。

脚本为 gate 单独设置 `AHELPA_HOME` 和 `AHELPA_TMP_DIR`，因此它的 SQLite 状态、daemon、archive、FIFO 和任务文件不会干扰用户正在运行的 ahelpa session。helper CLI 仍使用正常的 OS home 和既有认证状态。

```bash
bun run closure:gate
```

每个 driver 必须满足：

- `launch` 启动 session 并返回有效 JSON
- `wait` 报告成功完成，且 `check` 确认该状态
- helper 在指定的 `summary.md` 第一行写入要求的精确标记（结果合同要求的其他内容可以写在下面）
- `kill` 回收 tmux session，且 `check` 确认 session 已不再活跃

超时、任务文本回显和账号错误都会使 gate 失败。日志仅用于诊断，daemon 已回收 tmux 时也可以读取。检查失败时仍会尝试终止本轮启动的 helper，不处理其他 session。输出中的 evidence 目录保留 summary 和命令结果。 gate 先将自己的结果目录复制到 evidence，再移除自己在 fixture 中创建的交接文件，最后只停止本轮隔离的 daemon。

Kimi（`AHELPA_GATE_KIMI=1`）还会在 `kill` 和 `resume` 后完成第二个任务。gate 要求保留原生 session ID、恢复后的 helper 处于等待新任务的 `needs_attention` 状态，并在新 summary 中准确写出第一轮记住的上下文标记。

验证已安装 binary 时，可指定可执行文件的绝对路径，使用同一套检查：

```bash
AHELPA_GATE_CLI="$HOME/.ahelpa/bin/ahelpa" bun run closure:gate
```

**前置条件**：本轮选中的 helper CLI 需要先在本机完成登录。如果 helper CLI 在认证阶段失败，先修复该 CLI 的登录状态，再把 gate 结果当真。

`deepseek-pi` 的真机 gate 通过 `AHELPA_GATE_PI=1` 启用，需要 Node.js、Pi ≥ 1.4.0（TUI 在 1.5.0 上测试）及已在 CC-Switch 中配置并同步到 Pi 的 DeepSeek API。默认使用 `cc-switch-deep-seek/deepseek-flash`／`high`；可通过 `AHELPA_GATE_PI_MODEL=provider/id` 和 `AHELPA_GATE_PI_EFFORT=<level>` 覆盖。gate 在 TUI 运行时记录 pane 的进程树，等 daemon 在 draining 期间从退出画面读到原生恢复 ID，接着 resume 并检查第二个回合记得上下文，再 resume 一次运行 `sleep 120`、在回合中途 kill，确认记录下的进程（包括工具）一个不剩。原生会话 ID 在多次 resume 之间必须不变。Pi 原生会话保存在其按 cwd 编码的目录中，不属于 gate 的 ahelpa 临时状态。

`gemini` 的真机 gate 通过 `AHELPA_GATE_AGY=1` 启用，需要 agy ≥ 1.5.2（TUI 在 1.5.3 上测试），并已在 `agy` 里登录过一次。它使用默认的 `gemini-4-argon`／`medium`，检查 launch／check 记录的设置。gate 在 TUI 运行时记录 pane 的进程树，等 daemon 在 draining 期间从退出画面读到原生恢复 ID，接着 resume 并检查第二个回合记得上下文，再 resume 一次运行 `sleep 120`、在回合中途 kill，确认记录下的进程（包括工具）一个不剩。conversation ID 在多次 resume 之间必须不变。gate 产生的对话会留在 agy 自己的历史记录里。

`mistral` 的真机 gate 通过 `AHELPA_GATE_VIBE=1` 启用，需要 vibe ≥ 3.1.0 及已有登录，使用 `mistral-large-4-0-3`／`high`。gate 在 TUI 运行时记录 pane 的进程树，等 daemon 在 draining 期间从退出画面读到原生恢复 ID，接着 resume 并检查第二个回合记得上下文，再 resume 一次运行 `sleep 120`、在回合中途 kill，确认记录下的进程（包括工具）一个不剩。Vibe 的 8 位十六进制会话 ID 在多次 resume 之间必须不变。`AHELPA_GATE_DEEPSEEK=1` 以 `deepseek` 类型运行同一 Vibe 场景，默认 `deepseek-v4-1-flash-1017`／`high`，需要 Mistral 订阅包含该模型。Vibe 自己保存原生会话历史。

## 添加 driver

请先读 [Helper 后端](backends.md)。它回答一个候选到底该不该做成 driver（分类和准入漏斗）、helper 怎么接（只有一种：在 tmux 里跑它自己的 TUI）以及为什么、spike 清单，以及已评估候选的登记表。无论接不接，结论都要记进登记表。driver 是最后一步，不是第一步。

Driver 位于 `src/drivers/`。driver 要实现 `src/drivers/types.ts` 中的 `AgentDriver` 接口，共 23 个成员。

**必选（11 个）：**

- 身份与目录：`name`、`sessionPrefix`（session ID 前缀）、`modelCatalog`。
- 启动：`buildLaunchCommand`。
- 启动与投递：`prepareForTask`（就绪检测、信任提示、更新对话框）和 `afterTaskSubmitted`（确认新一回合确实开始）。
- 状态：`detectStatus`、`detectOutcome`（状态，加可选的 NEED_HELP 标签和 `reason`）、`detectActivity`（`working`、`booting` 或 `idle`）。暗号匹配在 `sentinels.ts`。
- 控制：`switchModel`（不支持运行时切换就抛错）和 `gracefulExit`。

**可选（12 个）：**

- `turnHooks` 和 `prepareLaunchFiles`：启动前写进结果目录的会话级 hook 或设置文件。driver 驱动的是厂商自己的 TUI，不加桥接程序（[原因](backends.md#怎么接)）。
- `launchProfiles`：角色 → model/effort 预设。
- `checkReadiness`：`doctor` 在不运行 CLI 的情况下报告什么。
- `interrupt`：`{ key, stopped }`，只停一个回合、保留会话的 tmux 按键，以及停下后 TUI 打印的那行提示，两者都须在真实 TUI 上核实。没有它，`interrupt` 会拒绝。
- `acceptsInput`、`acceptsInputAfterTurn`、`workingAfterTurn`：比默认实现更严格的「敲进去的字会不会进输入框」和「这一回合是否仍在运行」判断。
- 原生恢复，四个要么全写、要么全不写：`buildResumeCommand`、`extractResumeToken`、`prepareForResume`，以及 `resumeTokenAvailableAfterSubmit`（原生恢复 id 是在首次提交后立即可读，还是只出现在退出画面上）。helper 就是它的 ahelpa ID；不写这四个，`resume` 会拒绝（[原因](backends.md#怎么接)）。

在 `src/drivers/registry.ts` 中注册 driver。还有好几处会枚举 driver；`grep -rn "\bpi\b" src scripts skill docs` 是找到它们的快捷办法。至少包括：`src/disk-usage.ts`（session ID 前缀的匹配模式和会话专属文件名）、`scripts/closure-gate.sh` 里的 closure gate 场景及其 `AHELPA_GATE_<NAME>` 开关、`skill/SKILL.md` 的前置条件、配置说明页 `skill/references/<name>.md` 与 `skill/references/profiles.md`，以及 README 的支持 helper 表。还要加 `tests/<name>-driver.test.ts`，用合成的 pane 抓屏做测试。

Codex 终止回合的模型错误由 `detectOutcome` 检测，可返回 `needs_attention` 和可选的 `reason`（`model_capacity` 或 `usage_limit`）。只有错误后的工作证据才抑制该结果，并且错误后必须出现空闲输入框。准确短语必须紧随第零列的 `■`（仅 Codex 0.154 容量短语也支持 `⚠`）；`Tmux.capture` 保留行首空白。监控器需在同一 session version 下连续两次确认 driver 的相同 attention 原因，其他结果或 version 变化会重新计数。保留暗号优先级与不支持模型的原有错误行为。结算时将原因保存到已有归档，`check`、`status` 和 `wait` 仅展示当前已结算回合的原因。仅 `needs_attention` 且原因为 `model_capacity` 或 `usage_limit` 时，`wait` 才返回退出码 1；旧 attention 原因及没有原因的结果仍返回 0。合成终端及结果传递回归测试位于 `tests/codex-capacity.test.ts`。

## 不要提交什么

- 本地 runtime 输出（`~/.ahelpa/`）
- 生成物（`dist/`、`skill/bundle/`）
- 环境文件（`.env`、credentials）
- 本地数据库和日志
- 项目内 session artifacts（`.ahelpa/`）
