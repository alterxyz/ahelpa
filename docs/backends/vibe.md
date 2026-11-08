# Candidate card: Vibe (Mistral Vibe CLI)

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-06 (coordinating session's headless spike, macOS); TUI re-evaluated 2026-11-07 (migration session's spike, macOS).
- **Class:** Helper backend; host-target status unverified.
- **Verdict:** **Integrated (2026-11-06)** as the seventh helper backend. **Since 2026-11-07 the driver runs Vibe's own interactive TUI in tmux** and reads its screen, like Claude Code, Codex and Kimi; the persistent Node bridge over headless turns was removed under the owner's decision that every helper is operated like a person at a terminal. Defaults: `mistral-large-4-0-3` / `high`. Not in default dispatch.
- **Stopped at:** n/a. Soft tier: model/thinking configuration through a session agent file; no `--safe` or runtime model switch.
- **Version seen:** Vibe 3.1.0 (installed as a uv tool; Python launcher execs the Rust `vibe-rs` TUI, which starts a `vibe-app-server` child).
- **Re-evaluate when:** the TUI layout (composer rule, spinner hint, exit message), agent-file merging, update switches or Markdown rendering change; a newer release breaks `AHELPA_GATE_VIBE=1`.

## What it is

Mistral's Vibe CLI is a coding-agent harness with a full-screen interactive TUI and a headless mode. ahelpa runs the TUI in tmux: it types the task line with send-keys, reads the screen with capture-pane, and sends `/exit` after DONE. The native Vibe session holds the conversation and is resumed with `vibe --resume <id>`.

## Facts

TUI facts measured 2026-11-07 on Vibe 3.1.0/macOS by the migration session (tmux 80x24 and 200x50, real models). Model-definition facts from 2026-11-06 are marked.

- Launch: `VIBE_ENABLE_AUTO_UPDATE=false VIBE_ENABLE_UPDATE_CHECKS=false VIBE_AGENT_PATHS='["<delivery>"]' vibe --trust --agent ahelpa-helper [--resume <id>]`. No trust dialog and no update prompt appeared. Hashes of `~/.vibe/config.toml` and `trusted_folders.toml` were unchanged after the spike and the update-check timestamp in `cache.toml` did not move; the TUI itself rewrote its UI cache (`ui_startup_config.json`) and greeting timestamp. `--model` is headless-only, so model and thinking come from the agent file.
- The TUI uses the alternate screen (`alternate_on=1`, no tmux history): a capture is the visible viewport with the newest output at the bottom. Layout from the top: banner, transcript, spinner line while working, composer (`──── <Model>[<thinking>] · <agent> ─`, `>`, blank lines, plain rule), status line. A submitted turn appears as `> <text>` at column 0 with continuation lines indented two spaces, then a plain rule. Assistant text is indented two spaces.
- Start-up draws the default agent first (`· accept edits`, with `Initializing…`, and `Resuming session…` on resume) and switches to `· ahelpa helper` 3.7 s (fresh) and 3.3 s (resume) after the pane's first frame, one sample each. Typing earlier would run under the default agent, so readiness requires the session agent's label.
- Working: `<braille spinner> Generating… (Ns Esc/Ctrl+C to interrupt)`, also `Running command…` and `Thinking…`, with a `□/■ Reading 1 file, running 1 command…` progress row. The spinner redraws about four times a second; at about 0.3 s sampling the longest unchanged-screen stretch while working was 0.30 s and 0.31 s (Large 4, two runs) and 0.62 s (DeepSeek). An idle screen stayed unchanged for 17 s and more.
- `[AHELPA:DONE]` rendered alone on its line (indented two spaces) at 80 and 200 columns: 3/3 real ahelpa task files (Large 4 twice, DeepSeek once) and 2/2 completion nudges. Vibe renders assistant text as Markdown: one ad-hoc prompt produced `spike-ok\n[AHELPA:DONE]` (raw text confirmed in the session journal), shown as `spike-ok [AHELPA:DONE]`, which is not a signal.
- A scrollbar thumb glyph (U+2581–U+2588) is drawn in the last column of an arbitrary row, content rows included; the driver strips it before matching signals.
- The question tool replaces the composer with a dialog box; the hint line reads `User input required… (1s Esc/Ctrl+C to interrupt)` with the timer frozen and the spinner still animating.
- Esc interrupted a running `sleep 40` tool, which was gone afterwards; the session stayed and the transcript read `⎣ Interrupted · What should Vibe do instead?`.
- `/exit` quit without confirmation and printed `Or: vibe --resume <first 8 hex digits of the session ID>`. Both the 8-digit form and the full UUID resumed the same session, whose ID did not change; resume shows earlier turns and `✓ Resumed session <id>.`. Before the first message the session is not persisted (`/log` says so), and no full ID is on screen at start.
- `tmux kill-session` during a running `sleep 120` tool: `vibe-rs`, `vibe-app-server`, the tool shell and `sleep` all exited.
- An alias Vibe does not know shows a warning box `Model '<alias>' is not available — running 'Mistral Large 4'` and silently runs Large 4. A model the subscription lacks fails the turn with `✕ Error: API error occurred: Status 400 ... "type":"invalid_model" ...` and returns to the composer; the JSON wraps mid-word at 80 columns.
- The agent file selects model and thinking in the TUI: the composer showed `Mistral Large 4[high]` although the global `active_model` is DeepSeek, and a full DeepSeek table under an alias absent from the global config (`ahelpa-probe-ds`, thinking `low`) answered with session log `model_name` `deepseek-v4-1-flash-1017`. This machine's global `~/.vibe/config.toml` also defines the DeepSeek table (the owner's alternative route), so a plain `deepseek` run here cannot show that the session file alone suffices; the probe alias does.
- 2026-11-06 (headless spike): thinking has no CLI flag; `VIBE_MODELS` and nested variants did not override models; a quoted `[models."alias"]` sparse table deep-merges onto the routed model, and unquoted dotted aliases split and are ignored with a warning. Observed levels: Large 4 low/medium/high, default high; `mistral-medium-3.5` off/high; `glm-5-3` and `zai-glm-5-3-flash` low/high/max, default high. Unsupported levels may still be sent with a warning. A Large 4 probe at low/medium/high answered correctly in 8–19 s per call.
- 2026-11-06 (owner's session): DeepSeek through the Mistral subscription needs the full table (`name`, `provider = "mistral"`, `thinking`, `thinking_levels = ["low", "high", "max"]`, `max_context_length = 1048576`, `max_output_tokens = 131072`); the built-in `mistral` provider points at `https://api.mistral.ai/v1` and the key comes from the Keychain. A counting puzzle used 1622 reasoning tokens at `low` and 1335 at `max`, both correct; one sample does not show that the level changes reasoning depth.
- `vibe --version` is cheap, but doctor reads the installed `mistral-vibe` dist-info metadata instead, preserving its no-execution contract; unrecognized distributions report an unknown version.

## Turn-end hook (2026-11-08)

Measured on Vibe 3.1.0/macOS: a manual pair of TUIs (one with the hook, one without) on the user's default DeepSeek model, then `mistral` helpers through an isolated `AHELPA_HOME`.

- **Loading.** Vibe reads `<root>/.vibe/hooks.toml` for every project root: the trusted cwd plus each `--add-dir` (`harness_files/_harness_manager.py`, `hook_files`). The driver writes `.ahelpa/<id>/vibe-hook/.vibe/hooks.toml` (mode 0600, never overwritten) at launch and resume and passes `--add-dir` on that folder, so the result directory itself is not a workspace root and nothing in `~/.vibe` changes. The hook is `type = "post_agent"`, `match = "main"` (the main session's agent only, never a subagent), `timeout = 10`; its command is the `__turn-hook` wrapper, which exits 0 with empty stdout, so the turn passes through.
- **Payload.** `{"hook_event_name": "post_agent", "session_id", "parent_session_id": null, "transcript_path", "cwd", "agent_name"}`: no input and no turn id. ahelpa keeps the session id and adds a random turn id; the event wakes the daemon and is never attributed, so the driver leaves `turnHooks` off and a turn without a sentinel still waits for the ~12 s fallback. Attributing by time alone would end the wrong turn when a host sends while the helper is still working.
- **Firing.** Once per completed main-agent turn (3 payloads for 3 turns). Not on Escape (`Interrupted · What should Vibe do instead?`, no payload), matching the research note that error and Esc do not fire it; the screen and `interrupt` cover those.
- **Streaming.** The local harness sets `_buffer_completion_output` when any `post_agent_turn` binding exists (`mistralai_vibe_local_harness/runtime.py`), which suggested model text would stop streaming. The TUI path does not show that: with the hook, partial lines of a 1200-word reply appeared at 6, 9 and 12 s, as in the session without it, and the spinner line stayed.
- **Resume without the hook root.** Hook bindings are persisted with the session; a session created with the hook and resumed by hand (`vibe --resume <uuid>`, no `--add-dir`) answered normally, and `_resolve_hooks` skips a binding with no handler with a log warning only.
- **Timing.** A `mistral` task that wrote its summary and printed DONE: hook at 08:41:42.413, graceful exit sent at 08:41:42.949 (0.54 s, of which 250 ms is the daemon's wake grace); DONE was already drawn. Rebased on 0.14.0 (signals-only wake refresh): 0.54 s again (09:26:05.633 → 09:26:06.170). A reply that put DONE on the same Markdown line (`ok [AHELPA:DONE]`, not a signal) logged its hook at 08:41:01.150 and settled through the fallback at 08:41:10.492, as designed.

## Grid

| Column | Value |
| --- | --- |
| Shape | Vendor TUI in tmux; ahelpa types and reads the screen |
| Resume token | `Or: vibe --resume <8 hex>` printed by `/exit`, recorded while draining; old full-UUID tokens still resume |
| Turn-end signal | DONE/NEED_HELP alone on a line in the latest turn, after the last spinner line; a `post_agent` hook in a session `--add-dir` root wakes the daemon (wake only) |
| `--safe` means | Refused; lower-permission Vibe agents unverified |
| Trust persisted | No; `--trust` is invocation-only |
| Self-update | Both `VIBE_ENABLE_AUTO_UPDATE=false` and `VIBE_ENABLE_UPDATE_CHECKS=false` |
| Interrupt / exit | Esc (session kept) / `/exit` |
| Model / effort | Session agent TOML via `VIBE_AGENT_PATHS`; default `mistral-large-4-0-3` / `high`; no runtime switch |
| Last verified upstream | 3.1.0, 2026-11-07 |

## Unverified

Linux behaviour, fresh-account onboarding, the authentication-failure screen, rate-limit and retry screens, a What's-new panel after an upgrade, automated-use terms, lower-permission agents, sustained task quality and reliability, and how often models put the signal right after a text line (Markdown merge). The closure gate result is recorded in History; it does not establish behaviour on Linux.

## Why this verdict

The owner requested Vibe alongside agy and Pi. The 2026-11-06 headless spike supplied file handoff, unattended execution, native context continuity, update suppression and process settlement without global configuration writes, and a bridge was built on it. On 2026-11-07 the owner ruled that helpers must run the vendor TUI. The TUI spike showed the screen is readable (signal, working, ready, dialogs), the session runs unattended with session-only trust and no global configuration writes, and resume and process reclamation work without a bridge, so the driver moved to the TUI. Runtime model switching and `--safe` are optional capabilities and fail explicitly. Real-use observation is still pending, so the profile makes no quality assignment and leaves default dispatch unchanged.

The owner chose Large 4; the probe answered correctly at every level with modest latency differences and zero reported cost on this account, so its vendor default `high` (its highest level) was kept. Re-evaluate the level with real tasks.

## Where model definitions live (decided and implemented 2026-11-06)

A model Vibe does not know, such as DeepSeek through the Mistral subscription, needs a full model table somewhere. There are two places to put it.

**Chosen: per session, from the driver.** The driver holds the full definition. On every launch and resume the tmux pane writes it into the delivery directory's `ahelpa-helper.toml` (mode 0600, no secrets; Vibe still reads the key from the Keychain) before starting Vibe, which reads it through `VIBE_AGENT_PATHS` and `--agent`. `~/.vibe` is never written by ahelpa.

- Works out of the box: after installing ahelpa and signing in to Vibe, `ahelpa launch deepseek` runs without learning Vibe's config format.
- Every machine gets the same definition, so problems reproduce. Nothing is left in the user's global Vibe config.
- Matches the Mistral setup, which writes model and thinking the same way.

Costs and preconditions:

- The model ID `deepseek-v4-1-flash-1017` is dated and lives in code. If Mistral renames or retires it, every install breaks together, and the fix is a code change and a release.
- Out of the box only holds for subscriptions that include the model. The owner's Mistral subscription does; other plans and regions are unverified. Without it the first turn fails with `invalid_model`, and the helper settles `needs_attention` with the reason `model unavailable (the Mistral subscription may not include it)`.
- Runtime overhead is one small file write per launch or resume.

**Kept as the alternative: the user's global `~/.vibe/config.toml`.** The definition persists, ahelpa passes only the model name, a manually started `vibe` can use DeepSeek too, and a model-version change is one local edit. Against it: it edits global configuration, every new machine must be configured again, it breaks the driver's no-`~/.vibe`-writes rule, and it does not work out of the box. Verified 2026-11-06: with the same table in `config.toml`, no agent file, and `active_model` unchanged, `vibe --model deepseek-v4-1-flash-1017` answered the counting puzzle correctly, and a `--resume` turn recalled the answer. The owner keeps this table in the global config on the development machine, which is why TUI checks of the session file use an alias the global config lacks.

## History

- 2026-11-06: integrated from the coordinating session's Vibe 3.1.0 spike; added the dated card and an opt-in profile.
- 2026-11-06: review rework moved model/thinking configuration into bridge startup, bounded exit and pipe draining, added per-turn process-group cleanup, and retained delivered tasks when the native session ID is delayed; strengthened gate and regression coverage.
- 2026-11-06: the gate's vibe scenario no longer depends on the model obeying an artificial `NEED_HELP` request (Large 4 answered `DONE` instead in one run). `AHELPA_GATE_VIBE=1 bun run closure:gate` then passed on macOS with vibe 3.1.0: launch, `wait`/`check`, native resume with context recall, and a mid-turn `kill` of a running `sleep 120` turn with bridge, child and tool reclaimed.
- 2026-11-06: probed DeepSeek (`deepseek-v4-1-flash-1017`) through the Mistral subscription with a session agent file. Chose per-session model definitions over the global `~/.vibe/config.toml` (see “Where model definitions live”); implemented the same day.
- 2026-11-06: implemented model-named types `mistral` and `deepseek` on the Vibe harness, retaining `vibe` as a hidden compatibility alias. DeepSeek receives the full per-session model definition.
- 2026-11-06: finalized public names `mistral` (nickname `vibe`) and subscription-first `deepseek` (nickname `deepseek-vibe`), both storing harness ID `vibe`. The host may choose API backup `deepseek-pi` after subscription model-unavailable or authentication errors; no automatic fallback. Resume preserves stored settings and the original prefix.
- 2026-11-06: owner-side live check from the source tree with real models. `deepseek` and `mistral` each read a 250-line file and reported the correct sum and maximum. After `ahelpa resume`, each recalled the sum without rereading. A resumed turn took 13 s on DeepSeek and 19 s on Mistral (one sample each).
- 2026-11-06: first bounded task-quality trial of `deepseek` against `codex` and `claude` (worker), four tasks, one run each, in isolated clones of a large private repository. On par for bounded tasks; slower, and it followed a brief over a project rule as Claude did. Details in `skill/references/profiles.md#deepseek` and [the case study](../case-deepseek-trial-20261106.md).
- 2026-11-07: owner decision that every helper runs the vendor TUI in tmux; headless, RPC and stream-json bridges are banned. TUI spike (Facts above), then the driver was rewritten to drive the TUI from the screen alone (no hooks), the bridge and its tests were deleted, and the gate now checks the resume token recorded at drain and that the pane's process tree, recorded while live and mid-turn with a running `sleep`, is gone after kill. A source-tree check launched `mistral`, settled idle, recorded resume token `d320aec6` at drain, and after `ahelpa resume` recalled the context marker from the first turn.
- 2026-11-07: `AHELPA_GATE_VIBE=1 AHELPA_GATE_DEEPSEEK=1 bun run closure:gate` passed on macOS with vibe 3.1.0 (2088 tests; claude, codex, `mistral` and `deepseek` live, each with resume recall and a mid-turn kill of a running `sleep 120`; resume tokens were 8-hex prefixes). The run before it failed once on model behaviour: Large 4 judged the gate's "write exactly `gate-mistral-worker`" line to contradict the ahelpa contract, wrote a full summary instead and printed DONE; the next two runs complied. Startup bench (`scripts/startup-bench.sh`, compiled build, 3 rounds each): `launch` median 3.9 s for both names (bridge: 4.4–4.9 s), summary written at 8.6 s (`mistral`) and 7.9 s (`deepseek`), `wait` returned at 12.3 s and 12.2 s; 6/6 idle.
- 2026-11-07: `kill` now exits the TUI before closing tmux (Esc on a visibly working turn, then `/exit` into the ready composer), so a mid-turn kill kept the native ID in about 1 s and `resume` worked; `ahelpa interrupt` sends Esc and leaves the session in `needs_attention` for `send` or `task`.
- 2026-11-08: owner decision that a helper is its ahelpa ID and native resume is optional: `kill` no longer interrupts and exits the TUI to keep the native ID; it closes tmux at once. The ID is still recorded from the exit screen after DONE.
