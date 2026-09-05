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
- `src/drivers/` — agent-specific adapters (claude-code, codex, kimi)
- `tests/` — Bun test suite
- `scripts/` — build, deploy, packaging, closure gate
- `skill/` — skill package source (docs + generated bundle during local packaging)
- `docs/` — public documentation

## Documentation i18n

English is the default public documentation language. Simplified Chinese lives beside it:

- `README.md` / `README.zh-CN.md`
- `docs/*.md` / `docs/zh-CN/*.md`

When changing user-facing docs, update both language versions or explicitly note why only one language changed.

## Requirements

- macOS or Linux, Bun, tmux
- `npx` for `ahelpa install-skill` / public skill installation
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

## Closure Gate

Before closing local runtime work:

```bash
bun run closure:gate
```

The gate runs tests, typechecks, builds, and launches all three drivers. For each, verify that `wait`/`check` can observe session state and `kill` reclaims the session. If a helper CLI fails during authentication bootstrap, fix that CLI's login state first.

## Guardrails

- Preserve the skill distribution model: public repo skill source, generated runtime bundle for local packages, and GitHub Release assets for public installs.
- Prefer file handoff over terminal output parsing.
- Keep `wait` bounded — long tasks use re-wait or polling.
- Keep agent-specific behavior inside drivers.
- Do not commit runtime output, dependency folders, build artifacts, archives, credentials, or local paths.
- Helpers run with full local permissions. Be deliberate about `--project` and worktree isolation.
