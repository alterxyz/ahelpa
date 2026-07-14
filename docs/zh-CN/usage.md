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

Safe mode 是更低权限的启动姿态，不是独立 OS user 或 VM。各 driver 的具体行为见 [安全说明](security.md)。

用 `--notify-tmux` 在 helper 进入 `needs_attention`、`dead` 或 `error` 时，把 settle 消息推送到另一个 tmux session：

```bash
ahelpa launch codex --notify-tmux chief-pane --task "Review this change"
```

也可以在 `~/.ahelpa/config.json` 设置全局默认：

```json
{
  "notify": {
    "tmux": "chief-pane",
    "command": "printf '%s %s\n' \"$AHELPA_SESSION_ID\" \"$AHELPA_STATUS\" >> ~/.ahelpa/notify.log"
  }
}
```

单次 launch 的 `--notify-tmux` 优先于全局 tmux target。`wait` 仍是阻塞式拉取机制；notify 是推送信号，适合 host 在别处继续工作时被叫醒。

## 启动时选择模型

```bash
ahelpa models
ahelpa models codex
ahelpa launch codex --model gpt-5.5 --effort high --task "Review this change"
ahelpa launch claude-code --model sonnet --task "Review this change"
```

`models [agent]` 会打印当前 ahelpa 版本内置的静态模型目录。`--model` 会用指定模型启动 helper。所选 agent 支持启动时设置 effort 时，`--effort` 会一并透传。`resume` 会自动沿用启动时记录的 model 和 effort。

## 切换运行中 helper 的模型

```bash
ahelpa model "$session_id" --to sonnet --token "$token"
ahelpa model "$session_id" --to gpt-5.4 --effort xhigh --token "$token"
```

Helper 必须停在可输入的 idle prompt。Claude Code 只切当前 session。Codex 会走自己的 `/model` TUI，而该 TUI 会写入 Codex config；ahelpa 默认在当前 session 切换后恢复原 config。需要保留 Codex 新默认模型时，加 `--persist`。

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

如果 `check` 显示 `agentResumeId`，可以把 agent 对话恢复成一个新的 helper session：

```bash
ahelpa resume "$session_id" --token "$token"
```

## 回收 session

终止指定 session：

```bash
ahelpa kill "$session_id" --token "$token"
```

清理 dead 记录和孤儿运行时文件（pipe、task file）：

```bash
ahelpa clean
```

`clean` 不会删除 archive，也不会终止 live session。

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

它会把安装交给 `npx skills@latest`，并为 Codex 和 Claude Code 安装全局 hard-copy skill 文件。

## 时间预期

Helper 是完整 coding agent：它需要启动、读取任务、探索代码、计划、执行、打印暗号。一个有意义的任务通常需要 2–10 分钟。

- **先 wait，再判断。** 默认 500 秒很充裕。
- **`still_running` 正常。** 继续 re-wait，helper 还在工作。
- **前几分钟不要 capture。** 早期 capture 通常没有信息量。
- **不要每 30 秒 polling。** 一次 `wait`，必要时再 re-wait。
- **简单任务 8–10 分钟无声再介入。** 先 capture 看状态，再决定 `send` nudge 或 `kill` 重试。

## Messenger pattern

长任务或多个并行 helper，可以启动一个便宜的后台 subagent 做 messenger，负责 poll 和汇报，避免主对话阻塞在 `wait` 上。

| 场景 | 做法 |
| --- | --- |
| 单个短任务 | 直接 `ahelpa wait` |
| 长任务或多个 helper | 启动 messenger subagent |

Messenger 的职责很窄：周期性运行 `ahelpa check`，session 完成后检查结果目录并汇报。它不应该自己做任务。

平台差异见 `skill/references/claude-code.md` 和 `skill/references/codex.md`。

## Troubleshooting

ahelpa 是 tmux 上的一层薄封装。每个 helper 都是一个可预测命名的 tmux session：

```bash
tmux ls                                # 列出所有 session
tmux attach -t "$session_id"           # attach 查看 live output
tmux capture-pane -t "$session_id" -p  # 不 attach，直接 dump pane 内容
```

常见情况：

- **Helper 看起来卡住。** Attach 到 tmux session 看完整屏幕。可能出现了 driver 没自动处理的 prompt 或确认框。手动处理后，暗号协议仍然有效。
- **`wait` 返回但没有 summary.md。** Helper 可能完成了但没写结果。用 `capture` 或 `logs` 看发生了什么。
- **Session 显示 `error`。** Helper 打印了 `[AHELPA:NEED_HELP]`。用 `capture` 或 `logs` 看它需要什么，再用 `send` 介入。
- **Session 显示 `dead`。** tmux session 意外消失。用 `logs` 查看 archived output。
