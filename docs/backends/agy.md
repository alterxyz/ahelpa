# Candidate card: agy (Antigravity CLI)

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-06 (local checks and the driver spike the same day)
- **Class:** Helper backend (candidate). Whether it is also a host target (a skill install target): Unverified.
- **Verdict:** **Integrated (2026-11-06)** as the sixth helper backend. Since 2026-11-07 ahelpa drives agy's own interactive TUI in tmux (typed input, screen capture, like Kimi); the stream-json bridge it started with is removed. Default model `gemini-4-argon` with effort `medium`. Driver notes: `skill/references/agy.md`.
- **Stopped at:** n/a (passed all hard gates; soft tier: model/effort, no `--safe`, no runtime switch)
- **Version tested:** 1.5.2 (bridge, 2026-11-06), 1.5.3 (TUI, 2026-11-07); `doctor` flags installs older than 1.5.2
- **Re-evaluate when:** agy changes its TUI (composer, spinner, footer, exit line) or the update kill switch, or a later release breaks `AHELPA_GATE_AGY=1`.

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

Stopping agy headless: stdin EOF waits for the running turn to finish, SIGTERM leaves tool processes orphaned, and SIGINT's own cleanup left orphans in one of two runs. The bridge therefore reaped agy's descendants itself.

## TUI spike (2026-11-07, agy 1.5.3)

The owner ruled on 2026-11-07 that every helper runs its vendor's own TUI in tmux; headless, print, RPC, stream-json and ACP bridges are out. This spike measured the TUI in tmux at 80x24 and 120x40 on macOS, with the existing sign-in, in scratch folders; agy's global `settings.json` hash was unchanged afterwards. The binary on this machine had already been updated to 1.5.3 (its 1.5.3 changelog lists no change to the composer, spinner or exit line).

1. **Ready composer:** `>` alone between two full-width rules; footer `? for shortcuts` with the model on the right, which appears about 1.7 s after the composer. A fresh launch is ready in about 2 s.
2. **Working:** a Braille spinner line above the composer (`⣾  Generating...`, `Loading...`, `Running command...`) with footer `esc to cancel`. One transitional frame (about 0.5 s) after a submit shows neither. The slash menu also shows `esc to cancel`, so the footer alone is not a working signal.
3. **Background tasks:** a long command becomes a background task (`● [18:10:03] sleep 179 running` below the composer, footer `· 1 task(s) · /tasks`). The visible turn can end while it runs; when it ends agy resumes the conversation by itself. After `Esc` it did not.
4. **Turns and signals:** a submitted turn is `> text` at column 0 below a 60-column rule, continuation lines indented two. Question options (`> 1. red`), the trust dialog (`> Yes, I trust this folder`) and slash-menu rows also start with `> `. `[AHELPA:DONE]` renders alone, indented two. The ahelpa task line mentions both signals mid-line, which word wrapping cannot isolate.
5. **Interrupt and exit:** `Esc` stops one turn and keeps the session (`⎿  Interrupted · What should Antigravity CLI do instead?`); a background task keeps running. `/exit` (Enter on the highlighted slash-menu row) quits and prints `Resume with -c (or command below):` and `agy --conversation=<id>`; it also stopped a running background task. The ID is not on screen before exit.
6. **Resume:** `--conversation <id>` replays the earlier turns; an unknown ID prints `warning: conversation "<id>" not found` above the banner and starts a new conversation.
7. **Trust:** `--settings '{"trustedWorkspaces":[…]}'` trusts for the session only. It is matched against the literal working directory: a `/tmp/…` directory trusted only by its `/private/tmp/…` real path, or only by its parent, still showed the dialog.
8. **Dialogs:** with `--dangerously-skip-permissions` no file or command prompt appeared, including reads and writes outside the workspace; `sudo -n true` ran and failed normally. The model's question tool opens a dialog that waits for a person (`Question 1/1: …`, `↑/↓ Navigate · enter Select · esc Skip`). Without the flag, reading a task file outside the workspace asked "Allow access to this file?" and creating `summary.md` asked "Allow creation of this file?".
9. **Process cleanup:** `tmux kill-session` during a tool run (four times in the foreground phase, once as a background task) and `/exit` with a background task left no tool process behind within a second; agy handles the hangup itself.
10. **Static screen while working:** while the spinner showed, the captured screen never stayed unchanged longer than 0.29 s (the 0.24 s sampling interval), across about 150 s of spinner time including a 53 s wait for the model. With the turn ended and a background task running the screen stayed unchanged for 3.5 s and 65 s, but the footer's task count is a working signal throughout. Inside a live turn the only stretch without any working signal was the 0.5 s frame after a submit, so agy alone would allow the daemon's idle debounce to drop from 12 s to 6 s.
11. **Node.js:** not needed; the TUI is the Go binary.

## Turn-end hook (2026-11-08, agy 1.5.3)

Measured in agy's TUI on macOS: a manual probe with a logging hook (`gemini-3.8-flash` / `low`), then `gemini` helpers (`gemini-4-argon` / `medium`) through an isolated `AHELPA_HOME`.

- **Loading.** `--add-dir <root>` with `<root>/.agents/hooks.json` loads the hook in the TUI with no trust dialog for that folder (spike 5 had shown it for print mode). agy's built-in hook docs: the file maps hook names to events; a `Stop` handler runs via `sh -c` in the hooks.json folder, synchronously in the agent loop, with JSON on stdin, and must print a JSON object; `decision: "continue"` would block the stop, so `{}` lets it end. The driver writes `.ahelpa/<id>/agy-hook/.agents/hooks.json` (mode 0600, never overwritten) at launch and resume; the result directory itself is not a workspace root, and agy's settings and the project's `.agents/` are untouched.
- **Payload.** `conversationId`, `executionNum`, `terminationReason`, `error`, `fullyIdle`, `lastUserInput`, `modelName`, `transcriptPath`, `workspacePaths` (the add-dir appears there). `executionNum` was 0 on all four turns, so it cannot tell turns apart: ahelpa adds a random turn id. `lastUserInput` was the typed text; for the ahelpa task line its digest matched the one ahelpa registered.
- **Firing.** Once at the end of every turn (`NO_TOOL_CALL`), including a turn that ran a shell command. A turn whose command became a background task fired at the visible end with `fullyIdle: false`, then again with `fullyIdle: true` and the same `lastUserInput` when agy resumed after the task; ahelpa drops the first. Escape mid-generation fired nothing (`Interrupted · What should Antigravity CLI do instead?`); the screen and `interrupt` cover it. `USER_CANCELED` and `ERROR` are documented and logged as `stop_failure`, but were not seen.
- **Timing.** A `gemini` task that wrote its summary and printed DONE: hook at 08:52:57.188, graceful exit sent at 08:52:57.736 (0.55 s, of which 250 ms is the daemon's wake grace); rebased on 0.14.0, 0.55 s again (09:26:12.070 → 09:26:12.620). A turn told not to print a signal: hook at 08:53:26.537, `needs_attention` ("turn hook stop") at 08:53:26.820, while the event was still attributed (commit 5e3e9cd); since the change below such a turn waits for the ~12 s fallback again.
- **Wake only (review, same day).** agy's hook docs say handlers for one event are merged and run in sequence, and a `Stop` handler answering `decision: "continue"` re-enters the loop. A project's `.agents/hooks.json` or a plugin may ship such a handler, and it can run after ahelpa's. An attributed event would then mark a working helper `needs_attention` (reproduced against the daemon with a working screen). So the driver leaves `turnHooks` off: the event wakes the daemon, the sentinel settles at once, and a turn without one waits for the ~12 s fallback.
- **Unverified.** Whether a subagent's loop fires `Stop` (subagents have their own conversation ids per agy's strings; moot while the event only wakes), and a `Stop` after an API error.

## Grid

| Column | Value |
| --- | --- |
| Shape | Vendor TUI in tmux (`agy --dangerously-skip-permissions --settings '{"trustedWorkspaces":[…]}'`) |
| Resume token | After exit only (`agy --conversation=<id>`, captured while draining); `--conversation <id>` |
| Turn-end signal | Sentinel in the current turn with no spinner and no running background task after it; a `Stop` hook in a session `--add-dir` root (`.agents/hooks.json`) wakes the daemon (wake only: another Stop handler may continue the turn) |
| `--safe` means | Refused |
| Trust persisted | No: session-only trust through `--settings`; a trust dialog fails the launch |
| Self-update | `AGY_CLI_DISABLE_AUTO_UPDATE=true` on the launch command |
| Model / effort | `--model <family> --effort <level>`; a suffixed id needs a matching `--effort`; no runtime switch |

## Funnel status

- Step 1: helper backend.
- Step 2: maintained and current; personal-account sign-in works (verified on this machine); macOS verified, Linux not run; **terms that allow automated driving of the official CLI: Unverified.**
- Step 3: all hard gates pass via the bridge (verified by `AHELPA_GATE_AGY=1 bun run closure:gate`, 2026-11-06) and again via the TUI (2026-11-07, agy 1.5.3).
- Step 4: model/effort yes; `--safe`, interrupt and runtime model switching no (agy's `Esc` interrupts one turn, but ahelpa has no interrupt command).

## Unverified

Onboarding on a fresh install (what a signed-out TUI shows), protected-command checks under skip-permissions, Linux behaviour, the TUI on 1.5.2, `doctor` sign-in detection (it reports unknown because the keychain is not read), and the terms question above.

## History

- 2026-11-06: card created while the driver was being built elsewhere.
- 2026-11-06: driver merged; spike results, Grid and funnel status replaced with measured values.

- 2026-11-06: the public helper name is now `gemini`, with nicknames `agy` and `antigravity`; database records continue to store harness ID `agy`, and resume preserves original session prefixes.
- 2026-11-07: moved from the stream-json bridge to agy's own TUI in tmux (owner decision: helpers are driven like a person at a terminal). Added the TUI spike, updated the Grid and funnel status; the bridge source is removed.
- 2026-11-07: `kill` now exits the TUI before closing tmux (Esc on a visibly working turn, then `/exit` into the ready composer), so a mid-turn kill kept the native ID in about 1 s and `resume` worked; `ahelpa interrupt` sends Esc and leaves the session in `needs_attention` for `send` or `task`.
- 2026-11-08: owner decision that a helper is its ahelpa ID and native resume is optional: `kill` no longer interrupts and exits the TUI to keep the native ID; it closes tmux at once. The ID is still recorded from the exit screen after DONE.
