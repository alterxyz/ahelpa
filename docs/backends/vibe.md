# Candidate card: Vibe (Mistral Vibe CLI)

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-06 (coordinating session's local spike, macOS)
- **Class:** Helper backend; host-target status unverified.
- **Verdict:** **Integrated (2026-11-06)** as the seventh helper backend, with a persistent Node bridge in tmux and native resume between headless turns. Defaults: `mistral-large-4-0-3` / `high`. Not in default dispatch.
- **Stopped at:** n/a; spike established the runtime hard gates. Soft tier: structured output and process settlement, model/thinking configuration; no `--safe` or runtime model switch.
- **Version seen:** Vibe 3.1.0 (installed as a uv tool; Python launcher execs Rust `vibe-rs`).
- **Re-evaluate when:** streaming events, resume, agent-file merging, update switches, or process cleanup change; a newer release breaks `AHELPA_GATE_VIBE=1`.

## What it is

Mistral's Vibe CLI is a coding-agent harness. The chosen integration runs its official headless interface. A bridge persists in tmux; native sessions persist across the child process launched for each turn.

## Facts

Source: coordinating session's supplied spike results, measured 2026-11-06 on Vibe 3.1.0/macOS. These findings were supplied to the implementation task, not independently remeasured for this card.

- `-p <text>` / `--prompt-file <path>` with `--output streaming` emits NDJSON. Events carry `sessionId` (8-4-4-4-12 hexadecimal groups, not necessarily an RFC-4122 versioned UUID) and `turnId`. Observed types: `message`, `reasoning`, `effect`; assistant text is in message content blocks, tool summaries in effect titles and status.
- No explicit result event and no streaming stdin input. Exit 0 means finished, 3 interrupted (SIGTERM or time limit), and 1 error. `--output-dir` can export outcome, stop reason and exit code; the bridge needs only process settlement.
- `--resume <sessionId>` restored the first turn's context. An unknown ID exits 1 with “Session not found”; a bad model alias exits 1 with “Unknown model”.
- `--auto-approve` allowed a shell tool without prompting. `--trust` was invocation-only; the trusted-folder list stayed empty. The session agent's `safety = "yolo"` and `bypass_tool_permissions = true` replace the approval flag.
- `VIBE_ENABLE_AUTO_UPDATE=false` and `VIBE_ENABLE_UPDATE_CHECKS=false` appeared in effective configuration. Both are set for every child.
- Thinking has no CLI flag. `VIBE_MODELS` and nested variants did not override models. A per-session `ahelpa-helper.toml`, discovered through `VIBE_AGENT_PATHS` and selected by `--agent ahelpa-helper`, did set active model and thinking on initial and resumed turns. A quoted `[models."alias"]` sparse table deep-merges onto the routed model. Unquoted dotted aliases split and are ignored with a warning.
- Observed levels: Large 4 (`mistral-large-4-0-3`) low/medium/high, default high; `mistral-medium-3.5` off/high; `glm-5-3` and `zai-glm-5-3-flash` low/high/max, both default high in the effective configuration. Unsupported levels may still be sent with a warning. The low/medium/high Large 4 probe used two small reasoning prompts: output tokens 125/161/176 and 97/178/205, all answers correct, 8–19 seconds per call. Reported cost was zero on that account; this is not a pricing claim.
- SIGTERM exited 3 within a second and the spawned `sleep 30` was gone in one run. The bridge cleans the turn’s process group after natural and explicit exits, and snapshots descendants before stopping to also reap tools that create another session.
- Stderr includes a macOS Keychain notice and may contain account data; the bridge prints fixed categories only. Sign-in remains unknown in doctor and is checked by the first turn. `vibe --version` was cheap and safe in the spike. The driver instead reads installed `mistral-vibe` dist-info metadata, preserving doctor’s no-execution contract; unrecognized distributions report an unknown version.
- DeepSeek through the Mistral subscription (owner's session, 2026-11-06, Vibe 3.1.0/macOS): the model is absent from Vibe's built-in definitions, but a full `[models."deepseek-v4-1-flash-1017"]` table in the session agent file (`name`, `provider = "mistral"`, `thinking`, `thinking_levels = ["low", "high", "max"]`, `max_context_length = 1048576`, `max_output_tokens = 131072`) worked without touching `~/.vibe`. The built-in `mistral` provider already points at `https://api.mistral.ai/v1`; the key still comes from the Keychain. Three headless calls exited 0 without warnings, and Vibe's session log recorded `model_name` `deepseek-v4-1-flash-1017`. A trivial prompt at `high` used 0 reasoning tokens; a counting puzzle used 1622 at `low` and 1335 at `max`, both answering correctly (158, checked by hand). This shows reasoning is on and both levels are accepted. One sample does not show that the level changes reasoning depth.
- First-party `vibe-acp` and `vibe-app-server` also exist. Per-turn headless was simpler and structured enough; those interfaces are upgrade candidates if the measured roughly 1–2 second per-turn startup becomes material.

## Grid

| Column | Value |
| --- | --- |
| Shape | Persistent Node bridge in tmux; one streaming headless child per turn |
| Resume token | First event of first turn supplies sessionId; later turns use `--resume <id>` |
| Turn-end signal | Child exit plus assistant-text DONE/NEED_HELP sentinel |
| `--safe` means | Refused; lower-permission headless behavior unverified |
| Trust persisted | No; `--trust` is invocation-only |
| Self-update | Both `VIBE_ENABLE_AUTO_UPDATE=false` and `VIBE_ENABLE_UPDATE_CHECKS=false` |
| Model / effort | Session agent TOML via `VIBE_AGENT_PATHS`; default `mistral-large-4-0-3` / `high`; no runtime switch |
| Last verified upstream | 3.1.0, 2026-11-06 |

## Unverified

Linux behavior, fresh-account onboarding, automated-use terms, lower-permission headless agents, sustained task quality and reliability, and the alternative ACP/app-server routes. The spike demonstrated runtime primitives; it did not establish every admission-funnel policy question. The closure gate passed on macOS (see History); it does not establish behaviour on Linux.

## Why this verdict

The owner requested Vibe alongside agy and Pi. The spike supplied file handoff, unattended execution, native context continuity, update suppression and process settlement without global configuration writes. The persistent bridge plus native session satisfies ahelpa's persistence requirement even though each turn has a new child. Runtime model switching and `--safe` are optional capabilities and fail explicitly. Real-use observation is still pending, so the profile makes no quality assignment and leaves default dispatch unchanged.

The owner chose Large 4; the probe answered correctly at every level with modest latency differences and zero reported cost on this account, so its vendor default `high` (its highest level) was kept. Re-evaluate the level with real tasks.

## Where model definitions live (decided and implemented 2026-11-06)

A model Vibe does not know, such as DeepSeek through the Mistral subscription, needs a full model table somewhere. There are two places to put it.

**Chosen: per session, from the driver.** The driver holds the full definition. On every launch and resume the bridge writes it into `.ahelpa/<session-id>/ahelpa-helper.toml` (mode 0600, no secrets; Vibe still reads the key from the Keychain), and every turn reads it through `VIBE_AGENT_PATHS` and `--agent`. `~/.vibe` is never written.

- Works out of the box: after installing ahelpa and signing in to Vibe, `ahelpa launch deepseek` runs without learning Vibe's config format.
- Every machine gets the same definition, so problems reproduce. Nothing is left in the user's global Vibe config, which keeps the driver's no-`~/.vibe`-writes rule.
- Matches the existing Mistral setup, which already writes model and thinking this way.

Costs and preconditions:

- The model ID `deepseek-v4-1-flash-1017` is dated and lives in code. If Mistral renames or retires it, every install breaks together, and the fix is a code change and a release.
- Out of the box only holds for subscriptions that include the model. The owner's Mistral subscription does; other plans and regions are unverified. Without it the first turn fails, so that failure should get a readable hint, for example that the Mistral subscription may not include the model.
- Runtime overhead should be negligible: one small file write per launch, and Vibe reads the agent file every turn anyway. The real per-turn cost is the new Vibe process plus `--resume`, which does not depend on where the definition lives. Measured once after implementation: a resumed recall turn took 13 s on `deepseek` and 19 s on `mistral`, with about 1 s for `ahelpa resume` itself.

**Kept as the alternative: the user's global `~/.vibe/config.toml`.** The definition persists, ahelpa passes only the model name, a manually started `vibe` can use DeepSeek too, and a model-version change is one local edit. Against it: it edits global configuration, every new machine must be configured again, it breaks the driver's no-`~/.vibe`-writes rule, and it does not work out of the box. Verified the same day: with the same table in `config.toml`, no agent file, and `active_model` unchanged, `vibe --model deepseek-v4-1-flash-1017` answered the counting puzzle correctly, and a `--resume` turn recalled the answer. Both generations recorded the DeepSeek model with reasoning effort `high`.

## History

- 2026-11-06: integrated from the coordinating session's Vibe 3.1.0 spike; added the dated card and an opt-in profile.
- 2026-11-06: review rework moved model/thinking configuration into bridge startup, bounded exit and pipe draining, added per-turn process-group cleanup, and retained delivered tasks when the native session ID is delayed; strengthened gate and regression coverage.
- 2026-11-06: the gate's vibe scenario no longer depends on the model obeying an artificial `NEED_HELP` request (Large 4 answered `DONE` instead in one run). `AHELPA_GATE_VIBE=1 bun run closure:gate` then passed on macOS with vibe 3.1.0: launch, `wait`/`check`, native resume with context recall, and a mid-turn `kill` of a running `sleep 120` turn with bridge, child and tool reclaimed.
- 2026-11-06: probed DeepSeek (`deepseek-v4-1-flash-1017`) through the Mistral subscription with a session agent file. Chose per-session model definitions over the global `~/.vibe/config.toml` (see “Where model definitions live”); implemented the same day, see the entries below.

- 2026-11-06: implemented model-named types `mistral` and `deepseek` on the Vibe harness, retaining `vibe` as a hidden compatibility alias. DeepSeek now receives the full per-session model definition described above, with a fixed subscription-availability error category; real-model validation of this change remains for the owner.

- 2026-11-06: finalized public names `mistral` (nickname `vibe`) and subscription-first `deepseek` (nickname `deepseek-vibe`), both storing harness ID `vibe`. The host may choose API backup `deepseek-pi` after subscription model-unavailable or authentication errors; no automatic fallback. Resume preserves stored settings and the original prefix.
- 2026-11-06: owner-side live check from the source tree with real models. `deepseek` and `mistral` each read a 250-line file and reported the correct sum and maximum. After `ahelpa resume`, each recalled the sum without rereading. New IDs kept the `deepseek-` and `mistral-` prefixes, rows stored harness ID `vibe` with their own models, and a resumed turn took 13 s on DeepSeek and 19 s on Mistral (one sample each).
