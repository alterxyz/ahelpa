# ahelpa on Claude Code

Platform-specific guidance for using ahelpa inside Claude Code.

## Binary Mapping

- `ahelpa launch claude-code ...` uses the `claude` CLI
- `ahelpa launch codex ...` uses the `codex` CLI

Verify with `command -v claude` or `command -v codex`, not `command -v claude-code`.

Claude Code is launched with `--dangerously-skip-permissions --verbose` by default. Use `ahelpa launch claude-code --safe ...` to omit `--dangerously-skip-permissions`.

## Typical Workflow

```bash
# 1. Launch a helper
result=$(ahelpa launch claude-code --task "Add unit tests for auth.ts" --project /path/to/project)
session_id=$(echo $result | jq -r .sessionId)
token=$(echo $result | jq -r .ownerToken)

# 2a. Short task: wait inline
ahelpa wait "$session_id"

# 2b. Long task: spawn a messenger (see below)

# 3. Pick up results
cat ".ahelpa/$session_id/summary.md"
ls ".ahelpa/$session_id/artifacts/"
```

Cross-agent launch:

```bash
result=$(ahelpa launch codex --task "Migrate the database schema" --project /path/to/project)
session_id=$(echo "$result" | jq -r .sessionId)
ahelpa wait "$session_id"
```

## Spawning a Messenger

Use the `Agent` tool with `run_in_background: true` and a cheap model:

```json
{
  "tool": "Agent",
  "input": {
    "model": "haiku",
    "run_in_background": true,
    "prompt": "You are a messenger. Your only job is:\n1. Periodically run: ahelpa check\n2. When a session shows idle/error/dead, inspect .ahelpa/<session-id>/\n3. Report the status and summarize summary.md plus any artifacts\n4. Do NOT do any work yourself — no analysis, no coding, no modifications\n5. Be patient. No results is normal. Keep checking."
  }
}
```

## PostToolUse Hook

You can configure a hook to automatically check helper status after every Bash call:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "ahelpa check --parent 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

This gives passive status notifications without manual polling.

## Timeout

`ahelpa wait` defaults to 500 seconds, fitting within Claude Code's 600-second Bash tool timeout. Never set `--timeout` above 580 to preserve teardown headroom.

## Codex Helper Note

In some directories, `codex` shows a one-time trust prompt. The launch flow handles this automatically by sending Enter. If `codex` still looks idle, run `ahelpa check` to re-read session state.

## Usage Discipline

For normal helper delegation, follow the SKILL.md workflow directly. Only inspect `src/` or `tests/` when debugging ahelpa itself.
