# Candidate card: agy (Antigravity CLI)

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-06 (local checks the same day)
- **Class:** Helper backend (candidate). Whether it is also a host target (a skill install target): Unverified.
- **Verdict:** **In progress.** A separate session is building the driver; its spike results are added to this card when that driver merges. Strong prior: official, supported for personal accounts, structured modes, a session-only settings flag.
- **Stopped at:** Funnel step 3 (spike pending)
- **Version seen:** 1.5.2 (local binary)
- **Re-evaluate when:** The driver merges: replace the Grid below with measured results and update the registry row.

## What it is

Google's Antigravity CLI (`agy`), a Go binary. It is the successor to Gemini CLI for individual Google accounts and shares an agent harness with the Antigravity 2.0 desktop app (Google Developers Blog, 2026-05-19). The blog says Skills, Hooks, Subagents, and Extensions (now plugins) carry over.

## Facts

Local binary (2026-11-06, agy 1.5.2; `--version`, `--help`, `update --help`, and a string search of the binary; no model call was made and the updater was not run):

- Flags: `--dangerously-skip-permissions`; `--conversation <id>` (resume a conversation by id) and `--continue`; `--model`; `--effort low|medium|high|xhigh|max`; `--mode accept-edits|auto|plan`; `--settings` ("settings for this session only, never saved": a JSON object, inline or a file path); `--add-dir`; `--sandbox`; `-p/--print` with `--input-format text|stream-json` (stream-json reads one NDJSON message per line and runs a turn for each, and requires `--output-format stream-json`) and `--output-format text|json|stream-json`; `--json-schema`; `--prompt-interactive`; `--print-timeout`.
- Subcommands: `acp` (an ACP stdio server), `agent`, `changelog`, `install`, `mcp`, `models`, `plugin`, `remote-control`, `update`.
- The binary contains the string `AGY_CLI_DISABLE_AUTO_UPDATE` and a `--bg-updater` entry point.

From the coordinating session (2026-11-06, local binary): `agy models` lists `gemini-4-argon-*` and `gemini-3.8-flash-*`; model ids carry an effort suffix. This session did not re-run `agy models` on purpose (see the updater note below).

Official: Google's announcement and the Gemini CLI README direct individual, free, Pro, and Ultra accounts to agy for Gemini 4 Argon and later.

Third-party reports, not verified on 1.5.2:

- mngr's `mngr_antigravity` plugin README (fetched 2026-11-06; it cites agy 1.0.3 for one finding): each agent runs agy under its own `$HOME`; the OAuth token is a file that the plugin symlinks to a shared path; the plugin sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` by default; agy has no version pinning (the installer always fetches the latest); the first launch in a folder prompts to trust it; agy exposes no permission-dialog hook event, and a `PreToolUse` hook returning allow did not gate the `run_command` confirmation, so mngr uses `--dangerously-skip-permissions` instead; the desktop app's bundled `agy` shim can shadow the standalone CLI in `PATH`.
- `imbue-ai/default-workspace-template` pull request 986 (merged 2026-10-30), reproduced on agy 1.1.22 with an isolated home: a regular run, **including a signed-out `agy models`**, spawned a detached `--bg-updater` that downloaded the latest release and renamed it over the binary. With `AGY_CLI_DISABLE_AUTO_UPDATE=true` the binary was unchanged and no updater started; `agy --version` starts none. Updater state lives under `$HOME/.gemini/antigravity-cli/updater/`.
- `vardelabs/varde-agent-fabric` issue 84 (AI-drafted; agy 1.4.7; a personal Google AI Pro account; a dedicated service user with its own home): OAuth sign-in works over SSH by pasting the code back; the token is a file in a `0700` home (no keyring needed); `-p ... --output-format json --mode plan` returned a successful status but the headless run **denied the command tool by default** and the reply was empty, while a prompt that forbids tools returned text.

## Grid

| Column | Value |
| --- | --- |
| Shape | Undecided: TUI + hook, or a bridge over `-p --input-format stream-json` or `acp`. The spike decides. |
| Resume token | `--conversation <id>` exists; when the id is generated and where it is read: pending spike |
| Turn-end signal | Reported (pending spike): hooks can only be registered through `hooks.json`; stream-json events in print mode |
| `--safe` means | Candidates: `--mode`, `--sandbox`, a permissions policy through `--settings`; pending spike |
| Trust persisted | Reported (pending spike): directory trust persists; mngr corroborates a first-launch prompt |
| Self-update | `AGY_CLI_DISABLE_AUTO_UPDATE` is in the binary and two third parties rely on it; a live check that it suppresses the updater on 1.5.2 is pending |
| Model / effort | `--model`, `--effort`; model ids carry an effort suffix |

## Funnel status

- Step 1: helper backend.
- Step 2: maintained and current (official, 1.5.2 locally); personal-account sign-in is supported per Google's statements and one third-party report on 1.4.7; macOS and Linux per the installer announcement, architectures not checked; **terms that allow automated driving of the official CLI: Unverified.**
- Step 3: pending the spike. Two things to settle first: the update kill switch on 1.5.2 (set `AGY_CLI_DISABLE_AUTO_UPDATE=true` before any run, since even `agy models` can trigger the updater), and `PATH` shadowing by the desktop app's shim (always launch by absolute path).

## Unverified (pending the integrating session's spike)

Session-level hook registration beyond `hooks.json`, directory-trust persistence and its file, the self-update kill switch on 1.5.2, `PATH` shadowing on this machine, when the conversation id appears, what prompts remain after skip-permissions, sentinel capture through the rendered TUI, and whether stream-json mode keeps context and composes with `--conversation`.

## History

- 2026-11-06: card created while the driver is being built elsewhere.
