# Usage

[English](usage.md) | [简体中文](zh-CN/usage.md)

## Launch a Helper

```bash
result=$(ahelpa launch claude-code --task "Review src/parser.ts for edge cases")
session_id=$(echo "$result" | jq -r .sessionId)
token=$(echo "$result" | jq -r .ownerToken)
```

The `launch` command returns JSON with `sessionId`, `ownerToken`, and `tmuxSession`. Save the token — you need it for all mutating operations on this session.
- `warning`（可选）：任务已投递但 driver 未确认新回合时出现，此时会话为 `needs_attention`、`wait` 立即返回、daemon 不监控它——先 `capture` 看面板，指令还留在输入框就 `send ""`（回车），否则等回合结束再 `send`；**不要见到就 kill**。

Use `--project` to pin the helper to a specific working directory:

```bash
ahelpa launch codex --project /path/to/project --task "Add tests for the CLI parser"
```

Kimi Code uses the `kimi` helper type and the `kimi` binary:

```bash
command -v kimi
ahelpa launch kimi --project /path/to/project --task "Review the CLI parser"
```

Use `--label` to tag sessions for easier identification:

```bash
ahelpa launch claude-code --task "Fix auth bug" --label "auth-fix"
```

Use `--parent` when a headless host needs an explicit trace ID:

```bash
ahelpa launch codex --parent "bench-run-42" --task "Review this change"
```

Use `--safe` to omit or bound the default danger flags:

```bash
ahelpa launch codex --safe --project /path/to/project --task "Review this change"
```

Safe mode is a lower-permission launch posture, not a separate OS user or VM. ahelpa records this posture and preserves it across `resume`; passing `resume --safe` can upgrade a default-posture record, but omission never downgrades an already-safe session. See [Security](security.md) for the exact driver behavior.

Kimi launches as `KIMI_CODE_NO_AUTO_UPDATE=1 kimi --yolo` by default. The canonical update flag prevents a CLI self-update from interrupting the persistent tmux session. On the first launch in a directory, ahelpa automatically selects **Trust this folder**. Kimi persists that trust and may then start project MCP servers from the directory. This automatic trust step also runs with `--safe`: Kimi safe mode only omits `--yolo` and restores native approvals; it is not a sandbox.

## Choose a Model at Launch

```bash
ahelpa models
ahelpa models codex
ahelpa launch codex --model gpt-5.6 --effort high --task "Review this change"
ahelpa launch claude-code --model sonnet --task "Review this change"
```

`models [agent]` prints the model catalog known to this ahelpa release. For Codex, `gpt-5.6` is a stable convenience alias that launches `gpt-5.6-sol`; use `gpt-5.6-terra` or `gpt-5.6-luna` explicitly when you want those variants. For Kimi, omit `--model` by default so the CLI uses the default from its `config.toml`. If you pass `--model`, the value must exactly match a complete alias already configured in that file; a display name alone may fail. `--effort` is passed through when the selected agent supports launch-time effort settings; Kimi rejects `--effort`. `resume` reuses a launch-time model alias when one was explicitly supplied.

## Switch a Running Helper Model

```bash
ahelpa model "$session_id" --to sonnet --token "$token"
ahelpa model "$session_id" --to gpt-5.4 --effort xhigh --token "$token"
```

The helper must be idle at its input prompt. Claude Code switches the current session only. Codex uses its `/model` TUI, which writes the Codex config; ahelpa restores the previous config by default after the running session changes. Add `--persist` when you want Codex's new model to remain the default.

Runtime `ahelpa model` switching is not supported for Kimi. Choose the model at launch instead.

## Wait for Completion

```bash
ahelpa wait "$session_id"
```

`wait` blocks on a named pipe until the helper prints a sentinel or the timeout expires (default 500 seconds). If it returns `still_running`, the helper hasn't finished — call `wait` again:

```bash
ahelpa wait "$session_id"  # re-wait is normal, not an error
```

For multiple helpers, pass all IDs at once:

```bash
ahelpa wait "$id1" "$id2" "$id3"           # returns when ANY finishes
ahelpa wait "$id1" "$id2" "$id3" --all     # returns when ALL finish
```

Set a custom timeout:

```bash
ahelpa wait "$session_id" --timeout 300    # 5 minutes
```

## Read Results

After a helper completes, its output lives in the project directory:

```bash
cat ".ahelpa/$session_id/summary.md"
ls ".ahelpa/$session_id/artifacts/"
```

This is the primary communication channel — files, not terminal scraping.

## Send Follow-up Work

Short follow-up message:

```bash
ahelpa send "$session_id" "Also check the error handling path." --token "$token"
```

Long follow-up via file:

```bash
ahelpa task "$session_id" --file ./next-task.md --token "$token"
```

Prefer `task` over `send` for anything longer than a sentence — it avoids tmux's keystroke-based input limits.

## Monitor Sessions

Non-blocking status check:

```bash
ahelpa check                    # all sessions
ahelpa check --parent "$id"     # sessions launched by a specific parent
```

Human-readable overview:

```bash
ahelpa status
```

Both commands perform an inline state refresh if the daemon isn't running.

## Capture Terminal Output

For debugging only — not for routine communication:

```bash
ahelpa capture "$session_id" --token "$token"             # last 50 lines
ahelpa capture "$session_id" --token "$token" --lines 100  # last 100 lines
```

## View Session Logs

Full session output, including archived output after the tmux session is gone:

```bash
ahelpa logs "$session_id" --token "$token"
```

## Resume a Completed Helper

If `check` shows an `agentResumeId`, the agent conversation can be reconnected in a new helper session. For Kimi, the `session_*` ID does not exist at initial startup; ahelpa captures it after submitting the first task message, then reconnects with `kimi --session <id>`.

With the current settle/drain lifecycle, `resume` is rejected while the old Kimi helper is still draining. Either wait until `ahelpa check` reports it as `dead`, or reclaim it explicitly for the quickest path:

```bash
ahelpa kill "$session_id" --token "$token"
ahelpa resume "$session_id" --token "$token"
```

If launch included a configured `--model` alias, the resumed helper reuses it; otherwise Kimi continues to use its configured default. A launch-time `--safe` posture is also inherited; `resume --safe` can upgrade an older default-posture record. The conversation persists through Kimi's native session ID in a new tmux session; `[AHELPA:DONE]` does not keep the original tmux session alive forever.

`resume` waits until the new driver reaches an input prompt, then returns a new helper in `needs_attention`. Send the next turn to the new session ID with `send` or `task`, then call `wait`. ahelpa waits for evidence that the new turn was accepted, recreates the FIFO, and resumes daemon monitoring; this prevents an old DONE/NEED_HELP marker from settling the follow-up.

## Reclaim Sessions

Terminate a specific session:

```bash
ahelpa kill "$session_id" --token "$token"
```

Clean up dead records and orphan runtime files (pipes, task files):

```bash
ahelpa clean
```

`clean` deletes dead session records, including their resume metadata, so an old ID cannot be resumed afterward. It does not remove archives or terminate live or draining sessions.

## Daemon Management

The daemon starts automatically on `launch` and exits when all sessions complete. You rarely need to manage it directly:

```bash
ahelpa daemon start    # manual start
ahelpa daemon stop     # manual stop
```

## Refresh Agent Skill

If the runtime is installed but the agent skill is missing or stale:

```bash
ahelpa install-skill
```

This delegates to `npx skills@latest` and installs global hard-copy skill files with explicit `codex`, `claude-code`, and `kimi-code-cli` targets.

## Timing Expectations

Helpers are full coding agents — they boot, read the task, explore the codebase, plan, execute, and signal completion. A meaningful task typically takes 2–10 minutes.

- **Wait first, ask questions later.** The 500-second default is generous. Let it run.
- **`still_running` is normal.** Re-wait. The helper is working.
- **Don't capture in the first few minutes.** It adds no information early on.
- **Polling every 30 seconds is an anti-pattern.** One `wait`, then one re-wait if needed.
- **Complex or max-effort reviews can take much longer than 10 minutes.** Keep re-waiting while there is evidence of progress. Intervene only on a concrete stalled prompt, failed tool, or explicit help request; use `capture` once, then prefer `send` before `kill`.

## Long-running Helpers

Use `ahelpa wait` itself for long-running work. Its FIFO is the efficient persistent wait surface, so do not replace it with a one-shot process or a polling messenger. Re-wait after `still_running`; for parallel helpers, pass all session IDs to one wait and add `--all` when every result is required.

See `skill/references/claude-code.md`, `skill/references/codex.md`, and `skill/references/kimi.md` for platform-specific setup.

## Troubleshooting

ahelpa is a thin layer over tmux. Every helper is a plain tmux session with a predictable name. When something seems off:

```bash
tmux ls                                # list all sessions
tmux attach -t "$session_id"           # attach and see live output
tmux capture-pane -t "$session_id" -p  # dump pane content without attaching
```

Common situations:

- **Kimi shows a moon or `Retrying`.** The cycling moon and provider backoff countdown are active work signals, even though Kimi keeps its boxed input visible. Re-run `wait`; a 120-second provider retry is not a local CLI or tmux failure.
- **Helper seems stuck.** Attach to the tmux session to see the full screen. A prompt or confirmation dialog may have appeared that the driver didn't auto-handle. Manually dismiss it — the sentinel protocol still works afterward.
- **`wait` returned but no summary.md.** The helper may have completed without writing results. Check `capture` or `logs` to see what happened.
- **Session shows `error`.** The helper printed `[AHELPA:NEED_HELP]`. Use `capture` or `logs` to see what it needs, then `send` to intervene.
- **Session shows `dead`.** The tmux session disappeared unexpectedly. Check `logs` for archived output.
