# Candidate card: OpenCode

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-06
- **Class:** Helper backend (candidate). Possibly also a host target (see Unverified).
- **Verdict:** **Candidate, worth a spike; no driver yet.** Passes funnel steps 1-2. Steps 3-4 are read from documentation only and were not run.
- **Stopped at:** Funnel step 4, documentation only
- **Version seen:** Not installed locally. Documentation for OpenCode 1 and OpenCode 2 as fetched 2026-11-06.
- **Re-evaluate when:** The user wants a provider-neutral open harness beyond Pi, or OpenCode 2 has settled enough to pick a major version. Spike then.

## What it is

An open-source (MIT) AI coding agent from the team behind the SST framework. Repository `anomalyco/opencode` (the older `sst/opencode` address redirects), about 221,000 stars on 2026-11-06, default branch `dev`. Terminal UI, desktop app, and IDE extensions. Providers come from Models.dev with the user's own API keys (it also offers its own curated model list through an opencode.ai account). The TUI is a client of a local HTTP server that exposes an OpenAPI spec and an SDK.

## Facts

Documentation fetched 2026-11-06 (opencode.ai docs, V1 and V2 sections):

- **Two majors share the `opencode` command.** V2's installer replaces a V1 binary; Homebrew's `opencode` formula installs V2 and V1 comes from a tap. V2 breaks the plugin API (V1 plugins do not run), the server API and clients, and TUI configuration (one global `cli.json`). V2 renames permission fields (`permission` becomes an ordered `permissions` array; `bash` becomes `shell`), allows `external_directory` by default where V1 asks, and drops `OPENCODE_SERVER_USERNAME` (the password variable is `OPENCODE_PASSWORD`; `OPENCODE_SERVER_PASSWORD` still works).
- **Non-interactive and resumable.** `opencode run [message]` with `--continue`, `--session <id>`, `--fork`, `--model provider/model`, `--agent`, `--file`, `--format json`, `--attach <url>`, `--variant` (provider-specific reasoning effort), and `--auto`. The TUI takes the same session and model flags. `opencode session list|export|import|delete` manages persisted sessions.
- **Headless server.** `opencode serve` (default 127.0.0.1:4096, OpenAPI 3.1 at `/doc`, basic auth through an environment variable), `opencode attach`, SDK `@opencode-ai/sdk` (V2: `@opencode/client`). Endpoints include sending a message, aborting, and replying to a permission request.
- **Unattended permissions.** `--auto` approves everything not explicitly denied (explicit deny rules still hold). `OPENCODE_PERMISSION` takes an inline JSON permission config. V1 defaults are permissive: most actions allowed, `external_directory` and `doom_loop` ask, `.env` reads ask. In V2 an unmatched rule means ask.
- **Session-scoped configuration without editing global files.** `OPENCODE_CONFIG` (custom file), `OPENCODE_CONFIG_DIR` (custom agents/commands/plugins directory), `OPENCODE_CONFIG_CONTENT` (inline JSON, applied after project config), plus `OPENCODE_DISABLE_PROJECT_CONFIG`. This is the route for funnel gate "no global config edits".
- **Self-update.** The V1 configuration docs say it checks for new versions and shows a notice but never installs automatically; `autoupdate: false` and `OPENCODE_DISABLE_AUTOUPDATE` turn the check off. An older issue (2026-03) reported updates breaking a setup; the environment variable was added in 2025-08.
- **Plugins (V1).** Event hooks include `session.idle`, `session.error`, `permission.asked`, `permission.replied`, and `tool.execute.before|after`; loaded from `.opencode/plugins/`, a global plugins directory, or npm.
- **Third-party corroboration of driving it from tmux.** mngr's `mngr_opencode` plugin README (fetched 2026-11-06) runs the TUI as an `opencode attach` client, reports RUNNING/WAITING states (a permission prompt versus end of turn), resumes conversations across stop/start, defaults `autoupdate` to false, and supports pinning the installed version. The `oar` runtime library also lists OpenCode among the runtimes it drives. Neither was verified by this project.

## Grid (documentation only)

| Column | Value |
| --- | --- |
| Shape | TUI + plugin hook, or a bridge over `serve` and the SDK. The spike decides; V2 changes both the plugin and server APIs. |
| Resume token | `--session <id>`; ids visible in `session list`; when the id is generated: Unverified |
| Turn-end signal | Plugin events (V1) or the server event stream |
| `--safe` means | No `--safe` equivalent; closest is deny/ask permission rules with `--auto` left off. Mapping Unverified. |
| Trust persisted | No folder-trust prompt documented; project config and plugins load automatically (a risk to weigh) |
| Self-update | `OPENCODE_DISABLE_AUTOUPDATE` or `autoupdate: false` |
| Model / effort | `--model provider/model`; `--variant` for effort |

## Unverified

- Everything about running it in tmux: readiness detection, sentinel capture through the rendered TUI, what dialogs appear.
- Whether `OPENCODE_PERMISSION` plus `--auto` fully removes prompts in the TUI.
- Which major to target, and V2's stability.
- Host target: OpenCode's environment-variable docs say it discovers skills in `.claude` and `.agents` directories, so ahelpa's globally installed skill may already be visible to it. Not checked.
- Whether a runtime model switch exists.

## Why this verdict

It passes the eligibility steps clearly: MIT, very active, no dependence on a personal-account subscription, macOS and Linux, and automation is a designed use (`run`, `serve`, SDK). On paper it clears the hard gates, with the strongest showing on unattended operation without global edits. Two open points keep it at "spike" rather than "build": which major version, and the marginal value next to Pi, which already covers a provider-neutral open harness.

## History

- 2026-11-06: candidate card created.
