# Development

[English](development.md) | [简体中文](zh-CN/development.md)

## Requirements

- **macOS** (the only supported platform today)
- **Bun** (runtime, SQLite, test runner, and binary compiler)
- **tmux** (helper session management)

`jq` is useful for shell examples but is not required by the runtime itself.

## Repository Layout

```
src/
  cli.ts                   # Process entry point
  command-contract.ts      # Command registry and dispatch
  commands/                # launch, wait, session-ops
  drivers/                 # Agent-specific adapters
  *.ts                     # Core modules (state, daemon, wakeup, etc.)
tests/                     # Bun test suite
scripts/
  deploy-local.sh          # Install built binary to ~/.ahelpa/bin/
  closure-gate.sh          # End-to-end verification gate
  package-skill.ts         # Skill packaging (docs + runtime bundle)
  skill-package.ts         # Packaging helpers
skill/
  SKILL.md                 # Agent-facing skill documentation
  references/              # Platform-specific guidance
  bundle/                  # Generated runtime tarball (git-ignored)
docs/                      # Public documentation
dist/                      # Build output (git-ignored)
```

## Documentation i18n

English is the default documentation language. Simplified Chinese translations live beside it:

- `README.md` and `README.zh-CN.md`
- `docs/*.md` and `docs/zh-CN/*.md`

When editing user-facing documentation, update both language versions in the same change unless the edit is intentionally language-specific.

## Source vs Installed Runtime

This repository is the source tree. The installed runtime is a compiled binary generated from it.

| | Source tree | Installed runtime |
| --- | --- | --- |
| Location | This git repo | `~/.ahelpa/bin/ahelpa` |
| Edit | `src/`, `skill/`, `tests/`, `docs/` | Do not patch directly |
| Run | `bun run src/cli.ts <cmd>` | `ahelpa <cmd>` |
| Test | `bun test` | `bun run closure:gate` |

`bun run src/cli.ts` is convenient during development but does not replace testing the installed binary after deployment.

## Common Commands

```bash
bun test                       # Run the test suite
bun run build                  # Compile to dist/ahelpa
bun run package:skill          # Build skill package with runtime bundle
bash scripts/deploy-local.sh   # Deploy binary to ~/.ahelpa/bin/
bun run closure:gate           # End-to-end closure gate
```

## Build and Package

The repository does not track compiled binary bundles. To build:

```bash
bun run build
```

This compiles `src/cli.ts` into a standalone binary at `dist/ahelpa`.

To build the full skill package (binary + documentation + tarball):

```bash
bun run package:skill
```

This produces:
- `dist/ahelpa` — compiled binary
- `skill/bundle/ahelpa-darwin-arm64.tar.gz` — runtime tarball for skill distribution
- `dist/ahelpa.skill` — packaged skill

All generated artifacts are git-ignored.

## Deployment

Install the compiled binary locally:

```bash
bash scripts/deploy-local.sh
```

This copies the binary to `~/.ahelpa/bin/ahelpa`. Ensure `~/.ahelpa/bin` is on your `PATH`.

## Testing

For ordinary code changes:

```bash
bun test
```

## Closure Gate

The closure gate is the end-to-end verification step for changes that affect installed runtime behavior. It tests the full launch → wait → capture → kill cycle across both supported drivers.

```bash
bun run closure:gate
```

For each driver, verify that:

- `launch` starts a session and returns valid JSON
- `wait` or `check` observes a terminal session state
- `capture` shows the task entered the prompt flow
- `kill` reclaims the session cleanly

**Prerequisite:** Both helper CLIs (`claude` and `codex`) must be authenticated locally. If a helper CLI fails during authentication bootstrap, repair that CLI's login state before treating the gate result as meaningful.

## Adding a Driver

Drivers live in `src/drivers/`. A new driver implements the `AgentDriver` interface from `src/drivers/types.ts`:

- `name` and `sessionPrefix` — identity
- `buildLaunchCommand` — the shell command to start the agent CLI
- `prepareForTask` — handle any startup prompts before task delivery
- `afterTaskSubmitted` — handle post-submission confirmation (e.g., press Enter)
- `detectStatus` — sentinel-based status detection (typically delegates to `sentinels.ts`)

Register the new driver in `src/drivers/registry.ts`.

## What Not to Commit

- Local runtime output (`~/.ahelpa/`)
- Generated build artifacts (`dist/`, `skill/bundle/`)
- Environment files (`.env`, credentials)
- Local databases and logs
- Session artifacts (`.ahelpa/` in project directories)
