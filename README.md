# ahelpa

[English](README.md) | [简体中文](README.zh-CN.md)

**Agent Help Agent** — a local runtime that lets one coding agent launch and manage another.

## Why

Coding agents work best with focused context. When a task needs a second perspective, parallel execution, or a clean slate, the natural move is to spin up another agent. But managing tmux sessions, passing tasks through files, and waiting for completion is fiddly glue work that every agent reinvents.

ahelpa wraps that glue into a small CLI. One agent launches a helper, hands it a task file, and blocks until the helper prints a completion sentinel. Results come back as files, not terminal scraping. Sessions are tracked in SQLite with owner tokens, so only the launcher can mutate its own helpers.

## Installation

Requirements: macOS arm64, tmux, and `npx` for skill installation.

```bash
curl -fsSL https://raw.githubusercontent.com/alterxyz/ahelpa/main/scripts/install.sh | bash
```

The installer downloads the runtime binary from GitHub Releases, installs it to `~/.ahelpa/bin/ahelpa`, then delegates skill installation to `npx skills@latest`. The skill is installed globally as a hard copy for both supported agents:

- Codex: `~/.agents/skills/ahelpa` (the global universal location used by `skills`)
- Claude Code: `~/.claude/skills/ahelpa`

If the runtime is already installed and you only need to refresh the skill:

```bash
ahelpa install-skill
```

That command always uses the public `alterxyz/ahelpa` source, global scope, hard-copy mode, and explicit `codex` + `claude-code` targets.

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
| **FIFO wakeup** | `wait` blocks on a named pipe — zero polling, zero CPU while sleeping |
| **Owner token** | Mutating commands require the token returned by `launch` |
| **Driver adapters** | Agent-specific startup and prompt behavior lives behind pluggable drivers |
| **On-demand daemon** | Watches running sessions and settles them; starts automatically on `launch` |

## Supported Helpers

| Helper type | Underlying CLI |
| --- | --- |
| `claude-code` | `claude` |
| `codex` | `codex` |

Verify prerequisites with `command -v claude` or `command -v codex` — the helper type name is not the binary name.

## Commands

| Command | Purpose |
| --- | --- |
| `launch <type> --task "..."` | Start a helper (`claude-code` or `codex`) |
| `wait <id...> [--timeout <s>]` | Block until helpers settle or timeout |
| `check [--parent <id>]` | Non-blocking status poll with inline refresh |
| `send <id> "msg" --token <tok>` | Send a message to a running helper |
| `capture <id> --token <tok>` | Snapshot terminal output (debugging only) |
| `task <id> --file <path> --token <tok>` | Deliver a task file for long instructions |
| `kill <id> --token <tok>` | Terminate a helper session |
| `logs <id> --token <tok>` | Read live or archived session output |
| `status` | Show all sessions and daemon state |
| `clean` | Remove dead records and orphan runtime files |
| `daemon start\|stop` | Manage the background session monitor |
| `install-skill [--source <repo-or-path>]` | Hard-copy the global skill for Codex and Claude Code |
| `version` | Print the installed runtime version |

## Runtime Layout

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

## Security Posture

Helpers run with the same local user permissions as the host process. There is no sandbox. Use `--project` to constrain working directories, prefer git worktrees for risky tasks, and keep secrets out of task prompts and result artifacts. See [docs/security.md](docs/security.md) for details.

## Development

Requirements: macOS, Bun, tmux.

```bash
bun test                       # Unit tests
bun run build                  # Compile binary to dist/
bun run package:skill          # Build skill package with runtime bundle
bash scripts/deploy-local.sh   # Install runtime + global hard-copy skills
bun run closure:gate           # End-to-end gate across both drivers
```

The repository does not track compiled bundles — they are generated artifacts ignored by git.

For architecture, usage workflows, contributor guide, and security notes:

- [Architecture](docs/architecture.md) / [架构](docs/zh-CN/architecture.md)
- [Usage](docs/usage.md) / [使用指南](docs/zh-CN/usage.md)
- [Development](docs/development.md) / [开发指南](docs/zh-CN/development.md)
- [Security](docs/security.md) / [安全说明](docs/zh-CN/security.md)
