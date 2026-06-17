# Usage

[English](usage.md) | [简体中文](zh-CN/usage.md)

## Launch a Helper

```bash
result=$(ahelpa launch claude-code --task "Review src/parser.ts for edge cases")
session_id=$(echo "$result" | jq -r .sessionId)
token=$(echo "$result" | jq -r .ownerToken)
```

The `launch` command returns JSON with `sessionId`, `ownerToken`, and `tmuxSession`. Save the token — you need it for all mutating operations on this session.

Use `--project` to pin the helper to a specific working directory:

```bash
ahelpa launch codex --project /path/to/project --task "Add tests for the CLI parser"
```

Use `--label` to tag sessions for easier identification:

```bash
ahelpa launch claude-code --task "Fix auth bug" --label "auth-fix"
```

Use `--safe` to omit or bound the default danger flags:

```bash
ahelpa launch codex --safe --project /path/to/project --task "Review this change"
```

Safe mode is a lower-permission launch posture, not a separate OS user or VM. See [Security](security.md) for the exact driver behavior.

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

## Reclaim Sessions

Terminate a specific session:

```bash
ahelpa kill "$session_id" --token "$token"
```

Clean up dead records and orphan runtime files (pipes, task files):

```bash
ahelpa clean
```

`clean` does not remove archives or terminate live sessions.

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

This delegates to `npx skills@latest` and installs global hard-copy skill files for Codex and Claude Code.

## Timing Expectations

Helpers are full coding agents — they boot, read the task, explore the codebase, plan, execute, and signal completion. A meaningful task typically takes 2–10 minutes.

- **Wait first, ask questions later.** The 500-second default is generous. Let it run.
- **`still_running` is normal.** Re-wait. The helper is working.
- **Don't capture in the first few minutes.** It adds no information early on.
- **Polling every 30 seconds is an anti-pattern.** One `wait`, then one re-wait if needed.
- **Escalate after 8–10 minutes of silence on a simple task.** Use `capture` once to see what's happening, then `send` to nudge or `kill` and retry.

## Messenger Pattern

For long-running tasks or multiple parallel helpers, spawn a cheap background subagent to poll and report instead of blocking your main conversation with `wait`.

| Situation | Approach |
| --- | --- |
| Short task, single helper | `ahelpa wait` inline |
| Long task or multiple helpers | Spawn a messenger subagent |

The messenger's job is narrow: periodically run `ahelpa check`, inspect result directories when sessions complete, and report back. It should never do work itself.

See `skill/references/claude-code.md` and `skill/references/codex.md` for platform-specific messenger setup.

## Troubleshooting

ahelpa is a thin layer over tmux. Every helper is a plain tmux session with a predictable name. When something seems off:

```bash
tmux ls                                # list all sessions
tmux attach -t "$session_id"           # attach and see live output
tmux capture-pane -t "$session_id" -p  # dump pane content without attaching
```

Common situations:

- **Helper seems stuck.** Attach to the tmux session to see the full screen. A prompt or confirmation dialog may have appeared that the driver didn't auto-handle. Manually dismiss it — the sentinel protocol still works afterward.
- **`wait` returned but no summary.md.** The helper may have completed without writing results. Check `capture` or `logs` to see what happened.
- **Session shows `error`.** The helper printed `[AHELPA:NEED_HELP]`. Use `capture` or `logs` to see what it needs, then `send` to intervene.
- **Session shows `dead`.** The tmux session disappeared unexpectedly. Check `logs` for archived output.
