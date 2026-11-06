# agy (Antigravity CLI)

agy is Google's Antigravity CLI. It is an opt-in helper: launch it by name (see [profiles](profiles.md#agy)). Install the standalone `agy` CLI ≥ 1.5.2 and Node.js, and run `agy` once interactively to sign in. Version 1.5.2 is the tested baseline; newer releases are accepted, older ones are refused with an upgrade message. `ahelpa doctor agy` reads the version embedded in the binary without executing it, checks for Node.js, and reports when more than one `agy` is on `PATH` (a desktop app can ship its own). agy keeps its sign-in in the OS keychain, which doctor does not open, so sign-in stays `unknown` until launch.

```bash
ahelpa launch agy --file ./task.md --project /path/to/project
ahelpa launch agy --role reviewer --effort high --file ./review.md
```

## Model and effort

`worker` (default) and `reviewer` both launch `--model gemini-4-argon --effort medium`, which agy resolves to `gemini-4-argon-medium` (Gemini 4 Argon · medium). `advisor` is unsupported.

agy model IDs carry their effort: `agy models` lists `gemini-4-argon-low|medium|high`, `gemini-3.8-flash-*`, `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, and `gpt-oss-120b-medium` (the list depends on the account). agy composes a family with `--effort` (`--model gemini-4-argon --effort high` is `gemini-4-argon-high`) and refuses a suffixed ID with a different effort. ahelpa passes both flags through and refuses that contradiction before launch, so:

- `--effort high` alone switches the default to `gemini-4-argon-high`.
- A suffixed `--model`, such as `gemini-3.8-flash-low`, needs `--effort low`, or use `--model gemini-3.8-flash --effort low`.
- Gemini 4 Argon offers `low|medium|high`; agy rejects `xhigh`/`max` for it.

Runtime `ahelpa model` switching, including `--persist`, is unsupported; relaunch with the options you want.

## How it runs

The bridge (`agy-terminal.mjs` in the session's result directory, run by Node in tmux) starts one agy process:

```text
agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions [--conversation <id>] [--model …] [--effort …] -p ""
```

with `AGY_CLI_DISABLE_AUTO_UPDATE=true`. Each task line becomes one NDJSON user message; agy answers each with one `result` event and keeps the conversation in the same process. The bridge prints state markers that the driver reads; queued tasks run one at a time without an idle gap.

- **Completion.** A `SUCCESS` result whose answer has the DONE signal alone on a line settles `idle`. `NEED_HELP` settles `error` with its tags. A `SUCCESS` without a signal, a partial answer, or an interrupted turn needs attention. An `ERROR` result is an error and drops queued tasks.
- **No prompts.** Headless agy never stops for approval or input. Its own `ask_question` tool returns an empty answer at once, so the helper reaches the host only through `NEED_HELP`.
- **No global or project writes.** Print mode shows no trust dialog and does not record the folder as trusted. ahelpa writes no agy settings, hooks, or `.agents/` files.
- **Errors.** agy's stderr can name the account and local paths, so the bridge prints only fixed categories (`agy rejected the model or effort`, `agy is not signed in`, `agy exited during startup`, `agy exited unexpectedly`, `protocol failure`). After a fatal error the bridge discards input until `/exit`; relaunch or resume once the cause is fixed.

## Resume and takeover

The conversation ID appears in agy's first event, before any task, so the session records it right away. `ahelpa resume` starts a new bridge with `--conversation <id>`. agy opens a new conversation, with only a warning, when the ID is unknown; the bridge checks the ID agy reports and fails instead. Context carries over: the gate's resumed turn recalls a marker from the first turn.

To take a conversation over by hand, stop the helper first, then run `agy --conversation=<id>` in the same project. Two agy processes on one conversation are not coordinated.

## Stopping

`/exit` (sent by the daemon after completion) and `ahelpa kill` both stop agy with SIGINT, not stdin EOF or SIGTERM. EOF lets agy finish the running turn first, and SIGTERM leaves agy's tool processes running. agy runs each tool command in its own process group, and its SIGINT cleanup races its exit. So the bridge records agy's descendants before signalling and afterwards stops any that survived, by recorded process identity: TERM, then KILL. A direct SIGKILL of the bridge cannot clean up; agy then sees EOF and exits after its turn.

## Spike findings (agy 1.5.2, 2026-11-06)

Verified means observed on a real run; otherwise the source is named.

1. **tmux and sign-in.** Verified: an existing sign-in works in tmux, both headless and in the TUI (the token comes from the OS keychain). The TUI asks "Do you trust the contents of this project?" in an untrusted folder, even with `--dangerously-skip-permissions`; answering persists the trust globally. Session-only trust works with `--settings '{"trustedWorkspaces":[…]}'`, which leaves the settings file unchanged. Headless print mode shows no dialog. Unverified: the onboarding screens of a never-signed-in install.
2. **Auto-update.** Verified: `AGY_CLI_DISABLE_AUTO_UPDATE=true` logs "Auto-update disabled via environment variable". The values `1`, `TRUE`, `True`, and `yes` are ignored, and a run with `1` spawned the background updater. The variable is per process, so it is the session-only switch; no `--settings` key for updates was found.
3. **Conversation ID.** Verified: created before the first message. Headless runs report it in the `init` event and on every step and result. The TUI prints it only on exit (`agy --conversation=<id>`). Hook payloads carry `conversationId`. `--conversation <id>` restores context, including with stream-json. An unknown ID opens a new conversation with only a stderr warning.
4. **Prompts under skip-permissions.** Verified headless: no prompt ever blocks. `ask_question` returns empty answers, and the model declined a `git push --force` on its own. Verified TUI: the trust dialog still appears. From the 1.5.2 changelog, not reproduced: protected commands go through the usual checks, enterprise-reviewed actions are denied headless, and access outside the workspace asks "Allow access to this file?" in the TUI. The bridge needs no needs-attention screen detection because headless mode cannot block.
5. **Session-level hooks.** Verified: `--settings` rejects `hooks` ("unknown setting"), and `--agent` accepts only a discovered agent name, not a file. But `--add-dir <dir>` with `<dir>/.agents/hooks.json` loads that file's hooks for the session, both headless and in the TUI (with session-only trust), without touching global config or the project. The Stop payload has `conversationId`, `error`, `executionNum`, `fullyIdle`, `lastUserInput`, `modelName`, `terminationReason` (`NO_TOOL_CALL` on a normal turn), `transcriptPath`, `artifactDirectoryPath`, and `workspacePaths`. ahelpa does not use hooks, since stream-json already reports each turn's end. Workspace hooks also ran in an untrusted added folder in print mode, so a project's own `.agents/hooks.json` may run under a headless helper.
6. **Signals on screen.** Verified in the TUI: `[AHELPA:DONE]` survives Markdown rendering and collapsed tool groups as its own line (indented two spaces, which the signal matcher allows). The bridge reads the answer text from the `result` event, so rendering does not matter there.
7. **stream-json.** Verified: one process keeps context across turns. `--conversation <id>` combines with stream-json and continues the same conversation. Input lines are `{"event":"user","message":{"role":"user","content":"…"}}`. `-p` must be given an argument (`-p ""`). SIGINT ends the process with an `interrupted` result rather than cancelling one turn. An `ERROR` result leaves the process running.

**Choice of transport.** The bridge reports the conversation ID before the first task, gives structured turn results, needs no trust dialog or screen parsing, and does not depend on a TUI that changes between releases. TUI capture with `--add-dir` hooks and session-only trust is possible, and was kept as the fallback.

## Verification

`AHELPA_GATE_AGY=1 bun run closure:gate` makes model calls on `gemini-4-argon` / `medium`. It checks completion through `wait` and `check`, a native resume that recalls a marker from the first turn, and that the bridge and agy PIDs recorded while the helper ran are gone after `kill`. Every gate run leaves its agy conversations in agy's own history.
