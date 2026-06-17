# ahelpa — Domain Language

> This file defines project terms. Development workflow and guardrails live in `AGENTS.md`.

## Terms

**Helper** — A persistent coding-agent session launched by another agent. A helper can be a peer reviewer, a parallel worker, or a fresh-context clone.

**Host** — The agent that launches a helper and owns the returned token. A host controls only sessions it created directly.

**Session** — One helper runtime entity: a tmux session plus a SQLite record. The session ID doubles as the tmux session name.

**Driver** — An adapter for one helper type. Drivers own startup commands, readiness checks, trust prompt handling, post-submission nudges, and sentinel detection.

**Sentinel protocol** — Helpers print `[AHELPA:DONE]` or `[AHELPA:NEED_HELP]` to declare completion or request assistance. Sentinel strings and matching rules live in `src/drivers/sentinels.ts`.

**Wakeup protocol** — `wait` blocks on a named pipe (FIFO). When a session settles, the daemon writes a wakeup event through the pipe. Pipe paths and payload handling live in `src/wakeup.ts`.

**Settle** — The one-time transition of a running session to a terminal state: update SQLite, save archive snapshot, notify waiters via FIFO, clean up the pipe.

**File handoff** — Tasks and results are exchanged through files, not terminal scraping. Helpers read task files and write `.ahelpa/<session-id>/summary.md` plus supporting files under `artifacts/`. The instruction text is built by `src/file-handoff.ts`.

**Owner token** — The operation credential returned by `launch`. All mutating session operations require it.

**Nesting** — The lineage depth of helper sessions. Launch validates a maximum depth (default 4).

**Messenger** — A lightweight polling subagent that checks helper status and reports results. A usage pattern, not a daemon component.

**Archive** — The final snapshot saved under `~/.ahelpa/archive/<session-id>/`. Keeps `logs` useful after the tmux session is gone.

**Session ops** — Operations on existing sessions: `send`, `capture`, `task`, `kill`, `logs`, `check`, `status`, `clean`.

**Command contract** — The single source of truth for CLI usage text, flag schemas, and handlers in `src/command-contract.ts`.

**Closure gate** — The local end-to-end verification check: test, build, launch, wait/check, capture, and kill across supported drivers.
