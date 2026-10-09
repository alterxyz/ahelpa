# 安全说明

[English](../security.md) | [简体中文](security.md)

## 权限模型

ahelpa 默认启动的 helper agent 拥有和 host process 相同的本地用户权限。在默认模式下，它没有 sandbox，没有 capability restriction，也没有介于 helper 和本地文件系统之间的审批 gate。helper 能读取、写入和执行该用户账号能做的事情。

这是本地开发场景下的刻意取舍：最大化 helper 能力，同时要求使用者认真收窄任务范围。

`ahelpa launch --safe` 会省略或收窄默认 danger flags。Claude Code 会以 `claude --verbose` 启动；Codex 会以 `codex -s workspace-write -a never` 启动；Kimi 会省略 `--yolo`，恢复 Kimi 原生审批流程。ahelpa 会持久记录该姿态并带入每个 resume 记录，因此省略 resume 参数不会悄悄恢复 danger flags；`resume --safe` 可以升级默认姿态记录。这是更低权限的姿态，但不是独立 OS user、VM 或强安全边界。尤其要注意，Kimi 的原生审批不是 sandbox。

默认情况下，Kimi 以 `KIMI_CODE_NO_AUTO_UPDATE=1 kimi --yolo` 启动。这个 canonical 更新开关用于避免 CLI 自更新中断持久 tmux session。首次在某个目录启动时，ahelpa 会自动选择 **Trust this folder**，让任务能够无人值守地继续投递。Kimi 会持久保存该目录信任；可信项目可以提供 Kimi 随后可能启动的 MCP server。默认模式和 `--safe` 模式都会自动信任目录。因此，`--safe` 只是通过省略 `--yolo` 恢复逐项原生审批，并不能让不可信项目变得安全。

## 会话回合 Hooks

Claude 通过 `--settings` 加载 `.ahelpa/<id>/claude-settings.json`，该会话设置文件还写入 `promptSuggestionEnabled: false`，关闭 helper 输入框内的建议文字。Codex 使用仅本次调用生效的 `notify` override。Launch 和 resume 都不编辑 `~/.claude/settings.json` 或 `~/.codex/config.toml`。Claude 现有 project/user hooks 仍会与会话 hooks 合并运行。Codex 的 notify override 会替换本次调用原有的 notify 命令；native hooks 及其信任设置不变。

隐藏命令 `__turn-hook` 读取 stdin（Claude）或最后一个 JSON 参数（Codex），过滤支持的事件，仅把标识、时间、失败类型、输入 SHA-256 摘要和消息存在性／长度追加到会话的 `turns.log`。它不打开状态数据库，不执行 payload 中的指令，不输出 stdout。无效输入及不可用文件会被忽略，stdin 读取有时限。写入器要求 `.ahelpa` 下已有的会话目录，并拒绝 symlink 和 hardlink 目标；打开后检查 regular file 只有一个链接且 device／inode 与检查路径一致，通过该 descriptor 写入。保存的 runtime 不存在或不可用时，hook wrapper 静默退出 0。不保留 assistant 正文或 input-messages 内容。这是可信本地进程提供的时机提示，不是经过认证的成功信号或权限边界。

Hook 对日志文件提供 symlink 和 hardlink 防护，但不能防止已拥有用户权限的进程并发替换会话目录本身。

## 实用防护

- **用 `--project` 收窄范围。** 把 helper 指向最小可用工作目录。它设置 cwd 和任务意图边界，但不是 filesystem sandbox。做 review 时，应在 prompt 中明确禁止读取无关 home 目录、全局 `~/.ahelpa/archive` 和其他项目，除非任务确实需要。
- **使用 git worktree。** 风险任务或实验任务放进临时 worktree，降低误改主工作区的影响。
- **不要把 secret 放进任务 prompt。** 任务文件会写到 `/tmp/ahelpa/`，本地用户可读。不要在任务描述中嵌入 credential、API key 或敏感数据。
- **不要把 secret 留在结果 artifact。** Helper 会把结果写到项目内 `.ahelpa/<session-id>/`。commit 或分享前先检查。
- **不要提交运行时 artifact。** `.ahelpa/`、本地数据库、日志、构建输出都应保持 git-ignored。

## Owner token 边界

`launch` 返回的 owner token gate 所有写操作：

| 需要 token | 不需要 token |
| --- | --- |
| `send`、`task`、`model`、`capture`、`logs`、`kill`、`resume` | `status`、`check`、`clean` |

只读状态视图不会暴露 owner token。这意味着任何 agent 都可以观察 session 状态，但交互需要该 session 自身的 token。终止操作有下述 lineage 例外。

Ownership 不传递。如果 agent A 启动 helper B，helper B 又启动 helper C，那么 A 不能控制 C；只有 B 可以。唯一例外是 **终止权沿 lineage 传递，控制权不传递**：`kill B --token <B-token> --tree` 可以停止 B 及其后代，包括 C。它在任何终止动作之前校验 B 的 token；错误 token 不会停止任何 session。A 仍不能用 B 的 token 对 C 执行 `send`、`task`、`model`、`logs`、`capture` 或 `resume`。普通 `kill` 仍只影响指定 session，`--tree` 不赋予对兄弟树的权限。

## Nesting limit

Helper 可以继续启动 helper。Launch 和 resume 在外部副作用前，原子检查并预留 SQLite session：链深度（默认 4，`AHELPA_MAX_NESTING_DEPTH`）、每棵树的活跃 session 数（默认 8，`AHELPA_MAX_ACTIVE_PER_TREE`，包含准备中的预留记录），以及拒绝实际 `reviewer` 调用方，因为其契约是只读的。调用方由 `AHELPA_PARENT_ID` 对应的现存 session 确定；`--parent` 不能把 helper 移到自己的树外，也不能重置其深度。`clean` 保留活跃后代所需的已结算祖先，维持配额和 lineage；resume 仍留在原树中。见[架构](architecture.md#nesting)。

这些是协作式本地 agent 防止意外委派和展开的护栏，覆盖正常 ahelpa launch 和 resume 路径，包括并发调用。它们不能约束利用完整本地权限绕过 ahelpa 或直接修改 SQLite 的 helper。

## 暗号可信度

暗号协议（`[AHELPA:DONE]`、`[AHELPA:NEED_HELP]`）是约定，不是密码学保证。helper 可以在未真正完成时打印暗号，也可能完全忘记打印。daemon 通过 tmux capture 检测暗号，也就是读取 helper 控制的终端输出。

在本地 agent 场景中，这通常是可接受的：helper 是本机可信 agent CLI，权限模型本身也假设它能代表用户执行任务。

## 生成物和本地文件

公开源码树会忽略：

- 本地 runtime state（`~/.ahelpa/state.db`、`daemon.pid`、`daemon.log`）
- Session archives（`~/.ahelpa/archive/`）
- 生成的 build output（`dist/`）
- 生成的 skill bundle（`skill/bundle/`）
- 环境文件（`.env`、`.env.*`）
- key 和 certificate 文件
- 项目内 session 目录（`.ahelpa/`）

## 发布 hygiene

发布公开仓库前：

1. 跑 `bun test` 确认测试健康。
2. 扫描 tracked files 中的敏感字符串：本机路径、credential、私有名字、内部 URL。
3. 确认 git history 从预期的 clean commit 开始。
4. 确认生成物没有被 stage。
