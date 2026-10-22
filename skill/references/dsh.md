# ahelpa on DeepSeek Harness

DSH is a new helper integration under observation. This adapter targets the official `@deepseek-ai/dsh@0.2.1-rc.2`; future CLI releases are unverified. There is no archive-based capability ranking or preferred task type yet.

## Installation and authentication

```bash
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
command -v dsh
ahelpa doctor dsh --project /path/to/project
```

DSH needs Node.js, pnpm for profile/plugin management, and the official native sandbox/PTY components for the host platform. Follow the [official installation guide](https://github.com/deepseek-ai/deepseek-harness) for those prerequisites. A global CLI install alone does not prove that every native tool dependency is ready.

Use the credentials already configured through `dsh web`, or provide `DEEPSEEK_API_KEY` in the launch environment. Keep keys out of task text and shell command arguments. ahelpa shares `DSH_HOME` (default `~/.dsh`) with DSH and preserves existing Desktop/Web profiles and credentials.

`doctor dsh` reads the executable's package version and checks only whether the API-key environment variable or stored credential file exists. It does not read credential contents, refresh a login, call the model, create the profile, or validate native tool dependencies. It reports authentication as `unknown`; DSH validates it at runtime. A missing executable or tmux is still a definite blocker.

## Profile and terminal app

The official CLI offers Web, headless, SDK, and ACP profiles without a built-in TUI. ahelpa creates `DSH_HOME/profiles/ahelpa` if absent, with a `package.json` selecting `@deepseek-ai/dsh-base` and an empty `cordis.patch.yml`. Existing files in that profile are not overwritten. No preliminary `dsh plugin` installation is required for this base-backed profile.

Each helper gets a generated Cordis terminal app (`dsh-terminal.mjs`) and `dsh.patch.yml` in its delivery directory. The driver runs:

```bash
dsh --profile ahelpa --patch <session-delivery-dir>/dsh.patch.yml
```

Start this through `ahelpa launch dsh`; `dsh --profile ahelpa` alone has only the base services and no terminal app. The generated app uses DSH's public Agent/Session APIs directly, keeping one DSH process and conversation across multiple turns. It does not use an ACP or SDK transport and does not install a third-party TUI.

The adapter disables the session-log contributor and OTel upload for these helper sessions. Provider model requests still occur normally. Other shared home-level DSH configuration continues to apply.

## Typical workflow

```bash
result=$(ahelpa launch dsh --task "Review the CLI parser" --project /path/to/project)
session_id=$(echo "$result" | jq -r .sessionId)
token=$(echo "$result" | jq -r .ownerToken)
ahelpa wait "$session_id"
cat "/path/to/project/.ahelpa/$session_id/summary.md"
```

Use `--file ./task.md` for long instructions. `task`, `send`, `wait`, `check`, `capture`, and `kill` follow the normal ahelpa workflow; `capture` is for debugging. In a linked worktree, use the main checkout's result directory as described in `SKILL.md`.

The default role is `worker`, with `deepseek-flash` and `high` effort. `--role reviewer` uses the same model/effort with ahelpa's review-only task contract; `advisor` is rejected. Explicit overrides are independent:

```bash
ahelpa models dsh
ahelpa launch dsh --model deepseek-flash --effort high --file ./task.md --project /path/to/project
```

`--model` takes native DeepSeek model IDs, whose availability depends on the account. The adapter currently requires DSH's `deepseek-official` provider. `--effort` accepts `off`, `low`, `high`, and `max`; Codex/Claude aliases and effort spellings are not translated.

## Permissions and limits

The terminal profile runs with full local permissions, consistent with ahelpa's default helper posture. `--project` chooses the workspace and is not a filesystem sandbox. DSH `--safe` fails explicitly on launch and resume because the native approval UI requires DSH Web. Runtime switching through `ahelpa model` is also unsupported; choose model and effort at launch.

## Native resume

ahelpa records DSH's native `session-...` ID and flushes native session persistence before reporting a settled result. Once the old helper's terminal has been reclaimed, resume it normally:

```bash
ahelpa resume "$session_id" --token "$token"
```

The returned helper has a new ahelpa session ID and owner token. Use them to send the next `task` or `send`, then `wait`. DSH reloads the original native session from the same `DSH_HOME`, preserving context and recorded model/effort. The original project directory must still match; subagent, forked, and agent-preset sessions are not adopted by this adapter.

Resume is rejected while the old terminal is draining. Wait until `check` reports `idle` and the terminal is gone, or explicitly `kill` it before resuming. `clean` removes the ahelpa record and resume metadata, so keep that record while it is still useful. Persistence reconnects the native conversation in a new process; it does not keep the original tmux process alive indefinitely.

## Troubleshooting

- Missing CLI or credentials: run `ahelpa doctor dsh`, then configure DSH Web authentication or the API-key environment variable. `unknown` is not proof of valid authentication.
- Startup or native-tool failure: inspect `logs` or use `capture` once for the last screen, then compare the installed DSH/native dependencies with the official installation guide.
- A native turn that ends without a completion signal becomes `needs_attention`; read its summary and evidence before deciding how to continue.
- For ahelpa development, `AHELPA_GATE_DSH=1 bun run closure:gate` opts into DSH launch/wait/check/kill and native resume-context checks.

Upstream references: [repository and installation](https://github.com/deepseek-ai/deepseek-harness), [CLI profiles and patch layering](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli).
