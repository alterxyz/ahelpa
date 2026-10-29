# Helper Profiles

Callee profiles for choosing a helper type, role, model, and contract. The historical profiles come from an analysis of 750 archived ahelpa sessions (codex 479, claude 255, kimi 12). They describe observed delegation behavior on coding tasks, not capability rankings: the archive reflects what this host assigned to each type, so the load mix biases every comparison. DSH is newly integrated and is not represented in that sample. Defaults (model, effort, roles) are in `SKILL.md`; this file only says which to pick and what to put in the task.

Every profile assumes the task file ends with the `## ahelpa contract` and `## ahelpa signals` sections ahelpa appends. Do not weaken them.

## claude-code advisor (default role)

**Best at**
- Review, planning, and writing: Claude sessions were mostly review, plan, and prose work.
- Honest scoping: when work was not done, summaries said so (example: "did not run any tests").

**Watch for**
- Slow tail: p50 12 min, p75 67 min. A long wait is normal; do not kill on duration alone.
- Missing sentinel: 25% of archived Claude sessions ended `needs_attention`, and 47 of those 63 had already written `summary.md` without printing `[AHELPA:DONE]`. Read `summary.md` before treating it as a failure.
- Thin evidence: 49 of 104 summaries never mention verification; only 15% give an exit code.

**Give it**
- A bounded question or diff, a decision criterion, and a required output shape (findings with `file:line`, severity, what was not checked).
- For reviews: the exact commands to re-run, so the verdict rests on its own execution.

**Runtime quirks**
- Fails fast on an untrusted workspace (run `claude` there once first).
- `--effort` is launch-time only.

## claude-code worker (`--role worker`)

**Best at**
- Writing, docs, and small bounded edits against a clear objective.

**Watch for**
- Same sentinel and evidence issues as the advisor. There is no separate archive sample, so no worker-only rates are claimed.

**Give it**
- A narrow file list and acceptance check. For substantial implementation or mutation testing, prefer codex (see table).

**Runtime quirks**
- Same as advisor. Role changes the model default only, not permissions.

## codex worker

**Best at**
- Implementation and mutation testing: it carried nearly all of both. Summaries mentioning mutation: codex 73, claude 4.
- Predictable timing: p50 11 min, p90 34 min.
- Disclosure: no confirmed case of editing tests to fit the implementation. Every changed old assertion was disclosed.

**Watch for**
- Weak tests, not cheating: mutation survival rates of 18-40% (13 mutants with 5 surviving, 17 with 5, 12 with 3 missed).
- Stale or partial verification: failures traced to cached `go test` results and to no full-suite rerun after the last edit.
- Over-building: unrequested refactors, renames, abstractions, flags, dependencies, or doc rewrites grow the diff you must judge. Launch with `--scope` and read `evidence.outOfScopeChanges` before the summary; the contract sends other ideas to `## Suggestions (not done)` in `summary.md`.
- No verification claim at all: 115 of 376 summaries never mention it; only 32% give an exit code.
- Self-report vs. review: of about 20 adversarial reviews of codex implementations, about 19 ruled "must fix". Treat "done, all green" as a claim to check, not a result.
- Rework risk: two rework rounds introduced a new P1. About half of focused re-reviews after rework still ruled "needs rework".
- Scope: two out-of-scope reads, both self-reported.
- Delivery: two tasks arrived with the head of the instructions truncated (2026-09-24 and 09-26, before the October driver fix). Confirm the helper restated the objective if a result looks off-topic.

**Give it**
- Objective and the reason for it, acceptance checks, an explicit forbidden list (paths, global archives, unrelated projects), and a `file:line` requirement for claims.
- For new behavior: require a test that fails without the change.
- For verification: the final diff's commands with exit codes, run with caching off (`go test -count=1`, equivalents elsewhere), and rerun after the last edit.

**Runtime quirks**
- Roles: `worker` (default) and `reviewer`; `--role advisor` is rejected.
- Content filtering once stalled the main process at the "write the merged report" step. Ask for per-part files in `artifacts/` and keep the final `summary.md` short, so the host can assemble by hand if needed.
- `needs_attention` was rare (2%).

## kimi

**Best at**
- No claim. Only 12 archived sessions.

**Watch for**
- About 8 of 12 ended `needs_attention`, but those sessions predate Kimi Code 2.x and the current driver. Too small a sample either way.

**Give it**
- Well-scoped, checkable coding tasks, ideally with `--check`, when Claude or Codex quota is tight. Keep important or ambiguous work elsewhere until it has a track record. Omit `--model`, `--role`, `--effort`.

**Runtime quirks**
- Auto-trusts the project folder; `--safe` is not a sandbox. See `kimi.md`.

## dsh

**Observation status**

These observations were gathered on the `deepseek-official` route; the Magpie route has not been re-evaluated.

- Small controlled onboarding sample, 2026-10-22: DSH `0.2.1-rc.2`, `deepseek-flash` / `high`, through the ahelpa profile. Prompts, task contracts, and profile affect the observed behavior. These trials are not an archive, reliability estimate, or comparison with other helpers.
- Bounded parser repair: 44 helper tests and 132 independent host cases passed; the final file inventory and source diff stayed within the allowed source/test files, and the README remained unchanged.
- A native-resume follow-up changed the parser's upper bound from 86400 to 3600. It made a one-line implementation change, disclosed the old-test updates required by the new rule, and passed 51 helper tests plus 132 new-bound host cases; the final inventory and diff remained within scope.
- A seeded permission review found all three planted fault groups: public access bypassing identity/active/tenant checks, owner access before tenant isolation, and treating a share list as truthy authorization. The host reran its 15 regression checks on the faulty target: 8 passed and 7 reproduced failures.
- A separate fresh review of the correct control returned `ship` with no code findings. The host reran 13 regression checks and a 288-case combination oracle, all passing; three host-written mutants were caught by the reviewer's regression suite and the original source hash was restored.
- These are distinct fixture results, not one combined success rate. Large implementations, broad repository review, and long-running work remain unverified. See the [onboarding record](https://github.com/alterxyz/ahelpa/blob/main/docs/dsh-onboarding.md) for evidence and limits.

**Candidate assignments**
- Bounded implementation where the host has an independent oracle or acceptance check.
- Independent semantic review of a frozen target against explicit rules; keep a correct control and permit zero findings.
- Source-grounded discussion of a small set of options, with decision-bearing claims tied to supplied sources. This is a tentative assignment, not a demonstrated advantage over another helper.
- It suggested gradually trying real tasks in isolation rather than freezing historical assignments. That is a proposal for further evaluation, not an observed capability.

**Watch for**
- In the initial five Chinese conversation turns, open questions produced long, polished answers; direct response-length feedback shortened them. It partly revised disputed views while retaining reasoned disagreement.
- A precise-looking percentage was acknowledged as rhetoric when challenged. Ask for evidence behind consequential claims instead of inferring accuracy from fluency.
- A later read-only onboarding discussion produced a 22,300-byte summary and created a script checking headings and line references. Such format checks are not evidence that the prose's meaning is correct; do not mechanically add verification scripts to prose tasks.
- That discussion self-reported writing and then deleting a temporary log outside its allowed paths. The host confirmed final absence, but the final tree could not independently establish the transient write. Scope compliance in the parser fixtures is a local result, not evidence of general scope reliability; keep explicit path constraints and host checks.
- Under an explicit short brief, a simulated page/unsupported-speedup discussion returned a 176-character reply (146 Han characters), one question, two directions, and a screenshot next step without claiming screen access or speed data. Its summary was 1,265 bytes; artifacts contained only `reply.md`, with no new checker. Inline length counting was required acceptance. This different task and prompt are not a controlled A/B comparison or evidence of lasting scope compliance.

**Give it**
- The ordinary worker or reviewer brief, plus only the task-specific response guidance needed from [the Flash working card](dsh.md#working-with-flash). Avoid making every small task produce a report or a fact/inference table.
- Explicit replacement wording when a new condition supersedes an old one; require verification to follow the new rule and disclose changed assertions.
- `--role reviewer` for the review-only contract; the preset uses the same `magpie:deepseek/deepseek-flash`/`high` settings as the default worker. Source-grounded discussion uses `worker`, since DSH has no `advisor` role.

**Runtime quirks**
- Uses a separate `ahelpa` profile and a session-local terminal app; native DSH session persistence supports resume.
- Defaults to the local Magpie gateway. `--model <model>` keeps the profile provider; `<provider>:<model>` selects it, splitting at the first colon. Model IDs are provider-specific; effort is `off|low|high|max`.
- No `--safe` or runtime model switching. See `dsh.md` for prerequisites, authentication, and profile behavior.

## Task type to helper

| Task | Helper | Role | Contract emphasis |
| --- | --- | --- | --- |
| Implementation | codex | worker | Failing-first test, forbidden list, final-diff verification with exit codes and `-count=1`-style cache off |
| Adversarial review | a different model than the implementer (archive: mostly codex with mutation testing; claude for judgment-heavy review) | reviewer | Built-in reviewer contract (review-only, verdict first, findings with `path:line` and P1/P2, reruns with exit codes and cache off, at least 3 reverted mutations, unchecked list); add host-supplied commands to rerun |
| Rework after review | codex | worker | Map each finding to a change; no new tests that only mirror the fix; full-suite rerun after the last edit |
| Focused re-review | same choice as the adversarial review | reviewer | Built-in reviewer contract; check only the delta plus regressions; do not assume the rework's own claims |
| Read-only investigation | claude-code | advisor | Question, scope limits, `file:line` evidence, "not examined" section |
| Mutation testing | codex | worker | Report mutants tried, killed, survived; survivors become tests. Mutant copies go under `$AHELPA_SCRATCH`; `artifacts/` gets each mutant's patch and the test log, never a tree copy |
| Docs and prose | claude-code | worker (or advisor if judgment-heavy) | Source files to cite, no code changes |

## What the host must do regardless

- Compare `wait`'s `evidence` (`summaryBytes`, `changedFiles`, `testFilesChanged`) with the summary's claims. A mismatch is a finding: claimed edits but empty `changedFiles`; claimed new tests but empty `testFilesChanged`; test files changed that the task never asked for; a tiny `summaryBytes` for a large diff.
- Rerun the key verification yourself with caching off (`-count=1` or equivalent). Self-reports and independent reviews disagreed often enough to make this the default.
- Pass tasks with `--file` of a durable path. 33 archived tasks said "read /private/tmp/xxx.md"; in a sample of 10, 9 files were already gone.
- Brief the helper like a peer: state the goal and why, keep the scope narrow, include acceptance checks, a forbidden list, and `file:line` for claims. Ask the question, not your answer; for investigations, list what you already ruled out instead of what you suspect. Give pointers to files and docs worth reading, not pasted copies; the brief is the helper's only task context.
- Continue with `task` or `resume` when the session's context is the asset; launch fresh when blindness is the asset. Never continue a reviewer into a fix. Zero findings is a valid review result; do not invent findings to fill a quota.
- Pass `--check "<cmd>"` for implementation and rework: ahelpa reruns it on the final state when `wait` returns and puts the result in `evidence.check`. Trust that over the summary's own exit codes.
- Pass `--after <previous-id>` on review and rework hands. An explicit reviewer gets the previous host-written `ask.md` and diff target by default; the author's full task, summary, and artifacts stay withheld unless `--unblind` is requested. Non-reviewer rework gets those paths as claims to check, not facts.
- Pass `--worktree` when the helper's edits should not touch your working tree, or when several helpers run in parallel on one repo. It branches from `HEAD`, so uncommitted changes are not included; ahelpa never removes the worktree, and its results go to the source repo's `.ahelpa/<id>/`, so removing the worktree keeps them.
- Read the diff before committing. Helpers do not commit for you.
