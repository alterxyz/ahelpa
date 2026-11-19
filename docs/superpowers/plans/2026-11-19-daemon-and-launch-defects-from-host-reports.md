# Daemon and launch defects reported by a host project — open work

> Recorded 2026-11-19 against v0.16.0 (`34f389c`). A host project that drives ahelpa every night logged these between 2026-08-29 and 2026-10-25 and kept them on its own tracker; they are ahelpa's to fix, so they move here. Each item says what was re-checked in the v0.16.0 source and what is still unknown. Items 1, 2, 3 and 5 were fixed on 2026-11-19 (branch `claude/daemon-defects-2fc830`, not yet released); item 4 is still open.

## 1. No build identity between the CLI and a running daemon

- [x] Decide whether `startDaemon` should compare build identity with a running daemon and restart or warn on a mismatch. **Decided 2026-11-19: warn, never restart.**

Done: `startDaemon()` writes the CLI's build identity to `daemon.build` beside `daemon.pid`; `stopDaemon()` removes it. A build is `VERSION`, the program file it runs from (the compiled binary, or `cli.ts` for a source run, symlinks resolved) and when it last changed (the binary's mtime; for a source run, the newest `.ts` mtime under `src/`), so a binary replaced in place by `deploy-local.sh` or an installer, or any edited source file, counts as a new build. `status` prints `ahelpa daemon: running (build …)` (the `^ahelpa daemon: running` prefix that `deploy-local.sh` greps is kept), and `status` and `launch` print a warning on stderr when the running daemon's build differs from the CLI's, or was not recorded (a daemon started by an older build). The warning names the fix: `ahelpa daemon stop && ahelpa daemon start`.

Why warn and not restart: (1) the installed binary and a source checkout (`bun run src/cli.ts`) legitimately share one `~/.ahelpa`; with auto-restart each would restart the other's daemon on every call. (2) Stopping the daemon does not stop helpers (they live in tmux; `deploy-local.sh` already relies on this), but SIGTERM can land mid-iteration, between a settle commit and the wakeup or need-help ledger append, so a restart is not free and should be a deliberate act. (3) The daemon exits by itself when no session is active, so a stale daemon lasts only until the current helpers finish, and the next launch starts the new build. Warning is reversible; auto-restart can be added later if mismatches keep being ignored. Known limits: mtimes, not content, so a copy with a fresh mtime warns and a replacement that keeps path and mtime (`cp -p`) does not. The check compares the CLI with the running daemon; it does not report an installed binary that is behind the source HEAD (the 2026-11-16 observation), which stays a deploy question. A first review (codex, 2026-11-19) found that the first version keyed source runs on `cli.ts` alone and missed edits to `daemon.ts`; fixed by taking the newest `.ts` file.

Observed: 2026-08-29 a daemon kept running an older build after the CLI was upgraded; the host could not tell from `status`. 2026-11-16 the CLI and the daemon happened to be the same 0.15.0 file, but the installed binary was one commit behind the source HEAD, which is the kind of gap nothing reports.

v0.16.0 source: `isDaemonRunning()` (`src/daemon.ts`) only checks that the PID in the PID file is alive (`process.kill(pid, 0)`); `startDaemon()` returns early when it is. No handshake carries a version or build hash. `638ad2b` restarts a running daemon in `scripts/deploy-local.sh`, which covers that path but not a CLI replaced any other way. The row-version fence of `42efc85` is about session rows, not builds.

## 2. `daemonLoop` has no outer error handling

- [x] Wrap one loop iteration so a thrown error (DB read, refresh) is logged and the loop continues or exits with a recorded reason, instead of the daemon silently disappearing. Done 2026-11-19: a failed iteration writes `daemon loop failed: <error>` to `daemon.log`, sleeps one poll interval and continues; after 10 consecutive failures (about 30 s) it writes `daemon exiting after 10 consecutive loop failures: <error>` and exits, so a daemon whose state is broken does not poll forever. A successful iteration resets the count.
- [x] `startDaemon()` swallows spawn errors (`catch { /* ignore */ }`); consider writing the error to `daemon.log` so "daemon: stopped" has a cause. Done 2026-11-19: it writes `daemon start failed: <error>` to `daemon.log`; the caller still sees the daemon as stopped.

Observed: 2026-08-29 `daemon.log` held one real crash; 2026-09-22 two Codex launches failed while `status` showed `daemon: stopped`. 2026-11-16 `daemon.stderr.log` was empty and no recent crash was seen, so this is structural, not currently firing.

v0.16.0 source: `daemonLoop` calls `db.listActiveSessions()` and `refreshSessionStatuses()` inside `while (true)` with no `try`. Per-row refresh has its own catch (`refreshFailures`), the outer calls do not.

## 3. `--after` does not wait for a running previous hand

- [x] Decide: refuse, warn, or wait when `launch --after <id>` names a session that is still `running`. **Decided 2026-11-19: warn.**

Done: when the `--after` session is `running` as `launch` starts (read before launching, so a previous hand that settles while launch confirms the turn still warns; the first version read it afterwards and missed that, found by the 2026-11-19 review), `launch` still starts the helper and prints one line on stderr after the JSON that names both IDs and says to `wait` for the previous hand first, or kill the new one and relaunch once the previous has settled. `docs/usage.md` and `docs/zh-CN/usage.md` describe it.

Why not refuse: `--after` is documented as lineage plus handoff, and hosts may use it to join a running job or keep a parallel hand's lineage; refusing would break those calls, a contract change for a usability gap. Why not wait: `launch` returns in seconds and hosts call it inside tool calls with their own timeouts; a launch that blocks for a whole review would hide that time, against the rule that waits stay bounded and explicit (`wait` exists for this). Only `running` warns: `needs_attention` and settled hands have stopped, so the host has already decided what to do with them.

Observed 2026-10-22: a worker was launched `--after` a reviewer that was still running. It started at once, found the review missing, and stopped with no writes. The host then waited by hand.

v0.16.0: this is documented behavior (`docs/usage.md`: "`--after` alone records lineage and that handoff"), so it is a usability gap, not a bug. A one-line warning on stderr when the previous hand is not settled would have prevented the incident.

## 4. Claude launch: "did not expose the submitted task as a new turn"

- [ ] Reproduce on v0.16.0 with a bounded loop of Claude launches and record the rate; the existing watch item in `2026-10-08-helper-contract-and-evidence.md` covers the Codex form of the same error.

Observed: 2026-10-22 three Claude launches failed this way in one night (a retry succeeded); 2026-10-24/25 six more distinct sessions, some with the task bootstrap text still in the native composer, and three in a row on one task. Root cause not established: not shown to be model, quota or permission.

v0.16.0 source: the error is still raised in `src/commands/launch.ts` after `afterTaskSubmitted`. The nine Claude failure screens kept in `launch-failures/` from 2026-11-02 to 2026-11-14 all show the folder-trust prompt, a different cause; the four from 2026-10-28 to 2026-11-01 were not classified. Launches were not counted, so the absence of newer instances is not evidence of a fix.

## 5. Small: the session ID is easy to miss in `launch` output

- [x] Consider printing `sessionId` last (or repeating it) when a long `writerConflict` list precedes it. Done 2026-11-19: `tmuxSession`, which always equals `sessionId`, is now the last field of the `launch` JSON, so the ID is printed first and last. The key set and values are unchanged, so `jq .sessionId` and object comparisons are unaffected; only the key order changed. Stderr warnings (items 1 and 3) come after the JSON, and the `--after` warning repeats the new ID too.

Observed 2026-10-22: a host read the output with `tail`, missed the ID, and launched a duplicate helper.
