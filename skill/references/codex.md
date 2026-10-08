# ahelpa on Codex

Platform-specific guidance for using ahelpa inside the Codex CLI.

## Runtime Constraints

Codex operates in persistent interactive mode only — there is no background agent or subagent tool. All ahelpa operations happen inline in your conversation loop.

Codex is launched with `--dangerously-bypass-approvals-and-sandbox` by default, so helper agents also run with full permissions. Use `ahelpa launch codex --safe ...` to run Codex with `-s workspace-write -a never` instead. Be deliberate about `--project` and working directory isolation.

Codex is a `worker` by default (`gpt-6.1-sol`, `high` effort). `--role reviewer` selects `gpt-6.1-sol` with `xhigh` effort and the review-only task contract (no edits outside the result directory). Explicit `--model` and `--effort` override these fields independently. `--role advisor` is still rejected. Resume preserves the recorded selection without applying new launch defaults.

ahelpa probes the Codex executable from the caller's PATH in the target project and uses the same absolute path for launch and resume. It adds `--no-daemon` when the bounded help probe confirms support, keeping work within the helper's tmux lifecycle on CLIs that otherwise use a shared background server. Older CLIs and failed probes keep the previous flags; a login-shell-only Codex falls back to its command name without the new flag. ahelpa's own monitoring daemon is unchanged.

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
