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

一个 session 会从 `running` 进入 `idle`、`error` 或 `dead`。

1. **Launch**：`launch` 生成 session ID（`{driver-prefix}-{uuid8}`）和 owner token，写入任务文件，通过选定 driver 创建 tmux session，准备 FIFO，在 SQLite 记录 session，并在需要时启动 daemon。
2. **任务投递**：driver 的 `prepareForTask` 处理 agent-specific 启动流程，例如 ready 检查和 trust prompt。随后通过 `tmux send-keys` 发送任务指令，告诉 helper 读取哪个任务文件、把结果写到哪里。
3. **执行**：helper 读取任务文件，在目标项目目录工作，把结果写到 `.ahelpa/<session-id>/summary.md`，支撑文件放到 `artifacts/`，完成后打印暗号。
4. **Settlement**：daemon 或 inline refresh 捕获 tmux 输出，通过 driver 检测暗号，并转换 session 状态。settlement 是一次性动作：更新 SQLite、保存 archive snapshot、通知 FIFO、可选发送外部终态通知、清理 pipe。
5. **Wakeup**：`wait` 收到 FIFO 事件后返回，调用者从文件交接目录读取结果。

### 状态转换

```text
launch ──► running
              │
              ├── 检测到 [AHELPA:DONE] ──────► idle
              ├── 检测到 [AHELPA:NEED_HELP] ──► error
              └── tmux session 消失 ─────────► dead
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
| Session prefix | `claude`、`codex` |
| Launch command | `claude --dangerously-skip-permissions --verbose`、`codex --dangerously-bypass-approvals-and-sandbox` |
| 任务前准备 | 等待 CLI ready，处理 trust prompt |
| 提交后 nudge | 如果输入排队但没提交，补 Enter |
| 状态检测 | 委托 `src/drivers/sentinels.ts` 的暗号匹配 |

当前支持 `claude-code` 和 `codex`。二者共享暗号协议和文件交接路径，只在启动命令和交互细节上不同。

`launch --safe` 会把 safe-mode hint 传给选定 driver。Claude Code 会省略 `--dangerously-skip-permissions`；Codex 会使用 `-s workspace-write -a never`，而不是 `--dangerously-bypass-approvals-and-sandbox`。

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
