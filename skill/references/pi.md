# Pi

Public name: `deepseek-pi`. The `pi` nickname uses the same profile and prefix.

The `deepseek-pi` type is the official DeepSeek API backup for the subscription-first `deepseek` route (see [names](names.md)). Install `@earendil-works/pi-coding-agent` ≥ 1.4.0 and Node.js. Configure DeepSeek in CC-Switch and sync it to Pi so provider `cc-switch-deep-seek` exists. Version 1.4.0 is the tested baseline; newer releases are accepted, older releases are refused with an upgrade message. `ahelpa doctor deepseek-pi` checks installed metadata without executing the CLI or reading credentials; authentication remains unknown until launch.

```bash
ahelpa launch deepseek-pi --file ./task.md --project /path/to/project
ahelpa launch deepseek-pi --role reviewer --file ./review.md
```

`worker` is the default role; `reviewer` applies the read-only review contract. Both default to `cc-switch-deep-seek/deepseek-flash` / `high`; `advisor` is unsupported. These defaults also apply when launching with the `pi` nickname. To select explicitly, pass `--model provider/id` and `--effort <level>`; thinking levels depend on the selected model. The bridge verifies the actual provider, model, and thinking level before accepting a task, rejecting silent clamps. Runtime `ahelpa model`, including `--persist`, is unsupported; launch with the desired options instead.

`pi` is a nickname for `deepseek-pi` and the stable stored harness ID. Existing sessions resolve without a database migration; resume keeps their recorded model and effort. New session IDs start with `deepseek-pi-`.

## Permissions and resources

The bridge starts Pi in RPC mode with `--approve --no-extensions --no-mcp --offline`. Skills and context files remain enabled. Tools run with the local user’s permissions; `--offline` does not disable provider model requests. Launch and resume reject `--safe`. Extension UI select/confirm/input/editor requests are cancelled, work stops, and the turn requires attention; they are never auto-approved.

## Turns and controls

One native child persists while the bridge is alive. Normal input lines form a local FIFO and run one at a time; queued tasks do not expose intermediate idle states. Completion follows native settlement across retries and compaction and requires the current assistant’s DONE signal. NEED_HELP, aborts, and missing completion signals require attention; failures cannot reuse a prior DONE.

Send `/abort` through `ahelpa send <id> --token <token> /abort` to discard queued tasks and interrupt the active turn. `/exit` stops admission and closes the child with bounded termination. Normal successful completion still lets the daemon reclaim the terminal. A protocol failure or unexpected child exit leaves a fatal input loop that discards tasks; only `/exit` ends it. Relaunch or resume after resolving the fault.

## Persistence and takeover

The bridge explicitly uses Pi’s native per-project session directory beneath `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/`, using Pi’s physical cwd encoding after resolving symlinks and `/tmp` aliases. The agent directory follows Pi’s absolute/relative path, `~`, `~/…`, and `file://` expansion rules. Resume requires exactly one filename ending in `_<uuid>.jsonl` with a valid matching session header, then checks the RPC session ID. Missing, ambiguous, or malformed history fails without creating a replacement session.

Before spawn, ahelpa takes the atomic `.ahelpa-<uuid>.lock` in that session directory. It releases the lock only after the Pi child closes and recorded descendants are stopped. HUP, TERM, INT, and pane hangup use bounded TERM/KILL cleanup of Pi and tool process groups; hangup avoids terminal I/O and RPC waits. Direct SIGKILL of the bridge cannot run cleanup: a stale lock remains and Pi or detached tools may survive. Inspect and stop them before removing the lock. A leftover lock fails closed and reports its path; inspect whether a writer remains before removing it manually. There is no automatic PID-liveness takeover. This lock coordinates ahelpa bridges only: native Pi does not honor it. Run `pi -r` in the same project only after the helper and its child have exited.

Child stderr and RPC, retry, compaction, and extension errors are reduced to fixed categories; raw error fields and model/state objects are not printed. Native session transcripts still contain conversation data. Do not copy credentials or transcripts into shared diagnostics.

## Verification

`AHELPA_GATE_PI=1 bun run closure:gate` opts into model calls and checks completion, native resume/context continuity, and process-tree/lock cleanup using pre-kill PID snapshots and delivery `pi-process.json` metadata. It uses `cc-switch-deep-seek/deepseek-flash` / `high` unless `AHELPA_GATE_PI_MODEL=provider/id` or `AHELPA_GATE_PI_EFFORT=<level>` is set. Pi’s native session directory is separate from the gate’s disposable ahelpa state. The gate checks integration only; task-selection observations are recorded in [profiles](profiles.md#deepseek-pi).
