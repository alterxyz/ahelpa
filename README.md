# ahelpa

[English](README.md) | [简体中文](README.zh-CN.md)

**Agent Help Agent** — a local runtime that lets one coding agent launch and manage another.

## Why

Coding agents work best with focused context. When a task needs a second perspective, parallel execution, or a clean slate, the natural move is to spin up another agent. But managing tmux sessions, passing tasks through files, and waiting for completion is fiddly glue work that every agent reinvents.

ahelpa wraps that glue into a small CLI. One agent launches a helper, hands it a task file, and blocks until the helper prints a completion sentinel. Results come back as files, not terminal scraping. Sessions are tracked in SQLite with owner tokens, so only the launcher can mutate its own helpers.

For substantive cross-agent work, prefer ahelpa over a one-shot CLI call. The tmux session outlives the caller, file handoff leaves an inspectable result, FIFO waiting encourages patience without polling, and native session IDs support follow-up or recovery. One-shot execution is still useful for a genuinely short, stateless probe where persistence and handoff add no value.

## Installation

Requirements: macOS or Linux (x64 / arm64), tmux, and `npx` for skill installation.

```bash
curl -fsSL https://raw.githubusercontent.com/alterxyz/ahelpa/main/scripts/install.sh | bash
```

The installer downloads the runtime binary for your OS/arch from GitHub Releases, installs it to `~/.ahelpa/bin/ahelpa`, then delegates skill installation to `npx skills@latest`. The skill is installed globally as a hard copy for all supported agents through three explicit targets:

- Codex: target `codex` → `~/.codex/skills/ahelpa`
- Claude Code: target `claude-code` → `~/.claude/skills/ahelpa`
- Kimi Code CLI: target `kimi-code-cli` → `~/.agents/skills/ahelpa`

If the runtime is already installed and you only need to refresh the skill:

```bash
ahelpa install-skill
```

That command always uses the public `alterxyz/ahelpa` source, global scope, hard-copy mode, and explicit `codex` + `claude-code` + `kimi-code-cli` targets.

### Install from source

If a prebuilt runtime is not yet published for your platform (or you are developing), build and install locally — Bun compiles a native binary for the host OS/arch:

```bash
git clone https://github.com/alterxyz/ahelpa
cd ahelpa
bash scripts/deploy-local.sh   # builds dist/ahelpa, installs to ~/.ahelpa/bin, hard-copies skills
```

## Quick Start

```bash
# Launch a helper
result=$(ahelpa launch claude-code --task "Review the parser module")
session_id=$(echo "$result" | jq -r .sessionId)
token=$(echo "$result" | jq -r .ownerToken)

# Wait for it to finish
ahelpa wait "$session_id"

# Read the results
cat ".ahelpa/$session_id/summary.md"
ls ".ahelpa/$session_id/artifacts/"
```

Helpers run in their own tmux sessions with fresh context. They receive a task file, write results under `.ahelpa/<session-id>/`, and signal completion by printing `[AHELPA:DONE]` or `[AHELPA:NEED_HELP]`.

## Core Primitives

| Primitive | Role |
| --- | --- |
| **tmux sessions** | Persistent helper terminals that outlive the launching process |
| **File handoff** | Tasks and results are exchanged through files, not terminal output |
| **Sentinel protocol** | Helpers print `[AHELPA:DONE]` or `[AHELPA:NEED_HELP]` to declare their state |
| **FIFO wakeup** | Bounded waits with pipe notifications and periodic state checks |
| **Owner token** | Mutating commands require the token returned by `launch` |
| **Driver adapters** | Agent-specific startup and prompt behavior lives behind pluggable drivers |
| **On-demand daemon** | Watches running sessions and settles them; starts automatically on `launch` |

## Supported Helpers

| Helper type | Underlying CLI |
| --- | --- |
| `claude-code` | `claude` |
| `codex` | `codex` |
| `kimi` | `kimi` |

Verify prerequisites with `command -v claude`, `command -v codex`, or `command -v kimi` — the Claude helper type name is not its binary name.

## Commands

| Command | Purpose |
| --- | --- |
| `launch <type> --task "..." [--parent <id>] [--safe] [--model <model>] [--effort <level>]` | Start a helper (`claude-code`, `codex`, or `kimi`) |
| `wait <id...> [--all] [--timeout <s>]` | Block until helpers settle or timeout |
| `check [--parent <id>]` | Non-blocking status poll with inline refresh |
| `models [agent]` | List launch-time model options |
| `send <id> "msg" --token <tok>` | Send a message to a running helper |
| `capture <id> --token <tok>` | Snapshot terminal output (debugging only) |
| `task <id> --file <path> --token <tok>` | Deliver a task file for long instructions |
| `model <id> --to <model> --token <tok> [--effort <level>] [--persist]` | Switch a running helper's model |
| `kill <id> --token <tok>` | Terminate a helper session |
| `logs <id> --token <tok>` | Read live or archived session output |
| `resume <id> --token <tok> [--safe]` | Resume a completed helper; an existing safe posture is inherited |
| `status` | Show all sessions and daemon state |
| `clean` | Remove settled records whose terminals have exited, and orphan runtime files |
| `daemon start\|stop` | Manage the background session monitor |
| `install-skill [--source <repo-or-path>]` | Hard-copy the global skill for Codex, Claude Code, and Kimi Code CLI targets |
| `version` | Print the installed runtime version |

Kimi supports the normal persistent workflow, including `launch`, `wait`, `send`/`task`, `capture`, `kill`, and `resume`. ahelpa sets `KIMI_CODE_NO_AUTO_UPDATE=1` so a CLI self-update cannot interrupt the persistent tmux session. By default, do not pass `--model`; Kimi uses the default from its `config.toml`. If you do pass `--model`, it must exactly match an alias already configured there. Kimi creates its `session_*` ID after the first task message; ahelpa captures it and later reconnects with `kimi --session`. Kimi does not support `--effort` or runtime switching through `ahelpa model`. After `[AHELPA:DONE]`, `resume` is rejected while the old helper is draining; wait until `check` reports `idle` and its terminal is gone, or `kill` it explicitly, then resume. Completed and legacy dead records with a resume token remain resumable until `clean`; its launch-time `--safe` posture is inherited across resume, and `resume --safe` can safely upgrade an older default-posture record. The conversation persists through Kimi's native session ID in a new tmux session, not by keeping the original tmux session alive forever.

## Runtime Layout

Completed sessions keep their status, logs, and resume metadata after the helper terminal is reclaimed. Use `clean` when you no longer need those session records. With `wait --all`, a timeout reports `still_running` only for unfinished helpers and preserves the results of helpers that already settled.

| Path | Purpose |
| --- | --- |
| `~/.ahelpa/bin/ahelpa` | Installed binary |
| `~/.ahelpa/state.db` | SQLite session state |
| `~/.ahelpa/daemon.pid` | Daemon PID file |
| `~/.ahelpa/archive/<id>/` | Final session snapshots |
| `/tmp/ahelpa/<id>.pipe` | FIFO wakeup pipes |
| `/tmp/ahelpa/ahelpa-task-<id>.md` | Task files |
| `<project>/.ahelpa/<id>/summary.md` | Helper-written summary |
| `<project>/.ahelpa/<id>/artifacts/` | Helper-written supporting files |

For isolated tests or automation, set `AHELPA_HOME` to override the state/archive directory and `AHELPA_TMP_DIR` to override FIFO/task-file storage. These overrides are passed into helper tmux sessions so nested ahelpa calls stay isolated; they do not change the helper CLI's OS home or credential directories.

## Security Posture

Helpers run with the same local user permissions as the host process by default. Use `--project` to constrain working directories, `--safe` to omit or bound default danger flags, git worktrees for risky tasks, and keep secrets out of task prompts and result artifacts. On Kimi's first launch in a directory, ahelpa automatically selects **Trust this folder**; that trust persists in Kimi and allows the directory's project MCP servers. This happens with or without `--safe`. For Kimi, `--safe` only omits `--yolo` and restores native approvals; it is not a sandbox. See [docs/security.md](docs/security.md) for details.

## Development

Requirements: macOS or Linux, Bun, tmux.

```bash
bun test                       # Unit tests
bun run build                  # Compile binary to dist/
bun run package:skill          # Build skill package with runtime bundle
bash scripts/deploy-local.sh   # Install runtime + global hard-copy skills
bun run closure:gate           # End-to-end gate across all three drivers
```

The repository does not track compiled bundles — they are generated artifacts ignored by git.

For architecture, usage workflows, contributor guide, and security notes:

- [Architecture](docs/architecture.md) / [架构](docs/zh-CN/architecture.md)
- [Usage](docs/usage.md) / [使用指南](docs/zh-CN/usage.md)
- [Development](docs/development.md) / [开发指南](docs/zh-CN/development.md)
- [Security](docs/security.md) / [安全说明](docs/zh-CN/security.md)

## Credits

Developed with heavy dogfooding — the coding agents ahelpa launches also help build it. Claude **Fable 5** reviewed, hardened, and optimized this codebase. Fable did that.
