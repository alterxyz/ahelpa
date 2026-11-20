# Candidate card: Devin CLI

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-19 (owner's machine, macOS arm64, a personal Devin account on the Free plan).
- **Class:** Helper backend; host-target status unverified.
- **Verdict:** **Integrated (2026-11-19)** as public name `devin` (nickname `swe`), driven through Devin's own interactive TUI in tmux. Defaults: `swe-2-flash` / `medium` (sent as `--model swe-2-flash-medium`), the one model the Free plan offers. A low-priority option by the owner's decision (2026-11-19): not in default dispatch.
- **Stopped at:** n/a. Floor tier plus model/effort and a verified interrupt key: no turn-end hook, no `--safe`, no runtime model switch.
- **Version seen:** Devin CLI 3000.14.30821 (commit a09cd7f323ee), installed by `cli.devin.ai/install.sh` into `~/.local/share/devin/cli/_versions/<version>/bin/devin`, linked from `~/.local/bin/devin`.
- **Re-evaluate when:** the composer, status line or exit screen changes; the Free plan or the SWE-2 Flash offer changes (the vendor's post says free through 2026-11-30); Devin offers a per-launch hook or settings file; `AHELPA_GATE_DEVIN=1` fails.

## What it is

Cognition's terminal coding agent (the Windsurf/Devin family): a TUI with local tools, a model picker covering Cognition's SWE models and third-party models billed through the Devin account, plus cloud sessions, ACP and print modes that ahelpa does not use. ahelpa runs the TUI in tmux, types the task line, reads the screen, and sends `/exit` after DONE.

## Facts

Measured 2026-11-19 on 3000.14.30821/macOS in tmux at 80x24, 120x30 and 160x45, with `swe-2-flash-medium` unless noted. Documentation facts were read the same day at `docs.devin.ai/cli` (third-party summaries are not used).

- **Launch.** `devin --process-model in-process --permission-mode dangerous --respect-workspace-trust false --model swe-2-flash-medium [-r <name>]`. No trust dialog. After the run, `~/.config/devin/config.json` and `app_state.json` held no trace of the project, so the trust skip applies to this run only.
- **Never pass `--config`.** It replaces the user's config file instead of layering on it: devin started its setup wizard (sign-in check, organization, "Connect GitHub"). A keystroke meant as a task answered the wizard's default option, which connected the user's GitHub account to Devin through the `gh` CLI. Hooks and `auto_update` are therefore not settable per launch: the documented places are the user config and the project's `.devin/config.json` / `.devin/config.local.json` (docs: configuration, hooks).
- **Self-update.** `auto_update` (user config only, default `true`) downloads new releases in the background and switches `_versions/current`; the docs say a running session is unaffected and the swap takes effect on the next launch. Not observed. The driver leaves the user's setting alone, so a new TUI can arrive between launches without the owner upgrading.
- **Process model.** By default here the TUI starts `devin acp --process-model=in-process` as its child, inside the pane. The user config can select a shared background daemon instead, so the driver passes `--process-model in-process` explicitly.
- **Screen.** Inline renderer (earlier turns stay in tmux history). From the bottom: footer (`SWE-2 Flash Medium · bypass` plus hints, or `Press Ctrl+C again to exit.`), a plain rule, the composer `❭ …` at column 0, a top rule that may carry the session title at its right (`──── Complete task described in task2.md ─`), then while working a status line `⢀⡄ Running tools · 6s (esc twice to interrupt)` (also `Thinking`). The empty composer reads `❭ Ask Devin to build features, fix bugs, or work on your code`, and `❭ Guide Devin while it works` during a turn. A submitted turn is echoed as `❭ <text>` at column 0 with wrapped lines indented two spaces; the agent's reply follows a blank line, indented one space; tool rows read ` ✓ …`, ` ⏺ …`, ` ✗ …`.
- **Submission.** Text typed with `send-keys -l` followed by Enter in the same instant stayed in the composer (the Enter joined the paste); with the 250 ms pause `Tmux.sendKeys` already uses, Enter submitted every time (5 of 5).
- **Sentinel.** Rendered alone on its line with one leading space (` [AHELPA:DONE]`) at 80 and 160 columns. With ahelpa's full task line, SWE-2 Flash printed it (2 of 2). With a short ad-hoc prompt it finished without it, although its reasoning said it should print it (transcript, 1 of 1), so the idle fallback and nudge matter more here than for larger models.
- **Question tool.** `ask_user_question` replaces the composer with a dialog: `── Color ───`, the question, indented options (`  ❭ 1 red`), footer `↑↓ select · ↵ confirm · ? help me out · esc cancel`. No status line. The driver reads it as idle with no composer, so the session ends in `needs_attention` after the fallback.
- **Interrupt.** One `C-c` with an empty composer during a turn printed ` ✱ Canceled. What should Devin do?`, killed the running `sleep 61`, and kept the session. Esc needs two presses within three seconds. On an idle composer one `C-c` only prints `Press Ctrl+C again to exit.`.
- **Kill.** Each tool runs in a session of its own (`setsid`: `Ss`, no tty, stdin `/dev/null`). `tmux kill-session` during `sleep 93` ended `devin` and `devin acp`, but `sleep` survived, reparented to launchd. Ignoring SIGHUP did not help: devin still exited and left `sleep 95`. SIGTERM to the TUI ended `devin`, `devin acp` and `sleep 94`. ahelpa's `kill` only ends the tmux session, so the documented way to kill mid-turn is `interrupt`, then `kill`; the closure gate checks that path.
- **Exit and resume.** Typing `/exit` opens the slash-command menu with `/exit` highlighted (the user's skills follow it); the Enter that `Tmux.sendKeys` sends 250 ms later runs it. `/exit` quits without confirmation and prints ` devin -r maddening-trawler` and ` resumes this session · devin -r lists recent sessions`. The session name is not on screen earlier. `devin -r <name>` redraws earlier turns, including their old signals, and keeps the model. An unknown name opens a new, empty conversation without any message, so the driver requires an earlier turn on screen after a resume.
- **Models.** `devin models` (2026-11-19, Free plan) lists `swe-2-flash-medium` as `[262K context, Free]`. `--model swe-2-flash-high` exits at once with `Error: Upgrade to Pro to access this model (https://devin.ai/pricing)`; an unknown ID exits with `Error: Unknown model: '<id>'` and the family list. Model IDs carry the effort (`claude-opus-5-5-high`), some with a speed tier (`-fast`, `-priority`, `-lightning`). The startup banner shows `Free plan, use /upgrade to access better models · 100% remaining (resets in 7h 55m)`, so the Free plan has a usage window.
- **Latency.** Over 11 one-line turns in the closure gate and the timing runs, 9 finished in seconds; one took about 6.6 min, and one wrote its correct `summary.md`, then stayed on `⡆⠀ Thinking · 8m 20s (esc twice to interrupt)` until the gate's 500 s wait gave up. The driver read both as working, which is the rule for a working screen. Whether the Free plan throttles is unknown.
- **Offer.** Cognition's post `cognition.com/blog/swe-2-flash` (2026-11-04) says "Free through 11/30" next to "Try it today in Devin Desktop and CLI".
- **Terms.** The platform terms and acceptable use policy (read 2026-11-19) do not address scripted use of the CLI; the AUP's agentic-use clauses ask for human oversight before irreversible production actions.
- **Version for doctor.** The installer path carries the version (`_versions/3000.14.30821/bin/devin`); doctor reads it from the resolved path and never runs the binary. Credentials are stored in `~/.local/share/devin/credentials.toml`; doctor checks only that the file exists.

## Grid

| | `devin` |
| --- | --- |
| Shape | TUI, no hook |
| Resume token | After exit only: `devin -r <name>` on the exit screen (captured while draining); an unknown name opens a new conversation, which resume refuses |
| Turn-end signal | None; sentinel after the latest task echo with no status line, else inactivity |
| `--safe` means | Refused |
| Trust persisted | No: `--respect-workspace-trust false` for this run only |
| Self-update | Not suppressed (user config only); documented to take effect on the next launch |
| Model / effort | `--model <family>-<effort>`; default `swe-2-flash` / `medium`; a suffixed ID needs a matching `--effort`; no runtime switch |
| Last verified upstream | 3000.14.30821 (2026-11-19) |

## Unverified

- Self-update during a live session (documented as next-launch only; not observed).
- What a turn shows when the Free plan's usage window is used up, or when the model API fails mid-turn.
- Permission prompts in `dangerous` mode for MCP servers or team-admin `ask` rules (none appeared; the account has no team rules).
- A lower-permission posture: `--sandbox` with `--permission-mode autonomous` exists but was not tested, including whether it can write a result directory outside the workspace.
- Linux.

## Why this verdict

It passes every hard gate: its own TUI runs in tmux and takes keystrokes, several turns run in one session, trust and permissions are per-launch flags, the task file and result directory are reachable, the sentinel survives rendering, and self-update is documented to wait for the next launch. The owner asked for it because SWE-2 Flash is free on the Free plan, which gives a no-cost helper for small, well-specified work. The kill gap is a vendor behavior; the driver documents the interrupt-first path instead of managing processes itself ([why](../backends.md#why-a-terminal-not-a-bridge)).

## History

- 2026-11-19: spiked and integrated on 3000.14.30821. The live gate scenario passed in 30 s on a source build: first task, resume with the remembered marker, then `sleep 120` interrupted and killed with none of the 11 recorded processes left (the pane shell, `devin`, `devin acp`, the user's MCP servers and `sleep`). The native name (`artistic-learning`) stayed the same across both resumes. Startup timing over 3 runs (median, range): `launch` 1.8 s (1.4–1.9), `summary.md` 6.2 s (5.5–6.5), `wait` 9.3 s (8.1–9.3).
- 2026-11-19: the owner kept the GitHub connection the setup wizard made through the `gh` CLI (see `--config` above), and set `devin` as a low-priority option.
- 2026-11-19, after two review rounds (a dead TUI's frame read as live; a draft read as the empty composer; that frame's draft read as a signal), all fixed with tests. `AHELPA_GATE_DEVIN=1 bun run closure:gate`: tests, typecheck, build, `claude` and `codex` passed; the `devin` scenario failed once because the resumed turn sat on `Thinking` past the 500 s wait (see Latency). Two more runs of the `devin` scenario on the final build passed (28 s and 420 s, the second with a 6.6 min first turn).
