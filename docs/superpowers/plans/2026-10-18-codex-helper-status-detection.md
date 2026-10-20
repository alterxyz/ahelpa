# Codex Helper Status Detection — open work

> **For the next session:** both changes below are implemented, reviewed, verified and committed locally (A = `2d2853a`, B = `e939132`, on `main`), and installed on this machine on 2026-10-20 with the daemon restarted. Nothing has been pushed.

## Change A — a Codex model-capacity stop is reported, not `running` forever

Why: Codex helpers printed `■ Selected model is at capacity. Please try a different model.` and then sat at the idle composer. Earlier `• Ran …` rows in the same turn kept `detectActivity` at `working`, and Codex's `notify` fires only on a normal turn end, so `check` kept saying `running` for over an hour and `wait` never returned.

Behavior: a column-0 `■` error with the exact phrase (or `⚠` for the capacity phrase on Codex 0.154), then the idle composer, with no work evidence after it, settles as `needs_attention` with `reason: "model_capacity"` (also `usage_limit` for `■ Usage limit reached` / `■ You've hit your usage limit`). The daemon confirms the same reason on two consecutive polls of the same session version, so a draft typed into the composer can't settle a new turn. `check` / `wait` add an optional `reason` (archive-backed, no schema change); `status` prints it. `wait` exits 1 only for those two reasons; every other result keeps exit 0. No auto-retry; the docs give the manual relaunch / `send … "continue"` hint with a `<token>` placeholder.

Files: `src/drivers/codex.ts`, `src/drivers/types.ts`, `src/drivers/sentinels.ts`, `src/daemon.ts` (`pendingAttention` map + `reason` in settle), `src/tmux.ts` (`trim` → `trimEnd`, all 19 capture consumers checked), `src/archive.ts`, `src/commands/wait.ts`, `src/commands/session-ops.ts`, `src/command-contract.ts`, `tests/codex-capacity.test.ts`, `tests/tmux.test.ts`, `tests/fixtures/codex/`, the usage / architecture / development docs in both languages, `skill/SKILL.md`.

Reviews: adversarial review (3 P1 + 1 P2, all fixed), focused review (1 P2, fixed). 10 mutations, all caught. Helper reports: `.ahelpa/codex-c47dc7c392be`, `codex-029b04de05e2`, `codex-93d2a8a38d44`, `codex-1f95461a0d41`, `codex-69082f19ce27` (`summary.md` + `artifacts/`; gitignored, on disk only).

## Change B — a Codex sub-agent's `turn_complete` no longer ends the main turn

Why: two Codex reviewers were settled `needs_attention` ("turn ended without signal") while still `Working`. The first `agent-turn-complete` came from a sub-agent thread (rollout `session_meta.source.subagent.thread_spawn`), was accepted because it inherited the task input, and became the bound thread, so the main thread's real completion was then rejected.

Behavior: before the first Codex thread binding, `isKnownCodexSubagent` (`src/drivers/codex-rollout.ts`) probes five exact local-time rollout filenames derived from the UUIDv7 thread id (creation second to +4 s, no directory scan, first line only, ≤ 64 KiB, symlink/hardlink checks) and drops a positively identified sub-agent event. Unavailable metadata keeps the old behavior (fail-open). Explicit resume `--thread` is unchanged. Codex 0.163's `notify` payload has no source/parent field, so this lookup is the cheapest reliable signal.

Files: `src/turn-hooks.ts` (one call), `src/drivers/codex-rollout.ts` (new), `tests/turn-hook-subagents.test.ts` (new; fixed-zone date/DST cases run in a child process so the test never leaks `TZ`), one paragraph each in `docs/architecture.md` / `docs/zh-CN/architecture.md`.

Reviews: adversarial review (ship; 2 suggestions applied), focused review (1 P2 test-isolation fix applied). 6 mutations, all caught. Helper reports: `.ahelpa/codex-f97bf6c50952`, `codex-abe4c7b7f924`, `codex-9fa4f9d8dafd`, `codex-ac37c61d2896`.

## Verification on the final tree (A + B together)

| Command | Exit |
| --- | --- |
| `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun run typecheck` | 0 |
| `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test` | 0 (1461 pass / 0 fail, 80 files) |
| `env -u TZ BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test` | 0 (1461 pass / 0 fail) |
| `TZ=UTC BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test tests/turn-hook-subagents.test.ts` | 0 (21 pass) |
| `git diff --check` | 0 |

The reviewer's before/after timezone sentinel, rerun against the final test file, shows no leak.

## Not part of A or B (pre-existing work from the same tree)

- `src/daemon.ts` `DetachedSpawnOptions` / `daemonSpawnOptions` / `spawnDetached` / `startDaemon` hunks, `tests/daemon-start.test.ts`, `tests/setup.ts` (daemon env isolation). Committed on its own as `e538f05` on 2026-10-20; three mutations (no `env`, no `cwd`, no root override) are each caught by its test.
- The `AGENTS.md` bullet and `docs/superpowers/plans/2026-10-18-runtime-files-and-launch-diagnostics.md`, committed with this record.

`src/daemon.ts` mixed these with change A, and `docs/architecture.md` / `docs/zh-CN/architecture.md` held paragraphs from both A and B; the commits were staged hunk by hunk, so the `src/daemon.ts` diff left after A was only the spawn-environment work.

## Open work

- [x] **Commit.** Two atomic local commits: A `2d2853a`, B `e939132`. The pre-existing work above stays uncommitted. Each commit was typechecked and its focused tests run on its own tree (HEAD + A; HEAD + A + B); the full suite passed on the final tree. Not pushed.
- [ ] **Push.** Owner's call.
- [x] **Gate and install.** 2026-10-20, with no helper running: `bun run closure:gate` on `e538f05` exited 0 (1463 pass; claude-code advisor, claude-code worker and codex worker live runs passed; Kimi skipped by default), then `bash scripts/deploy-local.sh` exited 0. The installed binary is byte-identical to that build and also carries `d9b5ee4` (evidence git no longer leaves `index.lock`) and `e538f05`. The daemon was restarted onto it; its cwd is now `~/.ahelpa`. The previous binary and global skill copies are in `~/.ahelpa/backups/deploy-20261020-pre-e538f05/`.
- [ ] **Helper memory-service calls.** Despite task text forbidding it, Codex helpers called a memory-search tool six times across these runs (one implementer, five reviewer agents); they said their runtime instructions outrank the task. The task contract can't override host instructions, so align the Codex host instructions with the owner's policy.
- [x] **Two stale tmux sessions.** `codex-029b04de05e2` and `codex-1f95461a0d41` finished their work after being falsely settled by bug B, so their terminals were never reclaimed. Their owner tokens lived only in a session scratch dir; `tmux kill-session -t <id>` works without one. Killed by the owner on 2026-10-20 after both panes showed `[AHELPA:DONE]` and both `summary.md` files were confirmed on disk; their records stay `needs_attention`.
- [ ] **`wait --check` budget (observed, not changed).** Evidence checks share `wait`'s remaining deadline, so a ~70 s suite timed out (exit 137, `timedOut: true`) when the helper finished late in a wait slice. Decide whether checks need their own budget.

Accepted limits: A has no live end-to-end test against a real capacity error, its two-poll confirmation is per process (a lone `check` doesn't accumulate), and generic or stream errors stay on the old fallback. B falls back to the old first-event binding when rollout metadata is missing, malformed, oversized, or written more than 4 s after the thread id.
