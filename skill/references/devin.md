# Devin CLI

Public name: `devin`. Nickname `swe` uses the same profile and prefix.

Devin CLI is Cognition's terminal coding agent. It is an opt-in helper: launch it by name (see [profiles](profiles.md#devin)). Install it from `cli.devin.ai` and run `devin setup` once in a terminal to sign in; finish the whole wizard there, since ahelpa never types into it. The driver was verified on 3000.14.30821 (2026-11-19). `ahelpa doctor devin` reads the version from the install path (`~/.local/share/devin/cli/_versions/<version>/bin/devin`) without running `devin`, and reports `unknown` when `~/.local/share/devin/credentials.toml` is missing.

```bash
ahelpa launch devin --file ./task.md --project /path/to/project
ahelpa launch devin --role reviewer --file ./review.md
```

## Model and effort

`worker` (default) and `reviewer` both launch `swe-2-flash` / `medium`, sent to devin as `--model swe-2-flash-medium` (SWE-2 Flash Medium). It is the only model the Free plan offers; Cognition's post says SWE-2 Flash is free through 2026-11-30. `advisor` is unsupported.

Devin model IDs carry their effort, and ahelpa folds `--effort` into the ID:

- `--model swe-2-flash --effort high` launches `swe-2-flash-high`.
- A suffixed `--model`, such as `claude-opus-5-5-high` or `claude-opus-5-5-high-fast`, needs a matching `--effort` (the role default `medium` would contradict it), or pass the family with `--effort`.
- `devin models` lists what the account offers. On the Free plan any other model makes devin exit with `Error: Upgrade to Pro to access this model`, and `launch` fails with that message; an unknown ID fails with `Unknown model`.

Runtime model switching is not supported; choose at launch. Resume keeps the recorded model and effort.

## How it runs

The pane runs `devin --process-model in-process --permission-mode dangerous --respect-workspace-trust false --model <id>` in the project directory.

- **Permissions.** `dangerous` approves every tool call. `--safe` is refused: Devin's lower modes ask for approvals, and its `--sandbox` mode was not tested with a result directory outside the workspace.
- **Trust.** `--respect-workspace-trust false` skips the trust check for this run; nothing is saved.
- **In the pane.** `--process-model in-process` keeps the agent and its tools under the pane, even if the user's config selects the shared background daemon.
- **Your configuration.** ahelpa writes nothing to `~/.config/devin` or the project. Devin still loads the user's own rules, skills and MCP servers, as in interactive use. ahelpa never passes `--config`: that flag replaces the user's config and starts the setup wizard.
- **Updates.** Devin's background updater (`auto_update` in the user config) stays as the user set it. Devin documents that a running session keeps its version and the update applies at the next launch.

## Turns, interrupt, kill, resume

- The daemon reads the screen: a sentinel written after the latest task echo, with no `(esc twice to interrupt)` status line, ends the turn. There is no turn-end hook, so a turn that ends without a sentinel settles through the idle fallback (about 12 s), and the completion nudge applies.
- A turn can sit on `Thinking` for minutes even on trivial work (4 of 15 small turns on 2026-11-19; Devin's log showed its service request stalled, with the plan's usage window at 100%). While the status line shows work, the daemon waits without a limit; if the result is already written, `interrupt` the turn rather than waiting.
- If the agent asks a question (its `ask_user_question` dialog), the session ends `needs_attention`. Attach with `tmux attach -t <id>` to answer, or kill and relaunch with the answer in the brief.
- `ahelpa interrupt` sends one `C-c`: devin prints `Canceled. What should Devin do?`, stops the running tool, and keeps the session for `send` or `task`.
- **Kill mid-turn: interrupt first.** Devin starts each tool command in a session of its own, and when tmux closes, devin exits without stopping it. `ahelpa kill` alone can leave that command running (observed with `sleep`, 2026-11-19). Run `ahelpa interrupt <id> --token <tok>`, then `ahelpa kill`. A helper that finished its turn has no tool running.
- On DONE the daemon sends `/exit`; devin prints `devin -r <name>` (a two-word name such as `artistic-learning`), which becomes the resume ID. `ahelpa resume` relaunches with `-r <name>` and requires the earlier turns on screen, since devin silently opens a new conversation for an unknown name.

## Checks

```bash
ahelpa doctor devin
AHELPA_GATE_DEVIN=1 bun run closure:gate
```

The gate launches the default worker, resumes it and checks that it remembers a marker from the first turn, then resumes again, starts `sleep 120`, interrupts and kills it, and checks that none of the pane's recorded processes survive.
