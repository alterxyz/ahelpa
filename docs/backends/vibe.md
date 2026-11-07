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

## History

- 2026-11-06: integrated from the coordinating session's Vibe 3.1.0 spike; added the dated card and an opt-in profile.
- 2026-11-06: review rework moved model/thinking configuration into bridge startup, bounded exit and pipe draining, added per-turn process-group cleanup, and retained delivered tasks when the native session ID is delayed; strengthened gate and regression coverage.
- 2026-11-06: the gate's vibe scenario no longer depends on the model obeying an artificial `NEED_HELP` request (Large 4 answered `DONE` instead in one run). `AHELPA_GATE_VIBE=1 bun run closure:gate` then passed on macOS with vibe 3.1.0: launch, `wait`/`check`, native resume with context recall, and a mid-turn `kill` of a running `sleep 120` turn with bridge, child and tool reclaimed.
