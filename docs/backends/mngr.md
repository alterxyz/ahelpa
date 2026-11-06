# Candidate card: mngr

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-06
- **Class:** **Peer runtime.** The initial judgment is confirmed.
- **Verdict:** **Reference. No driver.** Its agent-type plugins are a useful third-party lead for spikes.
- **Stopped at:** Funnel step 1 (classification)
- **Version seen:** Public repository `main` as fetched 2026-11-06; no release number recorded. Not installed.
- **Re-evaluate when:** ahelpa needs remote, containerized, or multi-host helpers, which is mngr's focus. Compare then rather than build.

## What it is

`imbue-ai/mngr` (Imbue): "a CLI for managing coding agents", written in Python, MIT-licensed according to its README (GitHub's license field shows "Other"), built on SSH, git, and tmux, with a public mirror of a private development repository. Its verbs are `create`, `destroy`, `list`, `clone`, `message`, `connect`, `push`, `pull`, described as "git for agents". Agents run locally, in Docker, on Modal, or on any SSH host, and shut down when idle. Agent types are plugins; the repository's `libs/` directory includes plugins for Claude, Codex, OpenCode, Pi, and Antigravity.

## Evidence for the classification

Same primitives (tmux) and same job (spawn, list, message, and resume coding agents), so same layer. It runs harnesses; it is not one.

Different emphasis: remote hosts and isolation (containers, network allowlists), per-agent transcripts, and a plugin model for agent types. This evaluation did not examine whether mngr has an equivalent of ahelpa's file-handoff contract, sentinels, owner tokens, or evidence collection.

## Facts

Fetched 2026-11-06.

- README and product page: as above; supports "Claude, Codex, OpenCode, or any agent you can launch from a shell"; plugins add agent types, providers, and commands.
- `mngr_antigravity` plugin README: registers an `antigravity` agent type that runs `agy`. **Each agent runs `agy` under its own `$HOME`**, with the OAuth token symlinked to a shared path by default so one login serves all agents (set `symlink_oauth_token = false` for full isolation). Other settings: a `settings_overrides` blob merged into the per-agent settings, `auto_allow_permissions` (uses `--dangerously-skip-permissions`), `update_policy` (default resolves to never, which sets `AGY_CLI_DISABLE_AUTO_UPDATE=true`), and conversation resume across stop/start. The facts it records about agy are listed on the [agy card](agy.md) as third-party reports.
- `mngr_opencode` plugin README: runs OpenCode as a TUI attach client with RUNNING/WAITING reporting, resume, `autoupdate` off by default, and an optional version pin. Summarized on the [OpenCode card](opencode.md).
- Plugin settings worth noticing: `parent_type` plus overrides to derive agent variants, an explicit update policy per agent type, shared-or-isolated credentials, and `preserve_on_destroy` for transcripts and resumable sessions.

## What to take from it

1. Treat each upstream's update policy as an explicit, defaulted-safe setting (ahelpa's funnel gate on self-update says the same).
2. Read its plugins during spikes as a third-party source of TUI quirks, labelled as such under the [evidence rules](../backends.md#evidence-rules).
3. A per-agent `$HOME` is one way to keep one agent's configuration and trust from leaking into another's. ahelpa's alternative is session-scoped files and flags; consider the per-home option when an upstream offers no session-scoped route.

## Interop

None planned. ahelpa can be installed inside an mngr-managed agent like any other host environment (not tested).

## Unverified

mngr's own behavior on this machine (nothing was installed or run), its release cadence, and the full contract each plugin exposes.

## History

- 2026-11-06: classified as a peer runtime and recorded as reference (this card).
