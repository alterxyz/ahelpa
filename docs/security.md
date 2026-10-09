# Security

[English](security.md) | [简体中文](zh-CN/security.md)

## Permission Model

ahelpa launches helper agents with the same local user permissions as the host process by default. In default mode there is no sandbox, no capability restriction, and no approval gate between the helper and the local filesystem. A helper can read, write, and execute anything the user account can.

This is a deliberate design choice for local development. The tradeoff: maximum helper capability in exchange for the responsibility of scoping tasks carefully.

`ahelpa launch --safe` omits or bounds the default danger flags. Claude Code launches as `claude --verbose`; Codex launches as `codex -s workspace-write -a never`; Kimi omits `--yolo`, restoring Kimi's native approval flow. ahelpa persists this posture and carries it into every resumed record, so an omitted resume flag cannot silently restore danger flags; `resume --safe` may upgrade a default-posture record. This is a lower-permission posture, not a separate OS user, VM, or hard security boundary. In particular, Kimi's native approvals are not a sandbox.

By default, Kimi launches as `KIMI_CODE_NO_AUTO_UPDATE=1 kimi --yolo`. The canonical update flag prevents a CLI self-update from interrupting the persistent tmux session. On the first launch in a directory, ahelpa automatically selects **Trust this folder** so task delivery can continue unattended. Kimi persists that directory trust, and trusted projects can supply MCP servers that Kimi may start. This automatic trust happens in both default and `--safe` modes. Therefore `--safe` only restores per-action native approvals by omitting `--yolo`; it does not make an untrusted project safe to run.

## Session Turn Hooks

Claude hooks are loaded from `.ahelpa/<id>/claude-settings.json` with `--settings`; that session file also sets `promptSuggestionEnabled: false` to disable ghost text in the helper composer. Codex uses a per-invocation `notify` override. Launch and resume edit neither `~/.claude/settings.json` nor `~/.codex/config.toml`. Existing Claude project/user hooks still merge with the session hooks. A Codex notify override replaces the configured notify command for this invocation; native hooks and their trust settings are untouched.

The hidden `__turn-hook` command parses stdin (Claude) or the final JSON argument (Codex), filters supported events, and appends only identifiers, timestamps, error kinds, input SHA-256 digests, and message presence/length to the session's `turns.log`. It opens no state database, executes no payload instructions, and produces no stdout. Invalid inputs or unavailable files are ignored; stdin has a bounded read deadline. The writer requires an existing session directory under `.ahelpa` and rejects symlink and hardlink destinations, verifies the opened regular file has one link and matches the checked device/inode, and writes through that descriptor. Hook wrappers silently exit zero if the saved runtime is missing or unusable. It does not retain assistant text or input-message contents. This is a timing hint from trusted local processes, not an authenticated success signal or a permissions boundary.

The hook protects the log file against symlinks and hardlinks, but does not protect against concurrent replacement of the session directory itself by a process that already has the user’s permissions.

## Practical Mitigations

- **Scope with `--project`.** Point helpers at the smallest useful working directory. This sets cwd and the intended task boundary; it is not a filesystem sandbox. In review prompts, explicitly forbid unrelated home directories, global `~/.ahelpa/archive`, and other projects unless the task truly requires them.
- **Use git worktrees.** For risky or experimental tasks, launch helpers into throwaway worktree copies. This limits blast radius without restricting helper capability.
- **Keep secrets out of task prompts.** Task files are written to `/tmp/ahelpa/` and are readable by the local user. Don't embed credentials, API keys, or sensitive data in task descriptions.
- **Keep secrets out of result artifacts.** Helpers write to `.ahelpa/<session-id>/` in the project directory. Review results before committing or sharing.
- **Don't commit runtime artifacts.** `.ahelpa/` directories, local databases, logs, and build output should stay git-ignored.

## Owner Token Boundaries

The owner token returned by `launch` gates all mutating operations:

| Requires token | Does not require token |
| --- | --- |
| `send`, `task`, `model`, `capture`, `logs`, `kill`, `resume` | `status`, `check`, `clean` |

Read-only status views intentionally do not expose owner tokens. This means any agent can observe session status (who's running, what state they're in), but interaction requires the session's own token. Termination has the lineage exception below.

Ownership is not transitive. If agent A launches helper B, and helper B launches helper C, agent A cannot control C — only B can. The sole carve-out is **abort authority follows lineage; control does not**: `kill B --token <B-token> --tree` can stop B and its descendants, including C. It authenticates B's token before any kill; a wrong token stops nothing. A still cannot `send`, `task`, `model`, `logs`, `capture`, or `resume` C with B's token. Plain `kill` still affects only its target, and `--tree` grants no authority over sibling trees.

## Nesting Limits

Helpers can launch their own helpers. Launch and resume atomically check and reserve a SQLite session before external side effects: chain depth (default 4, `AHELPA_MAX_NESTING_DEPTH`), active sessions per tree (default 8, `AHELPA_MAX_ACTIVE_PER_TREE`, including in-progress reservations), and refusal for an actual `reviewer` caller, whose contract is read-only. The caller is the existing session named by `AHELPA_PARENT_ID`; `--parent` cannot move a helper outside its own tree or reset its depth. `clean` keeps settled ancestors needed by active descendants, preserving the quota and lineage; resume remains in the original tree. See [Architecture](architecture.md#nesting).

These are guardrails for cooperative local agents against accidental delegation and fan-out. They apply to normal ahelpa launch and resume paths, including concurrent calls, but do not restrict a helper that uses its full local permissions to bypass ahelpa or edit SQLite directly.

## Sentinel Trust

The sentinel protocol (`[AHELPA:DONE]`, `[AHELPA:NEED_HELP]`) is a convention, not a cryptographic guarantee. A helper could print a sentinel without actually completing its task, or fail to print one at all. The daemon detects sentinels through tmux capture — it reads what appears in the terminal, which is under the helper's control.

In practice, this is acceptable because helpers are trusted local processes running the same agent CLIs the user already trusts.

## Generated and Local Files

The public source tree ignores:

- Local runtime state (`~/.ahelpa/state.db`, `daemon.pid`, `daemon.log`)
- Session archives (`~/.ahelpa/archive/`)
- Generated build output (`dist/`)
- Generated skill bundles (`skill/bundle/`)
- Environment files (`.env`, `.env.*`)
- Key and certificate files
- Project-level session directories (`.ahelpa/`)

## Publication Hygiene

Before publishing changes to the public repository:

1. Run `bun test` to verify test health.
2. Scan tracked files for sensitive strings — local paths, credentials, private names, internal URLs.
3. Verify that the git history starts from the intended clean commit.
4. Confirm that generated artifacts are not staged for commit.
