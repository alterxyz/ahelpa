# Daemon and launch defects reported by a host project — open work

> Recorded 2026-11-19 against v0.16.0 (`34f389c`). A host project that drives ahelpa every night logged these between 2026-08-29 and 2026-10-25 and kept them on its own tracker; they are ahelpa's to fix, so they move here. Nothing below is fixed yet. Each item says what was re-checked in the v0.16.0 source today and what is still unknown.

## 1. No build identity between the CLI and a running daemon

- [ ] Decide whether `startDaemon` should compare build identity with a running daemon and restart or warn on a mismatch.

Observed: 2026-08-29 a daemon kept running an older build after the CLI was upgraded; the host could not tell from `status`. 2026-11-16 the CLI and the daemon happened to be the same 0.15.0 file, but the installed binary was one commit behind the source HEAD, which is the kind of gap nothing reports.

v0.16.0 source: `isDaemonRunning()` (`src/daemon.ts`) only checks that the PID in the PID file is alive (`process.kill(pid, 0)`); `startDaemon()` returns early when it is. No handshake carries a version or build hash. `638ad2b` restarts a running daemon in `scripts/deploy-local.sh`, which covers that path but not a CLI replaced any other way. The row-version fence of `42efc85` is about session rows, not builds.

## 2. `daemonLoop` has no outer error handling

- [ ] Wrap one loop iteration so a thrown error (DB read, refresh) is logged and the loop continues or exits with a recorded reason, instead of the daemon silently disappearing.
- [ ] `startDaemon()` swallows spawn errors (`catch { /* ignore */ }`); consider writing the error to `daemon.log` so "daemon: stopped" has a cause.

Observed: 2026-08-29 `daemon.log` held one real crash; 2026-09-22 two Codex launches failed while `status` showed `daemon: stopped`. 2026-11-16 `daemon.stderr.log` was empty and no recent crash was seen, so this is structural, not currently firing.

v0.16.0 source: `daemonLoop` calls `db.listActiveSessions()` and `refreshSessionStatuses()` inside `while (true)` with no `try`. Per-row refresh has its own catch (`refreshFailures`), the outer calls do not.

## 3. `--after` does not wait for a running previous hand

- [ ] Decide: refuse, warn, or wait when `launch --after <id>` names a session that is still `running`.

Observed 2026-10-22: a worker was launched `--after` a reviewer that was still running. It started at once, found the review missing, and stopped with no writes. The host then waited by hand.

v0.16.0: this is documented behavior (`docs/usage.md`: "`--after` alone records lineage and that handoff"), so it is a usability gap, not a bug. A one-line warning on stderr when the previous hand is not settled would have prevented the incident.

## 4. Claude launch: "did not expose the submitted task as a new turn"

- [ ] Reproduce on v0.16.0 with a bounded loop of Claude launches and record the rate; the existing watch item in `2026-10-08-helper-contract-and-evidence.md` covers the Codex form of the same error.

Observed: 2026-10-22 three Claude launches failed this way in one night (a retry succeeded); 2026-10-24/25 six more distinct sessions, some with the task bootstrap text still in the native composer, and three in a row on one task. Root cause not established: not shown to be model, quota or permission.

v0.16.0 source: the error is still raised in `src/commands/launch.ts` after `afterTaskSubmitted`. The nine Claude failure screens kept in `launch-failures/` from 2026-11-02 to 2026-11-14 all show the folder-trust prompt, a different cause; the four from 2026-10-28 to 2026-11-01 were not classified. Launches were not counted, so the absence of newer instances is not evidence of a fix.

## 5. Small: the session ID is easy to miss in `launch` output

- [ ] Consider printing `sessionId` last (or repeating it) when a long `writerConflict` list precedes it.

Observed 2026-10-22: a host read the output with `tail`, missed the ID, and launched a duplicate helper.
