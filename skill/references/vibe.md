# Vibe (Mistral Vibe CLI)

Public names: `mistral` and `deepseek`. Their nicknames are `vibe` and `deepseek-vibe`, respectively.

The `mistral` and `deepseek` types use the Vibe harness. `deepseek` is the subscription-first route with `deepseek-pi` as its API backup; `mistral` remains opt-in. `deepseek` has one bounded task-quality trial and `mistral` none (see [profiles](profiles.md#deepseek)). Install `vibe` ≥ 3.1.0 on PATH and complete Vibe sign-in first. Version 3.1.0 is the tested baseline. `ahelpa doctor mistral` reads the installed `mistral-vibe` dist-info metadata without executing Vibe, flagging older installs. Unrecognized distributions report an unknown version. Sign-in stays `unknown`: doctor does not read the OS keychain, and the first turn verifies authentication.

```bash
ahelpa doctor mistral
ahelpa launch mistral --file ./task.md --project /path/to/project
ahelpa launch mistral --role reviewer --effort high --file ./review.md
```

## Model and effort

For `mistral`, `worker` (default) and `reviewer` both use `mistral-large-4-0-3` / `high`. `advisor` is unsupported. Explicit `--model` and `--effort` override their respective role defaults.

Mistral model catalog (observed on 2026-11-06, Vibe 3.1.0):

| Alias | Thinking levels |
| --- | --- |
| `mistral-large-4-0-3` | `low`, `medium`, `high` (vendor default: `high`) |
| `mistral-medium-3.5` | `off`, `high` |

### Other aliases observed on Vibe

These remain usable with `--model`, but are not listed in the `mistral` catalog.

| Alias | Thinking levels |
| --- | --- |
| `glm-5-3` | `low`, `high`, `max` (vendor default: `high`) |
| `zai-glm-5-3-flash` | `low`, `high`, `max` (vendor default: `high`) |

The driver accepts aliases matching `^[\w.:-]+$` and effort `off|low|medium|high|max`. Vibe may warn and still send an unsupported thinking level; select a level appropriate to the model. Runtime `ahelpa model` switching is unsupported.

Vibe has no thinking CLI flag, and `--model` is headless-only. On launch and resume the tmux pane first writes a mode-0600 `ahelpa-helper.toml` in the delivery directory, then starts Vibe with it:

```toml
safety = "yolo"
bypass_tool_permissions = true
active_model = "mistral-large-4-0-3"
[models."mistral-large-4-0-3"]
thinking = "high"
```

The quoted model table key matters for aliases containing dots. The sparse table merges with Vibe's routed model; it needs no provider or API name. `VIBE_AGENT_PATHS` holds a JSON array containing the delivery directory and `--agent ahelpa-helper` selects the file. The composer's top rule then reads `<Model>[<thinking>] · ahelpa helper`. If the resolved launch settings omit effort, the file omits `thinking` and Vibe's model default applies. An alias Vibe does not know makes it fall back to another model with only a warning; the driver stops the launch instead (`vibe model <alias> is not available`).

## DeepSeek through the Mistral subscription

`ahelpa launch deepseek --file ./task.md` uses `deepseek-v4-1-flash-1017` / `high` for worker and reviewer. Supported thinking levels are `low`, `high`, and `max`. Your Mistral subscription must include this model. `ahelpa launch mistral --model deepseek-v4-1-flash-1017 --file ./task.md` uses the same definition.

Vibe does not ship this alias, so the session agent file carries its full definition on launch and resume, even when effort is omitted:

```toml
[models."deepseek-v4-1-flash-1017"]
name = "deepseek-v4-1-flash-1017"
provider = "mistral"
thinking_levels = ["low", "high", "max"]
max_context_length = 1048576
max_output_tokens = 131072
thinking = "high"
```

Omitting effort omits only `thinking`. Other aliases keep sparse overrides. Per-session definitions make installation reproducible and avoid writing `~/.vibe`; see [Where model definitions live](../../docs/backends/vibe.md#where-model-definitions-live-decided-and-implemented-2026-11-06) for the decision and trade-offs. When the subscription lacks the model, Vibe shows `✕ Error: ... invalid_model ...` and returns to the composer; the helper settles `needs_attention` with the reason `model unavailable (the Mistral subscription may not include it)`. Other turn errors (authentication included) end the turn without a signal and settle through the idle fallback with the error on screen.

`vibe` is the nickname for `mistral`; `deepseek-vibe` is the nickname for `deepseek`. Both store harness ID `vibe`; existing sessions resolve without a database migration. Resume retains recorded model/effort and the old session prefix. New session IDs start with `mistral-` or `deepseek-`.

## Terminal and permissions

The helper is Vibe's own interactive TUI in tmux, operated like a person at the terminal:

```text
VIBE_ENABLE_AUTO_UPDATE=false VIBE_ENABLE_UPDATE_CHECKS=false VIBE_AGENT_PATHS='["<delivery>"]' vibe --trust --agent ahelpa-helper [--resume <id>]
```

`--trust` applies only to this invocation; ahelpa writes neither `~/.vibe` configuration nor its trusted-folder list. Vibe itself keeps its usual history, session logs and UI caches under `~/.vibe`. The session agent enables unattended tool execution (`safety = "yolo"`, `bypass_tool_permissions = true`), so no approval dialog appears. `--safe` is refused on launch and resume because lower-permission Vibe agents are unverified.

The screen is the authority. Vibe is full screen: a capture is the visible viewport, newest output at the bottom.

- Ready: the composer's top rule shows `· ahelpa helper`, the line below is an empty `>`. During start-up the rule first shows the default agent (`· accept edits`) with `Initializing…`; the driver waits for the session agent.
- Working: a spinner line such as `Generating… (12s Esc/Ctrl+C to interrupt)`, `Running command…` or `Thinking…` above the composer.
- Done: `[AHELPA:DONE]` or `[AHELPA:NEED_HELP:tags]` alone on a line in the latest turn (the last `> ` user line), after the last spinner line. The scrollbar thumb glyph that Vibe draws in the last column is ignored.
- Vibe renders replies as Markdown. A signal written on the line right after text, without a blank line, joins that paragraph (`text [AHELPA:DONE]`) and is not a signal; the turn then ends without one and the daemon's single completion nudge usually recovers it.
- The question tool replaces the composer with a dialog (`User input required…`). That needs a human: answer it in the pane, or press Esc. Any screen without a composer reads as idle and settles through the idle fallback.

Esc interrupts a running turn and keeps the session (`Interrupted · What should Vibe do instead?`); the running tool is stopped. Attach to the tmux session to watch or type; follow-up tasks go through `ahelpa task` as usual.

## Resume and stopping

`/exit` quits without a confirmation and prints `Or: vibe --resume <id>`, where `<id>` is the first 8 hex digits of Vibe's session ID. That is the resume token: the daemon records it while the helper drains after DONE, as for Claude Code and Codex. `kill` never fetches a missing token; one a resumed helper inherited is kept. `ahelpa interrupt` stops one turn and keeps the session. `vibe --resume` accepts both the 8-digit form and the full UUID that the earlier bridge recorded, so old sessions resume unchanged. Resume shows the earlier turns and keeps the same session ID.

Killing the tmux session stops Vibe, its app server and any running tool; ahelpa runs no process cleanup of its own.

## Evidence and gate

Spike (2026-11-07, Vibe 3.1.0, macOS, tmux 80x24 and 200x50): the TUI ran unattended with no trust or update prompt, `~/.vibe/config.toml` and `trusted_folders.toml` unchanged; the agent file selected Large 4 `[high]` and a full DeepSeek table under an alias absent from the global config (session log `model_name` `deepseek-v4-1-flash-1017`); `[AHELPA:DONE]` rendered alone on its line for 3/3 real ahelpa task files and 2/2 completion nudges across Large 4 and DeepSeek; one ad-hoc prompt produced `text\n[AHELPA:DONE]`, shown merged; context carried across turns and across `--resume`; `tmux kill-session` reaped `vibe-rs`, `vibe-app-server` and a running `sleep 120`. While working the spinner redraws several times a second: the longest unchanged-screen stretch measured was 0.6 s. Linux, fresh-account onboarding, authentication-failure screens and lower-permission agents remain unverified.

`AHELPA_GATE_VIBE=1 bun run closure:gate` runs the `mistral` type; `AHELPA_GATE_DEEPSEEK=1` runs the same scenario with `deepseek`. Each checks launch, `wait`/`check`, the resume token recorded at drain, context recall after native resume, and a mid-turn kill with a running shell tool, checking that the pane's process tree recorded while live is gone. The gate makes model calls and leaves native sessions in Vibe's own history. See the [dated backend card](../../docs/backends/vibe.md).
