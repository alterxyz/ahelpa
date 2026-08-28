# 使用指南

[English](../usage.md) | [简体中文](usage.md)

## 启动 helper

```bash
result=$(ahelpa launch claude-code --task "Review src/parser.ts for edge cases")
session_id=$(echo "$result" | jq -r .sessionId)
token=$(echo "$result" | jq -r .ownerToken)
```

`launch` 返回 JSON，包含 `sessionId`、`ownerToken` 和 `tmuxSession`。请保存 token；所有写操作都需要它。

用 `--project` 指定 helper 工作目录：

```bash
ahelpa launch codex --project /path/to/project --task "Add tests for the CLI parser"
```

Kimi Code 使用 `kimi` helper type 和 `kimi` 二进制：

```bash
command -v kimi
ahelpa launch kimi --project /path/to/project --task "Review the CLI parser"
```

用 `--label` 给 session 打标签，方便识别：

```bash
ahelpa launch claude-code --task "Fix auth bug" --label "auth-fix"
```

headless host 需要显式追踪 ID 时，用 `--parent`：

```bash
ahelpa launch codex --parent "bench-run-42" --task "Review this change"
```

用 `--safe` 省略或收窄默认 danger flags：

```bash
ahelpa launch codex --safe --project /path/to/project --task "Review this change"
```

Safe mode 是更低权限的启动姿态，不是独立 OS user 或 VM。ahelpa 会记录该姿态并在 `resume` 时继承；`resume --safe` 可以升级默认姿态记录，但省略该参数不会把已 safe 的 session 降级。各 driver 的具体行为见 [安全说明](security.md)。

Kimi 默认以 `KIMI_CODE_NO_AUTO_UPDATE=1 kimi --yolo` 启动。这个 canonical 更新开关用于避免 CLI 自更新中断持久 tmux session。首次在某个目录启动时，ahelpa 会自动选择 **Trust this folder**。Kimi 会持久保存该信任，随后可能启动该目录中的项目 MCP server。即使使用 `--safe`，自动信任步骤也会执行：Kimi safe mode 只会省略 `--yolo` 并恢复原生审批，它不是 sandbox。

## 启动时选择模型

```bash
ahelpa models
ahelpa models codex
ahelpa launch codex --model gpt-5.5 --effort high --task "Review this change"
ahelpa launch claude-code --model sonnet --task "Review this change"
```

`models [agent]` 会打印当前 ahelpa 版本已知的模型目录。Kimi 默认应省略 `--model`，让 CLI 使用其 `config.toml` 中的默认模型；如果传入 `--model`，值必须与该文件中已经配置的完整 alias 精确匹配，只有显示名称可能会失败。所选 agent 支持启动时设置 effort 时，`--effort` 会一并透传；Kimi 会拒绝 `--effort`。如果 launch 时显式传入了模型 alias，`resume` 会沿用它。

## 切换运行中 helper 的模型

```bash
ahelpa model "$session_id" --to sonnet --token "$token"
ahelpa model "$session_id" --to gpt-5.4 --effort xhigh --token "$token"
```

Helper 必须停在可输入的 idle prompt。Claude Code 只切当前 session。Codex 会走自己的 `/model` TUI，而该 TUI 会写入 Codex config；ahelpa 默认在当前 session 切换后恢复原 config。需要保留 Codex 新默认模型时，加 `--persist`。

Kimi 不支持运行中的 `ahelpa model` 切换；请在 launch 时选择模型。

## 等待完成

```bash
ahelpa wait "$session_id"
```

`wait` 会阻塞在命名管道上，直到 helper 打印暗号或超时。默认 timeout 是 500 秒。如果返回 `still_running`，表示 helper 还没完成；再次 `wait` 即可：

```bash
ahelpa wait "$session_id"  # re-wait 是正常流程，不是错误
```

多个 helper 可以一起等：

```bash
ahelpa wait "$id1" "$id2" "$id3"           # 任意一个完成就返回
ahelpa wait "$id1" "$id2" "$id3" --all     # 全部完成才返回
```

设置自定义 timeout：

```bash
ahelpa wait "$session_id" --timeout 300    # 5 分钟
```

## 读取结果

Helper 完成后，输出位于项目目录：

```bash
cat ".ahelpa/$session_id/summary.md"
ls ".ahelpa/$session_id/artifacts/"
```

这是主要通信通道：文件，而不是终端 scraping。

## 发送后续任务

短消息：

```bash
ahelpa send "$session_id" "Also check the error handling path." --token "$token"
```

长指令用文件：

```bash
ahelpa task "$session_id" --file ./next-task.md --token "$token"
```

超过一句话的内容优先用 `task`，避免 tmux keystroke input 的长度限制。

## 观察 session

非阻塞状态查询：

```bash
ahelpa check                    # 所有 session
ahelpa check --parent "$id"     # 某个 parent 启动的 session
```

人类可读视图：

```bash
ahelpa status
```

daemon 未运行时，这两个命令也会先做 inline refresh。

## Capture 终端输出

仅用于调试，不作为常规通信：

```bash
ahelpa capture "$session_id" --token "$token"             # 最近 50 行
ahelpa capture "$session_id" --token "$token" --lines 100  # 最近 100 行
```

## 查看日志

读取完整 session 输出；tmux session 消失后会读取 archived output：

```bash
ahelpa logs "$session_id" --token "$token"
```

## 恢复已完成的 helper

如果 `check` 显示 `agentResumeId`，就可以把 agent 对话重新连接到新的 helper session。Kimi 初始启动时还没有 `session_*` ID；ahelpa 会在提交第一条任务消息后捕获它，之后通过 `kimi --session <id>` 重新连接。

按当前 settle/drain 生命周期，旧 Kimi helper 仍在 draining 时，`resume` 会被拒绝。可以等待 `ahelpa check` 显示它已变为 `dead`，也可以走更快的显式回收路径：

```bash
ahelpa kill "$session_id" --token "$token"
ahelpa resume "$session_id" --token "$token"
```

如果 launch 时传入了已配置的 `--model` alias，新 helper 会沿用它；否则 Kimi 继续使用其配置默认值。launch 时的 `--safe` 姿态也会自动继承；`resume --safe` 可以把旧的默认姿态记录升级为 safe。所谓持久对话，是通过 Kimi 原生 session ID 在新 tmux session 中恢复；`[AHELPA:DONE]` 不会让原 tmux session 永久存活。

`resume` 会等待新 driver 到达可输入 prompt，然后返回一个处于 `needs_attention` 的新 helper。请对新 session ID 使用 `send` 或 `task` 发送下一轮，再调用 `wait`。ahelpa 会先确认新用户回合已经被接受，重建 FIFO，并恢复 daemon monitoring，避免旧的 DONE/NEED_HELP 被拿来结算新一轮。

## 回收 session

终止指定 session：

```bash
ahelpa kill "$session_id" --token "$token"
```

清理 dead 记录和孤儿运行时文件（pipe、task file）：

```bash
ahelpa clean
```

`clean` 会删除 dead session 记录及其 resume 元数据，因此旧 ID 此后不能再恢复。它不会删除 archive，也不会终止 live 或 draining session。

## Daemon 管理

daemon 会在 `launch` 时自动启动，并在所有 session 结束后退出。通常不需要手动管理：

```bash
ahelpa daemon start    # 手动启动
ahelpa daemon stop     # 手动停止
```

## 刷新 agent skill

如果 runtime 已安装，但 agent skill 缺失或过期：

```bash
ahelpa install-skill
```

它会把安装交给 `npx skills@latest`，并通过显式的 `codex`、`claude-code` 和 `kimi-code-cli` target 安装全局 hard-copy skill 文件。

## 时间预期

Helper 是完整 coding agent：它需要启动、读取任务、探索代码、计划、执行、打印暗号。一个有意义的任务通常需要 2–10 分钟。

- **先 wait，再判断。** 默认 500 秒很充裕。
- **`still_running` 正常。** 继续 re-wait，helper 还在工作。
- **前几分钟不要 capture。** 早期 capture 通常没有信息量。
- **不要每 30 秒 polling。** 一次 `wait`，必要时再 re-wait。
- **复杂或 max-effort 审查超过 10 分钟很正常。** 只要仍有进展证据就继续 re-wait。只有看到明确卡住的 prompt、失败 tool 或求助信号才介入；先 capture 一次，再优先 `send`，最后才考虑 `kill`。

## 长时间运行的 helper

长任务直接使用 `ahelpa wait`。FIFO 本身就是高效、持久的等待面，不要再用一次性进程或 polling messenger 替代它。返回 `still_running` 后继续对同一个 session re-wait；并行 helper 应把所有 session ID 一次传给 `wait`，需要全部完成时加 `--all`。

平台差异见 `skill/references/claude-code.md`、`skill/references/codex.md` 和 `skill/references/kimi.md`。

## Troubleshooting

ahelpa 是 tmux 上的一层薄封装。每个 helper 都是一个可预测命名的 tmux session：

```bash
tmux ls                                # 列出所有 session
tmux attach -t "$session_id"           # attach 查看 live output
tmux capture-pane -t "$session_id" -p  # 不 attach，直接 dump pane 内容
```

常见情况：

- **Kimi 显示月相或 `Retrying`。** 循环月相和 provider backoff 倒计时都表示仍在工作，即使 boxed input 仍然可见。继续 `wait`；120 秒 provider 重试不是本地 CLI 或 tmux 故障。
- **Helper 看起来卡住。** Attach 到 tmux session 看完整屏幕。可能出现了 driver 没自动处理的 prompt 或确认框。手动处理后，暗号协议仍然有效。
- **`wait` 返回但没有 summary.md。** Helper 可能完成了但没写结果。用 `capture` 或 `logs` 看发生了什么。
- **Session 显示 `error`。** Helper 打印了 `[AHELPA:NEED_HELP]`。用 `capture` 或 `logs` 看它需要什么，再用 `send` 介入。
- **Session 显示 `dead`。** tmux session 意外消失。用 `logs` 查看 archived output。
