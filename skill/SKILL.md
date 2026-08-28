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

Both commands install the skill globally as hard copies through the explicit `codex`, `claude-code`, and `kimi-code-cli` targets. If `ahelpa` is not on `PATH` after installation, run `export PATH="$HOME/.ahelpa/bin:$PATH"` in the current shell or add it to your shell profile.

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
- `kimi` → `kimi` CLI on PATH

Verify prerequisites with `command -v claude`, `command -v codex`, or `command -v kimi`, not `command -v claude-code`.

## Key Rules

1. **Prefer ahelpa for substantive cross-agent work.** Reviews, implementation tasks, long investigations, and work that may need follow-up belong in ahelpa by default. A tmux helper survives the caller, isolates the helper's context, makes progress inspectable without coupling it to the host turn, preserves durable results through file handoff, blocks efficiently through FIFO wait, scopes control through owner tokens, and retains native session IDs for recovery and follow-up. These properties also make failures diagnosable and handoffs auditable. Use a one-shot CLI invocation only for a genuinely short, stateless probe where none of those properties adds value.
2. **File handoff is the protocol.** Exchange tasks and results through files. Do not rely on `capture` to parse terminal output.
3. **`wait` blocks until completion or timeout.** Default 500 seconds. If it returns `still_running`, re-wait — this is normal, not an error.
4. **Wait on multiple helpers at once.** Use `ahelpa wait id1 id2 id3`, not one-at-a-time waits.
5. **Ownership is non-transitive.** You can only manage sessions you launched. Your helper's helpers are not yours to control.
6. **Results land in files.** After completion: `.ahelpa/<session-id>/summary.md` for the summary, `.ahelpa/<session-id>/artifacts/` for supporting files.
7. **Use `task` for long instructions.** `ahelpa task <id> --file <path>` avoids tmux keystroke limits.
8. **`capture` is for debugging only.** Not a communication channel.
9. **Tidy up.** After reading results, move useful outputs to the project tree and keep `.ahelpa/` clean.
10. **Helpers have full permissions by default.** They run as the local user. Use `--project` to scope working directories, `--safe` to omit or bound default danger flags, or git worktrees for isolation. `--project` sets the task boundary but is not a filesystem sandbox, so prompts should explicitly forbid unrelated home directories, global ahelpa archives, and other projects unless the task truly needs them. For Kimi, `--safe` only restores native approvals by omitting `--yolo`; it still auto-trusts the project and is not a sandbox.
11. **Inline refresh works without daemon.** `wait`, `check`, and `status` refresh session state even if the daemon isn't running.
12. **Don't re-derive the CLI.** Follow this document for normal helper delegation. Only inspect `src/` or `tests/` when debugging ahelpa itself.
13. **Trust prompt handling is automatic.** The Codex and Kimi drivers handle their directory trust prompts. On Kimi's first launch, ahelpa selects **Trust this folder**; Kimi persists that trust and may start project MCP servers from the directory. No manual intervention is needed during normal use.

## Timing and Patience

Helpers are full coding agents. A meaningful task typically takes 2–10 minutes.

- **Wait first, ask questions later.** The 500-second default is generous.
- **`still_running` is normal.** Re-wait. The helper is working.
- **Don't capture early.** It adds no information in the first few minutes.
- **Don't poll every 30 seconds.** One wait, then one re-wait if needed.
- **Complex or max-effort reviews can take much longer than 10 minutes.** Keep re-waiting while there is evidence of progress. Intervene only after a concrete stalled prompt, failed tool, or explicit request for help; then use `capture` once and `send` before considering `kill`.

## Command Reference

| Command | Description |
|---------|-------------|
| `launch <type> --task "..." [--label] [--project] [--parent <id>] [--safe] [--model <model>] [--effort <level>]` | Spawn a helper. Returns JSON: `sessionId`, `ownerToken`, `tmuxSession`. |
| `wait <id...> [--all] [--timeout <seconds>]` | Block until sessions complete or timeout (default 500s). |
| `check [--parent <id>]` | Non-blocking status poll. |
| `models [agent]` | List launch-time model options. |
| `send <id> "msg" --token <tok>` | Send a message to a running helper. |
| `capture <id> --token <tok> [--lines N]` | Snapshot terminal output (debugging only). |
| `task <id> --file <path> --token <tok>` | Deliver a task file to a running helper. |
| `model <id> --to <model> --token <tok> [--effort <level>] [--persist]` | Switch a running helper's model. |
| `kill <id> --token <tok>` | Terminate a helper session. |
| `logs <id> --token <tok>` | Read session output (live or archived). |
| `resume <id> --token <tok> [--safe]` | Resume a dead helper; an existing safe posture is inherited. |
| `status` | Show all sessions and daemon state. |
| `clean` | Remove dead records, their resume metadata, and orphan runtime files. |
| `install-skill [--source <repo-or-path>]` | Install global hard-copy skill files for Codex, Claude Code, and Kimi Code CLI targets. |
| `version` | Show installed runtime version. |
| `daemon start\|stop` | Manage the background session monitor. |

## Choosing a Model at Launch

Use `ahelpa models` or `ahelpa models codex` to inspect the model information known to this ahelpa release. Pass `--model <model>` to `launch` when a helper should start on a specific model. Pass `--effort <level>` when the selected agent supports launch-time effort settings. `resume` reuses recorded launch settings that the selected driver supports, including a sticky safe posture; `resume --safe` can upgrade a default-posture record but omission cannot downgrade a safe one.

Examples:

```bash
ahelpa launch codex --model gpt-5.5 --effort high --task "Review this change"
ahelpa launch claude-code --model sonnet --task "Review this change"
ahelpa launch kimi --task "Review this change"
```

For Kimi, ahelpa sets `KIMI_CODE_NO_AUTO_UPDATE=1` so a CLI self-update cannot interrupt the persistent tmux session. Omit `--model` by default so the CLI uses the default from its `config.toml`. If you pass `--model`, the value must exactly match a complete alias already configured in that file; a display name alone may fail. `resume` reuses an explicitly supplied alias. Kimi does not support `--effort`.

## Switching a Running Helper's Model

Use `ahelpa model <id> --to <model> --token <tok>` when a helper is idle at its input prompt. Claude Code switches the current session only. Codex switches the running session and ahelpa restores the previous Codex config by default; add `--persist` to keep the new Codex default. For Codex reasoning level, pass `--effort low|medium|high|xhigh`.

Runtime `ahelpa model` switching is not supported for Kimi. Choose its model when launching the helper.

## Resume and Identity

Helpers' native agent sessions can be resumed after completion and tmux reclamation. ahelpa captures each driver's resume token when it becomes available (e.g., the ID for `claude --resume <id>`). Kimi creates its `session_*` ID only after the first task message; ahelpa captures it after submission and reconnects with `kimi --session <id>`. Use `ahelpa check` to see which sessions have resume tokens (`agentResumeId` field).

For Kimi, `resume` is rejected while the old helper is still draining after `[AHELPA:DONE]`. Wait until `ahelpa check` reports `dead`, or run `ahelpa kill <id> --token <tok>`, then run `ahelpa resume <id> --token <tok>`. A dead record with an `agentResumeId` remains resumable until `clean`; cleaning it deletes the resume metadata. Persistence means reconnecting the native Kimi session in a new tmux session, not keeping the original tmux process alive forever.

`resume` waits for the new driver prompt, then returns a `needs_attention` helper that is ready for its next turn. Send the follow-up with `send` or `task`, then call `wait` on the new session ID. The submission hook waits for evidence of a new user turn, rebuilds the FIFO, and restarts daemon monitoring when necessary, so historical DONE/NEED_HELP markers are not reused.

For headless hosts, pass `--parent <id>` or set `AHELPA_PARENT_ID` explicitly. If the hosting agent exports a known session variable such as `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`, ahelpa uses it as a best-effort fallback. Use `ahelpa check` to see the full parent chain for any session.

## Sentinel Protocol

Helpers signal completion by printing sentinel strings to stdout:

- `[AHELPA:DONE]` — task finished; results written to `.ahelpa/<session-id>/`
- `[AHELPA:NEED_HELP]` — helper is stuck and needs input from the host

The daemon (or inline refresh) detects these and transitions session state: `DONE` → `idle`, `NEED_HELP` → `error`. A `wait` returning `error` means the helper asked for help — use `capture` or `logs` to see what it needs, then `send` to intervene.

## Long-running Helpers

Use `ahelpa wait` itself for long tasks; FIFO blocking is the efficient, durable waiting surface. Do not replace it with a one-shot helper or a polling messenger. If a wait returns `still_running`, re-wait on the same session. For parallel helpers, pass every ID to one `ahelpa wait` call (and use `--all` when all results are required).

See `references/claude-code.md`, `references/codex.md`, and `references/kimi.md` for platform-specific setup.

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

Verifies the full launch → wait → capture → kill cycle across all three drivers. If `claude`, `codex`, or `kimi` returns an authentication error, fix that CLI's local login state before running the gate.
