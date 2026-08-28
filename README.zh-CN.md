# ahelpa

[English](README.md) | [简体中文](README.zh-CN.md)

**Agent Help Agent** — 一个本地运行时，让一个 coding agent 可以启动并管理另一个 coding agent。

## 为什么需要它

Coding agent 最擅长处理边界清楚、上下文集中的任务。当一个任务需要第二视角、并行执行，或者一个干净上下文时，最自然的做法是再启动一个 agent。但手动管理 tmux session、传递任务文件、等待完成、回收进程，这些胶水逻辑很容易被每个 agent 重复发明一遍。

ahelpa 把这些胶水收束成一个小 CLI。一个 agent 启动 helper，把任务交给它，然后等待 helper 打印完成暗号。结果通过文件返回，而不是解析终端输出。session 状态记录在 SQLite 中，写操作需要 launch 返回的 owner token。

对于正儿八经的跨 agent 工作，默认应优先使用 ahelpa，而不是一次性 CLI 调用。tmux session 可以脱离调用方继续存活；文件交接留下可检查的结果；FIFO wait 让调用方耐心等待而无需轮询；原生 session ID 则支持后续追问和恢复。只有真正短小、无状态，而且持久性与交接都没有价值的探针，才适合一次性执行。

## 安装

要求：macOS 或 Linux（x64 / arm64）、tmux，以及用于安装 skill 的 `npx`。

```bash
curl -fsSL https://raw.githubusercontent.com/alterxyz/ahelpa/main/scripts/install.sh | bash
```

安装脚本会按你的 OS/arch 从 GitHub Releases 下载对应的 runtime binary，安装到 `~/.ahelpa/bin/ahelpa`，然后把 skill 安装交给 `npx skills@latest`。skill 会以全局 hard copy 的方式通过三个显式 target 安装到所有受支持的 agent：

- Codex：target `codex` → `~/.codex/skills/ahelpa`
- Claude Code：target `claude-code` → `~/.claude/skills/ahelpa`
- Kimi Code CLI：target `kimi-code-cli` → `~/.agents/skills/ahelpa`

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

## 核心原语

| 原语 | 作用 |
| --- | --- |
| **tmux session** | 持久 helper 终端，不依赖启动命令继续存活 |
| **文件交接** | 任务和结果通过文件交换，而不是终端输出解析 |
| **暗号协议** | helper 打印 `[AHELPA:DONE]` 或 `[AHELPA:NEED_HELP]` 声明状态 |
| **FIFO 唤醒** | `wait` 阻塞在命名管道上，睡眠时零轮询、零 CPU |
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

## 命令速览

| 命令 | 用途 |
| --- | --- |
| `launch <type> --task "..." [--parent <id>] [--safe] [--model <model>] [--effort <level>]` | 启动 helper（`claude-code`、`codex` 或 `kimi`） |
| `wait <id...> [--timeout <s>]` | 阻塞等待 helper settle 或超时 |
| `check [--parent <id>]` | 非阻塞状态查询，并做 inline refresh |
| `models [agent]` | 列出启动时可选的模型 |
| `send <id> "msg" --token <tok>` | 给运行中的 helper 发送短消息 |
| `capture <id> --token <tok>` | 截取终端输出，仅用于调试 |
| `task <id> --file <path> --token <tok>` | 发送长任务文件 |
| `model <id> --to <model> --token <tok> [--effort <level>] [--persist]` | 切换运行中 helper 的模型 |
| `kill <id> --token <tok>` | 终止 helper session |
| `logs <id> --token <tok>` | 读取 live 或 archived session output |
| `resume <id> --token <tok> [--safe]` | 恢复 dead helper；已有 safe 姿态会自动继承 |
| `status` | 显示所有 session 和 daemon 状态 |
| `clean` | 清理 dead 记录、对应 resume 元数据和孤儿运行时文件 |
| `daemon start\|stop` | 管理后台 session monitor |
| `install-skill [--source <repo-or-path>]` | 为 Codex、Claude Code 和 Kimi Code CLI target 全局 hard-copy 安装 skill |
| `version` | 显示已安装 runtime 版本 |

Kimi 支持完整的持久工作流，包括 `launch`、`wait`、`send`/`task`、`capture`、`kill` 和 `resume`。ahelpa 会设置 `KIMI_CODE_NO_AUTO_UPDATE=1`，避免 CLI 自更新中断持久 tmux session。默认不要传 `--model`，让 Kimi 使用其 `config.toml` 中的默认模型；如果传入，值必须与该配置中已有的完整 alias 精确匹配。Kimi 会在收到第一条任务消息后创建 `session_*` ID；ahelpa 会捕获它，之后通过 `kimi --session` 恢复对话。Kimi 不支持 `--effort`，也不支持通过 `ahelpa model` 在运行中切换模型。`[AHELPA:DONE]` 之后，旧 helper 仍在 draining 时 `resume` 会被拒绝；可等待 `check` 显示 `dead`，或显式 `kill` 后再恢复。带 resume token 的 dead 记录会保留到 `clean`；launch 时的 `--safe` 姿态会在 resume 时自动继承，而 `resume --safe` 可以把旧的默认姿态记录安全升级。所谓持久对话，是用 Kimi 原生 session ID 在新 tmux session 中恢复，不是让原 tmux 永久存活。

## 运行时布局

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

要求：macOS 或 Linux、Bun、tmux。

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
