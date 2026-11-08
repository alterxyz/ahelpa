# agy (Antigravity CLI)

Public name: `gemini`. Nicknames `agy` and `antigravity` use the same profile and prefix.

agy is Google's Antigravity CLI. It is an opt-in helper: launch it by name (see [profiles](profiles.md#gemini)). Install the standalone `agy` CLI ≥ 1.5.2 and run `agy` once interactively to sign in. Version 1.5.2 is the minimum; the terminal driver was verified on 1.5.3. Newer releases are accepted, older ones are refused with an upgrade message. `ahelpa doctor gemini` reads the version embedded in the binary without executing it and reports when more than one `agy` is on `PATH` (a desktop app can ship its own). agy keeps its sign-in in the OS keychain, which doctor does not open, so sign-in stays `unknown` until launch. Node.js is not needed.

```bash
ahelpa launch gemini --file ./task.md --project /path/to/project
ahelpa launch gemini --role reviewer --effort high --file ./review.md
```

## Model and effort

`worker` (default) and `reviewer` both launch `--model gemini-4-argon --effort medium`, which agy resolves to `gemini-4-argon-medium` (Gemini 4 Argon · medium). `advisor` is unsupported.

agy model IDs carry their effort: `agy models` lists `gemini-4-argon-low|medium|high`, `gemini-3.8-flash-*`, `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, and `gpt-oss-120b-medium` (the list depends on the account). agy composes a family with `--effort` (`--model gemini-4-argon --effort high` is `gemini-4-argon-high`) and refuses a suffixed ID with a different effort. ahelpa passes both flags through and refuses that contradiction before launch, so:

- `--effort high` alone switches the default to `gemini-4-argon-high`.
- A suffixed `--model`, such as `gemini-3.8-flash-low`, needs `--effort low`, or use `--model gemini-3.8-flash --effort low`.
- Gemini 4 Argon offers `low|medium|high`; agy rejects `xhigh`/`max` for it.

Runtime `ahelpa model` switching, including `--persist`, is unsupported; relaunch with the options you want.

## How it runs

The helper is agy's own interactive TUI in tmux, driven like a person at a terminal: ahelpa types the task line and reads the screen. Attaching to the tmux session shows the real agy UI.

```text
cd <project> && AGY_CLI_DISABLE_AUTO_UPDATE=true agy --dangerously-skip-permissions --settings '{"trustedWorkspaces":["<project>"(, "<its real path>")]}' --add-dir <result dir>/agy-hook [--conversation <id>] [--model …] [--effort …]
```

- **Updates.** `AGY_CLI_DISABLE_AUTO_UPDATE=true` (lowercase `true` only) keeps agy's background updater from replacing the binary.
- **Trust.** The TUI asks "Do you trust the contents of this project?" in a folder it has not trusted, even with `--dangerously-skip-permissions`. Answering would save the trust for good, so ahelpa passes the trust in `--settings`, which applies to this session only and is never saved. agy compares the literal working directory (not its real path, not a parent), so ahelpa passes the project path and, when it differs, its real path. If the dialog still appears, the launch fails instead of answering it.
- **Completion.** The screen decides. `[AHELPA:DONE]` or `[AHELPA:NEED_HELP:tags]` alone on a line, after the latest submitted turn (`> …` right below a `────` rule), settles the turn once nothing is working: no Braille spinner line above the composer (`⣾  Generating...`, footer `esc to cancel`) and no running background task (footer `· 1 task(s) · /tasks`). agy's `Stop` hook (below) wakes the daemon when the turn ends, so a printed signal settles within about half a second. Without a signal the daemon's usual idle rule applies after about 12 s of a quiet screen: a nudge when `summary.md` exists, otherwise `needs_attention`.
- **Background tasks.** agy turns a long command into a background task, may end the visible turn while it runs, and resumes the conversation on its own when it ends. A running task counts as work, so the turn settles only after it; a server left running keeps the helper busy until you kill it.
- **Dialogs.** Under `--dangerously-skip-permissions` no file or command prompt appeared, including reads and writes outside the project. agy's own question tool opens a multiple-choice dialog (`Question 1/1: …`, `↑/↓ Navigate · enter Select · esc Skip`) that waits for a person; nothing answers it, so the helper becomes `needs_attention`. Answer it with `tmux attach -t <id>`.
- **Turn-end hook.** `<result dir>/agy-hook/.agents/hooks.json` holds one `Stop` handler, loaded through `--add-dir` (no trust dialog). It prints `{}`, which lets the turn stop, and hands agy's payload to ahelpa, which keeps the conversation id and a digest of the last input. It only wakes the daemon and never decides: agy runs every `Stop` handler, and a project's or plugin's handler may still answer `continue`. A Stop while a background task still runs (`fullyIdle: false`) is ignored; Escape fires none.
- **No global or project writes.** ahelpa writes no agy settings or trust entries and nothing in the project's `.agents/`; its only agy file is the session hook above.

## Resume and takeover

The TUI prints the conversation ID only when it exits (`Resume with -c (or command below):` then `agy --conversation=<id>`). After a completed turn the daemon sends `/exit` and records the ID while draining, so `check` may show it a few seconds after `wait` returns. `kill` closes tmux at once and never fetches a missing ID; one a resumed helper inherited is kept (2026-11-08). `ahelpa interrupt` stops one turn and keeps the session.

`ahelpa resume` starts agy with `--conversation <id>`; the TUI replays the earlier turns (their old signals do not count). agy opens a new conversation, with only `warning: conversation "<id>" not found` at the top, when the ID is unknown; the resume then fails instead. Context carries over: the gate's resumed turn recalls a marker from the first turn.

To take a conversation over by hand, stop the helper first, then run `agy --conversation=<id>` in the same project. Two agy processes on one conversation are not coordinated.

## Stopping

- `/exit` (sent by the daemon after completion) quits agy; it also stops agy's background tasks.
- `Esc` interrupts the running turn and keeps the session (`Interrupted · What should Antigravity CLI do instead?`); a background task it already started keeps running. ahelpa does not send it.
- `ahelpa kill` closes the tmux session. The hangup reaches agy, which stops its tools: in five kills during a tool run (foreground and background) no process survived.

## Spike findings (agy 1.5.3, 2026-11-07)

Measured in tmux at 80x24 and 120x40 on macOS with the existing sign-in, in scratch folders. agy's global `settings.json` was unchanged afterwards. The machine's agy had already been updated from 1.5.2 to 1.5.3 before this session.

1. **Ready composer.** `>` alone between two full-width `────` rules, footer `? for shortcuts` with the model on the right (`Gemini 4 Argon · low`). The model appears about 1.7 s after the composer; ahelpa waits for it. A fresh launch is ready in about 2 s.
2. **Working.** A Braille spinner line just above the composer (`Generating...`, `Loading...`, `Working...`, `Reading file...`, `Running command...`, `Editing files...`) with footer `esc to cancel`. Right after a submit there is one frame (about 0.5 s) with neither. While the spinner shows the screen never stayed unchanged for more than 0.29 s (the sampling interval), including a 53 s wait for the model. With the turn ended and a background task running, the screen stayed unchanged for 3.5 s and 65 s; the footer's task count covers that.
3. **Turns.** A submitted turn is `> text` at column 0 right below a 60-column rule, wrapped lines indented two. Menu rows (`> /exit  Exit the CLI`), question options (`> 1. red`) and the trust dialog (`> Yes, I trust this folder`) also start with `> `, but not below a rule (the slash menu's first row is the exception; it only shows while typing a command).
4. **Signal.** `[AHELPA:DONE]` renders on its own line, indented two. The ahelpa task line itself mentions both signals mid-line ("output [AHELPA:DONE] on its own line"); at 80 columns word wrapping cannot leave the 13-character token alone on a line.
5. **Interrupt and exit.** `Esc` stops one turn and keeps the session. `/exit` opens the slash menu with `/exit` highlighted; Enter quits and prints the resume line.
6. **Resume.** `--conversation <id>` replays the conversation (including old `[AHELPA:DONE]` lines). An unknown ID prints `warning: conversation "<id>" not found` above the banner and starts a new conversation.
7. **Trust.** Session-only trust via `--settings` works and is matched literally: a `/tmp/…` working directory with only its `/private/tmp/…` real path trusted, or with only its parent trusted, still showed the dialog.
8. **Prompts without `--dangerously-skip-permissions`.** Reading the task file outside the project asked "Allow access to this file?" (`1. Yes, allow access`, `2. Yes, and always allow non-workspace access`, `3. No, deny access`), and writing `summary.md` asked "Allow creation of this file?". With the flag, none of these appeared; `sudo -n true` ran and failed normally.
9. **Process cleanup.** tmux kill during a tool run (four times while the command ran in the foreground, once as a background task) and `/exit` with a background task left no `sleep` behind within a second.

`--safe` stays refused: without the skip flag every task needs answers for the task file outside the project, every write and every command, and agy would also need `--add-dir` for the task and result folders. The driver does not answer these dialogs.

## Verification

`AHELPA_GATE_AGY=1 bun run closure:gate` makes model calls on `gemini-4-argon` / `medium`. It checks completion through `wait` and `check`, waits for the conversation ID recorded while draining, resumes it and recalls a marker from the first turn, then resumes again, kills during a `sleep 120` tool, and checks that the pane's processes recorded while agy ran (the pane shell, agy and the tool) are gone. Every gate run leaves its agy conversations in agy's own history.
