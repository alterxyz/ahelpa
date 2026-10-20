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
  - **First count, 2026-10-20** (473 sessions since 2026-10-08; codex 452, claude-code 21; the commands below):
    - Contract: 319 summaries still on disk. 280 (88%) name an exit code and a not-done section, 37 only the not-done section, 2 could not be read by the grep. The other 154 have no summary to read, 150 of them because the project directory is gone (see the worktree item in `2026-10-18-runtime-files-and-launch-diagnostics.md`). Compliance looks good enough to leave the wording alone.
    - `--check`: 46 sessions, all codex workers. 7 `check.log` files survive: 6 exit 0, 1 exit 137 timeout (the `wait --check` budget case in `2026-10-18-codex-helper-status-detection.md`). Too few to judge red-vs-true-failure.
    - Nudge: 0 sessions have `nudged_at` set. Either nothing needed it or it never fires; not yet told apart. Next step: find settled `needs_attention` sessions that had a `summary.md` at settle time, and check whether the daemon skipped the nudge and why.
    - **Nudge verdict, 2026-10-20** (read-only diagnosis: no `src/` change, nothing installed, no tmux session touched; per-session tables are in the side-session notes, not in git). *Nothing needed a nudge, but only because every settle came before the summary existed (the Change B bug), and a second gate would have blocked about half of the nudges anyway.* The nudge has never fired on a real helper; its happy path works (47 tests pass in `completion-nudge`, `turn-hook-daemon`, `turn-hook-subagents`).
      - **No settle met the nudge precondition.** `daemon.log` has 47 non-test `needs attention` settles since 2026-10-08 (36 Codex turn-hook, 6 Codex idle-poll, 3 Claude idle-poll, 2 Claude StopFailure). 31 still have a `summary.md`; for 30 its creation time is 47 s to 46 min *after* the settle. 16 lost their project directory (worktree item above): unknown. The one summary that existed at settle, `codex-9c299e84c643` (settled in the same millisecond as `codex-4414feb7caeb` and `codex-134c85cf987d`), sat behind a bare shell prompt (`bash-3.2$`) after Codex had exited: no composer, so the gate was right to refuse.
      - **Why the settles came early: Change B** (`2026-10-18-codex-helper-status-detection.md`, `e939132`). For all 8 live `needs_attention` rows with a `turns.log` (`codex-a9dfde81dcd4`, `3cbfa240ec05`, `319a988d4979`, `432d95396ebc`, `db83687d4875`, `f935682ab303`, `630bddb895c0`, `bebf4eb580de`) the thread bound as "main" is a sub-agent thread (`session_meta.source.subagent` in its rollout), and the pane at settle still showed `Working (…)` with a timer within 4-17 s of the time since launch. Of the 26 turn-hook settles with a later summary, 19 are verified sub-agent threads, 7 have pruned rollouts, none is a counterexample. The fix was committed 2026-10-19 13:18 -07:00 and installed 2026-10-20 01:07 -07:00; every settle above predates it. Only 11 sessions (0 nudged) exist since, too few to judge.
      - **Latent second blocker, reproduced but not yet seen in production.** The Codex ready check reads the whole 30-line capture: `acceptsInput` contains `!codexHasStartedTask(capture)`, and `detectActivity` runs the same test, so a finished turn with a `• Ran …` / `• Explored …` row still in the window is "not ready" and "working". With a summary and an accepted turn-end event the daemon then neither nudges nor settles; the event stays pending and the session stays `running`. Of 399 archived end-of-turn Codex panes (sentinel row removed, to mimic "finished without the signal") 191 pass `acceptsInput`, 204 fail on a work row (mostly `Ran`) and 4 on a spinner row; all 208 read `working`. A scratch run of `refreshSessionStatuses` (Tmux fully stubbed, temp roots, summary + hook event + a real blocked pane, 12 polls) ended `running`, `nudged_at` unset, 0 sends; a clean composer and a real passing pane each nudged once. The archives keep only a 500-character tail, so the blocked share is a floor.
      - **The three `nudged for completion` lines in `daemon.log` (2026-10-08, id `codex-quiet`) are test leakage** from `tests/completion-nudge.test.ts` before `tests/setup.ts` isolated the roots; no such row exists in `state.db`.
      - **Proposed, not applied (needs the owner's go):** (1) Re-count after about 30 Codex sessions have run on the new build (`created_at >= '2026-10-20T08:07'`): `nudged_at` set, and settled `needs_attention` rows whose summary predates the settle. (2) For the blocker, in `src/drivers/codex.ts` judge readiness from the live area just above the last composer row (a `Working (` / `esc to interrupt` line, or a numbered menu), not from history rows in scrollback; keep the verb list only for the no-hook `detectActivity` fallback, and in the `src/daemon.ts` hook branch hold a pending event on the live spinner only. Tests: the 208 blocked panes (sentinel stripped) become ready; the existing mid-turn spinner, menu and approval panes stay not ready; one mutation that restores the whole-window test must fail. (3) Seen once each, cause unverified, unrelated to the nudge: an idle-poll settle 27 s after launch with the pane at `• 我先读取任务说明` (`codex-c952ac9d79b5`; the verb list is English-only) and a Claude advisor idle-poll settle with a tips prompt on screen (`claude-d969ad09f794`); their summaries appeared about 15 and 6 min later. (4) 11 `needs_attention` rows still have live tmux sessions and are probably falsely settled helpers that carried on (the 10-18 note found two); check and reclaim them.
      - **(2) done, committed `1eb7d94` on 2026-10-20 (not installed; the daemon must restart onto it).** The owner asked for the fix. Codex has `acceptsInputAfterTurn` (composer ready and no live spinner; history rows ignored) and `workingAfterTurn` (spinner only), and the daemon's hook branch uses them only for an event whose thread the hook verified: the Codex rollout metadata names it the main thread (`codexThreadSource` in `src/drivers/codex-rollout.ts`), or ahelpa bound it on resume, recorded as `threadVerified` in `turns.log`. Fail-open events and log lines from before the change keep the old checks. Both Codex input checks also refuse the free-form question view (an interrupt or submit hint below the last `›` row). The no-hook `detectActivity` path is unchanged.
        - Reviews: adversarial `codex-e526eb9afc68` (P1: a `Worked for` cut I had added to `detectActivity` ended a still-streaming turn, because older Codex draws that divider before streaming the answer and hides the spinner while it streams, so the cut was removed; P2: the relaxed check was reachable through a fail-open sub-agent event, and the question view was not recognized), focused `codex-1adba2baac2d` (both fixed; new P2: the focus veto scanned the whole screen and refused a ready composer below a reply that quoted the words, now limited to the rows below the composer; P3 docs). Reports in each `.ahelpa/<id>/summary.md` (gitignored). Both reviewers say their host instructions forced one Nowledge search despite the task forbidding it (see the memory-service item in `2026-10-18-codex-helper-status-detection.md`).
        - Evidence: full suite 1476 pass; 10 mutations each caught; both reviewers' adversarial tests pass except the accepted limit below. Over 856 archived idle Codex panes, `acceptsInputAfterTurn` passes 783 (`acceptsInput` 454); of the rest, 7 show a live spinner, 10 a numbered menu, 56 a `»` composer, and the new veto refuses none. On this machine 7 of 10 recent first-bound threads verify as main; the other 3 resolve to null (rollouts probably archived after the session) and would take the old path.
        - Accepted limit (focused review P2, derived from Codex source, not seen live): a sub-agent revived by `resume_agent` from a thread the CLI first created keeps `source: "cli"`; if its event comes first with the task input, it verifies and can earn one nudge into a main thread that is still streaming. The old checks would hold that session `running` forever instead.
        - Found on the way, not fixed: 56 archived panes draw the Codex composer as `»`, which the driver does not recognize at all (neither input check passes). The 2026-10-14 diagnosis "the prompt glyph changed to `»`" was withdrawn, but these panes say some Codex build does draw it. Find which version and add it to `codexHasInputPrompt`, with a fixture.
- [ ] If helpers ignore the contract (no exit codes), tighten wording or make `wait` flag `summaryBytes > 0 && !/exit/.test(summary)`; if they comply, leave it.
- [x] `tests/codex-capabilities.test.ts` "kills a timed-out shim's child even when it inherits the stdout pipe" was timing-sensitive under load (failed once inside a reviewer's `--check`, passes alone). Made deterministic on 2026-10-11: the shim ends the probe by flooding stdout past `maxBuffer` after the child pid is on disk; the timeout is only a backstop.
- [ ] `nudged_at` never resets, so a follow-up turn sent with `ahelpa task` is never nudged again; `markNudged` is not CAS (microsecond duplicate window between two daemon-less inline refreshes). Both low; fix if observed.
- [ ] Linux: `detached` + `process.kill(-pid)`, `reader.cancel()`, `rmdirSync` paths were verified on macOS/Bun 1.4.2 only. Run the evidence/wait tests on a Linux box once.
- [ ] Claude `acceptsInput` requires an empty column-0 `❯`. If a real Claude UI shows another column-0 `❯` form (new menu style, AskUserQuestion variant), capture the pane into `tests/fixtures/` and extend `tests/accepts-input.test.ts`.
- [ ] Other already-open Claude sessions read the skill snapshot from their start; they will not see the reviewer role / `--check` until restarted. Nothing to do in the repo; just know why an old session launches without them.
- [x] Review summaries of this campaign are packed (2026-10-11) into a local retained-history archive outside the repo, `campaign-evidence.tar.xz` with an `ORIGIN.json`; their tmux sessions are gone. The session records were kept on purpose: `ahelpa clean` deletes every settled record on the machine, which would erase the data the observation commands below read. Run it only after the numbers are taken.

- [ ] Codex launch intermittently fails with "codex did not expose the submitted task as a new turn" (`src/commands/launch.ts`). Seen on 2026-10-11 in two consecutive closure-gate runs from fresh worktrees, then not reproduced in three gate runs and two manual launches (codex-cli 0.162.1). The pane showed the task submitted and `Working`, so the turn evidence was late, not missing. If it recurs, keep the pane on failure and check whether `deliverTurn` needs a longer window for Codex.
- [x] Kimi's live closure-gate stage is shelved (2026-10-11): it runs only with `AHELPA_GATE_KIMI=1`. The Kimi provider was rejecting every request, and Kimi is being retired on the maintainer's machine. The driver and its unit tests are unchanged.

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

Summaries of the seven hands for this change, packed into the local `campaign-evidence.tar.xz` archive (not in git; the main checkout's results are under `repo/.ahelpa/` inside it): `codex-df6841fee226` (first review), `codex-56e8ee78dc36` (adversarial, 3 P1 / 7 P2), `claude-3d10ad79a1c9` (focused, found the Claude permission-dialog nudge), `codex-def1b7a0e016` (final, ship). Each carries `artifacts/` with mutation runners, probes and hashes.
