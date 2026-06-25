---
name: ahelpa
description: Agent Help Agent (ahelpa; also dictated as "A help A", "a help a", or "agent help agent") — launch, manage, and communicate with persistent helper agents via tmux. Trigger on those names, or when you need to delegate tasks to other coding agents, run parallel work, or get a fresh-context second opinion.
user-invocable: true
---

# ahelpa — Agent Help Agent

## What is ahelpa

ahelpa lets you spawn, manage, and communicate with persistent helper agents running in tmux. Use it to delegate long-running tasks, fan out work across multiple parallel agents, or get a second opinion from a fresh context without polluting your own conversation.

Public installs use GitHub Releases for the runtime and `npx skills@latest` for global hard-copy skill installation. Source checkouts can build a local skill bundle with `bun run package:skill`.

Public documentation is available in English and Simplified Chinese:

- `README.md` / `README.zh-CN.md`
- `docs/` / `docs/zh-CN/`

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/alterxyz/ahelpa/main/scripts/install.sh | bash
```

If the runtime is already installed but the skill is missing or stale:

```bash
ahelpa install-skill
```

Both commands install the skill globally as hard copies for Codex and Claude Code. If `ahelpa` is not on `PATH` after installation, run `export PATH="$HOME/.ahelpa/bin:$PATH"` in the current shell or add it to your shell profile.

## Quick Start

```bash
result=$(ahelpa launch claude-code --task "Refactor the auth module")
session_id=$(echo $result | jq -r .sessionId)
token=$(echo $result | jq -r .ownerToken)
ahelpa wait "$session_id"
cat ".ahelpa/$session_id/summary.md"
```

Helper type to CLI binary mapping:

- `claude-code` → `claude` CLI on PATH
- `codex` → `codex` CLI on PATH

Verify prerequisites with `command -v claude` or `command -v codex`, not `command -v claude-code`.

## Key Rules

1. **File handoff is the protocol.** Exchange tasks and results through files. Do not rely on `capture` to parse terminal output.
2. **`wait` blocks until completion or timeout.** Default 500 seconds. If it returns `still_running`, re-wait — this is normal, not an error.
3. **Wait on multiple helpers at once.** Use `ahelpa wait id1 id2 id3`, not one-at-a-time waits.
4. **Ownership is non-transitive.** You can only manage sessions you launched. Your helper's helpers are not yours to control.
5. **Results land in files.** After completion: `.ahelpa/<session-id>/summary.md` for the summary, `.ahelpa/<session-id>/artifacts/` for supporting files.
6. **Use `task` for long instructions.** `ahelpa task <id> --file <path>` avoids tmux keystroke limits.
7. **`capture` is for debugging only.** Not a communication channel.
8. **Tidy up.** After reading results, move useful outputs to the project tree and keep `.ahelpa/` clean.
9. **Helpers have full permissions by default.** They run as the local user. Use `--project` to scope working directories, `--safe` to omit or bound default danger flags, or git worktrees for isolation.
10. **Inline refresh works without daemon.** `wait`, `check`, and `status` refresh session state even if the daemon isn't running.
11. **Don't re-derive the CLI.** Follow this document for normal helper delegation. Only inspect `src/` or `tests/` when debugging ahelpa itself.
12. **Trust prompt handling is automatic.** The `codex` driver handles directory trust prompts by sending Enter. No manual intervention needed during normal use.

## Timing and Patience

Helpers are full coding agents. A meaningful task typically takes 2–10 minutes.

- **Wait first, ask questions later.** The 500-second default is generous.
- **`still_running` is normal.** Re-wait. The helper is working.
- **Don't capture early.** It adds no information in the first few minutes.
- **Don't poll every 30 seconds.** One wait, then one re-wait if needed.
- **Escalate after 8–10 minutes of silence.** Use `capture` once to see what's happening, then `send` to nudge or `kill` and retry.

## Command Reference

| Command | Description |
|---------|-------------|
| `launch <type> --task "..." [--label] [--project] [--parent <id>] [--safe]` | Spawn a helper. Returns JSON: `sessionId`, `ownerToken`, `tmuxSession`. |
| `wait <id...> [--all] [--timeout <seconds>]` | Block until sessions complete or timeout (default 500s). |
| `check [--parent <id>]` | Non-blocking status poll. |
| `send <id> "msg" --token <tok>` | Send a message to a running helper. |
| `capture <id> --token <tok> [--lines N]` | Snapshot terminal output (debugging only). |
| `task <id> --file <path> --token <tok>` | Deliver a task file to a running helper. |
| `model <id> --to <model> --token <tok> [--effort <level>] [--persist]` | Switch a running helper's model. |
| `kill <id> --token <tok>` | Terminate a helper session. |
| `logs <id> --token <tok>` | Read session output (live or archived). |
| `resume <id> --token <tok> [--safe]` | Resume a completed helper from its agent session. |
| `status` | Show all sessions and daemon state. |
| `clean` | Remove dead records and orphan runtime files. |
| `install-skill [--source <repo-or-path>]` | Install global hard-copy skill files for Codex and Claude Code. |
| `version` | Show installed runtime version. |
| `daemon start\|stop` | Manage the background session monitor. |

## Switching a Running Helper's Model

Use `ahelpa model <id> --to <model> --token <tok>` when a helper is idle at its input prompt. Claude Code switches the current session only. Codex switches the running session and ahelpa restores the previous Codex config by default; add `--persist` to keep the new Codex default. For Codex reasoning level, pass `--effort low|medium|high|xhigh`.

## Resume and Identity

Helpers' agent sessions can be resumed after completion. When a helper exits, ahelpa captures its resume token (e.g., `claude --resume <id>`) automatically. Use `ahelpa check` to see which sessions have resume tokens (`agentResumeId` field), then `ahelpa resume <id> --token <tok>` to reconnect.

For headless hosts, pass `--parent <id>` or set `AHELPA_PARENT_ID` explicitly. If the hosting agent exports a known session variable such as `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`, ahelpa uses it as a best-effort fallback. Use `ahelpa check` to see the full parent chain for any session.

## Sentinel Protocol

Helpers signal completion by printing sentinel strings to stdout:

- `[AHELPA:DONE]` — task finished; results written to `.ahelpa/<session-id>/`
- `[AHELPA:NEED_HELP]` — helper is stuck and needs input from the host

The daemon (or inline refresh) detects these and transitions session state: `DONE` → `idle`, `NEED_HELP` → `error`. A `wait` returning `error` means the helper asked for help — use `capture` or `logs` to see what it needs, then `send` to intervene.

## Messenger Pattern

For long tasks or multiple parallel helpers, spawn a cheap background subagent to poll rather than blocking with `wait`.

| Situation | Approach |
|-----------|----------|
| Short task, single helper | `ahelpa wait <id>` |
| Long task or multiple helpers | Spawn a messenger subagent |

Messenger prompt template:

```
You are a messenger. Your only job is:
1. Periodically run: ahelpa check
2. When a session shows idle/error/dead, inspect its .ahelpa/<session-id>/ result directory
3. Report the status and summarize summary.md plus any artifacts
4. Do NOT do any work yourself — no analysis, no coding, no modifications
5. Be patient. No results is normal. Keep checking.
```

See `references/claude-code.md` and `references/codex.md` for platform-specific messenger setup.

## Troubleshooting

ahelpa is a thin layer over tmux. Every helper is a plain tmux session:

```bash
tmux ls                                # list all sessions
tmux attach -t <session-id>            # attach and see live output
tmux capture-pane -t <session-id> -p   # dump pane content without attaching
```

Manual tmux intervention is an allowed escape hatch, not a protocol violation. After manual intervention, the sentinel protocol still works.

## Closure Gate

For development/testing of ahelpa itself:

```bash
bun run closure:gate
```

Verifies the full launch → wait → capture → kill cycle across both drivers. If `codex` returns an authentication error, fix the local `codex` CLI login state before running the gate.
