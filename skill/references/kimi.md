# ahelpa on Kimi Code

Platform-specific guidance for using ahelpa with Kimi Code CLI, either as the host or as the helper.

## Binary Mapping

- `ahelpa launch kimi ...` uses the `kimi` CLI
- `ahelpa launch claude-code ...` uses the `claude` CLI
- `ahelpa launch codex ...` uses the `codex` CLI

Verify with `command -v kimi`, `command -v claude`, or `command -v codex`.

## Kimi Launch Posture

By default, ahelpa starts Kimi with:

```bash
KIMI_CODE_NO_AUTO_UPDATE=1 kimi --yolo
```

`KIMI_CODE_NO_AUTO_UPDATE=1` is Kimi Code's canonical update flag; it prevents a CLI self-update from interrupting the persistent tmux helper. `--yolo` bypasses Kimi's native approval flow. On the first launch in a directory, ahelpa also selects **Trust this folder** automatically. Kimi persists that trust and may start project MCP servers supplied by the directory.

Use `ahelpa launch kimi --safe ...` to omit `--yolo`. This restores Kimi's native approvals, but the driver still automatically trusts the project directory. ahelpa records the safe posture and preserves it across resume; `resume --safe` can upgrade a default-posture record, while omission cannot downgrade a safe one. Safe mode is not a sandbox or another hard security boundary. Always use `--project` to choose the smallest useful working directory.

## Typical Workflow

```bash
result=$(ahelpa launch kimi --task "Review the API contracts" --project /path/to/project)
session_id=$(echo "$result" | jq -r .sessionId)
token=$(echo "$result" | jq -r .ownerToken)

ahelpa wait "$session_id"
cat ".ahelpa/$session_id/summary.md"
ls ".ahelpa/$session_id/artifacts/"
```

Kimi helpers support the normal `launch`, `wait`, `capture`, `kill`, and `resume` flow. Keep using file handoff for results; `capture` remains a debugging tool.

## Models

Do not pass `--model` by default. Kimi then uses the default from its `config.toml`. If you do pass `--model`, the value must exactly match a complete alias already configured in that file; a display name alone may fail. Kimi does not support ahelpa's `--effort` flag or runtime switching through `ahelpa model`.

## Resume

ahelpa captures Kimi's `session_*` ID after submitting the first task message; the ID does not exist during initial startup. When `[AHELPA:DONE]` appears, `resume` is rejected while the old helper is draining. Wait until `ahelpa check` reports `dead`, or use the explicit reclamation path:

```bash
ahelpa kill "$session_id" --token "$token"
ahelpa resume "$session_id" --token "$token"
```

The driver reconnects through `kimi --session <id>` in a new tmux session. It reuses an explicitly supplied launch-time model alias and the original safe posture; otherwise Kimi uses its configured default. A dead record with an `agentResumeId` remains available until `ahelpa clean`; cleaning it deletes the resume metadata. Persistent conversation does not mean the original tmux process remains alive forever.

## Skill Installation

`ahelpa install-skill` delegates to `npx skills@latest` with global hard-copy mode and the explicit `codex`, `claude-code`, and `kimi-code-cli` targets. The Kimi-specific target installs the skill in Kimi Code's supported global skill root.

## Troubleshooting

- If the binary is missing, check `command -v kimi`.
- A cycling moon (`🌑` through `🌘`) or `Retrying (n/3) ... in 120s` means Kimi is still working or applying provider backoff. Keep waiting; do not treat it as an idle prompt merely because the boxed input remains visible.
- If Kimi requests approval in safe mode, handle the native prompt in the tmux session; this is expected.
- If a resumed helper cannot start, use `ahelpa check` to confirm the original session has an `agentResumeId`.
- Use `ahelpa capture <id> --token <tok>` or attach with `tmux attach -t <id>` only when debugging an unexpected prompt.

## Usage Discipline

For normal helper delegation, follow the main `SKILL.md` workflow directly. Only inspect `src/` or `tests/` when debugging ahelpa itself.
