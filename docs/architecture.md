# Architecture

[English](architecture.md) | [简体中文](zh-CN/architecture.md)

ahelpa is a local helper runtime built around a small set of durable primitives: tmux for persistent terminals, SQLite for session state, named pipes for zero-poll blocking, files for task/result exchange, and driver adapters for agent-specific behavior.

## System Overview

```
host agent
  │
  │ ahelpa launch claude-code --task "..."
  ▼
ahelpa CLI ──────────► tmux session
  │                       │
  │                       ▼
  │                   helper agent
  │                       │
  │                       ├── reads task file
  │                       ├── works in project directory
  │                       ├── writes .ahelpa/<id>/summary.md
  │                       └── prints [AHELPA:DONE]
  │
  ├── SQLite: session record (id, status, token, lineage)
  ├── /tmp/ahelpa/<id>.pipe: FIFO for wait wakeup
  ├── /tmp/ahelpa/ahelpa-task-<id>.md: task file
  └── daemon: watches sessions, detects sentinels, settles state
```

## Session Lifecycle

A session starts as `running` and can settle as `idle`, `error`, `needs_attention`, or `dead`. Successful sessions pass through `draining` while their terminal is being reclaimed.

1. **Launch.** `launch` generates a session ID (`{driver-prefix}-{uuid8}`) and an owner token. It writes the task to a temp file, creates a tmux session through the selected driver, prepares a FIFO pipe, records the session in SQLite, and starts the daemon if it isn't running.

2. **Task delivery.** The driver's `prepareForTask` handles agent-specific startup (readiness checks, trust prompts). Then the task instruction is sent via `tmux send-keys` — it tells the helper to read the task file and where to write results.

3. **Execution.** The helper reads the task file, works in the target project directory, writes results to `.ahelpa/<session-id>/summary.md` (with supporting files under `artifacts/`), and prints a sentinel string when done.

4. **Settlement.** The daemon (or inline refresh) captures tmux output, runs sentinel detection through the driver, and transitions the session. Settlement is a one-time atomic operation: update SQLite, save an archive snapshot, notify the FIFO, and clean up the pipe.

5. **Wakeup.** `wait` unblocks when the FIFO receives the settlement event. The caller reads results from the file handoff directory.

6. **Runtime cleanup.** After success, the driver requests a graceful exit and the daemon records any resume token during `draining`. It allows up to 15 seconds before reclaiming the tmux session, then leaves the session `idle`. `wait` also reports `idle` during draining. Cleanup removes temporary runtime files while retaining the SQLite result, owner token, and resume metadata so later `wait`, `logs`, and `resume` calls still work. `clean` explicitly removes settled records only when their tmux sessions are gone; it leaves draining and attention states alone.

### State Transitions

```
launch ──► running
              │
              ├── [AHELPA:DONE] detected ──────► draining ──► idle
              ├── [AHELPA:NEED_HELP] detected ──► error
              ├── sustained inactivity ────────► needs_attention
              └── tmux session gone ───────────► dead
```

Sending input to a `needs_attention` session resumes monitoring as `running`. If its terminal disappears instead, it becomes `dead`.

`still_running` is a wait-specific return value, not a session state — it means the timeout expired before settlement.

## File Handoff

Terminal capture is available for debugging, but files are the durable protocol:

| Direction | Mechanism |
| --- | --- |
| Host → helper | Task file at `/tmp/ahelpa/ahelpa-task-<id>.md` |
| Helper → host | `<project>/.ahelpa/<id>/summary.md` + `artifacts/` |
| Completion signal | Sentinel line (`[AHELPA:DONE]` or `[AHELPA:NEED_HELP]`) printed to stdout |

The task instruction sent to each helper includes the exact paths for reading the task and writing results. This instruction is built by `src/file-handoff.ts` and is the same across all drivers.

## Wakeup Protocol

`wait` blocks on a named pipe (FIFO) rather than polling SQLite. The lifecycle:

1. `launch` creates the pipe at `/tmp/ahelpa/<id>.pipe`.
2. The daemon writes a JSON event (`{sessionId, status}`) when the session settles.
3. `wait` reads the pipe and unblocks.
4. After notification, the pipe is cleaned up.

If no one is waiting (no reader on the pipe), the write is dropped — the SQLite row remains the source of truth. If `wait` is called after settlement, it reads the terminal state from SQLite and returns immediately.

## Daemon

The daemon is an optional background process that watches running sessions. It starts automatically on `launch` and exits when no active sessions remain.

**Poll loop (every 3 seconds):**

1. Check whether each monitored tmux session is still alive.
2. If a running or attention session disappears, settle as `dead`. If a draining session disappears, preserve its successful result as `idle`.
3. For running sessions, capture output and run driver sentinel and activity detection.
4. On success, request graceful exit, capture the resume token, and reclaim the terminal after the drain timeout. Restarted monitors honor the recorded drain window.
5. A capture or kill failure is logged for that session. If its terminal disappeared, reconcile the final state; otherwise retry on a later poll. Other sessions continue refreshing.
6. When no running, draining, or attention sessions remain, the daemon exits.

**Inline refresh.** When the daemon is not running, `wait`, `check`, and `status` perform the same refresh logic inline before reporting state. Short-lived tasks work fine without a persistent daemon.

**Process management:** PID file at `~/.ahelpa/daemon.pid`, log at `~/.ahelpa/daemon.log`. Crash recovery is automatic — the next `launch` restarts it.

## Drivers

Drivers encapsulate agent-specific terminal behavior so that launch orchestration stays generic. A driver defines:

| Responsibility | Example |
| --- | --- |
| Session prefix | `claude`, `codex` |
| Launch command | `claude --dangerously-skip-permissions --verbose`, `codex --dangerously-bypass-approvals-and-sandbox` |
| Pre-task readiness | Wait for CLI to be ready, handle trust prompts |
| Post-submission nudge | Press Enter if the prompt queued but didn't submit |
| Sentinel detection | Delegates to shared sentinel matching in `src/drivers/sentinels.ts` |

The supported drivers are `claude-code` and `codex`. Both share the same sentinel protocol and file handoff paths — they differ only in startup commands and interactive prompt handling.

`launch --safe` passes a safe-mode hint into the selected driver. Claude Code omits `--dangerously-skip-permissions`; Codex uses `-s workspace-write -a never` instead of `--dangerously-bypass-approvals-and-sandbox`.

## Nesting

Helpers can launch their own helpers, creating a session lineage. Launch validates a maximum depth (default 4, configurable via `AHELPA_MAX_NESTING_DEPTH`). Each child session records its parent ID, but ownership is not transitive — a host controls only the sessions it directly launched.

## Archives

When a session settles, a final snapshot is saved under `~/.ahelpa/archive/<session-id>/`. This keeps `logs` useful after the tmux session has been cleaned up. Archives are managed by the daemon (or inline refresh) during settlement and are not automatically pruned.

The retained SQLite record supplies ownership checks and resume settings. Running `clean` removes that record, so subsequent token-gated `logs` and `resume` calls for that session are no longer available; archive and project handoff files remain on disk.

## Module Map

| Module | Responsibility |
| --- | --- |
| `cli.ts` | Process shell: opens DB, calls `runCli`, returns exit code |
| `command-contract.ts` | Command registry: usage text, flag schemas, handlers, dispatch |
| `commands/launch.ts` | Launch orchestration: plan + execute |
| `commands/wait.ts` | Wait orchestration: FIFO blocking + timeout + multi-session |
| `commands/session-ops.ts` | Operations on existing sessions |
| `daemon.ts` | Background monitor: poll loop, inline refresh, process management |
| `settle.ts` | Atomic settlement: update DB + archive + notify + cleanup |
| `session-lifecycle.ts` | Status enum and capture-to-status mapping |
| `session-access.ts` | Owner token validation and session lookup |
| `file-handoff.ts` | Task/result path planning and instruction generation |
| `wakeup.ts` | FIFO-based wakeup protocol |
| `fifo.ts` | Named pipe primitives |
| `nesting.ts` | Lineage tracking and depth validation |
| `runtime-layout.ts` | All filesystem path conventions |
| `tmux.ts` | tmux command wrappers |
| `archive.ts` | Archive read/write |
| `drivers/sentinels.ts` | Sentinel strings and matching rules |
| `drivers/types.ts` | AgentDriver interface |
| `drivers/registry.ts` | Driver lookup by agent type |
| `drivers/claude-code.ts` | Claude Code driver |
| `drivers/codex.ts` | Codex driver |
