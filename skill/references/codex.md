# ahelpa on Codex

Platform-specific guidance for using ahelpa inside the Codex CLI.

## Runtime Constraints

Codex operates in persistent interactive mode only — there is no background agent or subagent tool. All ahelpa operations happen inline in your conversation loop.

Codex is launched with `--dangerously-bypass-approvals-and-sandbox` by default, so helper agents also run with full permissions. Use `ahelpa launch codex --safe ...` to run Codex with `-s workspace-write -a never` instead. Be deliberate about `--project` and working directory isolation.

## Binary Mapping

- `ahelpa launch codex ...` uses the `codex` CLI
- `ahelpa launch claude-code ...` uses the `claude` CLI

Verify with `command -v codex` or `command -v claude`, not `command -v claude-code`.

## Trust Prompts

In some directories, `codex` shows a one-time trust prompt (`Do you trust the contents of this directory?`). The launch flow handles this automatically by sending Enter, then proceeds to task delivery. If a task appears idle for an unusually long time, run `ahelpa check` to re-read session state.

## Typical Workflow

```bash
# 1. Launch a helper
result=$(ahelpa launch codex --task "Migrate DB schema" --project /path/to/project)
session_id=$(echo $result | jq -r .sessionId)

# 2. Wait (500s default fits Codex interactive limits)
ahelpa wait "$session_id"

# 3. Pick up results
cat ".ahelpa/$session_id/summary.md"
ls ".ahelpa/$session_id/artifacts/"
```

Cross-agent launch:

```bash
result=$(ahelpa launch claude-code --task "Review the API contracts" --project /path/to/project)
session_id=$(echo "$result" | jq -r .sessionId)
ahelpa wait "$session_id"
```

## Messenger Pattern

Codex has no background agent tool, so the messenger pattern works differently: you must poll inline rather than delegating to a subagent.

```bash
while true; do
  result=$(ahelpa check)
  echo "$result" | jq '.[] | select(.status == "idle" or .status == "error" or .status == "dead")'
  sleep 30
done
```

Prefer `ahelpa wait` for single short tasks. Structure multi-helper work so you can checkpoint and poll between steps.

## Notes

- No PostToolUse hooks in Codex — manual `ahelpa check` is required.
- `capture` is available for debugging but should not be part of normal flow.
- `wait`, `check`, and `status` perform inline refresh even without the daemon running.
- Keep `.ahelpa/` tidy: move useful outputs to the project tree when done.

## Usage Discipline

For normal helper delegation, follow the SKILL.md workflow directly. Only inspect `src/` or `tests/` when debugging ahelpa itself.
