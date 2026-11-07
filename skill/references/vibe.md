# Vibe (Mistral Vibe CLI)

Public names: `mistral` and `deepseek`. Their nicknames are `vibe` and `deepseek-vibe`, respectively.

The `mistral` and `deepseek` types use the Vibe harness. `deepseek` is the subscription-first route with `deepseek-pi` as its API backup; `mistral` remains opt-in. `deepseek` has one bounded task-quality trial and `mistral` none (see [profiles](profiles.md#deepseek)). Install `vibe` ≥ 3.1.0 and Node.js on PATH and complete Vibe sign-in first. Version 3.1.0 is the tested baseline. `ahelpa doctor mistral` checks both executables and reads the installed `mistral-vibe` dist-info metadata without executing Vibe, flagging older installs. Unrecognized distributions report an unknown version. Sign-in stays `unknown`: doctor does not read the OS keychain, and the first turn verifies authentication.

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

Vibe has no thinking CLI flag, and model-table environment overrides did not apply in the spike. The driver passes model and effort to the bridge on launch and resume. At startup, before announcing ready, the bridge writes a mode-0600 `ahelpa-helper.toml` in the delivery directory from those arguments:

```toml
safety = "yolo"
bypass_tool_permissions = true
active_model = "mistral-large-4-0-3"
[models."mistral-large-4-0-3"]
thinking = "high"
```

The quoted model table key matters for aliases containing dots. The sparse table merges with Vibe's routed model; it needs no provider or API name. The bridge sets `VIBE_AGENT_PATHS` to a JSON array containing the delivery directory and passes `--agent ahelpa-helper` on every turn, including resume. If the resolved launch settings omit effort, the file omits `thinking` and Vibe's model default applies.

## DeepSeek through the Mistral subscription

`ahelpa launch deepseek --file ./task.md` uses `deepseek-v4-1-flash-1017` / `high` for worker and reviewer. Supported thinking levels are `low`, `high`, and `max`. Your Mistral subscription must include this model. `ahelpa launch mistral --model deepseek-v4-1-flash-1017 --file ./task.md` uses the same definition.

Vibe does not ship this alias, so the bridge writes its full definition in the session agent file on launch and resume, even when effort is omitted:

```toml
[models."deepseek-v4-1-flash-1017"]
name = "deepseek-v4-1-flash-1017"
provider = "mistral"
thinking = "high"
thinking_levels = ["low", "high", "max"]
max_context_length = 1048576
max_output_tokens = 131072
```

Omitting effort omits only `thinking`. Other aliases keep sparse overrides. Per-session definitions make installation reproducible and avoid writing `~/.vibe`; see [Where model definitions live](../../docs/backends/vibe.md#where-model-definitions-live-decided-2026-11-06-not-yet-implemented) for the decision and trade-offs. An API `Invalid model` response reports `model unavailable (the Mistral subscription may not include it)`; an unknown local alias keeps its separate error category. Raw stderr is not exposed.

`vibe` is the nickname for `mistral`; `deepseek-vibe` is the nickname for `deepseek`. Both store harness ID `vibe`; existing sessions resolve without a database migration. Resume retains recorded model/effort and the old session prefix. New session IDs start with `mistral-` or `deepseek-`.

## Bridge and permissions

A persistent Node bridge (`vibe-terminal.mjs`) runs inside tmux. Each input line queues one turn, writes a mode-0600 prompt file, then starts:

```text
vibe --prompt-file <file> --output streaming --trust --agent ahelpa-helper [--resume <sessionId>]
```

Every spawn sets `VIBE_ENABLE_AUTO_UPDATE=false` and `VIBE_ENABLE_UPDATE_CHECKS=false`. `--trust` applies only to this invocation; ahelpa does not edit `~/.vibe` configuration or its trusted-folder list. The session agent enables unattended tool execution. `--safe` is refused on launch and resume because lower-permission headless behavior is unverified.

The bridge captures sessionId from the first event, prints session/turn/state markers and a running heartbeat, and shows sanitized assistant text and short tool summaries. Raw stderr can contain account information and is reduced to fixed categories.

There is no result event: child exit settles a turn. Exit 0 with `[AHELPA:DONE]` in assistant text becomes idle; `[AHELPA:NEED_HELP:tags]` takes precedence and becomes error with tags. Exit 0 without a sentinel and exit 3 (interrupted) become needs_attention. Other exits become error. Failed or incomplete turns discard queued work.

## Resume and stopping

The first turn supplies the native sessionId; every later child uses `--resume <id>` so context survives the per-turn process boundary. `ahelpa resume` starts a new bridge with that token. Unknown IDs fail on the first resumed turn with the fixed category `resume session not found`. Vibe maintains native history itself.

`/exit`, SIGTERM and pane hangup stop the bridge and SIGTERM its active child. After both natural and explicit exits, the bridge sends TERM then KILL to surviving members of the turn’s process group. Before stopping a live child it also snapshots descendants, so tools that create another session can be reaped by recorded identity. Root exit and stdout/stderr draining have separate bounded waits; a tool holding a pipe cannot block settlement or cleanup forever. A direct SIGKILL of the bridge cannot perform cleanup.

## Evidence and gate

The coordinating spike (2026-11-06, Vibe 3.1.0, macOS) verified native context across two turns, invocation-only trust, unattended shell execution, update switches in effective config, and model/thinking via the session agent file on initial and resumed turns. SIGTERM returned exit 3 within a second and left no observed shell child in one run. These are protocol checks, not a reliability or task-quality assessment. Linux, fresh-account onboarding, and lower-permission headless behavior remain unverified.

`AHELPA_GATE_VIBE=1 bun run closure:gate` runs the `mistral` type; `AHELPA_GATE_DEEPSEEK=1` runs the same scenario with `deepseek`. Each checks launch, `wait`/`check`, context on a second turn and native resume, and a mid-turn kill with a running shell tool, checking cleanup of the bridge, native child and tool recorded while live. The gate makes model calls and leaves native sessions in Vibe's own history. See the [dated backend card](../../docs/backends/vibe.md).
