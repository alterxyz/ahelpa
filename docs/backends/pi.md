# Candidate card: Pi (Pi Coding Agent)

English only: a dated evidence record for agents, not a user guide. Principles and funnel are in [Helper backends](../backends.md).

- **Evaluated:** 2026-11-07 (implementation session's local spike, macOS, tmux 3.7c)
- **Class:** Helper backend; host-target status unverified.
- **Verdict:** **Integrated, driven through its own TUI (2026-11-07).** Public name `deepseek-pi` (nickname `pi`, harness ID `pi`), the API backup for `deepseek`. Defaults: `cc-switch-deep-seek/deepseek-flash` / `high`. Replaces the RPC bridge (`pi --mode rpc`, 2026-10, commit 03598f7). Not in default dispatch.
- **Stopped at:** n/a; the spike met every runtime hard gate through the TUI. Soft tier: no `--safe`, no runtime model switch.
- **Version seen:** Pi 1.5.0 (`@earendil-works/pi-coding-agent`, npm global, Node.js 26). 1.4.0 is still accepted but its TUI was not exercised.
- **Re-evaluate when:** the fullscreen layout, the editor border spinner, the exit resume hint, `--session` lookup, or `--approve` change; a newer release breaks `AHELPA_GATE_PI=1`.

## What it is

Earendil's Pi is a terminal coding agent with read, bash, edit and write tools. ahelpa runs its interactive TUI in tmux, types tasks with `send-keys`, and reads the outcome from `capture-pane`, as for Claude Code, Codex and Kimi. No hook, extension or bridge process is involved.

## Facts

Measured 2026-11-07 on Pi 1.5.0/macOS with `cc-switch-deep-seek/deepseek-flash` / `high`, in a private tmux server.

- **Launch.** `pi --tui-mode fullscreen --offline --approve --no-extensions --no-mcp [--model p/id] [--thinking level]`. Fullscreen is Pi's default since before 1.4.0 and is passed explicitly so a user's `tuiMode` setting cannot change the screen. It uses the alternate screen: `capture-pane` returns the visible rows only (history 0). `--tui-mode regular` keeps scrollback and rendered the same transcript; fullscreen was kept as Pi's default and for its fixed layout.
- **Layout.** Transcript, padded one column; a blank row; the editor between two column-0 `─` borders; a two-line footer (cwd, then usage stats with `model • level` right-aligned). The empty ready composer is one blank row between the borders. Nothing else starts at column 0 while Pi runs. With tmux `extended-keys` off, Pi adds a one-line warning to the transcript at startup; Enter still submits.
- **Working.** A braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, 80 ms per frame) in the editor's top border: `── ⠼ Working ───`. Retry (`Retrying (n/m) in Ns...`) and compaction use the same spinner; at narrow widths only the spinner remains. During a 22 s turn with three bash calls and the model calls between them, all 76 captured frames showed it.
- **User messages have no text marker.** They are padded like assistant text; Pi marks them only with OSC 133 zone escapes and a theme background, neither of which plain `capture-pane` shows. The driver therefore treats a signal as current only when it is the transcript's last non-blank line and no spinner is shown. An older DONE sits above any newer user message.
- **Sentinels.** `[AHELPA:DONE]` rendered alone as ` [AHELPA:DONE]` at 40, 80, 100 and 220 columns. The ahelpa task line names both signals inline (`output [AHELPA:DONE] on its own line`); its echo never puts a signal alone on a line at these widths.
- **Model and thinking.** The footer shows what Pi applied: `deepseek-flash • high`, with `(provider) ` in front when there is room and several providers exist, `• thinking off` for off, and no level for non-reasoning models. `--thinking minimal` on `deepseek-flash` started silently with `deepseek-flash • high` (a clamp); `--thinking max` showed `• max`. An unknown model of a known provider printed `Warning: Model "x" not found for provider "p". Using custom model id.` and started; an unknown provider exited with `Error: Model "p/x" not found.` At 40 columns the footer had no room for the model.
- **Trust.** With a protected project resource (`.pi/settings.json`) and no flag, Pi shows `Trust project folder?` with options including `Trust (this session only)`. `--approve` skipped the dialog and wrote nothing to `~/.pi/agent/trust.json`.
- **Approvals.** Pi has none for built-in tools. Extension and MCP UI is disabled by flags.
- **Provider errors.** A bogus `--api-key` made the first turn print ` Error: 401: {"message":"Authentication Fails, …","type":"authentication_error",…}` (key masked by the provider), then ` If this looks like a pi bug, /bug sends a report to the developers.`, and return to the empty composer. The status code and provider text are on screen. Because a host chooses between retrying and the `deepseek` route from that code, the driver turns a transcript ending in ` Error: <status>: ` into `needs_attention` with the bridge's former whitelist as the reason (`provider overloaded (503|529)`, `rate limited (429)`, `authentication failed (401|403)`, otherwise `native turn failed`), never the provider text. The 503 `Service is too busy` seen on the bridge on 2026-11-07 was not reproduced on the TUI; its shape (`503: {…}`) comes from that session's log.
- **Interrupt.** Escape mid-tool printed `Command aborted`, then ` Error: This operation was aborted`, killed the tool's `sleep`, and returned to the empty composer in the same session.
- **Exit and resume ID.** `/quit` printed the transcript to the normal screen, the last frame, then `To resume this session: pi --session <uuid>` (`--session-dir <dir>` is added before it when sessions live elsewhere). Native IDs are UUIDv7 here; the bridge created v4 IDs with `--session-id`. The hint is printed only after the session file exists. `/session` also shows the ID but scrolls off a fullscreen screen.
- **Resume.** `pi --session <uuid>` in the project opened the session with its old transcript and an empty composer. Per `dist/main.js`: an exact local ID opens; a local prefix match also opens (so the driver accepts only full UUIDs); a match only in another project prints `Session found in different project` and asks `Fork this session into current directory? [y/N]`; no match exits with `No session found matching`. These lookups use the same per-project directory the bridge wrote, so bridge-era sessions resume without compat code.
- **Process tree.** Pi's process name is `pi`; a bash tool runs as `/bin/bash -c …` below it. `tmux kill-session` during a running `sleep 97` tool left neither `pi` nor `sleep` 3 s later.
- **Static screen while working.** Sampling `capture-pane` every 0.25 s through that 22 s turn, the longest stretch without any change was 0.55 s, the sampling resolution: the spinner redraws every 80 ms and tool rows show an `Elapsed Ns` timer. The model was waiting on the API for several of those seconds. Thinking blocks were hidden by the user's `hideThinkingBlock` setting; the spinner kept turning through them.

## Grid

| Column | Value |
| --- | --- |
| Shape | Vendor fullscreen TUI in tmux; screen only, no hooks |
| Resume token | Native UUID from the `/quit` hint, read by the daemon while draining; resume `pi --session <uuid>` |
| Turn-end signal | DONE/NEED_HELP as the transcript's last line with no spinner in the editor border |
| `--safe` means | Refused; Pi has no approval mode for built-in tools |
| Trust persisted | No; `--approve` trusts project files for this run only |
| Self-update | `--offline` skips startup update and catalog checks |
| Model / effort | `--model` / `--thinking`; footer checked at startup; default `cc-switch-deep-seek/deepseek-flash` / `high`; no runtime switch |
| Interrupt / exit | Escape keeps the session / `/quit` |
| Last verified upstream | 1.5.0, 2026-11-07 |

## Unverified

Pi 1.4.0's TUI, Linux, terminals other than tmux 3.7c with `extended-keys` off, regular TUI mode under ahelpa, and the model check at widths where the footer truncates (it is skipped when no `model • level` is visible). Whether a model's closing remark after DONE is common enough to cost a nudge in practice. A session that never reached DONE has no recorded resume ID; the host can still pick it with `pi -r`. Two concurrent resumes of the same dead session are no longer blocked by a lock, as for the other terminal helpers. Task quality on the TUI path has not been re-observed (see `skill/references/profiles.md#deepseek-pi`).

## Why this verdict

The owner decided on 2026-11-07 that every helper is operated like a person at a terminal; headless, print, RPC, stream-json and ACP bridges are out. Pi's TUI meets every runtime need from the screen alone: a stable working indicator, a fixed composer, a visible applied model and level, session-scoped trust by flag, an interrupt that keeps the session, and a resume hint with the native UUID. The bridge's extra guarantees map as follows. Its process-tree cleanup is Pi's own hangup handling, confirmed above. Its silent-clamp rejection is the footer check. Its lock coordinated only ahelpa bridges and is replaced by ahelpa's rule that a session cannot be resumed while its terminal lives. Its provider-error categories are read from Pi's own ` Error: <status>:` line and reported as the reason.

## History

- 2026-10: integrated as an opt-in RPC helper (`pi --mode rpc` under a Node bridge, commit 03598f7). No TUI comparison was recorded; the pattern was then followed by agy and Vibe.
- 2026-11-06: renamed `deepseek-pi` (nickname `pi`) as the API backup for `deepseek`; 20 launches and a four-task replay on the bridge (see the profile).
- 2026-11-07: spiked Pi 1.5.0's TUI in tmux (this card) and replaced the bridge with a screen-only driver; deleted `pi-terminal-source.ts`, its test and the session lock.
- 2026-11-07: `AHELPA_GATE_PI=1 bun run closure:gate` passed on macOS with Pi 1.5.0 and `cc-switch-deep-seek/deepseek-flash` / `high`: completion, the native UUID recorded 3 s after the daemon sent `/quit` (one poll), resume with the same UUID and the context marker recalled, and no process of the pane tree (recorded while Pi was live) left after each `kill`.
- 2026-11-07: `bash scripts/startup-bench.sh deepseek-pi`, 3 rounds, development build with private state: medians `launch` returned 1.9 s, wrote the result 4.9 s, `wait` returned 6.2 s (bridge baseline in `docs/performance.md`: 1.4 / 4.4 / 6.3). Launches took 1.8–1.9 s, below the 4.5 s startup reference.
