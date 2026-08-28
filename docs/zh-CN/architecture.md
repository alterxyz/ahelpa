# 架构

[English](../architecture.md) | [简体中文](architecture.md)

ahelpa 是一个本地 helper runtime。它由少数可靠原语组成：tmux 负责持久终端，SQLite 负责 session 状态，命名管道负责零轮询阻塞，文件负责任务和结果交接，driver adapter 负责不同 agent CLI 的交互差异。

## 系统概览

```text
host agent
  │
  │ ahelpa launch claude-code --task "..."
  ▼
ahelpa CLI ──────────► tmux session
  │                       │
  │                       ▼
  │                   helper agent
  │                       │
  │                       ├── 读取任务文件
  │                       ├── 在项目目录中工作
  │                       ├── 写入 .ahelpa/<id>/summary.md
  │                       └── 打印 [AHELPA:DONE]
  │
  ├── SQLite: session 记录（id、status、token、lineage）
  ├── /tmp/ahelpa/<id>.pipe: wait 唤醒 FIFO
  ├── /tmp/ahelpa/ahelpa-task-<id>.md: 任务文件
  └── daemon: 监控 session、检测暗号、settle 状态
```

## Session 生命周期

session 通常从 `running` 开始；需要 host 输入时会进入 `needs_attention`；完成后经过 `draining`，最终成为 `dead`。`idle` 和 `error` 是 settlement 结果；成功 session 正在 draining 时，`wait` 会把它报告为 `idle`。

1. **Launch**：`launch` 生成 session ID（`{driver-prefix}-{uuid12}`）和 owner token，先取得新的 tmux session，再准备文件交接，并通过所选 driver 提交、确认第一轮任务。只有这些步骤成功后，才在 SQLite 记录 session、准备 FIFO，并在需要时启动 daemon。
2. **任务投递**：driver 的 `prepareForTask` 处理 agent-specific 启动流程，例如 ready 检查和 trust prompt。随后通过 `tmux send-keys` 发送任务指令，告诉 helper 读取哪个任务文件、把结果写到哪里。
3. **提交后准备**：driver 的 `afterTaskSubmitted` hook 处理第一条消息后的 agent-specific 确认。Kimi 只有在收到该消息后才会创建原生 `session_*` ID，因此 launch 流程会在这里捕获 resume token。
4. **执行**：helper 读取任务文件，在目标项目目录工作，把结果写到 `.ahelpa/<session-id>/summary.md`，支撑文件放到 `artifacts/`，完成后打印暗号。
5. **Settlement**：daemon 或 inline refresh 捕获 tmux 输出，通过 driver 检测暗号，并转换 session 状态。settlement 是一次性动作：更新 SQLite、保存 archive snapshot、通知 FIFO、清理 pipe。
6. **Wakeup**：`wait` 收到 FIFO 事件后返回，调用者从文件交接目录读取结果。

### 状态转换

```text
launch ──► running
              │
              ├── 检测到 [AHELPA:DONE] ──────► idle ─► draining ─► dead
              ├── 检测到 [AHELPA:NEED_HELP] ──► error
              ├── 持续未知 idle ──────────────► needs_attention ── send/task ─► running
              └── tmux session 消失 ─────────► dead

dead + 原生 resume token ── resume ─► needs_attention ── send/task ─► running
```

`still_running` 是 `wait` 的返回值，不是 session 状态。它表示等待超时前 session 还没有 settle。

## 文件交接

终端 capture 只用于调试；可靠协议是文件：

| 方向 | 机制 |
| --- | --- |
| Host → helper | `/tmp/ahelpa/ahelpa-task-<id>.md` 任务文件 |
| Helper → host | `<project>/.ahelpa/<id>/summary.md` 和 `artifacts/` |
| 完成信号 | stdout 中的暗号行：`[AHELPA:DONE]` 或 `[AHELPA:NEED_HELP]` |

发送给 helper 的任务指令包含读取任务和写入结果的精确路径。该指令由 `src/file-handoff.ts` 生成，并在所有 driver 间保持一致。

## 唤醒协议

`wait` 阻塞在命名管道（FIFO）上，而不是轮询 SQLite。

1. `launch` 创建 `/tmp/ahelpa/<id>.pipe`。
2. session settle 时，daemon 写入 JSON 事件（`{sessionId, status}`）。
3. `wait` 读取 pipe 并返回。
4. 通知后 pipe 被清理。

如果没有 reader，写入会被丢弃；SQLite 记录仍是事实来源。如果 session 已经 settle 后再调用 `wait`，它会直接从 SQLite 读到终态并立即返回。

## Daemon

daemon 是可选后台进程，用于监控运行中的 session。它会在 `launch` 时自动启动，并在没有 active session 后退出。

**每 3 秒的 poll loop：**

1. 遍历每个 `running` session，检查对应 tmux session 是否还活着。
2. 如果 tmux session 消失，settle 为 `dead`。
3. 如果还活着，capture 输出并运行 driver 暗号检测。
4. 如果检测到暗号，settle 为 `idle` 或 `error`。
5. 如果没有 active session，daemon 退出。

**Inline refresh**：daemon 未运行时，`wait`、`check`、`status` 会在返回前执行同样的刷新逻辑。短任务不依赖常驻 daemon。

## Drivers

Driver 封装不同 agent CLI 的终端交互差异，使 launch orchestration 保持通用。

| 职责 | 示例 |
| --- | --- |
| Session prefix | `claude`、`codex`、`kimi` |
| Launch command | `claude --dangerously-skip-permissions --verbose`、`codex --dangerously-bypass-approvals-and-sandbox`、`KIMI_CODE_NO_AUTO_UPDATE=1 kimi --yolo` |
| 任务前准备 | 等待 CLI ready，处理 trust prompt |
| 提交后处理 | 必要时补 Enter；捕获新创建的原生 session ID |
| 状态检测 | 委托 `src/drivers/sentinels.ts` 的暗号匹配 |

当前支持 `claude-code`、`codex` 和 `kimi`。三者共享暗号协议和文件交接路径，只在启动命令和交互细节上不同。Kimi 首次在某个目录启动时，其 driver 会自动选择 **Trust this folder**。Kimi 会持久保存该信任，随后可能启动目录中的项目 MCP server。Kimi 初始界面没有原生 session ID；第一条任务消息创建 `session_*` ID 后，ahelpa 才会记录它，并通过 `kimi --session <id>` 恢复。

`launch --safe` 会把 safe-mode hint 传给选定 driver，并把它写入 session 状态。原生 resume 会继承该姿态；`resume --safe` 可以升级默认姿态记录，但省略参数不会把 safe 记录降级。Claude Code 会省略 `--dangerously-skip-permissions`；Codex 会使用 `-s workspace-write -a never`，而不是 `--dangerously-bypass-approvals-and-sandbox`；Kimi 会省略 `--yolo`，从而恢复自身原生审批流程。Kimi 在 safe mode 下仍会自动信任项目目录，因此它的 safe mode 不是 sandbox。

Kimi 会设置 canonical `KIMI_CODE_NO_AUTO_UPDATE=1`，避免 CLI 自更新中断持久 tmux session。它默认不带模型参数启动，使用其 `config.toml` 中的默认模型。launch 时传入的 `--model` 必须与该文件中已配置的完整 alias 精确匹配；如果存在，resume 会沿用它。Kimi 不支持 `--effort`，也不支持运行中的 `ahelpa model` 切换。

Kimi 打印 `[AHELPA:DONE]` 后，旧 helper 仍在 draining 时 `resume` 会被拒绝。host 可以等待 daemon 回收并让 `check` 显示 `dead`，也可以显式 `kill` 后再恢复。带 `agentResumeId` 的 dead 记录会保留到 `clean`；没有 token 的记录可以自动回收。`clean` 会删除 dead 记录及其 resume 元数据，但不会终止 live 或 draining session。持久性指通过原生 Kimi session 在新 tmux session 中重新连接，而不是无限保留原 tmux process。

## Nesting

Helper 可以继续启动自己的 helper，形成 session lineage。`launch` 会校验最大深度，默认 4，可通过 `AHELPA_MAX_NESTING_DEPTH` 配置。每个 child session 会记录 parent ID，但 owner 权限不传递：host 只能控制自己直接启动的 session。

## Archives

Session settle 时，最终快照会保存到 `~/.ahelpa/archive/<session-id>/`。这样 tmux session 清理后，`logs` 仍能读取输出。Archive 由 daemon 或 inline refresh 在 settlement 中写入，不会自动裁剪。

## 模块地图

| 模块 | 职责 |
| --- | --- |
| `cli.ts` | 进程入口：打开 DB、调用 `runCli`、返回 exit code |
| `command-contract.ts` | 命令注册：usage、flag schema、handler、dispatch |
| `commands/launch.ts` | Launch orchestration：plan + execute |
| `commands/wait.ts` | Wait orchestration：FIFO block、timeout、multi-session |
| `commands/session-ops.ts` | 已有 session 的操作 |
| `daemon.ts` | 后台 monitor：poll loop、inline refresh、进程管理 |
| `settle.ts` | 原子 settlement：更新 DB、archive、notify、cleanup |
| `session-lifecycle.ts` | 状态 enum 和 capture-to-status 映射 |
| `session-access.ts` | Owner token 校验和 session lookup |
| `file-handoff.ts` | 任务/结果路径规划和 helper 指令生成 |
| `wakeup.ts` | FIFO 唤醒协议 |
| `fifo.ts` | 命名管道原语 |
| `nesting.ts` | Lineage 和 depth 校验 |
| `runtime-layout.ts` | 文件系统路径约定 |
| `tmux.ts` | tmux 命令封装 |
| `archive.ts` | Archive 读写 |
| `drivers/sentinels.ts` | 暗号字符串和匹配规则 |
| `drivers/types.ts` | `AgentDriver` 接口 |
| `drivers/registry.ts` | 按 agent type 查找 driver |
| `drivers/claude-code.ts` | Claude Code driver |
| `drivers/codex.ts` | Codex driver |
| `drivers/kimi.ts` | Kimi Code driver |
