# Helper Contract and Evidence — campaign record and open work

> **For the next session:** this file is the handoff. Read "Open work" first and continue from the first unchecked box. Everything above it is context you can skim. Shipped as v0.9.0 on 2026-10-08.

**Goal:** stop trusting a helper's self-report. Make the task contract, the evidence `wait` returns, and the review chain carry the weight instead.

**Trigger:** a tweet arguing GPT-series models optimize for "looks like the result" over the actual intent (modify tests to fit, no self-review, short horizon). We checked that claim against our own archive before changing anything.

---

## What the archive said (750 sessions, analysed 2026-10-07)

Data: `~/.ahelpa/state.db` (244 rows since 2026-09-01: codex 224, claude 20), `~/.ahelpa/archive/` (750 dirs: codex 479, claude 255, kimi 12), 487 `summary.md` files under project `.ahelpa/` dirs. Keyword-regex counts are order-of-magnitude only.

- **Self-report vs review.** ~20 adversarial reviews of codex implementations, ~19 ruled "must fix"; after rework, ~half of focused re-reviews still ruled needs-rework. Root causes were not lies but carelessness: `codex-f4fe9c361376` reported "full Go suite passed" while the same summary noted other packages "hit the test cache"; reviewer `codex-054a2ae2c327` reran with `-count=1`, exit 1, one test flaky 3/10. `codex-440a99824903` ran the suite before its final edit and never again.
- **No test cheating found.** Every changed old assertion was disclosed (`codex-e8745af44c7a`, `codex-f4fe9c361376`); reviewer `codex-aaf682f45fac` judged them legitimate. The real problem is weak tests: mutation survival 5/13 (`codex-0e75eb941a34`), 5/17 (`codex-054a2ae2c327`), 3/12 (`codex-2b632b32269d`). This is what stretched one planned five-hand job to 8–9 hands.
- **Verification is absent, not faked.** Codex summaries with no verification mention: 115/376; with an exit code: 32%. Claude: 49/104 and 15% — but Claude states what it did not do ("no tests were run", `claude-aea51ad8`).
- **Claude's problem is protocol, Codex's is quality.** Archived Claude sessions ended `needs_attention` 25% of the time (63/255); 47 of those had already written `summary.md` and simply never printed the signal. Codex: 2%. Kimi: ~8/12.
- **Delivery and traceability.** Two task instructions arrived with their head truncated (`codex-a768d7ea4e53`, `codex-cc8a31f55867`, 2026-09-24/26, before the October driver fixes). 33 tasks said "read /private/tmp/xxx.md"; 9 of 10 sampled files were already gone.
- **Scope and regressions.** Two out-of-scope reads, both self-reported (`codex-eee16d02c363`, `codex-e8745af44c7a`). Two rework rounds introduced a new P1 (`codex-2b95415667dc`, `codex-7a548e26e9d5`).
- **Good task prompts** share four things: the why, acceptance checks, a forbidden list, `file:line` for claims (e.g. `codex-ce949444ee3c`, `codex-cc8a31f55867`).
- **Codex content filtering** once stalled the main process at "write the merged report"; the host assembled the summary from `artifacts/` by hand (`codex-43e63de2085f`).

## Principles we settled on (how to command heterogeneous agents)

1. Pair failure modes, not capabilities: Codex (short horizon, careless verification, strong protocol) against Claude (thin evidence, honest scoping, weak protocol), with the host under the same contract.
2. The first hand decides the total hand count: a failing-first test in hand 1 is cheaper than two more review hands. Rework hands get a narrow mandate.
3. The task file is the only shared memory between hands: durable, self-contained, carrying the why / acceptance / forbidden list / field semantics.
4. Design an honest exit for every agent: "cannot satisfy acceptance item X" must count as a valid delivery, or faking becomes the path of least resistance.
5. The host reads evidence, then summary, then diff — never the other order.
6. One worktree, one writer; reviewers get a frozen target.
7. Discovery → strongest model; transforming given facts → cheaper model; adversarial check → a different model than the author; judgment → the host, never delegated.
8. Tolerate protocol slips (read the summary even without the signal); never tolerate quality slips (rerun verification).

## What shipped in v0.9.0

- Role-aware `## ahelpa contract` in every task file; new `--role reviewer` (Claude and Codex) with a review-only contract (verdict first, own reruns, ≥3 restored mutations, N/A changed files).
- `wait` returns `evidence`: `summaryBytes`, `baseCommit`/`baseCommitMissing`, `changedFiles`, `testFilesChanged`, `check`.
- `--check "<cmd>"`: in the contract, rerun by `wait` on the final state, bounded by the wait deadline, once per `(project, command)`, in its own process group (killed when the check ends), `check.skipped` when no budget is left.
- `--after <id>`: `## ahelpa previous hand` section linking `task.md`/`summary.md`/`artifacts/`. `--worktree`: sibling worktree on `ahelpa/<id>`, rolled back on launch failure. `task.md` kept beside the summary. `taskWarning` on temp-file pointers from `--task`.
- Completion nudge: summary present, idle, no signal → one nudge, only into an empty ready composer (`driver.acceptsInput`), persisted as `nudged_at`, re-read row version before sending.
- `skill/references/profiles.md`; `tests/setup.ts` always isolates runtime roots.
- Review chain for the change itself: Codex (Luna) → rework → Codex reviewer → rework → Claude reviewer → rework → Codex reviewer: ship. Reviews found broken promises, not taste: unbounded wait, orphaned process trees, nudges into menus/approval dialogs, parallel checks poisoning each other.

## Open work

Observation period first; code changes only when the numbers say so.

- [ ] **After a few days of real use, compute the three numbers** (commands below) and decide what to tune.
  - Contract compliance: of sessions launched after 2026-10-08, how many summaries contain an exit code / a "not done" section.
  - `--check` signal: how many sessions used it; red vs green; of the reds, how many were true failures (read the summary and `check.log`).
  - Nudge: `nudged_at IS NOT NULL` count; how many ended `idle` (it worked) vs `needs_attention`; any sign of a nudge landing somewhere wrong (search daemon.log for "nudged for completion" and check the session's pane history / logs).
- [ ] If helpers ignore the contract (no exit codes), tighten wording or make `wait` flag `summaryBytes > 0 && !/exit/.test(summary)`; if they comply, leave it.
- [ ] `tests/codex-capabilities.test.ts` "kills a timed-out shim's child even when it inherits the stdout pipe" is timing-sensitive under load (failed once inside a reviewer's `--check`, passes alone). Pre-existing; make it deterministic or widen its budget.
- [ ] `nudged_at` never resets, so a follow-up turn sent with `ahelpa task` is never nudged again; `markNudged` is not CAS (microsecond duplicate window between two daemon-less inline refreshes). Both low; fix if observed.
- [ ] Linux: `detached` + `process.kill(-pid)`, `reader.cancel()`, `rmdirSync` paths were verified on macOS/Bun 1.4.2 only. Run the evidence/wait tests on a Linux box once.
- [ ] Claude `acceptsInput` requires an empty column-0 `❯`. If a real Claude UI shows another column-0 `❯` form (new menu style, AskUserQuestion variant), capture the pane into `tests/fixtures/` and extend `tests/accepts-input.test.ts`.
- [ ] Other already-open Claude sessions read the skill snapshot from their start; they will not see the reviewer role / `--check` until restarted. Nothing to do in the repo; just know why an old session launches without them.
- [ ] `ahelpa clean` the idle review sessions from this campaign when their summaries are no longer needed: `codex-df6841fee226`, `codex-56e8ee78dc36`, `claude-3d10ad79a1c9`, `codex-def1b7a0e016`, `codex-22b6fc11382a` (their `summary.md` files live under this repo's `.ahelpa/`, gitignored).

### Commands for the observation numbers

```bash
DB=~/.ahelpa/state.db
# sessions since the release, with role / check / after usage
sqlite3 -header -column $DB "select agent_type, role, count(*) n, sum(check_cmd is not null) with_check, sum(after_id is not null) chained, sum(nudged_at is not null) nudged from sessions where created_at > '2026-10-08T10:00' group by 1,2"
# nudge outcomes
sqlite3 -header -column $DB "select status, count(*) from sessions where nudged_at is not null group by 1"
# check results: last line of each check.log
sqlite3 $DB "select project_path, id from sessions where check_cmd is not null and created_at > '2026-10-08T10:00'" | while IFS='|' read p id; do f="$p/.ahelpa/$id/check.log"; [ -f "$f" ] && printf '%s  %s\n' "$id" "$(tail -1 "$f")"; done
# contract compliance: summaries with an exit code and a not-done section
sqlite3 $DB "select project_path, id from sessions where created_at > '2026-10-08T10:00'" | while IFS='|' read p id; do s="$p/.ahelpa/$id/summary.md"; [ -f "$s" ] && printf '%s exit:%s notdone:%s\n' "$id" "$(grep -ciE 'exit (code )?[0-9]|退出码' "$s")" "$(grep -ciE 'not done|未做|未验证|not verified|N/A' "$s")"; done
grep -c "nudged for completion" ~/.ahelpa/daemon.log
```

## Where the review evidence lives

Summaries of the seven hands for this change, under this repo's `.ahelpa/` (gitignored, local only): `codex-df6841fee226` (first review), `codex-56e8ee78dc36` (adversarial, 3 P1 / 7 P2), `claude-3d10ad79a1c9` (focused, found the Claude permission-dialog nudge), `codex-def1b7a0e016` (final, ship). Each carries `artifacts/` with mutation runners, probes and hashes.
