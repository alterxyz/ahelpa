# Test suite ablation — which tests to delete, merge, rewrite or add

> Recorded 2026-11-19 against v0.17.0 (`f7dadb0`). An audit only: no test or source file was changed. Each action below waits for the owner's decision. Ablation here means: take one test file (or one source behavior) away, keep everything else, and measure what protection is lost.

## Answer

- **Delete whole files: none.** 25 files kill nothing that another file does not also kill, but that is not enough to delete them: every file that looked like that and was then probed with a mutant aimed at the behavior it was written for held a unique guard (5 of 5: `task-input`, `tmux-env` and the three below). Those 25 are merged or trimmed instead. The three that looked most redundant: `review-fingerprint-lifecycle` (the only stable guard of fix `094a292`), `pr6-reservation-edges` (the only killer of three startup-lease mutants and of the reservation re-check after tmux creation), `state-version` (the only killer of a cross-process lost update).
- **Delete 36 duplicate test declarations** (41 tests at run time, 452 lines, 0.95 s): each repeats another test on the same source branch. A `deepseek` reviewer checked the 39 proposals against the source with 13 mutations of its own and kept 3 (each the only test catching a mutant of its branch).
- **Merge 8 clusters**, 94 files → 72: `peer-mail*` (4 → 1), `kill-*` (5 → 2), `pr6-*` (split into module files), `refresh*` (3 → 1), `state*` (3 → 1), `turn-hook*` (8 → 3), `codex-*` (7 → 4), `review-*` lineage and lifecycle into their module files. No test is lost; about 200–300 lines of repeated imports and copied fixtures go.
- **Rewrite 6 groups of tests** that either do not assert what their name claims (`status`), or pin data and wording that routine changes must edit in several files (model catalogs and defaults: 5 of the last 30 days' commits to `command-contract.test.ts` were such edits).
- **Add 11 tests** for behaviors no test protects: a mutant there survives every test file that covers its line (list below).
- **Savings: about 650–750 lines of 21,174 (about 3%) and about 1 s of 287 s.** The suite is not redundant in bulk: 2019 tests mostly check distinct behavior. Its time is in `closure-gate.test.ts` (176 s, 62%) and eight files over 5 s; that belongs to the test-speed lane, not to deletion.

Evidence strength: 58 of the 94 files ran as mutation candidates (833 valid mutants in all): 33 kill a mutant nothing else kills; the other 25 are merged or trimmed, never deleted, on the strength of reading. Of the 36 files that did not run as candidates, 26 have exclusive coverage lines and 10 test scripts, run the CLI or a compiled binary in a subprocess, are out of scope (`integration`), or are one-assertion guards (`version`). Every one of the 36 test deletions was found by reading, 6 were re-read by me, and all were checked blind by a different model, which ran 13 mutations of its own and removed 3 proposals. No conclusion rests on coverage alone.

## Method

Baseline: `bun test` on bun 1.4.4 (the repository pins 1.4.2), 2019 tests in 94 files, 287.3 s, all passing (`junit.xml` from the bus run).

1. **Coverage ablation.** Each file ran alone with `bun test tests/<file> --coverage --coverage-reporter=lcov`. A line is *exclusive* to a file when no other file covers it. Bun instruments 5,718 lines in `src/` loaded in-process; 5,155 (90%) are covered by at least one file. 41 files have zero exclusive lines, because most tests drive the shared `state`, `daemon` and `launch` paths as setup: line coverage is too coarse to separate them. Seven files cover no `src/` line in-process because they test scripts or run the CLI in a subprocess (`closure-gate`, `doctor`, `installer`, `release-workflow`, `skill-package`, `test-progress`, `tmux-errors`). Coverage was used to choose mutation targets, never alone for a conclusion.
2. **Reading by cluster.** Three Sonnet readers produced a per-test fact sheet for 59 files in the named clusters (source branch driven, key assertion, overlaps with `file:line`, flags). I spot-checked their claims; 6 of the pairs they reported were wrong or partial and are not in the delete list (for example `drivers:32` builds a launch command and `resume:90` a resume command, two different functions).
3. **Mutation.** A runner applies one mutant to a throwaway copy of the repository, runs each listed test file alone, and restores the file with `git checkout`. Every *candidate* file always runs; other files that cover the mutated line (from step 1) run cheapest first and stop at the first failure. A candidate's kill is *exclusive* when no other file fails. Mutants:
   - 761 operator mutants generated on lines the candidate files cover (flip `===`/`&&`/`<`, negate `if`, constant + 1, delete a statement, `return undefined`);
   - 53 semantic mutants written by two `glm` helpers for the race and regression files (drop a guard or a `WHERE` term, swap two statements, skip a re-read, remove a version bump or tombstone);
   - 20 semantic mutants I wrote where a file's claimed behavior is out of reach of operator mutants (FIFO open mode, tmux environment filter, fingerprint process group, startup lease, cross-process version increment, `check`/`status` fields, token check).
   All copies were left clean (`git status --porcelain` empty).
4. **Independent check.** A `deepseek` reviewer received only the delete list and the instruction to read both tests of each pair and, where reading does not settle it, run its own mutation.

Two hazards changed conclusions and are worth knowing for any rerun:

- **Operator mutants understate a regression test's value.** `task-input`, `tmux-env`, `state-version` and `pr6-reservation-edges` had 0 exclusive kills under operator mutants, and each turned out to be the only killer of a mutant aimed at the behavior it was written for.
- **Machine load produces false kills, which bias toward deletion.** Under load average 25–45, `integration.test.ts` failed three times with the launch error "did not expose the submitted task as a new turn" (that test passes alone), and `daemon-recovery`'s "10000 actual refresh failures" test (12 s) timed out once. A rerun alone showed both were spurious. `integration` is dropped as a killer everywhere; the three false kills found by rerun are dropped too. The decisive deletion evidence (the lifecycle pair) was confirmed by running the other killer twice.

## Per-file results

Columns: tests and seconds from the baseline run; covered and exclusive `src/` lines from step 1; mutants run with this file as a candidate, how many it killed, and how many only it killed (spurious kills removed). "–" means the file was not a mutation candidate.

| File | Tests | Secs | Lines | Covered src lines | Exclusive lines | Mutants as candidate | Killed | Exclusive kills | Conclusion | Evidence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `accepts-input` | 21 | 0.00 | 139 | 635 | 0 | 61 | 31 | 0 | Keep, trim | Only home of `acceptsInputAfterTurn`/`workingAfterTurn` (:100); its Folder-access rows (:14-17) repeat codex-readiness:364. Takes the driver half of turn-hook-readiness. |
| `agy-driver` | 14 | 0.01 | 210 | 581 | 77 | – | – | – | Keep | Sole coverage of `drivers/agy.ts`. |
| `archive` | 3 | 0.00 | 43 | 15 | 0 | 6 | 2 | 0 | Keep | Small; `Archive.reasonFor`/`revision` still lack a direct test (gap). |
| `check` | 3 | 0.02 | 82 | 736 | 0 | 47 | 16 | 4 | Keep | Only file that catches `check` dropping nesting, role, model or scope (manual mutants chk-*). |
| `claude-model-switch` | 20 | 0.01 | 163 | 188 | 5 | 33 | 25 | 4 | Keep | 4 exclusive kills. |
| `clean` | 8 | 0.09 | 142 | 750 | 6 | – | – | – | Keep | Receives the clean-retention tests from pr6-*. |
| `cli-args` | 12 | 0.00 | 70 | 30 | 4 | – | – | – | Keep | Exclusive coverage of `cli-args.ts`. |
| `cli-dispatch` | 61 | 0.24 | 520 | 2039 | 20 | – | – | – | Keep | 20 exclusive lines. |
| `closure-gate` | 75 | 176.50 | 521 | 0 | 0 | – | – | – | Keep (speed: test-speed) | Tests `scripts/closure-gate.sh` in subprocesses; no in-process coverage. 62% of suite time. |
| `codex-capabilities` | 23 | 3.12 | 230 | 50 | 0 | 13 | 12 | 5 | Keep | 5 exclusive kills. |
| `codex-capacity` | 40 | 3.26 | 306 | 1486 | 17 | – | – | – | Keep | 17 exclusive lines; optional: move the settlement half (:114+) beside the refresh tests. |
| `codex-config` | 17 | 0.01 | 208 | 268 | 40 | – | – | – | Keep | 40 exclusive lines; receives codex-model-switch. |
| `codex-driver` | 10 | 0.00 | 80 | 537 | 0 | 31 | 13 | 0 | Merge → codex-readiness | 0 exclusive kills of 13. Delete :5; keep :18 (shell-quote oracle) and :44-79. |
| `codex-folder-trust` | 11 | 0.20 | 165 | 1845 | 0 | 45 | 28 | 0 | Merge → launch | 0 exclusive kills of 28; launch-level plumbing of the Folder-access answer and the rollback note (:114-165, the only launch-level coverage). |
| `codex-model-switch` | 18 | 0.00 | 174 | 235 | 2 | 31 | 17 | 2 | Merge → codex-config | 2 exclusive kills; same subject as codex-config. Its effort list (:166) repeats command-contract:61-67. |
| `codex-readiness` | 72 | 0.01 | 395 | 393 | 5 | – | – | – | Keep | Receives codex-driver and the codex half of driver-protocol. |
| `command-contract` | 14 | 0.01 | 122 | 864 | 2 | 23 | 17 | 4 | Keep, rewrite | 4 exclusive kills; rewrite the literal catalog/default pins (:56-95, :108-109) into structural checks. |
| `completion-nudge` | 17 | 0.16 | 250 | 1120 | 1 | 50 | 23 | 0 | Keep | 0 exclusive of 23 kills, but 2 kills shared only with other hook files; no duplicate found by reading. |
| `daemon-recovery` | 34 | 2.13 | 667 | 1815 | 13 | – | – | – | Keep, trim | 13 exclusive lines. Delete :658 (keep :191: the only test that a backoff on one session leaves the others alone). The "10000 actual refresh failures" test (12 s) fails under load. |
| `daemon-start` | 6 | 0.11 | 113 | 523 | 2 | 4 | 1 | 0 | Keep, trim | 2 exclusive lines (spawn options); delete :65 (repeats :51). |
| `daemon-wake` | 6 | 1.94 | 106 | 1071 | 14 | – | – | – | Keep | 14 exclusive lines. :53 is the only test of `FIFO.tryWrite` against a regular file or a symlink (reviewer mutation H, reproduced). |
| `disk-usage` | 27 | 0.17 | 281 | 1160 | 273 | – | – | – | Keep | 273 exclusive lines. |
| `doctor` | 76 | 5.30 | 738 | 0 | 0 | – | – | – | Keep | Runs the CLI in subprocesses; only test of the `*-readiness.ts` doctor modules. |
| `driver-outcome` | 43 | 0.02 | 139 | 608 | 0 | 48 | 25 | 0 | Keep, trim | 0 exclusive of 25 kills; delete :97 (codex-driver:31 covers it). |
| `driver-protocol` | 195 | 0.02 | 1051 | 895 | 22 | – | – | – | Keep, trim, split | 22 exclusive lines. Delete :555, :572, :620, :793, :970 (keep :537: the only legacy update screen without a cursor row); move the codex half (:433-580) to codex-readiness; collapse :454/:467/:480. |
| `drivers` | 17 | 0.01 | 175 | 588 | 0 | 52 | 21 | 0 | Keep, trim | 0 exclusive of 21 kills; delete :56 and :101. |
| `evidence` | 39 | 7.25 | 545 | 251 | 17 | – | – | – | Keep | 17 exclusive lines. |
| `fifo` | 12 | 0.28 | 102 | 59 | 2 | 12 | 8 | 1 | Keep | 1 exclusive kill (`fifo.ts:96`). |
| `file-handoff` | 21 | 0.45 | 322 | 154 | 0 | 13 | 10 | 0 | Keep, rewrite | 0 exclusive of 10 kills, but it is the only check on the helper contract text. Drop the verbatim sentence pins that repeat the keyword regexes of the same test (:224-226). |
| `installer` | 28 | 13.34 | 289 | 0 | 0 | – | – | – | Keep | Only test of `scripts/install.sh`. |
| `install-skill` | 13 | 1.53 | 148 | 31 | 26 | – | – | – | Keep | 26 exclusive lines. |
| `integration` | 1 | 7.41 | 85 | 1519 | 0 | – | – | – | Out of scope (hermetic-e2e) | Failed twice under load with the launch error "did not expose the submitted task as a new turn". |
| `interrupt` | 16 | 19.12 | 240 | 925 | 81 | – | – | – | Keep (speed: test-speed) | 81 exclusive lines; 19 s. |
| `job` | 10 | 0.10 | 176 | 1388 | 4 | 35 | 14 | 0 | Keep | Receives the job tests from pr6-guardrails. |
| `kill-archive-races` | 14 | 0.15 | 164 | 822 | 0 | 117 | 59 | 3 | Merge → kill | Exclusive kills (2 operator, 1 semantic). |
| `kill-nonsettle-races` | 26 | 0.33 | 292 | 1530 | 2 | 154 | 84 | 9 | Merge → kill | Exclusive kills (2 operator, 2 semantic). |
| `kill-tree` | 21 | 0.18 | 238 | 1124 | 0 | 95 | 41 | 4 | Merge → kill (base file) | Exclusive kills (1 operator, 1 semantic). |
| `kill-tree-rework` | 12 | 0.09 | 199 | 1435 | 0 | 126 | 50 | 0 | Merge → kill / launch-reservation | 0 exclusive kills (operator and semantic); :57 is the only test where kill throws because no terminal exists yet. |
| `kill-tree-rollback` | 5 | 0.07 | 182 | 1550 | 0 | 196 | 82 | 2 | Merge → launch-reservation | Exclusive kills: rollback tombstone releases the reservation (state.ts:388), launch.ts:455. |
| `kimi-driver` | 43 | 0.33 | 603 | 1071 | 16 | – | – | – | Keep, trim | 16 exclusive lines; delete :226, :323, :387, :435, :553, :574. |
| `kimi-refresh` | 2 | 0.01 | 73 | 879 | 0 | 32 | 11 | 0 | Merge → refresh | 0 exclusive of 11 kills. Delete :50 (daemon-wake:70 covers it); move :28. |
| `launch` | 35 | 6.13 | 880 | 1936 | 13 | – | – | – | Keep | 13 exclusive lines; receives codex-folder-trust. |
| `launch-profiles` | 23 | 0.01 | 129 | 526 | 0 | 34 | 18 | 1 | Keep, trim, rewrite | 1 exclusive kill; delete :98; assert defaults structurally. |
| `linked-worktree-results` | 21 | 3.11 | 413 | 2119 | 1 | 45 | 19 | 0 | Keep | 0 exclusive of 19 kills, but the only tests of results living in the main checkout for a linked worktree; not read in depth. |
| `model-menu` | 7 | 0.00 | 42 | 27 | 0 | 10 | 9 | 1 | Keep | Unit layer for menus; 1 exclusive kill. |
| `model-named-drivers` | 35 | 0.43 | 167 | 1832 | 2 | 30 | 15 | 1 | Keep, rewrite | 1 exclusive kill; rewrite the catalog literals (:84-96) and wording pins (:52-58). |
| `model-state` | 4 | 0.02 | 52 | 700 | 4 | 37 | 18 | 1 | Keep | 1 exclusive kill. |
| `need-help-ledger` | 13 | 0.06 | 240 | 1040 | 2 | 51 | 17 | 2 | Keep | 2 exclusive kills. |
| `peer-mail` | 29 | 0.35 | 407 | 2027 | 2 | 94 | 54 | 7 | Keep, trim (merge target) | Exclusive kills (5 operator, 2 semantic). Delete :138 and :304. |
| `peer-mail-hardening` | 35 | 0.49 | 228 | 1598 | 7 | 96 | 52 | 7 | Merge → peer-mail | Exclusive kills (4 operator, 3 semantic). |
| `peer-mail-regressions` | 40 | 0.71 | 337 | 2230 | 2 | 97 | 58 | 5 | Merge → peer-mail | 5 exclusive operator kills; 9 semantic kills shared only with other peer-mail files. Delete :275. |
| `peer-mail-stack` | 2 | 0.01 | 86 | 1444 | 0 | 53 | 19 | 0 | Merge → peer-mail | 0 exclusive kills; keep as a nested describe (runs with the daemon stopped). |
| `pi-driver` | 24 | 0.01 | 190 | 582 | 90 | – | – | – | Keep, trim | 90 exclusive lines; delete :27. |
| `pr6-guardrails` | 37 | 1.17 | 487 | 2034 | 2 | 104 | 44 | 2 | Split by module | 2 exclusive semantic kills (cross-tree --parent, depth non-reduction). Reservation/quota → launch-reservation, job → job, clean → clean. |
| `pr6-reservation-edges` | 28 | 1.14 | 382 | 1856 | 1 | 108 | 47 | 4 | Split by module | 4 exclusive kills: the startup-lease boundary, an EPERM launcher and a crashed resume (targeted mutants), and the reservation re-check after tmux creation (`launch.ts:522`). Lease → refresh, CAS units → state, cancelled launches → launch-reservation. Delete :279, :359. |
| `refresh` | 9 | 0.06 | 169 | 948 | 0 | 49 | 15 | 0 | Keep, trim (merge target) | 0 exclusive of 15 kills; 4 of its 9 tests repeat others: delete :26, :50, :68, :96. |
| `refresh-snapshot` | 9 | 0.02 | 141 | 890 | 2 | 44 | 13 | 1 | Merge → refresh | 1 exclusive kill; delete :107. |
| `release-workflow` | 4 | 0.47 | 110 | 0 | 0 | – | – | – | Keep | Only test of the release workflow script. |
| `removed-dsh` | 8 | 0.06 | 142 | 1533 | 24 | – | – | – | Keep | 24 exclusive lines. |
| `resume` | 33 | 0.12 | 641 | 1252 | 9 | – | – | – | Keep, trim | 9 exclusive lines; delete :40; optional: move :560-640 (StateDB fields) to state. |
| `review-ask-lineage` | 3 | 0.37 | 117 | 1517 | 0 | 76 | 18 | 0 | Merge → review-target | 0 exclusive of 18 kills; each test adds assertions to review-target:214/:261. |
| `review-fingerprint-bounds` | 9 | 6.68 | 201 | 1438 | 3 | 39 | 12 | 2 | Keep (merge target) | 2 exclusive kills. |
| `review-fingerprint-lifecycle` | 2 | 0.91 | 90 | 89 | 0 | 10 | 2 | 1 | Merge → review-fingerprint-bounds | Test 1 is the only stable guard of fix 094a292 (git detached from the caller's group); delete test 2 (bounds kills its mutant twice). |
| `review-target` | 21 | 6.46 | 372 | 1983 | 1 | 42 | 21 | 1 | Keep (merge target) | 1 exclusive kill (`launch.ts:778`); 6.5 s; receives review-ask-lineage. |
| `runtime-layout` | 13 | 0.49 | 230 | 61 | 0 | 7 | 7 | 0 | Keep | 0 exclusive of 7 kills, but the only direct test of `RuntimeLayout`; not read in depth. |
| `scope` | 43 | 0.81 | 231 | 1858 | 2 | 38 | 14 | 0 | Keep | 0 exclusive of 14 kills, 2 exclusive lines; the only tests of `--scope` parsing; not read in depth. |
| `sentinels` | 40 | 0.01 | 146 | 38 | 4 | 10 | 10 | 3 | Keep | 3 exclusive kills. |
| `session-access` | 3 | 0.02 | 55 | 200 | 0 | 38 | 17 | 0 | Keep | 0 exclusive kills (resume and cli-dispatch also catch them), but it is the direct contract of the token check; 55 lines. |
| `session-lifecycle` | 2 | 0.00 | 19 | 462 | 2 | 4 | 2 | 1 | Keep | 1 exclusive kill. |
| `session-ops` | 14 | 2.14 | 282 | 1188 | 5 | – | – | – | Keep | Catches glmA-19 (a kill commits while `send` re-arms monitoring), which none of the five kill files catches; 5 exclusive lines. |
| `settle` | 3 | 0.01 | 78 | 246 | 2 | 69 | 19 | 3 | Keep | Exclusive kills (2 operator, 1 semantic). |
| `settle-aba` | 6 | 0.03 | 249 | 1080 | 0 | 103 | 48 | 1 | Keep, trim | 1 exclusive semantic kill (updateStatus must bump the version); delete :175. |
| `skill-package` | 2 | 0.08 | 62 | 0 | 0 | – | – | – | Keep | Only test of `scripts/skill-package.ts`. |
| `state` | 9 | 0.06 | 146 | 207 | 5 | 30 | 18 | 1 | Keep, trim (merge target) | 1 exclusive kill; delete :113. |
| `state-migration` | 7 | 0.23 | 252 | 208 | 3 | 28 | 18 | 0 | Merge → state | Migration describe. |
| `state-version` | 1 | 0.06 | 102 | 187 | 0 | 26 | 12 | 1 | Merge → state | Only killer of the cross-process lost-update mutant. |
| `status` | 1 | 0.00 | 55 | 741 | 0 | 49 | 14 | 0 | Rewrite | Claims to test depth and parent columns; both mutants survive it (it only checks header words and IDs). |
| `task-input` | 6 | 0.02 | 65 | 11 | 0 | 6 | 5 | 1 | Keep | Only killer of the blocking-open (FIFO hang) mutant. |
| `test-progress` | 1 | 0.01 | 23 | 0 | 0 | – | – | – | Keep | Guards the dot reporter in agent mode. |
| `tmux` | 8 | 3.03 | 69 | 43 | 3 | – | – | – | Keep | Exclusive lines in `tmux.ts`. |
| `tmux-env` | 66 | 0.14 | 93 | 10 | 0 | 5 | 5 | 1 | Keep | Only stable killer of host-identity leaks into tmux. |
| `tmux-errors` | 16 | 2.00 | 112 | 0 | 0 | – | – | – | Keep | Subprocess tmux error paths; not mutated. |
| `turn-delivery` | 44 | 0.29 | 445 | 1944 | 11 | – | – | – | Keep | 11 exclusive lines. |
| `turn-hook-attribution` | 8 | 0.04 | 131 | 1251 | 0 | 69 | 31 | 0 | Merge → turn-hook-daemon | 0 exclusive of 31 kills. |
| `turn-hook-daemon` | 21 | 0.17 | 252 | 1394 | 2 | 82 | 42 | 3 | Keep (merge target) | 3 exclusive kills. |
| `turn-hook-readiness` | 83 | 0.23 | 139 | 1099 | 0 | 66 | 31 | 0 | Split | 0 exclusive of 31 kills; the same 37 panes run twice (:53-57 and :116-124). Driver half → accepts-input, daemon half → turn-hook-daemon; delete :132. |
| `turn-hook-safety` | 2 | 1.02 | 51 | 68 | 0 | – | – | – | Merge → turn-hooks | Hardlink and moved-binary safety; not mutated. |
| `turn-hook-subagents` | 25 | 0.74 | 223 | 1140 | 27 | – | – | – | Merge → turn-hooks | 27 exclusive lines. |
| `turn-hooks` | 28 | 1.01 | 353 | 565 | 8 | – | – | – | Keep, trim (merge target) | 8 exclusive lines; delete :199. |
| `turn-hooks-launch` | 5 | 0.16 | 79 | 1409 | 0 | 11 | 1 | 0 | Merge → turn-hooks | 0 exclusive of 1 kill. |
| `vibe-driver` | 13 | 0.15 | 223 | 587 | 57 | – | – | – | Keep | 57 exclusive lines; :153 is tautological (one assertion), :92-96 pins a data literal. |
| `version` | 1 | 0.00 | 9 | 1 | 0 | – | – | – | Keep | One assertion, guards the release version. |
| `wait` | 6 | 0.99 | 134 | 1011 | 3 | 27 | 12 | 0 | Keep | 0 exclusive of 12 kills, 3 exclusive lines in `commands/wait.ts`; not read in depth. |
| `wakeup` | 5 | 0.58 | 95 | 845 | 14 | – | – | – | Keep | 14 exclusive lines. |

## Delete: duplicate tests

- [ ] Delete the 36 tests in the table below; keep the three listed after it.

Each row repeats the covering test on the same source branch. "Lines" counts the test's own lines. The last column is the blind reviewer's verdict; "(mutation)" marks rows it settled by mutating the source.

| Test | Name | Lines | Covered by | Reviewer |
| --- | --- | ---: | --- | --- |
| `drivers:56` | codex danger mode includes bypass flag by default | 5 | codex-driver:11 | delete-ok |
| `codex-driver:5` | codex driver exists | 5 | model-named-drivers:28,125 | delete-ok |
| `pi-driver:27` | Pi is registered | 1 | model-named-drivers:28 | delete-ok |
| `launch-profiles:98` | native %s resume still leaves unspecified model and effort unchanged | 6 | resume:202 | delete-ok |
| `drivers:101` | codex hooks trust screens trigger an escape | 9 | codex-readiness:177,198,345 | delete-ok |
| `driver-protocol:555` | codex skips the 0.160 update menu and never mistakes it for the input prompt | 16 | codex-readiness:46,66,133 | delete-ok |
| `driver-protocol:572` | codex keeps waiting past an unknown numbered menu instead of typing into it | 9 | codex-readiness:89,104 | delete-ok (mutation) |
| `driver-protocol:793` | codex switches model through model and reasoning menus | 28 | codex-model-switch:29 + codex-readiness:211 | delete-ok |
| `driver-protocol:620` | claude-code %s fails fast without typing into the workspace safety dialog | 23 | driver-protocol:371,277 | delete-ok |
| `driver-protocol:970` | codex ignores NEED_HELP from an earlier turn | 6 | driver-outcome:20 | delete-ok |
| `resume:40` | kimi extracts resume ID after the first message | 6 | kimi-driver:154 | delete-ok |
| `driver-outcome:97` | Codex unsupported-model error does not inherit older help tags | 15 | codex-driver:31 | delete-ok (mutation) |
| `kimi-driver:553` | detects Kimi Code bullet sentinels | 6 | driver-outcome:36-51 | delete-ok (mutation) |
| `kimi-driver:574` | ignores a historical NEED_HELP after intervention resumes the same turn | 11 | driver-outcome:113 | delete-ok |
| `kimi-driver:323` | accepts resumed generation above the persistent composer within the same turn | 8 | kimi-driver:298 | delete-ok |
| `kimi-driver:387` | does not accept an unchanged retained approval and DONE as a new turn | 21 | kimi-driver:336 | delete-ok (mutation) |
| `kimi-driver:435` | does not accept an unchanged attention panel without newer generation | 20 | kimi-driver:336 | delete-ok |
| `kimi-driver:226` | resume readiness ignores settled historical tool use before a newer prompt | 16 | kimi-driver:210 | delete-ok (mutation) |
| `peer-mail-regressions:275` | F8 reading a symlinked inbox is refused without marking read | 10 | peer-mail-hardening:138 | delete-ok |
| `peer-mail:304` | budget configuration stays out of every driver's launch and resume environment | 20 | peer-mail-regressions:176 | delete-ok |
| `peer-mail:138` | invalid budget %s uses the same fallback as nesting limits | 5 | peer-mail-regressions:160,326 (AHELPA_MAIL_BUDGET params are inert in mail()) | delete-ok |
| `pr6-reservation-edges:359` | startup lease is the documented finite three minutes | 3 | pr6-reservation-edges:363 | delete-ok |
| `pr6-reservation-edges:279` | a foreign launcher cannot publish a running reservation | 5 | pr6-reservation-edges:267 | delete-ok |
| `settle-aba:175` | a normal refresh settles, archives, notifies and records exactly once | 13 | need-help-ledger:54 | delete-ok (mutation) |
| `daemon-recovery:658` | kill propagates failures when the terminal remains alive | 9 | kill-archive-races:136 | delete-ok |
| `daemon-start:65` | does not duplicate the binary path for a real compiled-binary argv | 16 | daemon-start:51 | delete-ok (mutation) |
| `turn-hooks:199` | Claude helper settings disable prompt suggestions | 7 | turn-hooks:213 | delete-ok |
| `state:113` | drops the legacy tmux_session column from existing databases | 33 | state-migration:48 | delete-ok |
| `refresh:26` | preserves settled sessions whose tmux session has gone away | 10 | refresh-snapshot:36 | delete-ok |
| `refresh:50` | retains a token captured in the same draining refresh that reclaims tmux | 17 | daemon-recovery:512 (kimi case) | delete-ok |
| `refresh:68` | does not reclaim a recent draining session after daemon restart | 14 | daemon-recovery:572 | delete-ok |
| `refresh:96` | captures agent resume token after graceful exit enters draining | 18 | daemon-recovery:512 (claude case) | delete-ok (mutation) |
| `kimi-refresh:50` | flags a sustained Kimi approval prompt as needs_attention | 23 | daemon-wake:70 | delete-ok |
| `refresh-snapshot:107` | a capture failure settles a row the snapshot still lists once tmux is gone | 12 | daemon-recovery:585 | delete-ok (mutation) |
| `turn-hook-readiness:132` | row-version change during capture still prevents the hook-aware nudge | 7 | turn-hook-daemon:173 | delete-ok |
| `review-fingerprint-lifecycle:72` | escaped descendant holding stdout cannot prolong fingerprint deadline | 19 | review-fingerprint-bounds (mutant fp-no-cancel confirmed killed twice by bounds) | delete-ok (mutation) |

Proposed but kept after review (each is the only test that catches a mutant of its branch; the reviewer's mutations B, M and H, H reproduced independently):

- `driver-protocol:537` codex skips update prompt instead of accepting update — Only test covering a legacy update screen with no `›` cursor row; `codex-readiness.test.ts:164`'s `oldUpdate` has `› 1. Update now`, so it passes when `codexNeedsUpdateSkip` starts requiring a cursor row.
- `daemon-recovery:191` refresh failures retry on calls 1, 2, 4, 8 while other sessions refresh every call — Only test asserting other sessions refresh on every call while one backs off (`capture.mock.calls` = `Array(8).fill(healthy)`); `:209` has one session, and `:378` is excluded by the task.
- `daemon-wake:53` the wake path is used only as a pipe: never a regular file, never through a link — Only caller of `FIFO.tryWrite` against a regular file and a symlink; `daemon-wake.test.ts:94` tests `FIFO.read`, which has a separate guard.

Assertion-level overlaps also exist inside larger tests (for example `vibe-driver:43` and `agy-driver:40` re-check registration that `model-named-drivers:28` covers; `resume:88` re-checks resume flags that `codex-capabilities:175` covers). They are left for whoever merges the files, since deleting one assertion saves a line, not a test.

## Merge map

Merging keeps every test and removes the per-file imports, setup and copied fixtures (6 copies of a `gate()` helper, 8 hand-written `DriverRuntime` stubs). Keep distinct setups as nested `describe` blocks; Bun applies top-level hooks to every block in a file.

- [ ] `peer-mail-hardening`, `peer-mail-regressions`, `peer-mail-stack` → `peer-mail.test.ts`. The stack tests need the daemon stopped (own `beforeEach`). `peer-mail:357/388` (relationship labels) fit better in `check`/`status`; `peer-mail:325/337` (help text, handoff text) in `command-contract`/`file-handoff`.
- [ ] `kill-tree-rework`, `kill-archive-races`, `kill-nonsettle-races` → `kill-tree.test.ts` (rename `kill.test.ts`); keep the two setup families (spies on layout methods versus `Object.assign` on the layout).
- [ ] New `launch-reservation.test.ts` from `kill-tree-rollback`, `kill-tree-rework:57`, `pr6-reservation-edges:94-264` and the reservation and quota tests of `pr6-guardrails`; then `pr6-reservation-edges:267-308` → `state`, its clean tests and `pr6-guardrails`' → `clean`, `pr6-reservation-edges:347-382` (startup lease) → `refresh`, `pr6-guardrails:88-116, 428-467` → `job`. Both `pr6-*` files disappear.
- [ ] `refresh-snapshot`, `kimi-refresh:28` → `refresh.test.ts` (keep separate describes: in-memory DB with mocked layout versus file DB with the real layout).
- [ ] `state-version`, `state-migration` → `state.test.ts` (three describes: CRUD, migrations, cross-process versions).
- [ ] `turn-hook*` 8 → 3: `turn-hooks` takes `turn-hook-safety` and `turn-hook-subagents` (keep the subagents file's `CODEX_HOME`/`TZ` isolation in a scoped describe); `turn-hooks-launch` joins the driver-launch describe of `turn-hooks`; `turn-hook-attribution` and the daemon half of `turn-hook-readiness` → `turn-hook-daemon`; its driver half → `accepts-input`. `turn-delivery` stays.
- [ ] `codex-*` 7 → 4: `codex-driver` → `codex-readiness` (plus the codex half of `driver-protocol`, :433-580); `codex-model-switch` → `codex-config`; `codex-folder-trust` → `launch`. `codex-capabilities`, `codex-capacity`, `codex-config`, `codex-readiness` stay.
- [ ] `review-ask-lineage` → `review-target`; `review-fingerprint-lifecycle` test 1 → `review-fingerprint-bounds`.

Per-vendor driver files (`agy`, `pi`, `vibe`, `kimi`) are not merged: each is the only coverage of its driver. Share their copied runtime stub instead.

## Rewrite

- [ ] `status.test.ts:25` claims "shows nesting depth and parent session" but only checks header words and IDs that appear in the first column anyway; mutants that print depth 0 or hide the parent survive it. Assert the child row's depth and parent columns.
- [ ] Model catalogs and defaults are pinned as literals in `command-contract` (:56-95, :108-109), `launch-profiles`, `model-named-drivers` (:84-96), `codex-model-switch:166` (the same Codex effort list as `command-contract:61-67`) and `vibe-driver:92-96`. Since 2026-10-19 four default or catalog changes (`5acc0b1`, `4a155cb`, `298584e`, `c9bc81a`) forced about 8 test edits across 5 files. Assert each default once per driver, and elsewhere check structure (the default model is in its own catalog; the default effort is allowed for that model). Cost: a literal guard against an accidental default change remains only in one place.
- [ ] `turn-hook-readiness` runs the same 37 blocked panes through the driver (:53-57) and again through the daemon (:116-124); the daemon half only needs to show the wiring, so one or two panes suffice (about 35 fewer tests at run time). Two table entries are byte-identical (:27 and :45).
- [ ] `file-handoff:224-226` pins whole contract sentences that the keyword checks of the same test (:212-222) already cover.
- [ ] `review-ask-lineage:14` copies the source message text instead of importing it.
- [ ] Polling budgets (capture counts, sleep totals) are pinned in six driver files (for example `driver-protocol:447-502`, `kimi-driver:206/341`, `codex-readiness:277`), so a cadence change touches six files.

## Missing tests

A mutant listed here survived every test file that covers its line. The `status` columns are listed under Rewrite. Mutants that only change a log line, a cache size, a padding width, or remove a second copy of a check that is made twice were judged equivalent and are not listed.

- [ ] `turn-hooks.ts:165` — when one batch of hook events holds a `stop_failure` and a later `stop`, the failure must win ("an error in this batch takes precedence"). Making the last event win survives every test.
- [ ] `commands/session-ops.ts:80` — `send` to a hook-capable helper must normalize the message, so the next turn hook is attributed to it and the fast path is used. Inverting the condition survives.
- [ ] `daemon.ts:374` — after `[AHELPA:DONE]` and the graceful exit, a successful idle → draining compare-and-set must start the drain timer (`drainingAt`) that later reclaims the terminal. Inverting the condition (the timer starts only when the CAS fails) survives.
- [ ] `daemon.ts:226` — a pending capacity or usage-limit confirmation must be dropped once the row leaves `running` or a launch owns it again. Requiring both conditions survives.
- [ ] `drivers/codex.ts:21` — the older Codex trust prompt ("Do you trust the contents of this directory?") on its own; every test screen also carries "Press enter to continue".
- [ ] `evidence.ts:151` — the fingerprint repository cap (`maxRepositories`) is never reached; removing the check survives `review-fingerprint-bounds`.
- [ ] `evidence.ts:120`, `:133` — a git call that reaches the deadline while reading must mark the fingerprint incomplete; both mutants that drop the `timedOut` flag survive (the existing deadline test hits the earlier check at `:150`).
- [ ] `commands/peer-mail.ts:214` — `inbox --read 0` and a non-integer sequence must be refused.
- [ ] `nesting.ts:79` — a root session's `parentSessionId` is `null`, not `undefined`.
- [ ] `commands/launch.ts:619` — `writerConflict` is absent from the launch result when there is no conflict.
- [ ] `archive.ts:38` — `Archive.reasonFor` and `Archive.revision` have no direct test; `reasonFor` returning a reason for a running row survives.
- Unclassified: removing any of five `continue` statements in the daemon poll loop (`daemon.ts:222`, `:245`, `:276`, `:394`, `:401`) survives. Each lets a row fall through to the next stage in the same poll; later stages may re-check status, so some may be harmless. Worth one reading before writing tests.

## Estimated savings

| Action | Files | Test declarations | Tests at run time | Lines | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Delete duplicates | 0 | 36 | 41 | 452 | 0.95 |
| Merge clusters | −22 | 0 | 0 | ~200–300 | ~0 |
| Collapse the daemon-level pane loop | 0 | 0 | ~35 | ~0 | ~0.1 |
| Rewrite pins | 0 | 0 | 0 | ~0 | 0 |
| **Total** | **94 → 72** | **−36** | **≈ −76** | **≈ −650 to −750 of 21,174** | **≈ −1 of 287** |

## Helpers

| Helper | Role | Task | Wall time | Result |
| --- | --- | --- | ---: | --- |
| Sonnet subagent | reader | Fact sheet: lifecycle, kill, peer-mail, pr6, settle (15 files) | 9.6 min | 10 duplicate pairs reported; 1 overstated (`pr6-reservation-edges:285`); 1 flag withdrawn (`peer-mail-hardening:145`: its effective spy is `fstatSync`) |
| Sonnet subagent | reader | Fact sheet: turn hooks, refresh, state, daemon, review (21 files) | 12.8 min | about 20 pairs; `daemon-recovery:191` and `daemon-wake:53` were overstated (kept after review); 1 flag withdrawn (`turn-delivery:410` tests a legacy column) |
| Sonnet subagent | reader | Fact sheet: drivers, codex, catalogs (23 files) | 8.9 min | about 25 pairs; 6 were assertion-level or different functions and left out |
| `glm-56f5e9c87742` | `glm` worker | 26 semantic mutants for the kill and settle path | 22 min | 25 killed; every kill file has a unique or kill-file-only kill; found the `send`-re-arm race no kill file covers (glmA-19) |
| `glm-ff3630095349` | `glm` worker | 27 semantic mutants for peer mail and launch reservations | 26 min | 27 killed; `pr6-reservation-edges` 0 unique in that batch |
| `deepseek-e5c1f4098a88` | `deepseek` reviewer | Blind check of the 39 proposed deletions | 7.6 min | 36 delete-ok, 3 keep, 13 mutations; it could not read fix commits because its copy had one squashed commit |

## Not done

- 36 files did not run as mutation candidates (26 with exclusive coverage lines; the scripts and subprocess tests in step 1). Their conclusions rest on coverage and reading.
- Shell scripts (`scripts/closure-gate.sh`, `scripts/install.sh`) and the release workflow were not mutated.
- Mutation was per file, not per test, except for the reviewer's 13 mutations on the delete list.
- The savings were estimated from the baseline run, not measured on an edited suite. Nothing ran on Linux.
- `integration.test.ts` (hermetic-e2e lane) and the speed of `closure-gate.test.ts` and `interrupt.test.ts` (test-speed lane) were left to their owners.

Scratch (mutation runner, generators, per-mutant results, cluster fact sheets) is under `$TMPDIR/ahelpa-ablation/` on the machine that ran this audit and is disposable; the tables above carry the evidence.
