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

SQLite 建表和 schema 迁移在同一个 immediate transaction 内执行。CLI 或 daemon 并发启动时，会等待该事务并重新读取已提交的 schema，避免升级旧 runtime 时重复添加列。

一个 session 从 `running` 开始，可以结算为 `idle`、`error`、`needs_attention` 或 `dead`。成功完成后，在回收终端期间会经过 `draining` 状态。

1. **Launch**：`launch` 生成 session ID（`{driver-prefix}-{uuid12}`）和 owner token。在 SQLite immediate transaction 中检查调用方和嵌套限制，并预留 session，记录 parent、job、适用时的 resume 关联，以及启动进程标记。之后才创建 worktree、tmux session 或交接文件，通过所选 driver 提交第一轮任务。因此 helper 读取任务前已能找到自身记录。任务准备和 FIFO 创建完成后，launch 清除标记，并在需要时启动 daemon。投递已可见、但尚未确认新回合时，会返回 warning，并把 helper 保留为 `needs_attention`。启动失败会回滚预留记录、tmux session、FIFO、交接文件及本次创建的 worktree。Resume 同样在外部副作用前执行这条检查并预留的路径。
2. **任务投递**：driver 的 `prepareForTask` 处理 agent-specific 启动流程，例如 ready 检查和 trust prompt。随后通过 `tmux send-keys` 发送任务指令，告诉 helper 读取哪个任务文件、把结果写到哪里。
3. **提交后准备**：driver 的 `afterTaskSubmitted` hook 处理第一条消息后的 agent-specific 确认。Kimi 只有在收到该消息后才会创建原生 `session_*` ID，因此 launch 流程会在这里捕获 resume token。
4. **执行**：helper 读取任务文件，在目标项目目录工作，把结果写到 `.ahelpa/<session-id>/summary.md`，支撑文件放到 `artifacts/`，完成后打印暗号。
5. **Settlement**：daemon 或 inline refresh 捕获 tmux 输出，通过 driver 检测暗号，并转换 session 状态。settlement 是一次性动作：更新 SQLite、保存 archive snapshot、通知 FIFO、清理 pipe。
6. **Wakeup**：`wait` 收到 FIFO 事件后返回，调用者从文件交接目录读取结果。
7. **运行时清理**：成功完成后，driver 请求正常退出，daemon 在 `draining` 期间记录 resume token，最多等待 15 秒后回收 tmux session，再将状态恢复为 `idle`。`wait` 在 draining 期间也返回 `idle`。清理只移除临时运行文件，SQLite 中的结果、owner token 和 resume 元数据仍保留，因此之后的 `wait`、`logs`、`resume` 仍可用。显式运行 `clean` 才会删除 tmux 已消失的结算记录；draining 和 attention 状态不在清理范围内。显式 `kill` 后记录保持为 `dead`；已经开始的刷新不会在 capture 或终端清理结束后覆盖该状态。

### 状态转换

```text
launch ──► running
              │
              ├── 检测到 [AHELPA:DONE] ──────► draining ──► idle
              ├── 检测到 [AHELPA:NEED_HELP] ──► error
              ├── 持续无活动 ────────────────► needs_attention
              └── tmux session 消失 ─────────► dead

idle/dead + 原生 resume token ── resume ─► needs_attention ── send/task ─► running
```

向 `needs_attention` session 发送输入后，driver 确认新用户回合已开始，才会恢复为 `running` 并继续监控。该转换有状态条件：即使输入投递已开始，并发执行的 `kill` 仍然优先，不会被重新标为运行中。如果终端消失，则转为 `dead`。

预留记录从 `running` 开始，在 launch 或 resume 准备期间带有启动进程标记。该进程仍存活时，daemon 和 inline refresh 会跳过它，避免因 tmux 尚未创建或旧暗号而提前结算。启动进程退出却未清除标记时，refresh 会清除失效标记并恢复正常状态核对。`wait` 把准备阶段视为待完成，FIFO 尚未创建时也遵守原有 deadline。

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

重复准备已有 FIFO 时会复用原 inode，保持等待中的 reader 连通；并发准备共用同一管道。该路径若是普通文件或符号链接，则拒绝使用并保留原文件。

## Daemon

daemon 是可选后台进程，用于监控运行中的 session。它会在 `launch` 时自动启动，并在没有 active session 后退出。

**每 3 秒的 poll loop：**

1. 检查被监控的 tmux session 是否仍存活。
2. running 或 attention session 消失时结算为 `dead`；draining session 消失时保留成功结果，恢复为 `idle`。
3. 对 running session 捕获输出，运行 driver 暗号和活动检测。
4. 成功后请求正常退出、捕获 resume token，并在 draining 超时后回收终端。重启后的 monitor 仍遵守已记录的等待窗口。
5. 某个 session 的 capture 或 kill 失败会记录到日志。如果终端已消失，则补齐终态；否则留待之后重试。其他 session 的刷新继续执行。
6. 没有 running、draining 或 attention session 后，daemon 退出。

**Inline refresh**：daemon 未运行时，`wait`、`check`、`status` 会在返回前执行同样的刷新逻辑。短任务不依赖常驻 daemon。tmux 的权限或连接错误不代表会话死亡，monitor 会保留状态并重试。`clean` 会保留已预留的启动记录，并在清理孤立运行文件前检查终端是否存活。

**进程管理**：PID 文件为 `~/.ahelpa/daemon.pid`，日志为 `~/.ahelpa/daemon.log`。没有 supervisor 在 daemon 崩溃后立即重启它。下一次 launch 或 resume 在 PID 存活检查认定 daemon 已停止时启动它；未检测到 daemon 时，`wait`、`check`、`status` 使用 inline refresh。

## Drivers

### 2026-10-02 上游接口调研

| 官方资料 | 对 ahelpa 的启示 |
| --- | --- |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | 结构化回合事件区分成功、失败与中断；部分接口需要显式开启实验能力。后续 driver 应优先使用稳定生命周期方法与原生 thread ID。 |
| [Kimi ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp) 与 [Wire](https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html) | 双向 JSON-RPC 可减少终端解析。选择传输方式前，应探测本机 CLI 的协议能力；不同 Kimi 发行版的文档可能存在差异。 |
| [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup) | 原生恢复前必须确认 `loadSession` 能力，而不能默认所有 agent 均支持。 |
| [Claude hooks](https://code.claude.com/docs/en/hooks) | `Stop`、`StopFailure` 和 `SessionEnd` 是不同生命周期事件；一轮回复结束本身不能证明任务成功。 |

当前实现保留 tmux 与文件交接。接入这些传输方式需要能独立于调用方存活的受管进程，以及能力协商、审批处理、取消和重连测试。后续应保留现有命令契约，每次接入一个 driver；成为默认实现前，验证启动、中断、重启、原生恢复和结果交付，并保持 owner token 与 safe mode 的保证。结构化传输是后续设计方向，本版本尚未实现。

### 当前终端驱动

Driver 可选的 `launchProfiles` 定义支持的角色及其默认模型/effort。`launch-profiles.ts` 在启动规划时解析一次角色和显式覆盖参数，最终值随 session 存储并返回 host。Claude 支持默认 `advisor` 与 `worker`；Codex 只支持 `worker`；Kimi 保持既有配置，不设置角色。角色不改写任务指令或权限。Resume 直接使用记录中的设置，包括旧记录中的未知值，不重新套用当前启动预设。

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

Kimi 打印 `[AHELPA:DONE]` 后，旧 helper 仍在 draining 时 `resume` 会被拒绝。host 可以等待 daemon 回收终端且 `check` 显示 `idle`，也可以显式 `kill` 后再恢复。所有已结算记录都会保留到 `clean`；已完成及旧版 dead 记录只要带有 `agentResumeId` 就可以恢复。`clean` 仅在终端已回收后删除已结算记录及其 resume 元数据；live、draining 和 attention session 会保留。持久性指通过原生 Kimi session 在新 tmux session 中重新连接，而不是无限保留原 tmux process。

## Nesting

Helper 可以继续启动自己的 helper，形成 session lineage。每个 child session 会记录 parent ID，但 owner 权限不传递：host 只能控制自己直接启动的 session。

Launch 和 resume 在同一个 SQLite immediate transaction 中检查实际调用方和递归限制，并预留新 session，然后才产生外部副作用。并发调用方不能同时占用最后一个名额。限制如下：

| 限制 | 默认值 | 覆盖方式 | 防止什么 |
| --- | --- | --- | --- |
| 链的深度 | 4 | `AHELPA_MAX_NESTING_DEPTH` | helper 不断向下委派 |
| 一棵树中的活跃 session 数（根 helper 及其全部后代，计入 `running`、`draining`、`needs_attention`） | 8 | `AHELPA_MAX_ACTIVE_PER_TREE` | helper 在合法深度上横向无限展开 |
| 从 `reviewer` 调用方发起 launch 或 resume | 拒绝 | 无 | 只读的 review hand 借他人之手修改，或让作者的推理进入 review |

Host 每次直接 launch 都创建独立的 helper tree；不会对 host 的不同 root 合并计数。`clean` 保留连接活跃后代所需的已结算祖先记录，因此清理不会拆散树配额。后代结算、终端退出后，这些记录才可删除。Resume 保留原 parent，不会降低记录深度；实际调用方更深时，可以提高该深度。被恢复的 root 通过现有 `resumed_from` 关联留在原树中。两个限制值都会导出到每个 helper 的环境变量中。

实际调用方由 `AHELPA_PARENT_ID` 对应的现存 SQLite session 确定，不受显式 `--parent` 覆盖。Reviewer 调用方一律拒绝；helper 的 `--parent` 必须留在自己的树内，深度检查同时覆盖实际调用方和指定 parent。Host 调用方仍可指定任意 parent 追踪 ID。Job 独立于树：显式 `--job` 优先于 `--after` session 保存的 job，再优先于实际调用方保存的 job；host shell 的 `AHELPA_JOB_ID` 不作为继承来源。

## Archives

Session settle 时，最终快照会保存到 `~/.ahelpa/archive/<session-id>/`。这样 tmux session 清理后，`logs` 仍能读取输出。Archive 由 daemon 或 inline refresh 在 settlement 中写入，不会自动裁剪。

保留的 SQLite 记录提供 owner 校验和 resume 设置。运行 `clean` 删除记录后，该 session 的带 token 的 `logs`、`resume` 调用不再可用；archive 和项目交接文件仍留在磁盘上。

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
