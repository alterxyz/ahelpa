# ahelpa

[English](README.md) | [简体中文](README.zh-CN.md)

**Agent Help Agent** — 一个本地运行时，让一个 coding agent 可以启动并管理另一个 coding agent。

## 为什么需要它

Coding agent 最擅长处理边界清楚、上下文集中的任务。当一个任务需要第二视角、并行执行，或者一个干净上下文时，最自然的做法是再启动一个 agent。但手动管理 tmux session、传递任务文件、等待完成、回收进程，这些胶水逻辑很容易被每个 agent 重复发明一遍。

ahelpa 把这些胶水收束成一个小 CLI。一个 agent 启动 helper，把任务交给它，然后等待 helper 打印完成暗号。结果通过文件返回，而不是解析终端输出。session 状态记录在 SQLite 中，写操作需要 launch 返回的 owner token。

对于正儿八经的跨 agent 工作，默认应优先使用 ahelpa，而不是一次性 CLI 调用。tmux session 可以脱离调用方继续存活；文件交接留下可检查的结果；FIFO wait 让调用方耐心等待而无需轮询；原生 session ID 则支持后续追问和恢复。只有真正短小、无状态，而且持久性与交接都没有价值的探针，才适合一次性执行。

## 安装

要求：macOS 或 Linux（x64 / arm64）、tmux，以及用于安装 skill 的 Node.js >=22.20.0 和可正常运行的 `npx`。编译后的 runtime 本身不依赖 Node.js。

```bash
curl -fsSL https://raw.githubusercontent.com/alterxyz/ahelpa/main/scripts/install.sh | bash
```

安装脚本会在下载前检查 Node.js 和 `npx`，再解析明确的 release tag，按 OS/arch 下载归档并用 `SHASUMS256.txt` 校验，检查二进制版本，最后原子安装到 `~/.ahelpa/bin/ahelpa`，保留已有二进制的备份。随后通过 `npx skills@latest` 安装同一 tag 的 skill。skill 会以全局 hard copy 的方式通过三个显式 target 安装到所有受支持的 agent：

- Codex：target `codex` → `~/.agents/skills/ahelpa`（共享的通用 skill 目录）
- Claude Code：target `claude-code` → `~/.claude/skills/ahelpa`
- Kimi Code CLI：target `kimi-code-cli` → `~/.agents/skills/ahelpa`

这些位置由 `skills` 安装器决定。目前 Codex 和 Kimi 共用通用目录，Claude Code 使用独立的 hard copy。

没有校验清单的旧 release 需要显式提供可信的 `AHELPA_SHA256`；自定义下载源也需要该摘要或 `AHELPA_CHECKSUM_URL`。详见[安装说明](docs/zh-CN/development.md#部署)。

如果 runtime 已经装好，只需要刷新 skill：

```bash
ahelpa install-skill
```

这个命令固定使用公开源 `alterxyz/ahelpa`、全局作用域、hard-copy 模式，并显式安装到 `codex` + `claude-code` + `kimi-code-cli`。

### 从源码安装

如果某个平台还没有预编译产物（或你在做开发），可以本地构建安装——Bun 会为当前 OS/arch 编译原生 binary：

```bash
git clone https://github.com/alterxyz/ahelpa
cd ahelpa
bash scripts/deploy-local.sh   # 构建 dist/ahelpa，装到 ~/.ahelpa/bin，并 hard-copy skill
```

## 快速开始

```bash
# 启动一个 helper
result=$(ahelpa launch claude-code --task "Review the parser module")
session_id=$(echo "$result" | jq -r .sessionId)
token=$(echo "$result" | jq -r .ownerToken)

# 等待完成
ahelpa wait "$session_id"

# 读取结果
cat ".ahelpa/$session_id/summary.md"
ls ".ahelpa/$session_id/artifacts/"
```

Helper 会在自己的 tmux session 中运行，拥有独立上下文。它读取任务文件，把结果写入 `.ahelpa/<session-id>/`，并通过打印 `[AHELPA:DONE]` 或 `[AHELPA:NEED_HELP]` 宣告状态。

长任务可以直接用 `ahelpa launch codex --file ./task.md` 启动。`--task` 和 `--file` 必须二选一；任务投递前会把文件正文复制到该 session 的交接文件，完整保留多行文本，无需 shell 转义。

## 核心原语

| 原语 | 作用 |
| --- | --- |
| **tmux session** | 持久 helper 终端，不依赖启动命令继续存活 |
| **文件交接** | 任务和结果通过文件交换，而不是终端输出解析 |
| **暗号协议** | helper 打印 `[AHELPA:DONE]` 或 `[AHELPA:NEED_HELP]` 声明状态 |
| **FIFO 唤醒** | 有界等待，通过管道通知并定期检查状态 |
| **Owner token** | 写操作必须带上 `launch` 返回的 token |
| **Driver adapter** | agent-specific 启动和交互细节封装在 driver 后面 |
| **按需 daemon** | 监控运行中的 session 并做 settle；`launch` 时自动启动 |

## 支持的 helper

| Helper type | 底层 CLI |
| --- | --- |
| `claude-code` | `claude` |
| `codex` | `codex` |
| `kimi` | `kimi` |

检查依赖时请用 `command -v claude`、`command -v codex` 或 `command -v kimi`。Claude 的 helper type 不是它的二进制名称。

### 角色与默认值

| Helper | 角色 | 默认模型 | Effort |
| --- | --- | --- | --- |
| `codex` | `worker`（默认） | `gpt-6.1-sol` | `high` |
| `codex` | `reviewer` | `gpt-6.1-sol` | `xhigh` |
| `claude-code` | `advisor`（默认） | `claude-opus-5-5` | `xhigh` |
| `claude-code` | `worker` | `claude-sonnet-5-5` | `high` |
| `claude-code` | `reviewer` | `claude-opus-5-5` | `xhigh` |

Advisor 用于分析、方案和审阅；worker 按明确目标执行。例如 `ahelpa launch claude-code --role worker --file ./task.md` 会选择 Sonnet。显式 `--model`、`--effort` 分别覆盖对应默认值。`reviewer` 用于只读的对抗式审阅，其任务合同禁止修改结果目录之外的文件；Codex 仍拒绝 `advisor`。角色只选择启动设置，不改变权限或任务范围。Kimi 保持原生模型默认值，不接受 `--role`。`models` 展示预设，`check` 展示已记录的角色、模型和 effort；resume 保留已记录设置，旧会话没有角色时也不会套用新默认。

## 命令速览

| 命令 | 用途 |
| --- | --- |
| `launch <type> (--task "..." \| --file <path>) [--role <role>] [--check "<cmd>"] [--after <id>] [--unblind] [--job <id>] [--worktree] [--parent <id>] [--safe] [--model <model>] [--effort <level>]` | 启动 helper（`claude-code`、`codex` 或 `kimi`）；`--after` 串联前后手，显式 `--role reviewer` 增加盲审和目标证据 |
| `wait (<id...> \| --job <id>) [--all] [--timeout <s>]` | 阻塞等待 helper settle 或超时 |
| `check [--parent <id>] [--job <id>]` | 非阻塞状态查询，并做 inline refresh |
| `models [agent]` | 列出启动时可选的模型 |
| `doctor [agent] [--project <path>]` | 以 JSON 检查本地就绪状态，不调用模型、不写运行状态 |
| `send <id> "msg" --token <tok>` | 给运行中的 helper 发送短消息 |
| `capture <id> --token <tok>` | 截取终端输出，仅用于调试 |
| `task <id> --file <path> --token <tok>` | 发送长任务文件 |
| `model <id> --to <model> --token <tok> [--effort <level>] [--persist]` | 切换运行中 helper 的模型 |
| `kill <id> --token <tok> [--tree]` | 终止 helper；`--tree` 同时停止后代并报告 `killed` / `missed` |
| `logs <id> --token <tok>` | 读取 live 或 archived session output |
| `resume <id> --token <tok> [--safe]` | 恢复已完成的 helper；已有 safe 姿态会自动继承 |
| `status` | 显示所有 session 和 daemon 状态 |
| `clean` | 清理终端已退出的已结算记录和孤儿运行时文件 |
| `daemon start\|stop` | 管理后台 session monitor |
| `install-skill [--source <repo-or-path>]` | 为 Codex、Claude Code 和 Kimi Code CLI target 全局 hard-copy 安装 skill |
| `version` | 显示已安装 runtime 版本 |

Kimi 支持完整的持久工作流，包括 `launch`、`wait`、`send`/`task`、`capture`、`kill` 和 `resume`。ahelpa 会设置 `KIMI_CODE_NO_AUTO_UPDATE=1`，避免 CLI 自更新中断持久 tmux session。默认不要传 `--model`，让 Kimi 使用其 `config.toml` 中的默认模型；如果传入，值必须与该配置中已有的完整 alias 精确匹配。Kimi 会在收到第一条任务消息后创建 `session_*` ID；ahelpa 会捕获它，之后通过 `kimi --session` 恢复对话。Kimi 不支持 `--effort`，也不支持通过 `ahelpa model` 在运行中切换模型。`[AHELPA:DONE]` 之后，旧 helper 仍在 draining 时 `resume` 会被拒绝；可等待 `check` 显示 `idle` 且终端已回收，或显式 `kill` 后再恢复。已完成及旧版 dead 记录只要带有 resume token，就能在 `clean` 前恢复；launch 时的 `--safe` 姿态会在 resume 时自动继承，而 `resume --safe` 可以把旧的默认姿态记录安全升级。所谓持久对话，是用 Kimi 原生 session ID 在新 tmux session 中恢复，不是让原 tmux 永久存活。

## 运行时布局

Helper 终端回收后，已完成会话仍保留状态、日志和恢复信息。不再需要这些会话记录时再运行 `clean`。`wait --all` 超时时，只对尚未结束的 helper 返回 `still_running`，已结算的结果保持不变。

| 路径 | 用途 |
| --- | --- |
| `~/.ahelpa/bin/ahelpa` | 已安装二进制 |
| `~/.ahelpa/state.db` | SQLite session 状态 |
| `~/.ahelpa/daemon.pid` | daemon PID 文件 |
| `~/.ahelpa/archive/<id>/` | 终态 session 快照 |
| `/tmp/ahelpa/<id>.pipe` | FIFO 唤醒管道 |
| `/tmp/ahelpa/ahelpa-task-<id>.md` | 任务文件 |
| `<project>/.ahelpa/<id>/summary.md` | helper 写入的总结 |
| `<project>/.ahelpa/<id>/artifacts/` | helper 写入的支撑文件 |

隔离测试或自动化可以通过 `AHELPA_HOME` 覆盖状态/archive 目录，通过 `AHELPA_TMP_DIR` 覆盖 FIFO/任务文件目录。这两个 override 会传入 helper 的 tmux session，使嵌套 ahelpa 调用也保持隔离；它们不会改变 helper CLI 的 OS home 或凭据目录。

## 安全姿态

Helper 默认以 host process 相同的本地用户权限运行。请用 `--project` 收窄工作目录，用 `--safe` 省略或收窄默认 danger flags；风险任务优先放到 git worktree；不要把 secret 放进任务 prompt 或结果 artifact。Kimi 首次在某个目录启动时，ahelpa 会自动选择 **Trust this folder**；该信任会持久保存在 Kimi 中，并允许项目 MCP server。无论是否使用 `--safe` 都会执行这一步。对于 Kimi，`--safe` 只会省略 `--yolo` 并恢复原生审批，它不是 sandbox。更多细节见 [安全说明](docs/zh-CN/security.md)。

## 开发

要求：macOS 或 Linux、Bun 1.4.2（release 固定使用的工具链）、tmux。

```bash
bun test                       # 单元测试
bun run build                  # 编译二进制到 dist/
bun run package:skill          # 构建带 runtime bundle 的 skill package
bash scripts/deploy-local.sh   # 安装 runtime + 全局 hard-copy skills
bun run closure:gate           # 三个 driver 的端到端 gate
```

仓库不跟踪编译后的 bundle；它们是 git-ignored 生成物。

更多文档：

- [架构](docs/zh-CN/architecture.md) / [Architecture](docs/architecture.md)
- [使用指南](docs/zh-CN/usage.md) / [Usage](docs/usage.md)
- [开发指南](docs/zh-CN/development.md) / [Development](docs/development.md)
- [安全说明](docs/zh-CN/security.md) / [Security](docs/security.md)

## 致谢

本项目重度"吃自己的狗粮"——ahelpa 启动的 coding agent 也在反过来参与构建它。Claude **Fable 5** 复核、加固并优化了本代码库。Fable did that.
