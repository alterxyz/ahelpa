# Helper Profiles

Callee profiles for choosing a helper type, role, model, and contract. They come from an analysis of 750 archived ahelpa sessions (codex 479, claude 255, kimi 12). They describe observed delegation behavior on coding tasks, not capability rankings: the archive reflects what this host assigned to each type, so the load mix biases every comparison. Defaults (model, effort, roles) are in `SKILL.md`; this file only says which to pick and what to put in the task.

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
- About 8 of 12 ended `needs_attention`. Too small a sample to generalize, but enough to avoid it for important work.

**Give it**
- Low-stakes, easily checked probes only. Omit `--model`, `--role`, `--effort`.

**Runtime quirks**
- Auto-trusts the project folder; `--safe` is not a sandbox. See `kimi.md`.

## Task type to helper

| Task | Helper | Role | Contract emphasis |
| --- | --- | --- | --- |
| Implementation | codex | worker | Failing-first test, forbidden list, final-diff verification with exit codes and `-count=1`-style cache off |
| Adversarial review | a different model than the implementer (archive: mostly codex with mutation testing; claude for judgment-heavy review) | reviewer | Built-in reviewer contract (review-only, verdict first, findings with `path:line` and P1/P2, reruns with exit codes and cache off, at least 3 reverted mutations, unchecked list); add host-supplied commands to rerun |
| Rework after review | codex | worker | Map each finding to a change; no new tests that only mirror the fix; full-suite rerun after the last edit |
| Focused re-review | same choice as the adversarial review | reviewer | Built-in reviewer contract; check only the delta plus regressions; do not assume the rework's own claims |
| Read-only investigation | claude-code | advisor | Question, scope limits, `file:line` evidence, "not examined" section |
| Mutation testing | codex | worker | Report mutants tried, killed, survived; survivors become tests |
| Docs and prose | claude-code | worker (or advisor if judgment-heavy) | Source files to cite, no code changes |

## What the host must do regardless

- Compare `wait`'s `evidence` (`summaryBytes`, `changedFiles`, `testFilesChanged`) with the summary's claims. A mismatch is a finding: claimed edits but empty `changedFiles`; claimed new tests but empty `testFilesChanged`; test files changed that the task never asked for; a tiny `summaryBytes` for a large diff.
- Rerun the key verification yourself with caching off (`-count=1` or equivalent). Self-reports and independent reviews disagreed often enough to make this the default.
- Pass tasks with `--file` of a durable path. 33 archived tasks said "read /private/tmp/xxx.md"; in a sample of 10, 9 files were already gone.
- Write tasks the way the good ones did: the why, acceptance checks, a forbidden list, `file:line` for claims.
- Pass `--check "<cmd>"` for implementation and rework: ahelpa reruns it on the final state when `wait` returns and puts the result in `evidence.check`. Trust that over the summary's own exit codes.
- Pass `--after <previous-id>` on review and rework hands so the helper gets the previous `task.md`, `summary.md`, and `artifacts/` paths (as claims to check, not facts).
- Pass `--worktree` when the helper's edits should not touch your working tree, or when several helpers run in parallel on one repo. It branches from `HEAD`, so uncommitted changes are not included; ahelpa never removes the worktree.
- Read the diff before committing. Helpers do not commit for you.
