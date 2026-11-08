# Helper Profiles

Callee profiles for choosing a helper type, role, model, and contract. The historical profiles come from an analysis of 750 archived ahelpa sessions (codex 479, claude 255, kimi 12). They describe observed delegation behavior on coding tasks, not capability rankings: the archive reflects what this host assigned to each type, so the load mix biases every comparison. Pi and Antigravity are newly integrated and are not represented in that sample. Defaults (model, effort, roles) are in [names.md](names.md); this file only says which to pick and what to put in the task.

Every profile assumes the task file ends with the `## ahelpa contract` and `## ahelpa signals` sections ahelpa appends. Do not weaken them.

## claude advisor (default role)

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

## claude worker (`--role worker`)

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

## deepseek-pi

**API backup for [deepseek](#deepseek).** Configure official DeepSeek in CC-Switch and sync it to Pi so the `cc-switch-deep-seek` provider exists. Worker and reviewer default to `cc-switch-deep-seek/deepseek-flash` / `high`; explicit `--model provider/id` and `--effort <level>` override them. `advisor`, `--safe`, and runtime model switching are unsupported.

**Observation status**
- Pi 1.5.0 ran 20 launches on 2026-11-06 without a stall, false completion, or error; the ahelpa tested baseline is 1.4.0. This short sample does not establish long-task or broad-repository reliability.
- Replay of the four-task trial (2026-11-07, see [case study](../../docs/case-deepseek-trial-20261106.md)): quality and habits matched [deepseek](#deepseek): 6/6 rule lookups, 9/9 hidden tests, heavy self-verification, a push the project forbids made because the brief asked, placeholders in the real ID range. It was not faster on real tasks (2.6–8.8 min). One turn failed before any tool call when the official API returned `503 Service is too busy` four times.

**Watch for**
- A provider error ends the turn as `error` with only `pi: native turn failed`; the bridge shows no category. Read the Pi session log under `~/.pi/agent/sessions/` for the cause, and relaunch on overload.
- Summaries longer than the requested length, and coverage claims slightly stronger than the tests support.
- Input-validation edges left open (whitespace-only values, overflow to infinity) and untested environment wiring; tests whose expected value equals the fallback catch no mutants. Ask for a mutation check on validation code.

See [Pi setup and limits](pi.md) for version requirements, interrupt controls, session locking, and native takeover.

## gemini

**New integration (2026-11-06). First choice for prose people will read, divergent ideation, and the generative half of strategy work; never the critical voice.** Google Antigravity CLI, default `gemini-4-argon` / `medium` (Gemini 4 Argon · medium). Roles: `worker` (default) and `reviewer`; `advisor`, `--safe`, and runtime model switching are unsupported.

**Observation status**
- Integration checks only: Antigravity 1.5.2 smoke runs, then its own TUI on 1.5.3 (2026-11-07), and the closure gate (completion, native resume with context recalled, kill mid-turn). No task-quality comparison inside ahelpa yet.
- Owner's assessment of Gemini 4 Argon (2026-11-06, from use outside ahelpa): a very good writer, best at text meant for people, and good at divergent thinking. Its clear weakness is agreeing with whatever it is given: it polishes the premise into being right and rarely raises a critical objection. The owner also expects it to suit strategy work, grand strategy especially. This is about the default model; gemini's other models are not assessed.
- Public reviews (read 2026-11-06, three weeks after release; anecdotes and vendor numbers, not ahelpa runs) agree on the writing: it ranks at or near the top of LMArena's creative-writing board and is praised as a structural editor. They add that one-shot first drafts tend to be dense, with long sentences and elevated wording, and that, in one review panel's words, it "generates more ideas than it verifies": it seldom goes back to check its own work. Some users call it sycophantic; Google's model card claims less sycophancy than earlier Gemini models, a comparison outside reviewers dispute. No one has measured strategy work directly; users credit it with long-horizon, open-ended reasoning when the prompt is well specified.

**Watch for**
- Antigravity's own question tool opens a multiple-choice dialog that waits for a person; the helper then shows `needs_attention` (it is not answered for you). Tell it not to ask, and when to stop and signal `NEED_HELP` instead.
- Agreement is not evidence. An Argon summary that endorses the brief's premise says little about whether the premise holds; look for what it actually checked.
- The model may decline a destructive command on its own and report it as skipped (seen with `git push --force`). Read the summary for skipped steps, not only the exit status.
- Under `--dangerously-skip-permissions` file access outside the project and ordinary commands run without a prompt (seen 2026-11-07). Per Antigravity's 1.5.2 changelog (not reproduced by ahelpa), commands on its system denylist are blocked, so the helper sees a refusal instead of a prompt.
- A long command becomes an Antigravity background task; the turn waits for it and settles only after the task ends, so a server it leaves running keeps the helper busy until you kill it.

**Give it**
- Prose for people to read: explanations, docs, announcements, drafts. Give it the facts and the sources and let it hold the pen; have a different model check its claims against the sources before the text ships. Ask for plain wording and short sentences, since first drafts run dense.
- Divergent work: brainstorming, alternatives, framings, naming. Ask for many options with their trade-offs, not a verdict; the host or another model chooses.
- Strategy, grand strategy included: mapping the landscape, long-horizon scenarios, alternative paths, and the write-up people will read. Give it the goals, constraints, and facts, and ask for several strategies, each with its assumptions and how it could fail. Then have a different model attack those assumptions, and leave the choice to the owner. Strategies usually fail on a wrong premise, and going along with the premise is this model's known weakness, so it must never be the only voice.
- Not adversarial review, verdicts, ship decisions, or "is this right?" questions: it sides with the premise. Use the `reviewer` role on another model (codex or claude), even though gemini accepts `--role reviewer`.
- Choose the effort with `--effort low|medium|high`; a suffixed `--model` needs the matching `--effort`.

**Runtime quirks**
- Each helper is Antigravity's own TUI in tmux; resume reopens the same Antigravity conversation. The conversation ID is printed only when the helper exits, so a helper killed before it finished cannot be resumed. See [gemini setup and limits](agy.md).

## mistral

**Observation status:** new; not yet observed in real use; not in default dispatch (2026-11-06). The Vibe 3.1.0 spike establishes protocol, resume, permission and thinking configuration only; no task-quality or reliability claim follows from it.

**Best at**
- No assignment claim yet. Launch by name for bounded trials with independent acceptance checks.

**Watch for**
- Exit 0 without the completion sentinel still needs attention; interruption (exit 3) also needs attention. Read the result before deciding to continue.
- Thinking levels vary by model. The driver accepts `off|low|medium|high|max`; a level outside the model’s supported set can still be sent by Vibe with a warning.

**Give it**
- A narrow task, scope limits, a short expected result, and a check the host can rerun.

**Runtime quirks**
- `worker` (default) and `reviewer` use `mistral-large-4-0-3` / `high`. No `advisor`, `--safe`, or runtime model switching.
- The tmux bridge and native session persist; each turn starts a new headless child with native resume. Model/thinking come from a session agent file. See [Vibe setup and limits](vibe.md).

## deepseek

Uses the Vibe harness and Mistral subscription, with `deepseek-v4-1-flash-1017` / `high` for both `worker` and `reviewer`. The subscription must include the model. This is the subscription-first DeepSeek route; use `deepseek-pi` as the API backup when the first turn reports model unavailability or authentication failure. Pi observations do not establish this route's task quality. It shares [mistral](#mistral)'s bridge and limits. The bridge writes the full model definition per session, without editing global Vibe config; see [DeepSeek setup](vibe.md#deepseek-through-the-mistral-subscription).

**Observation status**
- One bounded trial (2026-11-06), one run per task, same briefs as `codex` (`gpt-6-astra` / `medium`) and `claude --role worker` (`claude-sonnet-5-5` / `high`), each in an isolated clone of a large private repository with a 76 KB AGENTS.md, project skills, and repo CLI tools. Four tasks: six rule lookups across AGENTS.md; applying a project skill whose answers need its CLI; running a repo checker on a seeded draft and proposing compliant fixes; a small feature with a hidden 9-test acceptance suite. DeepSeek matched every expected answer, ran the skill's CLI the documented way (codex skipped it and read the table by hand), passed 9/9 hidden tests like both others, and checked more of its own claims than either, finding real tool defects. For bounded tasks its quality was on par with both. Not yet observed: long multi-file work, ambiguous tasks, rework after review, reliability across many runs. Full record: [case study](../../docs/case-deepseek-trial-20261106.md).

**Watch for**
- Slower: 2.6–5.7 min per task against about 1–3 min for codex and claude, and summaries about twice as long.
- It obeyed a brief that broke a project rule (push to a remote the repository forbids), after noting the conflict in summary.md. Claude did the same; codex refused. Do not count on it to overrule a brief: keep such steps out of the task.
- It wrote placeholder ticket numbers next to real ones, labelled as placeholders. Ask for obviously fake placeholders or none.
- Vibe loads the whole AGENTS.md and skills from `.agents/skills`, `.vibe/skills`, `~/.agents/skills` and `~/.vibe/skills`, not `.claude/skills`, and runs no Claude Code hooks. Project rules enforced only by Claude hooks are not enforced for this helper.

## Task type to helper

| Task | Helper | Role | Contract emphasis |
| --- | --- | --- | --- |
| Implementation | codex | worker | Failing-first test, forbidden list, final-diff verification with exit codes and `-count=1`-style cache off |
| Adversarial review | a different model than the implementer, not gemini (it sides with the premise) (archive: mostly codex with mutation testing; claude for judgment-heavy review) | reviewer | Built-in reviewer contract (review-only, verdict first, findings with `path:line` and P1/P2, reruns with exit codes and cache off, at least 3 reverted mutations, unchecked list); add host-supplied commands to rerun |
| Rework after review | codex | worker | Map each finding to a change; no new tests that only mirror the fix; full-suite rerun after the last edit |
| Focused re-review | same choice as the adversarial review | reviewer | Built-in reviewer contract; check only the delta plus regressions; do not assume the rework's own claims |
| Read-only investigation | claude | advisor | Question, scope limits, `file:line` evidence, "not examined" section |
| Mutation testing | codex | worker | Report mutants tried, killed, survived; survivors become tests. Mutant copies go under `$AHELPA_SCRATCH`; `artifacts/` gets each mutant's patch and the test log, never a tree copy |
| Prose for people to read (explanations, docs, drafts) | gemini | worker | Facts and source files to cite, no code changes; a different model checks the claims against the sources |
| Brainstorming and alternatives | gemini | worker | Many options with trade-offs, not a verdict; the host or another model chooses |
| Strategy (landscape, scenarios, options, the write-up) | gemini, then a red-team pass on a different model | worker | Goals, constraints, and facts; several strategies, each with assumptions and failure modes; the other model attacks the assumptions; the owner decides |
| Docs that must match code exactly | claude | worker (or advisor if judgment-heavy) | Source files to cite, no code changes |

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
