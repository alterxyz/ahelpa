# AGENTS.md

Instructions for agents working on the ahelpa codebase.

## What This Is

`ahelpa` is a local helper runtime for coding agents. It lets one agent launch another as a persistent helper in a tmux session, pass tasks through files, and wait for completion via FIFO-based blocking.

> **Naming:** `ahelpa` is frequently dictated by voice input as **"A help A"** (also "a help a" / "agent help agent"). Those are registered as skill triggers so voice-driven users still activate it.

**Stack:** Bun CLI runtime, on-demand daemon, tmux sessions, SQLite state, FIFO wakeup, skill packaging.

**Platform:** macOS and Linux (x64 and arm64). The runtime is platform-agnostic Bun; only the release/install plumbing is platform-aware.

## Design Rule: Helpers Run in Their Own Terminal UI

Every helper is driven the way a person drives it: the vendor's own interactive TUI in tmux, input through `send-keys`, outcome read from the screen (the `[AHELPA:DONE]` / `[AHELPA:NEED_HELP]` sentinel). Do not add headless, print, RPC, stream-json or ACP bridges, even when the upstream recommends them for automation. A CLI that cannot be driven this way is declined. Hooks may speed up turn-end detection but never decide the outcome. The reasons, and how the project once drifted into bridges (2026-10-30 to 2026-11-07), are in [Helper backends](docs/backends.md#how-a-helper-is-wired). Only the owner changes this rule; a precedent set by an earlier driver is not a reason.

A helper is its ahelpa ID, the tmux session name ahelpa gives it at launch; `send`, `interrupt`, `capture`, `attach` and `kill` need nothing else. The CLI's native conversation ID and `resume` are optional: record the ID where the CLI shows it anyway, and never press keys or delay `kill` to get one. Reopening a killed helper almost never happens; continuing a finished one does (28 of 791 helpers in October and November 2026, mostly for rework or a focused review), and a CLI without native resume gets a new helper with a brief instead. Give a working helper patience: while its screen shows work there is no time limit, and the no-sentinel fallback (about 12 s of a quiet screen) is not to be shortened to catch a silent stop sooner, since a false alarm wakes the host and invites it to interrupt or kill work in progress. Recognize a finished turn sooner only from positive signals: the sentinel, and a turn-end hook where the CLI offers one per launch. Owner decisions of 2026-11-08; details in [Helper backends](docs/backends.md#how-a-helper-is-wired).

## Source vs Installed Runtime

| | Source tree | Installed runtime |
| --- | --- | --- |
| Location | This git repo | `~/.ahelpa/bin/ahelpa` |
| Edit | `src/`, `skill/`, `tests/`, `docs/` | Do not patch generated output |
| Run | `bun run src/cli.ts <cmd>` | `ahelpa <cmd>` |
| Test | `bun run test` | `bun run closure:gate` |

## Repo Layout

- `src/cli.ts` — process entry point
- `src/command-contract.ts` — command registry (single source of truth for CLI surface)
- `src/commands/` — launch, wait, session-ops
- `src/drivers/` — agent-specific adapters (claude-code, codex, kimi, pi, agy, vibe, devin)
- `tests/` — Bun test suite
- `scripts/` — build, deploy, packaging, closure gate
- `skill/` — skill package source (docs + generated bundle during local packaging)
- `docs/` — public documentation

## Documentation i18n

English is the default public documentation language. Simplified Chinese lives beside it:

- `README.md` / `README.zh-CN.md`
- `docs/*.md` / `docs/zh-CN/*.md`

When changing user-facing docs, update both language versions or explicitly note why only one language changed.

Exception: `docs/backends/*.md` (candidate cards) are English-only dated evidence for agents, with no zh-CN copy. `docs/backends.md` stays bilingual.

## Requirements

- macOS or Linux, Bun 1.4.2 (pinned in `packageManager` and CI), tmux
- Node.js >=22.20.0 with working `npx` for `ahelpa install-skill` / public skill installation
- `jq` for shell examples (not required by runtime)

## Common Commands

```bash
bun run test                   # run tests (scripts/test.sh, parallel)
bun run typecheck              # tsc --noEmit over src/ and tests/
bun run build                  # compile binary
bun run package:skill          # build skill package
bash scripts/deploy-local.sh   # install runtime + global hard-copy skills
ahelpa install-skill           # refresh global skill from the public repo
bun run closure:gate           # end-to-end gate
```

`bun run test` runs `scripts/test.sh`: every test file except a few timing-bound ones in parallel workers, then those files in a small parallel pass of their own. It takes about 30 s (20–30 s on 2026-11-19, with other work loading the machine); plain `bun test` runs the files one at a time in about 85 s. Both print one dot per test (`bunfig.toml`). Bun hides passing tests from AI agents, so the dots are the only progress an agent sees; `bun run test` prints two `Ran N tests` summaries, so wait for the second before calling it hung.

## Closure Gate

Before closing local runtime work:

```bash
bun run closure:gate
```

The gate runs tests, typechecks, builds, and launches `claude` and `codex`; Kimi runs with `AHELPA_GATE_KIMI=1`, `deepseek-pi` runs with `AHELPA_GATE_PI=1`, `gemini` runs with `AHELPA_GATE_AGY=1`, `mistral` runs with `AHELPA_GATE_VIBE=1`, `deepseek` runs the same Vibe scenario with `AHELPA_GATE_DEEPSEEK=1`, and `devin` runs with `AHELPA_GATE_DEVIN=1`. For each, verify that `wait`/`check` can observe session state and `kill` reclaims the session. Kimi, Pi, agy, Vibe, and Devin also verify native resume and context continuity. Pi, agy, Vibe and Devin run their own TUIs, so their gates also wait for the native ID read from the exit screen and kill a resumed helper mid-turn (`sleep 120`), checking that none of the pane's recorded processes survive; Devin's tool outlives the pane's hangup, so its gate interrupts the turn before the kill. Pi requires Node.js and Pi >= 1.4.0, using `cc-switch-deep-seek/deepseek-flash` / `high` after configuring DeepSeek in CC-Switch and syncing to Pi, unless gate overrides are set. agy requires agy >= 1.5.2 and uses the `gemini-4-neon` / `medium` default. The Vibe types require vibe >= 3.1.0; `mistral` uses `mistral-large-4-0-3` / `high` and `deepseek` uses `deepseek-v4-1-flash-1017` / `high` through an eligible Mistral subscription. `devin` uses `swe-2-flash` / `medium` (Free plan) after `devin setup`. If a helper CLI fails during authentication bootstrap, fix that CLI's login state first.

## Open Work

Campaign records with unchecked boxes live in `docs/superpowers/plans/`. At the start of a session, check them for open items before proposing new work:

- `2026-10-08-helper-contract-and-evidence.md` — observation period for the v0.9.0 contract / evidence / `--check` / nudge mechanisms. Still open: re-count the nudge numbers on builds after 2026-10-20 and decide what to tune, the contract-wording decision, one Linux run of the evidence/wait tests, and four watch-only items (`nudged_at` never resets, other Claude `❯` forms, old sessions' skill snapshot, the intermittent Codex "did not expose the submitted task" launch failure).
- `2026-11-19-daemon-and-launch-defects-from-host-reports.md` — five defects a host project logged in August–October. Items 1, 2, 3 and 5 were fixed on 2026-11-19 (build identity warning, logged daemon loop failures, `--after` warning, session ID printed last). Still open: item 4, the Claude "did not expose the submitted task as a new turn" launch failure, which needs a bounded loop of real Claude launches to measure; under heavy machine load it also showed up in tests that launch a real `claude`.
- `2026-11-19-test-suite-ablation.md` — which tests to delete, merge, rewrite or add, with coverage and mutation evidence. Its deletions, merges and the 11 missing tests are being carried out; the boxes in that file track what is done.
- `2026-10-18-codex-helper-status-detection.md` — both fixes are pushed and installed. Still open: align the Codex host instructions with the owner's memory-service policy (through the owner's config flow), and decide whether `wait --check` needs its own time budget.

Fully shipped records are removed from the tree so searches stay lean. Read them from git history:

- `git show b87fe45:docs/proposals/2026-10-08-orchestration-lessons-clawwork-confer.md` — the full original behind the rejected designs (MCP server, workflow engine, full permission as the only posture, process-per-delivery, a shared transcript, an ACP transport; §6). The current summary of each is in [`docs/backends.md#rejected-designs`](docs/backends.md#rejected-designs); read that before proposing any of them again, and use the original (§6) only when you need the full argument.
- `git show b87fe45:docs/superpowers/plans/2026-06-26-launch-model-options.md` — the finished launch model/effort campaign.
- `git show 955278d:docs/superpowers/plans/2026-10-18-runtime-files-and-launch-diagnostics.md` — the finished runtime-files campaign: linked worktrees keep results in the main checkout, bounded `daemon.log`, a failed launch keeps its screen, helper scratch lives outside the project, deploy backups are pruned.

## Guardrails

- Preserve the skill distribution model: public repo skill source, generated runtime bundle for local packages, and GitHub Release assets for public installs.
- Prefer file handoff over terminal output parsing.
- Keep `wait` bounded — long tasks use re-wait or polling.
- Keep agent-specific behavior inside drivers.
- Before proposing or researching a new helper backend, read [`docs/backends.md`](docs/backends.md) and its [candidate registry](docs/backends.md#candidate-registry); the candidate may already be evaluated. Record the conclusion in the registry either way (declined, deferred or built), with date and version.
- Do not commit runtime output, dependency folders, build artifacts, archives, credentials, or local paths.
- Tests put scratch under `realpathSync(tmpdir())` and remove it, never under the checkout or its `.ahelpa/`. A helper's result directory is not a test fixture root; test code written by a helper must not keep that path.
- Helpers run with full local permissions. Be deliberate about `--project` and worktree isolation.
