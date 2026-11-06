# Candidate card: Gemini CLI

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-06
- **Class:** Helper backend (candidate)
- **Verdict:** **Declined.** Personal accounts are no longer served, the enterprise route is closing to new buyers, and Google's own path for individuals is agy.
- **Stopped at:** Funnel step 2 (eligibility)
- **Version seen:** Not installed locally. Repository README and documentation as fetched on 2026-11-06; no CLI version number recorded.
- **Re-evaluate when:** Google serves personal accounts in Gemini CLI again, or the user holds an eligible route (an existing Code Assist Standard/Enterprise license, or a paid Gemini or Vertex API key they are willing to pay per token) **and** has a need agy does not cover.

## What it is

Google's open-source terminal agent (`gemini`, npm `@google/gemini-cli`, repository `google-gemini/gemini-cli`, Apache-2.0). Google now positions it as maintained for enterprise Gemini Code Assist workflows on Google Cloud.

## Facts

All fetched 2026-11-06 unless noted.

Eligibility (official sources):

- Google Developers Blog, 2026-05-19: on 2026-06-18 Gemini CLI and the Code Assist IDE extensions stop serving Google AI Pro, Google AI Ultra, and free "Code Assist for individuals" accounts, which are directed to Antigravity CLI. Code Assist Standard/Enterprise licenses are unchanged, and Gemini CLI stays accessible with paid Gemini and Gemini Enterprise Agent Platform API keys.
- Maintainers' announcement (`google-gemini/gemini-cli` discussion 28017, 2026-06-18) confirms the cutover happened that day.
- Current README banner: enterprise Code Assist only; no free tier or Google AI plans; **not tuned for Gemini 4 or later** (it names Gemini 4 Argon) and not to be used to benchmark Gemini models. It points individuals to `agy`, and points agents and scripts that want direct model commands to a separate stateless `gemini-api` CLI, which is explicitly not a coding harness (a model-layer tool in the [classification](../backends.md#classify-first)).
- Google Cloud Code Assist release notes: from 2026-10-09 new Standard and Enterprise subscriptions can no longer be purchased; existing ones auto-renew through the rest of 2026 and auto-renewal ends in 2027. Since 2026-09-04 new subscriptions through the Cloud console are limited to billing accounts that already have one.
- Third-party corroboration (not authoritative): a dispatcher project's issue (`vardelabs/varde-agent-fabric` 84, AI-drafted) records that its first real Gemini CLI sign-in with a personal Google AI Pro account failed with a "client no longer supported for individuals" error, four months after the route closed, because every earlier check ran against source or a stub.

Engineering facts from the official docs (this is why it would otherwise be easy to wire):

- `--skip-trust` trusts the workspace for this session only; `GEMINI_CLI_TRUST_WORKSPACE=true` does the same. Folder trust is off by default (`security.folderTrust.enabled`); when on, a headless run in an untrusted folder fails fast. Persisted trust lives in `~/.gemini/trustedFolders.json` (path overridable with `GEMINI_CLI_TRUSTED_FOLDERS_PATH`).
- `GEMINI_CLI_SYSTEM_SETTINGS_PATH` points the CLI at a system-settings file, the highest-precedence settings file. That is a session-level route for settings; whether it can carry session hooks was not checked.
- `-p` for non-interactive mode, `--output-format text|json|stream-json`, `--approval-mode default|auto_edit|yolo|plan`, `--sandbox`, `--resume latest|<index>|<session UUID>`, `--list-sessions`, `--experimental-acp`, `gemini update`, and a `general.enableAutoUpdate` setting (default true).

## Grid (docs only)

| Column | Value |
| --- | --- |
| Shape | TUI + hook, or a bridge over `stream-json`; not decided |
| Resume token | `--resume <UUID>` exists; when the id appears: Unverified |
| Turn-end signal | Hooks exist (listed in the trust dialog docs); schema Unverified |
| `--safe` means | `--approval-mode`, `--sandbox`; mapping Unverified |
| Trust persisted | Not required with `--skip-trust` / `GEMINI_CLI_TRUST_WORKSPACE` |
| Self-update | `general.enableAutoUpdate`; per-session control Unverified |
| Model / effort | `-m` with aliases; effort Unverified |

## Unverified

- A pre-assignable `--session-id`: reported by the coordinating session when this card was commissioned, but it is **not** on the CLI reference or configuration reference pages fetched 2026-11-06, which document only `--resume`. It may exist in a newer build.
- Whether session hooks can be delivered through `GEMINI_CLI_SYSTEM_SETTINGS_PATH`.
- Whether a paid API key meets the user's needs, and whether its terms allow automated driving of the CLI.
- Behavior on Gemini 4 models, which Google says the harness is not tuned for.

## Why this verdict

Step 2 fails for the account type the user actually has. The enterprise route is closed to new buyers, the API-key route is metered and runs on a harness Google says is not tuned for current models, and the same models are reachable for individuals through agy, which is already being integrated. Engineering ease does not offset eligibility.

The decisive fact was findable in five minutes (README banner plus the announcement) and was found only after reading code. That is why funnel step 2 comes before any code reading.

## History

- 2026-11-06: declined (this card).
