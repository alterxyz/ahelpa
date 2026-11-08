# Development

[English](development.md) | [简体中文](zh-CN/development.md)

## Requirements

- **macOS or Linux** (x64 and arm64)
- **Bun 1.4.2** (runtime, SQLite, test runner, and binary compiler; pinned in `packageManager` and CI, with matching `bun-types`)
- **tmux** (helper session management)

`jq` is useful for shell examples but is not required by the runtime itself.

Skill installation also requires Node.js >=22.20.0 and working `npx`, matching the [skills CLI requirement](https://github.com/vercel-labs/skills/blob/v1.7.0/package.json). Both installation entry points check these prerequisites; the public installer does so before any download or runtime replacement. The compiled ahelpa runtime does not require Node.js.

The end-to-end gate also requires authenticated helper CLIs for the drivers being exercised. Verify the binaries with `command -v claude`, `command -v codex`, and `command -v kimi`; verify authentication with each CLI's own status or a harmless request.

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
  install.sh               # Public installer: release binary + global skills
  deploy-local.sh          # Install local binary + global hard-copy skills
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

Exception: the candidate cards in `docs/backends/*.md` are English-only. They are dated, agent-facing evidence about third-party products, not user-facing documentation, and a translation would only drift. `docs/backends.md` itself stays bilingual.

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
bun run typecheck              # tsc --noEmit over src/ and tests/
bun run build                  # Compile to dist/ahelpa
bun run package:skill          # Build skill package with runtime bundle
bash scripts/deploy-local.sh   # Deploy runtime + global hard-copy skills
ahelpa install-skill           # Refresh global skill from the public repo
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
- `skill/bundle/ahelpa-<platform>.tar.gz` — runtime tarball for skill distribution (platform is e.g. `darwin-arm64`, `linux-x64`)
- `dist/ahelpa.skill` — packaged skill

All generated artifacts are git-ignored.

## Deployment

Install the compiled binary and refresh global skills locally:

```bash
bash scripts/deploy-local.sh
```

This copies the binary to `~/.ahelpa/bin/ahelpa`, then runs:

```bash
ahelpa install-skill --source ./skill
```

`install-skill` delegates to `npx skills@latest` instead of reimplementing agent skill installation. The policy is fixed: global scope, hard-copy mode, and explicit `codex` + `claude-code` + `kimi-code-cli` targets. Ensure `~/.ahelpa/bin` is on your `PATH`.

Public installs use the release installer:

```bash
curl -fsSL https://raw.githubusercontent.com/alterxyz/ahelpa/main/scripts/install.sh | bash
```

The public installer resolves `latest` to a specific tag and downloads the platform tarball plus `SHASUMS256.txt` from that release. It verifies SHA-256, requires an archive containing only the regular `ahelpa` file, and checks that the executable's version matches the tag before replacing an installation. Replacement is atomic within the destination directory; the previous binary is retained as `ahelpa.backup.*`. Runtime and skill use the same tag. Skill installation is a subsequent step; if it fails, the new runtime and previous binary backup remain available.

Installer overrides:

| Variable | Purpose |
| --- | --- |
| `AHELPA_VERSION` | Explicit release tag; default `latest` is resolved once |
| `AHELPA_BIN_DIR` | Runtime installation directory |
| `AHELPA_REPO` | Release and skill source as `owner/repository` |
| `AHELPA_ARCHIVE_URL` | Custom archive URL; requires one checksum override below |
| `AHELPA_SHA256` | Trusted archive SHA-256 digest |
| `AHELPA_CHECKSUM_URL` | Alternate manifest with an entry for the platform archive |

Use only one checksum override. Old releases without a manifest require an explicit trusted digest or alternate manifest; verification is never silently skipped. A custom archive must match `AHELPA_VERSION`, which also selects its skill source.

### Release workflow

The tag workflow builds on native macOS and Linux runners for both architectures, checks source types and installer fixtures, and smoke-tests the compiled and packaged binaries. A publish job waits for all four builds, assembles the checksum manifest, then creates or resumes a draft GitHub Release. Releases stay in draft until their assets upload. Published releases cannot be overwritten by rerunning the workflow; use a new version tag. The tag must match `package.json`.

Builds use Bun 1.4.2 instead of a moving `latest`. Checkout v5, upload-artifact v6, and download-artifact v7 declare Node 24 runtimes, following [GitHub Actions' Node 20 retirement](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/).

The macOS matrix uses `macos-15` and `macos-15-intel`: [macOS 13 has retired](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/), and [macOS 14 retirement is scheduled for 2026-11-02](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/). Publish a release containing the manifest before distributing the new installer to users of older releases.

## Testing

For ordinary code changes:

```bash
bun test
```

The Bun test preload assigns temporary `AHELPA_HOME` and `AHELPA_TMP_DIR` roots when the caller has not supplied them, then removes those roots after the suite. Unit and integration tests therefore do not write session state, archives, FIFOs, or task files into the user's active ahelpa runtime.

## Closure Gate

The closure gate runs tests, typechecks, and a build, then tests the compiled `dist/ahelpa` binary with the selected drivers. It exercises Claude's default advisor and explicit worker separately, followed by Codex's default worker. The live Kimi scenario bills a metered provider and runs only with `AHELPA_GATE_KIMI=1`. The first three scenarios verify the exact role/model/effort returned by launch and persisted in check, using separate result markers and evidence directories. Codex and Kimi use the stable `tests/fixtures/closure` workspace; Claude Code uses the repository root. Tasks permit only the assigned task file and result directory.

The gate assigns private `AHELPA_HOME` and `AHELPA_TMP_DIR` roots, so its SQLite state, daemon, archives, FIFOs, and task files do not interfere with active ahelpa sessions. Helper CLIs retain their normal OS home and authentication.

```bash
bun run closure:gate
```

For each driver, the gate requires:

- `launch` starts a session and returns valid JSON
- `wait` reports successful completion and `check` confirms that state
- The helper writes the exact requested content to its assigned `summary.md`
- `kill` reclaims the tmux session and `check` confirms it is no longer active

Timeouts, echoed task text, and account errors fail the gate. Logs are retained for diagnosis, including when the daemon has already reclaimed tmux. Failed checks also attempt to kill only the helper launched by that run. The printed evidence directory contains the summaries and command results. The gate copies its result directories into that evidence directory before removing its own fixture handoff files, and stops only its isolated daemon.

Kimi (`AHELPA_GATE_KIMI=1`) also complete a second task after `kill` and `resume`. The gate requires a retained native session ID, a resumed helper waiting in `needs_attention`, and a new summary containing the context marker remembered from the first turn.

To verify an installed binary with the same checks, set an absolute executable path:

```bash
AHELPA_GATE_CLI="$HOME/.ahelpa/bin/ahelpa" bun run closure:gate
```

**Prerequisite:** Authenticate the selected helper CLIs locally. If authentication bootstrap fails, repair that CLI’s login state before treating the gate result as meaningful.

Enable the live `deepseek-pi` gate with `AHELPA_GATE_PI=1`; it requires Node.js, Pi ≥ 1.4.0 (TUI tested on 1.5.0), and DeepSeek configured in CC-Switch and synced to Pi. Defaults are `cc-switch-deep-seek/deepseek-flash` / `high`; optional `AHELPA_GATE_PI_MODEL=provider/id` and `AHELPA_GATE_PI_EFFORT=<level>` override these defaults. The gate records the pane's process tree while the TUI is live, waits for the native resume ID that the daemon reads from the exit screen while draining, resumes and checks remembered context on a second turn, then resumes again, runs `sleep 120`, kills the helper mid-turn, and verifies that none of the recorded processes, the tool included, survive. The native session ID must stay the same across resumes. Pi's native sessions remain in its cwd-encoded directory, outside the gate's temporary ahelpa state.

Enable the live `gemini` gate with `AHELPA_GATE_AGY=1`; it requires agy ≥ 1.5.2 (TUI tested on 1.5.3), signed in once in `agy`. It uses the `gemini-4-argon` / `medium` default and checks launch/check settings. The gate records the pane's process tree while the TUI is live, waits for the native resume ID that the daemon reads from the exit screen while draining, resumes and checks remembered context on a second turn, then resumes again, runs `sleep 120`, kills the helper mid-turn, and verifies that none of the recorded processes, the tool included, survive. The conversation ID must stay the same across resumes. agy keeps the gate's conversations in its own history.

Enable the live `mistral` gate with `AHELPA_GATE_VIBE=1`; it requires vibe ≥ 3.1.0 and an existing sign-in, using `mistral-large-4-0-3` / `high`. The gate records the pane's process tree while the TUI is live, waits for the native resume ID that the daemon reads from the exit screen while draining, resumes and checks remembered context on a second turn, then resumes again, runs `sleep 120`, kills the helper mid-turn, and verifies that none of the recorded processes, the tool included, survive. Vibe's 8-hex session ID must stay the same across resumes. `AHELPA_GATE_DEEPSEEK=1` runs the same Vibe scenario with type `deepseek`, defaulting to `deepseek-v4-1-flash-1017` / `high` and requiring its inclusion in the Mistral subscription. Vibe retains its native session history.

## Adding a Driver

Read [Helper backends](backends.md) first. It covers whether a candidate should be a driver at all (classification and the admission funnel), how a helper is wired (one way: its own TUI in tmux) and why, the spike checklist, and the registry of candidates already evaluated. Record the outcome in the registry whether or not you build it. The driver is the last step, not the first.

Drivers live in `src/drivers/`. A driver implements `AgentDriver` from `src/drivers/types.ts`, which has 22 members.

**Required (15):**

- Identity and catalog: `name`, `sessionPrefix` (the session-ID prefix), `modelCatalog`.
- Launch and resume: `buildLaunchCommand`, `buildResumeCommand`, `extractResumeToken`, and `resumeTokenAvailableAfterSubmit` (whether the native resume id is readable right after the first submit, or only after the helper exits).
- Startup and delivery: `prepareForTask` and `prepareForResume` (readiness, trust prompts, update dialogs), and `afterTaskSubmitted` (confirm that the new turn started).
- State: `detectStatus`, `detectOutcome` (a status plus optional NEED_HELP tags and a `reason`), and `detectActivity` (`working`, `booting`, or `idle`). Sentinel matching lives in `sentinels.ts`.
- Control: `switchModel` (throw if runtime switching is unsupported) and `gracefulExit`.

**Optional (7):**

- `turnHooks` and `prepareLaunchFiles`: session-scoped hook or settings files written under the result directory before launch. A driver drives the vendor's own TUI; no bridge program ([why](backends.md#how-a-helper-is-wired)).
- `launchProfiles`: role → model/effort presets.
- `checkReadiness`: what `doctor` reports without running the CLI.
- `acceptsInput`, `acceptsInputAfterTurn`, `workingAfterTurn`: stricter "would typed text reach the composer" and "is the turn still running" checks than the defaults.

Register the driver in `src/drivers/registry.ts`. Several other places enumerate drivers; `grep -rn "\bpi\b" src scripts skill docs` is a quick way to find them. At least: `src/disk-usage.ts` (a session-ID prefix pattern and the names of per-session files), the closure gate scenario and its `AHELPA_GATE_<NAME>` switch in `scripts/closure-gate.sh`, the prerequisites in `skill/SKILL.md`, the setup page `skill/references/<name>.md` and `skill/references/profiles.md`, and the supported-helpers table in the README. Add `tests/<name>-driver.test.ts` with synthetic pane captures.

Codex terminal model stops belong in `detectOutcome`, which can return `needs_attention` with an optional `reason` (`model_capacity` or `usage_limit`). Only work after the error suppresses this outcome, and the idle composer must follow it. Require the exact phrase immediately after a column-zero `■` (`⚠` is supported only for the Codex 0.154 capacity phrase); `Tmux.capture` preserves leading whitespace. The monitor confirms a driver attention outcome twice at the same session version and reason, resetting on other outcomes or version changes. Preserve sentinel precedence and unsupported-model errors. Settlement stores the reason in the existing archive; `check`, `status`, and `wait` expose it for the current settled turn. `wait` exits 1 only for `needs_attention` with `model_capacity` or `usage_limit`; legacy attention reasons and missing reasons keep exit 0. Synthetic pane and reporting regressions live in `tests/codex-capacity.test.ts`.

## What Not to Commit

- Local runtime output (`~/.ahelpa/`)
- Generated build artifacts (`dist/`, `skill/bundle/`)
- Environment files (`.env`, credentials)
- Local databases and logs
- Session artifacts (`.ahelpa/` in project directories)
