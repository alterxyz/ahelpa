# Pi

Public names: `deepseek-pi` (the `pi` nickname uses the same profile and prefix) and `glm`.

The `deepseek-pi` type is the official DeepSeek API backup for the subscription-first `deepseek` route (see [names](names.md)). Install `@earendil-works/pi-coding-agent` ≥ 1.4.0 (a Node.js program). Configure DeepSeek in CC-Switch and sync it to Pi so provider `cc-switch-deep-seek` exists. The terminal driver is tested with 1.5.0; 1.4.0 and newer are accepted, older releases are refused with an upgrade message. `ahelpa doctor deepseek-pi` checks installed metadata without executing the CLI or reading credentials; authentication remains unknown until launch.

```bash
ahelpa launch deepseek-pi --file ./task.md --project /path/to/project
ahelpa launch deepseek-pi --role reviewer --file ./review.md
```

`worker` is the default role; `reviewer` applies the read-only review contract. Both default to `cc-switch-deep-seek/deepseek-flash` / `high`; `advisor` is unsupported. These defaults also apply when launching with the `pi` nickname. To select explicitly, pass `--model provider/id` and `--effort <level>`; thinking levels depend on the selected model. Pi clamps an unsupported level without a warning, so startup reads the footer's `model • level` and refuses the launch when it differs from the request; a model Pi does not know (its "Using custom model id" warning) is refused too. Runtime `ahelpa model`, including `--persist`, is unsupported; launch with the desired options instead.

`pi` is a nickname for `deepseek-pi` and the stable stored harness ID. Existing sessions resolve without a database migration; resume keeps their recorded model and effort. New session IDs start with `deepseek-pi-`.

## The `glm` name: OpenCode Go plan

`glm` (no nicknames) is a second public name on this same Pi driver, so it shares every limit below: launch and resume reject `--safe`, runtime `ahelpa model` switching is unsupported, and `--model <provider>/<model>` and `--effort` select at launch only. `worker` (default) and `reviewer` both use `magpie/opencode-go/glm-5.3` / `high`; the catalog offers efforts `low`, `high`, `max`; there is no `advisor`. New session IDs start with `glm-`, and resume uses Pi's native session ID as for `deepseek-pi`.

The route is the OpenCode Go plan (a flat-rate plan with 5-hour, 7-day and monthly windows), reached through the local magpie gateway. magpie is a local desktop app that serves an OpenAI-compatible endpoint on localhost and writes a `magpie` provider into Pi's `~/.pi/agent/models.json`. Prerequisites: Pi ≥ 1.4.0 and Node.js; OpenCode Go added as a provider in magpie; Pi connected in magpie so `pi --list-models glm` shows `magpie  opencode-go/glm-5.3`; magpie running.

There is no fallback entry. A used-up plan window has not been observed yet (2026-11-18); if the provider answers 429, Pi reports `Pi: rate limited (429)` and the host decides what to use next. Only `high` has been run; `low` and `max` come from the provider's model list.

Verified 2026-11-18 with Pi 1.5.2 and magpie 0.1.4501: a launch with this model reached the composer, the footer read `opencode-go/glm-5.3 • high`, and a trivial task finished with `[AHELPA:DONE]`. Observed the same day: `magpie provider test opencode-go` reported HTTP 400 for another plan model ("hosted outside Europe and the United States"; the response says to select Global under the OpenCode console's privacy regions, not tried); `glm-5.3` answered without that setting. Also observed 2026-11-18: asked which model it is, the model answers "GLM-4.6" (an observation only; no cause is recorded). In the terms of [Helper backends](../../docs/backends.md) this is a model / gateway layer on the existing Pi driver, not a new helper backend.

## Terminal and permissions

The helper is Pi's own fullscreen TUI in tmux: `pi --tui-mode fullscreen --offline --approve --no-extensions --no-mcp -e .ahelpa/<id>/pi-turn-hook.mjs`. The only extension loaded is ahelpa's own turn-end hook, written to the session's result directory; nothing is added to Pi's settings. Attach to the pane to watch or take over as a person would. `--approve` trusts project files for this run only, so the trust dialog never appears and nothing is saved to `trust.json`; `--offline` skips startup update and catalog checks but not model requests. Skills and context files remain enabled. Pi never asks before tool calls; tools run with the local user's permissions. Launch and resume reject `--safe`.

## Turns and controls

ahelpa reads the screen. A running turn shows a spinner in the editor's top border (`── ⠼ Working ──`; retry and compaction use the same spinner). Pi gives user messages no text marker, so a turn settles only when `[AHELPA:DONE]` or `[AHELPA:NEED_HELP:…]` is the last line of the transcript and no spinner is shown. A signal followed by more text does not count. When Pi settles a run (`agent_settled`), the hook wakes the daemon, so a turn that printed its signal settles within about half a second; a turn that ended without one gets the single nudge if `summary.md` exists, otherwise it is marked `needs_attention` at the next poll (within about 3 s). Without an attributable hook event the daemon waits about 12 s of a quiet screen first. When Pi gives up on a turn (after its own retries) it ends the transcript with ` Error: <status>: <provider JSON>`; the session goes to `needs_attention` within two polls, and `wait`, `check` and `status` show the reason `Pi: provider overloaded (503|529)`, `Pi: rate limited (429)`, `Pi: authentication failed (401|403)`, or `Pi: native turn failed` for any other status. Provider text is never copied into the reason; it stays on the screen (`ahelpa logs`). On overload, retry later or choose `deepseek`; on authentication failure, repair the CC-Switch provider.

To interrupt, send Escape to the pane (`tmux send-keys -t <id> Escape`). Pi aborts the turn and its running tool, prints ` Error: This operation was aborted`, and keeps the session at its empty composer for the next message; ahelpa reports it as `needs_attention` with reason `Pi: turn aborted`. `/quit` exits; the daemon sends it after DONE.

## Persistence and resume

Pi stores sessions in its per-project directory under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/`. On `/quit` it prints `To resume this session: pi --session <uuid>`, and the daemon records that UUID while draining the finished turn. `kill` never fetches a missing UUID (one a resumed helper inherited is kept); for a session killed before DONE, run `pi -r` in the project to pick it by hand. `ahelpa interrupt` stops one turn and keeps the session. Resume runs `pi --session <uuid>` with the same flags and accepts only a full UUID. Sessions recorded by the old RPC bridge resume the same way. If Pi finds the ID only in another project it asks whether to fork; that question, a missing session, or any other startup error fails the resume with Pi's own line, and nothing is answered for you.

The bridge's `.ahelpa-<uuid>.lock` is gone. It coordinated only ahelpa bridges (native Pi never honored it) and existed because the bridge owned the RPC child and its tools. Now the pane owns Pi: `ahelpa kill` closes the tmux session, Pi handles the hangup and stops its tool children, and ahelpa refuses to resume while the old session's terminal is still alive, as for the other terminal helpers. A native `pi -r` in the same project is safe once the helper has exited.

Native session transcripts contain conversation data. Do not copy credentials or transcripts into shared diagnostics.

## Verification

`AHELPA_GATE_PI=1 bun run closure:gate` opts into model calls and checks completion, the native UUID recorded at drain, resume with context continuity, and that `kill` leaves none of the pane's process tree recorded while Pi was live. It uses `cc-switch-deep-seek/deepseek-flash` / `high` unless `AHELPA_GATE_PI_MODEL=provider/id` or `AHELPA_GATE_PI_EFFORT=<level>` is set. Pi's native session directory is separate from the gate's disposable ahelpa state. The gate checks integration only; task-selection observations are recorded in [profiles](profiles.md#deepseek-pi). Dated TUI findings are in the [Pi card](../../docs/backends/pi.md).
