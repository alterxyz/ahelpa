# AGENTS.md

Instructions for agents working on the ahelpa codebase.

## What This Is

`ahelpa` is a local helper runtime for coding agents. It lets one agent launch another as a persistent helper in a tmux session, pass tasks through files, and wait for completion via FIFO-based blocking.

> **Naming:** `ahelpa` is frequently dictated by voice input as **"A help A"** (also "a help a" / "agent help agent"). Those are registered as skill triggers so voice-driven users still activate it.

**Stack:** Bun CLI runtime, on-demand daemon, tmux sessions, SQLite state, FIFO wakeup, skill packaging.

**Platform:** macOS and Linux (x64 and arm64). The runtime is platform-agnostic Bun; only the release/install plumbing is platform-aware.

## Source vs Installed Runtime

| | Source tree | Installed runtime |
| --- | --- | --- |
| Location | This git repo | `~/.ahelpa/bin/ahelpa` |
| Edit | `src/`, `skill/`, `tests/`, `docs/` | Do not patch generated output |
| Run | `bun run src/cli.ts <cmd>` | `ahelpa <cmd>` |
| Test | `bun test` | `bun run closure:gate` |

## Repo Layout

- `src/cli.ts` — process entry point
- `src/command-contract.ts` — command registry (single source of truth for CLI surface)
- `src/commands/` — launch, wait, session-ops
- `src/drivers/` — agent-specific adapters (claude-code, codex, kimi, dsh, pi, agy, vibe)
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
bun test                       # run tests
bun run typecheck              # tsc --noEmit over src/ and tests/
bun run build                  # compile binary
bun run package:skill          # build skill package
bash scripts/deploy-local.sh   # install runtime + global hard-copy skills
ahelpa install-skill           # refresh global skill from the public repo
bun run closure:gate           # end-to-end gate
```

The full suite takes about 3 minutes and prints one dot per test (`bunfig.toml`). Bun hides passing tests from AI agents, so the dots are the only progress an agent sees; wait for the `Ran N tests` summary before calling it hung.

## Closure Gate

Before closing local runtime work:

```bash
bun run closure:gate
```

The gate runs tests, typechecks, builds, and launches Claude Code and Codex; DSH runs with `AHELPA_GATE_DSH=1`, Kimi runs with `AHELPA_GATE_KIMI=1`, Pi runs with `AHELPA_GATE_PI=1`, agy runs with `AHELPA_GATE_AGY=1`, and Vibe runs with `AHELPA_GATE_VIBE=1`. For each, verify that `wait`/`check` can observe session state and `kill` reclaims the session. DSH, Kimi, Pi, agy, and Vibe also verify native resume and context continuity. Pi additionally checks child exit and session-lock release; it requires Node.js and Pi >= 1.4.0, using native model/effort defaults unless gate overrides are set. agy checks that its bridge and agy process, recorded while the helper is live, are gone after kill; it requires Node.js and agy >= 1.5.2 and uses the `gemini-4-argon` / `medium` default. Vibe requires Node.js and vibe >= 3.1.0, uses `mistral-large-4-0-3` / `high`, and checks context across turns and native resume plus bridge/child cleanup. If a helper CLI fails during authentication bootstrap, fix that CLI's login state first.

## Open Work

Campaign records with unchecked boxes live in `docs/superpowers/plans/`. At the start of a session, check them for open items before proposing new work:

- `2026-10-08-helper-contract-and-evidence.md` — observation period for the v0.9.0 contract / evidence / `--check` / nudge mechanisms. Still open: re-count the nudge numbers on builds after 2026-10-20 and decide what to tune, the contract-wording decision, one Linux run of the evidence/wait tests, and four watch-only items (`nudged_at` never resets, other Claude `❯` forms, old sessions' skill snapshot, the intermittent Codex "did not expose the submitted task" launch failure).
- `2026-10-18-codex-helper-status-detection.md` — both fixes are pushed and installed. Still open: align the Codex host instructions with the owner's memory-service policy (through the owner's config flow), and decide whether `wait --check` needs its own time budget.

Fully shipped records are removed from the tree so searches stay lean. Read them from git history:

- `git show b87fe45:docs/proposals/2026-10-08-orchestration-lessons-clawwork-confer.md` — the full original behind the rejected designs (MCP server, workflow engine, full permission as the only posture, process-per-delivery, a shared transcript, an ACP transport; §6). The current summary of each is in [`docs/backends.md#rejected-designs`](docs/backends.md#rejected-designs); read that before proposing any of them again, and use the original (§6) only when you need the full argument.
- `git show b87fe45:docs/superpowers/plans/2026-06-26-launch-model-options.md` — the finished launch model/effort campaign.
- `git show 955278d:docs/superpowers/plans/2026-10-18-runtime-files-and-launch-diagnostics.md` — the finished runtime-files campaign: linked worktrees keep results in the main checkout, bounded `daemon.log`, a failed launch keeps its screen, helper scratch lives outside the project, deploy backups are pruned, and DSH starts under non-official providers.

## Guardrails

- Preserve the skill distribution model: public repo skill source, generated runtime bundle for local packages, and GitHub Release assets for public installs.
- Prefer file handoff over terminal output parsing.
- Keep `wait` bounded — long tasks use re-wait or polling.
- Keep agent-specific behavior inside drivers.
- Before proposing or researching a new helper backend, read [`docs/backends.md`](docs/backends.md) and its [candidate registry](docs/backends.md#candidate-registry); the candidate may already be evaluated. Record the conclusion in the registry either way (declined, deferred or built), with date and version.
- Do not commit runtime output, dependency folders, build artifacts, archives, credentials, or local paths.
- Tests put scratch under `realpathSync(tmpdir())` and remove it, never under the checkout or its `.ahelpa/`. A helper's result directory is not a test fixture root; test code written by a helper must not keep that path.
- Helpers run with full local permissions. Be deliberate about `--project` and worktree isolation.
