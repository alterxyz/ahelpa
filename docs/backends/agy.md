# Candidate card: agy (Antigravity CLI)

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-06 (local checks and the driver spike the same day)
- **Class:** Helper backend (candidate). Whether it is also a host target (a skill install target): Unverified.
- **Verdict:** **Integrated (2026-11-06)** as the sixth helper backend, through a stream-json bridge in tmux (the `pi` shape). Default model `gemini-4-argon` with effort `medium`. Driver notes: `skill/references/agy.md`.
- **Stopped at:** n/a (passed all hard gates; soft tier: structured turn end and model/effort, no `--safe`, no runtime switch)
- **Version tested:** 1.5.2 (`doctor` flags older installs)
- **Re-evaluate when:** agy changes its stream-json events or the update kill switch, or a release past 1.5.2 breaks `AHELPA_GATE_AGY=1`.

## What it is

Google's Antigravity CLI (`agy`), a Go binary. It is the successor to Gemini CLI for individual Google accounts and shares an agent harness with the Antigravity 2.0 desktop app (Google Developers Blog, 2026-05-19). The blog says Skills, Hooks, Subagents, and Extensions (now plugins) carry over.

## Facts

Local binary (2026-11-06, agy 1.5.2; `--version`, `--help`, `update --help`, and a string search of the binary; no model call was made and the updater was not run):

- Flags: `--dangerously-skip-permissions`; `--conversation <id>` (resume a conversation by id) and `--continue`; `--model`; `--effort low|medium|high|xhigh|max`; `--mode accept-edits|auto|plan`; `--settings` ("settings for this session only, never saved": a JSON object, inline or a file path); `--add-dir`; `--sandbox`; `-p/--print` with `--input-format text|stream-json` (stream-json reads one NDJSON message per line and runs a turn for each, and requires `--output-format stream-json`) and `--output-format text|json|stream-json`; `--json-schema`; `--prompt-interactive`; `--print-timeout`.
- Subcommands: `acp` (an ACP stdio server), `agent`, `changelog`, `install`, `mcp`, `models`, `plugin`, `remote-control`, `update`.
- The binary contains the string `AGY_CLI_DISABLE_AUTO_UPDATE` and a `--bg-updater` entry point.

From the coordinating session (2026-11-06, local binary): `agy models` lists `gemini-4-argon-*` and `gemini-3.8-flash-*`; model ids carry an effort suffix. This session did not re-run `agy models` on purpose (see the updater note below).

Official: Google's announcement and the Gemini CLI README direct individual, free, Pro, and Ultra accounts to agy for Gemini 4 Argon and later.

Third-party reports, gathered before the spike (see Spike results below for what 1.5.2 confirmed or refuted):

- mngr's `mngr_antigravity` plugin README (fetched 2026-11-06; it cites agy 1.0.3 for one finding): each agent runs agy under its own `$HOME`; the OAuth token is a file that the plugin symlinks to a shared path; the plugin sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` by default; agy has no version pinning (the installer always fetches the latest); the first launch in a folder prompts to trust it; agy exposes no permission-dialog hook event, and a `PreToolUse` hook returning allow did not gate the `run_command` confirmation, so mngr uses `--dangerously-skip-permissions` instead; the desktop app's bundled `agy` shim can shadow the standalone CLI in `PATH`.
- `imbue-ai/default-workspace-template` pull request 986 (merged 2026-10-30), reproduced on agy 1.1.22 with an isolated home: a regular run, **including a signed-out `agy models`**, spawned a detached `--bg-updater` that downloaded the latest release and renamed it over the binary. With `AGY_CLI_DISABLE_AUTO_UPDATE=true` the binary was unchanged and no updater started; `agy --version` starts none. Updater state lives under `$HOME/.gemini/antigravity-cli/updater/`.
- `vardelabs/varde-agent-fabric` issue 84 (AI-drafted; agy 1.4.7; a personal Google AI Pro account; a dedicated service user with its own home): OAuth sign-in works over SSH by pasting the code back; the token is a file in a `0700` home (no keyring needed); `-p ... --output-format json --mode plan` returned a successful status but the headless run **denied the command tool by default** and the reply was empty, while a prompt that forbids tools returned text.

## Spike results

Measured by the integrating session (2026-11-06, agy 1.5.2, macOS, scratch conversations and temp directories only; agy's global `settings.json` hash was unchanged afterwards and no global `hooks.json` was created).

1. **Sign-in in tmux:** works with the existing sign-in (the token is in the OS keychain on macOS). The TUI's first screen is a folder-trust dialog; inline `--settings` with `trustedWorkspaces` trusts for that session only without saving. Onboarding on a never-signed-in install: Unverified.
2. **Self-update:** `AGY_CLI_DISABLE_AUTO_UPDATE` honours only lowercase `true`. A run with `1` started the background updater, and `TRUE`, `True` and `yes` also failed. No `--settings` key turns it off. This refutes the `=1` value in the pre-spike research.
3. **Conversation id:** generated before the first message and present in the `init`, step and `result` events; `--conversation` resumes it. An unknown id only prints a warning and silently starts a new conversation, so the bridge checks the id and fails the resume.
4. **Prompts left after skip-permissions:** in print mode nothing blocks; the model's ask-the-user tool gets an empty answer at once. "Protected commands are still checked" comes only from the 1.5.2 changelog and was not reproduced.
5. **Session-level hooks:** `--settings` rejects hooks and `--agent` takes no file path, but `--add-dir` pointing at a temp directory that holds `.agents/hooks.json` loads it and fires `Stop` in print and TUI modes, touching neither global nor project config. The bridge does not need hooks. Security note: an untrusted directory's hooks also run in print mode (see `docs/security.md`).
6. **Sentinel capture:** `[AHELPA:DONE]` stays on its own line through Markdown rendering and tool folding.
7. **stream-json:** one process keeps context across turns and composes with `--conversation`.

Stopping agy: stdin EOF waits for the running turn to finish, SIGTERM leaves tool processes orphaned, and SIGINT's own cleanup left orphans in one of two runs. The bridge snapshots agy's descendants, sends SIGINT, then reaps leftovers by recorded identity; a kill mid-turn is reclaimed in 1-2 seconds.

## Grid

| Column | Value |
| --- | --- |
| Shape | stream-json bridge in tmux (`-p "" --input-format stream-json --output-format stream-json --dangerously-skip-permissions`) |
| Resume token | Right after the first submit (from `init`); `--conversation <id>` |
| Turn-end signal | One `result` event per turn (`status`, `finished_reason`) |
| `--safe` means | Refused |
| Trust persisted | No trust prompt in print mode; nothing persisted |
| Self-update | `AGY_CLI_DISABLE_AUTO_UPDATE=true` set by the bridge |
| Model / effort | `--model <family> --effort <level>`; a suffixed id needs a matching `--effort`; no runtime switch |

## Funnel status

- Step 1: helper backend.
- Step 2: maintained and current; personal-account sign-in works (verified on this machine); macOS verified, Linux not run; **terms that allow automated driving of the official CLI: Unverified.**
- Step 3: all hard gates pass via the bridge (verified by `AHELPA_GATE_AGY=1 bun run closure:gate`, 2026-11-06).
- Step 4: structured turn end and model/effort yes; `--safe`, `/abort` and runtime model switching no.

## Unverified

Onboarding on a fresh install, protected-command checks under skip-permissions, Linux behaviour, `doctor` sign-in detection (it reports unknown because the keychain is not read), and the terms question above.

## History

- 2026-11-06: card created while the driver was being built elsewhere.
- 2026-11-06: driver merged; spike results, Grid and funnel status replaced with measured values.

- 2026-11-06: the public helper name is now `gemini`, with nicknames `agy` and `antigravity`; database records continue to store harness ID `agy`, and resume preserves original session prefixes.
