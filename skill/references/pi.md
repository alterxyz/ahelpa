# Pi

Public name: `deepseek-pi`. The `pi` nickname uses the same profile and prefix.

The `deepseek-pi` type is the official DeepSeek API backup for the subscription-first `deepseek` route (see [names](names.md)). Install `@earendil-works/pi-coding-agent` ≥ 1.4.0 (a Node.js program). Configure DeepSeek in CC-Switch and sync it to Pi so provider `cc-switch-deep-seek` exists. The terminal driver is tested with 1.5.0; 1.4.0 and newer are accepted, older releases are refused with an upgrade message. `ahelpa doctor deepseek-pi` checks installed metadata without executing the CLI or reading credentials; authentication remains unknown until launch.

```bash
ahelpa launch deepseek-pi --file ./task.md --project /path/to/project
ahelpa launch deepseek-pi --role reviewer --file ./review.md
```

`worker` is the default role; `reviewer` applies the read-only review contract. Both default to `cc-switch-deep-seek/deepseek-flash` / `high`; `advisor` is unsupported. These defaults also apply when launching with the `pi` nickname. To select explicitly, pass `--model provider/id` and `--effort <level>`; thinking levels depend on the selected model. Pi clamps an unsupported level without a warning, so startup reads the footer's `model • level` and refuses the launch when it differs from the request; a model Pi does not know (its "Using custom model id" warning) is refused too. Runtime `ahelpa model`, including `--persist`, is unsupported; launch with the desired options instead.

`pi` is a nickname for `deepseek-pi` and the stable stored harness ID. Existing sessions resolve without a database migration; resume keeps their recorded model and effort. New session IDs start with `deepseek-pi-`.

## Terminal and permissions

The helper is Pi's own fullscreen TUI in tmux: `pi --tui-mode fullscreen --offline --approve --no-extensions --no-mcp`. Attach to the pane to watch or take over as a person would. `--approve` trusts project files for this run only, so the trust dialog never appears and nothing is saved to `trust.json`; `--offline` skips startup update and catalog checks but not model requests. Skills and context files remain enabled. Pi never asks before tool calls; tools run with the local user's permissions. Launch and resume reject `--safe`.

## Turns and controls

ahelpa reads the screen. A running turn shows a spinner in the editor's top border (`── ⠼ Working ──`; retry and compaction use the same spinner). Pi gives user messages no text marker, so a turn settles only when `[AHELPA:DONE]` or `[AHELPA:NEED_HELP:…]` is the last line of the transcript and no spinner is shown. A signal followed by more text does not count: the daemon waits about 12 s, then nudges once if `summary.md` exists, otherwise it marks the session `needs_attention`. When Pi gives up on a turn (after its own retries) it ends the transcript with ` Error: <status>: <provider JSON>`; the session goes to `needs_attention` within two polls, and `wait`, `check` and `status` show the reason `Pi: provider overloaded (503|529)`, `Pi: rate limited (429)`, `Pi: authentication failed (401|403)`, or `Pi: native turn failed` for any other status. Provider text is never copied into the reason; it stays on the screen (`ahelpa logs`). On overload, retry later or choose `deepseek`; on authentication failure, repair the CC-Switch provider.

To interrupt, send Escape to the pane (`tmux send-keys -t <id> Escape`). Pi aborts the turn and its running tool, prints ` Error: This operation was aborted`, and keeps the session at its empty composer for the next message; ahelpa reports it as `needs_attention` with reason `Pi: turn aborted`. `/quit` exits; the daemon sends it after DONE.

## Persistence and resume

Pi stores sessions in its per-project directory under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/`. On `/quit` it prints `To resume this session: pi --session <uuid>`, and the daemon records that UUID while draining the finished turn. A session that never reached DONE (for example killed in `needs_attention`) has no recorded ID; run `pi -r` in the project to pick it by hand. Resume runs `pi --session <uuid>` with the same flags and accepts only a full UUID. Sessions recorded by the old RPC bridge resume the same way. If Pi finds the ID only in another project it asks whether to fork; that question, a missing session, or any other startup error fails the resume with Pi's own line, and nothing is answered for you.

The bridge's `.ahelpa-<uuid>.lock` is gone. It coordinated only ahelpa bridges (native Pi never honored it) and existed because the bridge owned the RPC child and its tools. Now the pane owns Pi: `ahelpa kill` closes the tmux session, Pi handles the hangup and stops its tool children, and ahelpa refuses to resume while the old session's terminal is still alive, as for the other terminal helpers. A native `pi -r` in the same project is safe once the helper has exited.

Native session transcripts contain conversation data. Do not copy credentials or transcripts into shared diagnostics.

## Verification

`AHELPA_GATE_PI=1 bun run closure:gate` opts into model calls and checks completion, the native UUID recorded at drain, resume with context continuity, and that `kill` leaves none of the pane's process tree recorded while Pi was live. It uses `cc-switch-deep-seek/deepseek-flash` / `high` unless `AHELPA_GATE_PI_MODEL=provider/id` or `AHELPA_GATE_PI_EFFORT=<level>` is set. Pi's native session directory is separate from the gate's disposable ahelpa state. The gate checks integration only; task-selection observations are recorded in [profiles](profiles.md#deepseek-pi). Dated TUI findings are in the [Pi card](../../docs/backends/pi.md).
