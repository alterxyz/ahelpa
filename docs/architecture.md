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

SQLite schema creation and migrations run in one immediate transaction. Concurrent CLI or daemon starts wait for that transaction and then inspect the committed schema, preventing duplicate-column failures when upgrading an existing runtime.

A session starts as `running` and can settle as `idle`, `error`, `needs_attention`, or `dead`. Successful sessions pass through `draining` while their terminal is being reclaimed.

1. **Launch.** `launch` generates a session ID (`{driver-prefix}-{uuid12}`) and an owner token. In a SQLite immediate transaction, it checks the caller and nesting limits and reserves the session with its parent, job, resume linkage when applicable, and launch-process marker. Only then does it create a worktree, tmux session, or handoff files and submit the first turn through the selected driver. The helper can therefore find its own row before reading its task. After task setup and FIFO preparation, launch clears the marker only if the row is still `running` and owned by the same launch PID, then starts the daemon if needed. It also checks that reservation immediately after tmux creation. A killed or removed reservation cancels startup, returns a cancellation error, and rolls back the resources this launch created. If delivery is visible but a new turn cannot yet be confirmed, launch returns a warning and retains the helper as `needs_attention`. A failed launch rolls back its reservation, tmux session, FIFO, handoff, and any worktree it created. Resume uses the same check-and-reserve path before external side effects, re-reading the source and its current parent/resume ancestry inside the transaction; a removed source is refused.

2. **Task delivery.** The driver's `prepareForTask` handles agent-specific startup (readiness checks, trust prompts). Then the task instruction is sent via `tmux send-keys` — it tells the helper to read the task file and where to write results.

3. **Post-submission setup.** The driver's `afterTaskSubmitted` hook handles any agent-specific confirmation after the first message. Kimi creates its native `session_*` ID only after this message, so the launch path captures the resume token here.

4. **Execution.** The helper reads the task file, works in the target project directory, writes results to `.ahelpa/<session-id>/summary.md` (with supporting files under `artifacts/`), and prints a sentinel string when done.

5. **Settlement.** The daemon (or inline refresh) captures tmux output, runs sentinel detection through the driver, and transitions the session. Settlement is a one-time atomic operation: update SQLite, save an archive snapshot, notify the FIFO, and clean up the pipe.

6. **Wakeup.** `wait` unblocks when the FIFO receives the settlement event. The caller reads results from the file handoff directory.

7. **Runtime cleanup.** After success, the driver requests a graceful exit and the daemon records any resume token during `draining`. It allows up to 15 seconds before reclaiming the tmux session, then leaves the session `idle`. `wait` also reports `idle` during draining. Cleanup removes temporary runtime files while retaining the SQLite result, owner token, and resume metadata so later `wait`, `logs`, and `resume` calls still work. `clean` explicitly removes settled records only when their tmux sessions are gone; it leaves draining and attention states alone.

An explicit `kill`, including each stop in `kill --tree`, preserves an existing settlement archive. For an unsettled session, the order is capture the last 500 pane lines → terminate tmux → compare-and-set commit of `dead` and the snapshot, followed by FIFO cleanup. If the row version changed, kill re-reads it and retries against the new version, with at most three commit attempts. Metadata updates, launch publication, and follow-up monitoring do not discard the captured result. A newer settlement archive owns its settled status and output, including the `idle` → `draining` window; a row already removed by `clean` is not recreated. Tree mode also skips descendants that settle during capture, and never lists the same ID in both `killed` and `missed`. Capture or archive-write failures do not prevent termination; an unavailable pane preserves any earlier archive. If termination fails while the terminal still exists, the row and archive remain unchanged. A reservation with no terminal is still marked `dead` to cancel launch publication.

Failed or cancelled launch/resume rollback removes its reservation unless child records or active resume ancestry still need that lineage link. In that case it retains a `dead` tombstone with the launch PID cleared. Dead tombstones do not count against active-session quotas. `clean` retains required ancestors and reclaims them once their descendants have settled and their terminals have exited; archives remain available.

### State Transitions

```
launch ──► running
              │
              ├── [AHELPA:DONE] detected ──────► draining ──► idle
              ├── [AHELPA:NEED_HELP] detected ──► error
              ├── sustained inactivity ────────► needs_attention
              └── tmux session gone ───────────► dead

idle/dead + native resume token ── resume ─► needs_attention ── send/task ─► running
```

Sending input to a `needs_attention` session resumes monitoring as `running` after the driver confirms a new user turn. The transition is conditional: a concurrent `kill` remains authoritative even if input submission was already in progress. If its terminal disappears instead, it becomes `dead`.

A reservation starts as `running` and carries a launch-process marker while launch or resume is setting it up. Daemon and inline refresh skip it while that process is alive and the reservation is younger than the three-minute startup lease (`LAUNCH_STARTUP_LEASE_MS`, measured from `created_at`), so an absent tmux session or an old sentinel cannot settle it during setup. The lease exceeds the slowest driver budget: Codex allows 82 seconds for readiness and 5 seconds for submission. A missing launcher or expired lease clears the marker conditionally and resumes reconciliation, even if the PID has been reused. An unpublished resume becomes `needs_attention`, waiting for a new task, so old native DONE output cannot settle it. `wait` treats setup as pending and retains its deadline even before the FIFO exists.

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

Preparing an existing FIFO reuses its inode, keeping current readers connected. Concurrent preparations converge on the same pipe; a regular file or symbolic link at that path is rejected and preserved.

## Daemon

The daemon is an optional background process that watches running sessions. It starts automatically on `launch` and exits when no active sessions remain.

**Poll loop (every 3 seconds):**

1. Check whether each monitored tmux session is still alive.
2. If a running or attention session disappears, settle as `dead`. If a draining session disappears, preserve its successful result as `idle`.
3. For running sessions, capture output and run driver sentinel and activity detection.
4. On success, request graceful exit, capture the resume token, and reclaim the terminal after the drain timeout. Restarted monitors honor the recorded drain window.
5. A capture or kill failure is logged for that session. If its terminal disappeared, reconcile the final state; otherwise retry on a later poll. Other sessions continue refreshing.
6. When no running, draining, or attention sessions remain, the daemon exits.

**Inline refresh.** When the daemon is not running, `wait`, `check`, and `status` perform the same refresh logic inline before reporting state. Short-lived tasks work fine without a persistent daemon. A tmux permission or connection error is not proof of session death: the monitor retains state and retries. `clean` preserves reserved launches and checks for live terminals before removing orphan runtime files.

**Process management:** PID file at `~/.ahelpa/daemon.pid`, log at `~/.ahelpa/daemon.log`. There is no supervisor that restarts a crashed daemon immediately. The next launch or resume starts it when the PID liveness check reports it stopped; meanwhile `wait`, `check`, and `status` use inline refresh when no daemon is detected.

## Drivers

### Upstream interfaces reviewed on 2026-10-02

| Official source | Implication for ahelpa |
| --- | --- |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Structured turn events distinguish completion, failure, and interruption; some APIs require explicit experimental opt-in. A future driver should use stable lifecycle methods and native thread IDs. |
| [Kimi ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp) and [Wire](https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html) | Bidirectional JSON-RPC is an alternative to terminal parsing. Probe the installed CLI's protocol capabilities before choosing a transport; documentation for different Kimi distributions may differ. |
| [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup) | Check the advertised `loadSession` capability before attempting native resume. |
| [Claude hooks](https://code.claude.com/docs/en/hooks) | `Stop`, `StopFailure`, and `SessionEnd` represent different lifecycle events. A finished response alone does not prove the assigned task succeeded. |

The current implementation keeps tmux and file handoff. Adopting these transports requires a supervised process that outlives the caller, capability negotiation, approval handling, cancellation, and reconnection tests. Add one driver at a time behind the existing command contract. Before making it the default, verify launch, interruption, restart, native resume, and result delivery; keep the same owner-token and safe-mode guarantees. Structured transports are a follow-up design direction, not an implemented feature of this release.

### Current terminal drivers

Optional driver `launchProfiles` define supported roles and their default model/effort. `launch-profiles.ts` resolves the role and explicit overrides once during launch planning. The resulting role, model, and effort are stored with the session and returned to the host. Claude supports `advisor` (default) and `worker`; Codex only supports `worker`; Kimi leaves the role unset and retains native model defaults. Roles do not alter task instructions or permissions. Resume uses the stored settings directly, including unknown values in legacy records, and never reapplies current launch presets.

Drivers encapsulate agent-specific terminal behavior so that launch orchestration stays generic. A driver defines:

| Responsibility | Example |
| --- | --- |
| Session prefix | `claude`, `codex`, `kimi` |
| Launch command | `claude --dangerously-skip-permissions --verbose`, `codex --dangerously-bypass-approvals-and-sandbox`, `KIMI_CODE_NO_AUTO_UPDATE=1 kimi --yolo` |
| Pre-task readiness | Wait for CLI to be ready, handle trust prompts |
| Post-submission handling | Press Enter if needed; capture a newly created native session ID |
| Sentinel detection | Delegates to shared sentinel matching in `src/drivers/sentinels.ts` |

The supported drivers are `claude-code`, `codex`, and `kimi`. All three share the same sentinel protocol and file handoff paths — they differ only in startup commands and interactive prompt handling. On Kimi's first launch in a directory, its driver automatically selects **Trust this folder**. Kimi persists that trust and may then start project MCP servers from the directory. Kimi initially shows no native session ID; after the first task message creates a `session_*` ID, ahelpa records it and resumes with `kimi --session <id>`.

`launch --safe` passes a safe-mode hint into the selected driver and stores it with the session. Native resume inherits that posture; `resume --safe` can upgrade a default-posture record, but an omitted flag cannot downgrade a safe one. Claude Code omits `--dangerously-skip-permissions`; Codex uses `-s workspace-write -a never` instead of `--dangerously-bypass-approvals-and-sandbox`; Kimi omits `--yolo` and therefore restores its native approval flow. Kimi still automatically trusts the project directory in safe mode, so its safe mode is not a sandbox.

Kimi sets the canonical `KIMI_CODE_NO_AUTO_UPDATE=1` flag so a CLI self-update cannot interrupt its persistent tmux session. It starts without a model flag by default and uses the default from its `config.toml`. A launch-time `--model` value must exactly match a complete alias already configured there; resume reuses it when present. Kimi does not support `--effort` or runtime `ahelpa model` switching.

After Kimi prints `[AHELPA:DONE]`, `resume` is rejected while the old helper is draining. The host can wait for daemon reclamation until `check` reports `idle` and the terminal is gone, or explicitly `kill` the helper, then resume. All settled records are retained until `clean`; completed and legacy dead records with an `agentResumeId` can be resumed. `clean` deletes settled records and their resume metadata only after the terminal is gone; it preserves live, draining, and attention sessions. Persistence means reconnecting the native Kimi session in a new tmux session, not preserving the original tmux process indefinitely.

## Nesting

Helpers can launch their own helpers, creating a session lineage. Each child session records its parent ID, but ownership is not transitive — a host controls only the sessions it directly launched.

Launch and resume check the actual caller and recursion bounds, then reserve the new session in the same SQLite immediate transaction before external side effects. Concurrent callers cannot claim the same last slot. The bounds are:

| Bound | Default | Override | What it stops |
| --- | --- | --- | --- |
| Depth of a chain | 4 | `AHELPA_MAX_NESTING_DEPTH` | A helper that keeps delegating downward |
| Active sessions in one tree (the root helper and all its descendants, counting `running`, `draining`, and `needs_attention`) | 8 | `AHELPA_MAX_ACTIVE_PER_TREE` | A helper that fans out sideways at a legal depth |
| Launch or resume from a `reviewer` caller | refused | none | A read-only review hand delegating edits, or letting the author's reasoning reach the review |

Each direct host launch starts a separate helper tree; there is no aggregate quota across the host's independent roots. `clean` retains every parent and resume ancestor needed by sessions it will keep in this pass, including startup reservations, running/draining/attention sessions, and settled idle/error sessions with live terminals. This covers the idle-to-draining settlement window, so cleanup cannot split their tree quota. Those records become removable after their descendants settle and their terminals exit. Resume retains the original parent and never lowers recorded depth; a deeper actual caller can raise that depth. A resumed root remains in its original tree through the existing `resumed_from` link. Both limit values are exported into every helper's environment.

The actual caller is the existing SQLite session named by `AHELPA_PARENT_ID`, independently of an explicit `--parent`. A reviewer caller is always refused; a helper's `--parent` must stay inside its own tree, and checks cover the actual caller's depth as well as the requested parent. Host callers can still use arbitrary parent trace IDs. Jobs are independent of trees: explicit `--job` takes precedence over the `--after` session's stored job and then the actual caller's stored job; host-shell `AHELPA_JOB_ID` does not provide inheritance.

## Archives

When a session settles, a final snapshot is saved under `~/.ahelpa/archive/<session-id>/`. This keeps `logs` useful after the tmux session has been cleaned up. Archives are written by the daemon (or inline refresh) during settlement and by explicit `kill` before terminal termination; they are not automatically pruned.

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
| `drivers/kimi.ts` | Kimi Code driver |
