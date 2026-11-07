# Helper backends: what to integrate, how to judge it, how to wire it

[English](backends.md) | [简体中文](zh-CN/backends.md)

This page answers three questions about adding an agent to ahelpa as a helper: **what fits**, **how to decide**, and **roughly how it is wired**. It ends with a registry of every candidate already evaluated. Written 2026-11-06 against ahelpa 0.10.0.

Before researching or proposing a new backend:

1. Look the candidate up in the [registry](#candidate-registry). If it has a card, read the card first; a verdict from the last few weeks usually stands.
2. Do the five-minute checks in [funnel step 2](#the-admission-funnel) before reading any of its code. The decisive fact (can a personal account still sign in?) is cheap to find and expensive to find late.
3. Whatever you decide, record it in the registry, accepted or not.

Principles on this page are meant to last. Candidate cards under [`docs/backends/`](backends/) are dated evidence records, written in English only, and they expire.

## Positioning

ahelpa is the CLI one host agent uses to hand work to another agent. Three properties define it:

- **Persistent.** A helper is a tmux session plus a SQLite row. It outlives the caller, and `wait`, `check`, `send`, `resume` work from any later process.
- **Local.** No server, no account, no network service. State is SQLite, tmux, and named pipes on the machine ([architecture](architecture.md)).
- **File handoff.** The task goes in as a file; the result comes back as `summary.md` plus `artifacts/`; a sentinel line (`[AHELPA:DONE]` / `[AHELPA:NEED_HELP]`) says the turn is over. The host agent stays the conductor and decides whether to ship, using the evidence ahelpa collects.

It serves two of the three relationships a harness draws between agents: *subagent* (launch, wait, one report) and *teammate* (persistent, addressable, bounded peer mail inside a job). A *colleague* (another session nobody in the job launched) is visible in `status`, never controllable, and anything it says is information to weigh, not an instruction.

ahelpa is **not**:

- an orchestrator or workflow engine (the host LLM orchestrates; see [rejected designs](#rejected-designs));
- a model gateway (drivers pass `--model`; providers and keys stay in the upstream CLI's own configuration);
- a sandbox (`--safe` is a lower-permission posture where the upstream has one, not a security boundary; see [security](security.md));
- a chat workspace with a shared transcript, or an MCP server.

Sources: `README.md`, `docs/architecture.md`, `CONTEXT.md`, and the design proposal at `git show b87fe45:docs/proposals/2026-10-08-orchestration-lessons-clawwork-confer.md` (§6 declined designs, §9 positioning).

## Classify first

Most candidates end here. Put the candidate in exactly one row before anything else. Only the first row produces a driver.

| Layer | What it is | Outcome | Examples |
| --- | --- | --- | --- |
| **Helper backend** | An agent harness that does the work itself: reads files, edits, runs commands, talks to a model. | Driver candidate. Continue to the funnel. | `claude-code`, `codex`, `kimi`, `pi`, `agy`, `vibe`, `dsh`; candidate OpenCode |
| **Host target** | The agent that *calls* ahelpa. It corresponds to a skill installation target, not a driver. The same agent can be both a host target and a helper backend. | Skill-install question, not a driver question. | Skill targets `codex`, `claude-code`, `kimi-code-cli` (all three are also helper backends) |
| **Model / gateway layer** | Sits below a driver: a provider endpoint, router, key broker, or a stateless model CLI. | It is configuration of an existing driver, never a new driver. | Magpie (DSH's route), Kimi's `config.toml` providers, Pi's `provider/id` models, `gemini-api` |
| **Peer runtime** | An orchestration or management tool at the same layer as ahelpa. | **Reference, not rejection.** Learn from it, consider interop if useful, write no driver. | Raft, mngr, oar |
| **Wrapper / bridge** | A plugin or bridge someone built around a specific agent. | Evaluate the agent underneath, not the wrapper. | `dsh-raft-channel`, `raft-acp-bridge`, mngr's `mngr_antigravity` plugin |

Two checks resolve most disputes. *Does it do the work itself, or does it run other agents that do?* If the latter it is a peer runtime. *Would it sit below an existing driver, supplying models?* If so it is a gateway.

## The admission funnel

Cheapest checks first. Stop at the first failure and record where it stopped. Every gate carries a **because**, tied to an ahelpa primitive, so a later reader can tell when the gate no longer applies after the architecture changes.

### Step 1: Classification

Wrong layer → stop. Record the right layer in the registry.

### Step 2: Lifecycle and eligibility (five minutes, no code reading)

| Check | Because |
| --- | --- |
| Is the upstream still maintained (latest release, activity, announced deprecations)? | A driver tracks a moving TUI or protocol; an abandoned upstream makes it dead weight. |
| **Can the account type you will actually use still authenticate?** Read the upstream README banner and latest announcements, search for "individual accounts no longer supported/discontinued", and if possible attempt a sign-in with that account type on a scratch home directory. | Helpers run unattended on the user's own subscriptions. Code that is correct against a stub cannot prove the service still accepts the account (one third-party dispatcher's own AI-drafted issue says its first real Gemini CLI sign-in failed four months after the personal-account route closed, because every earlier check ran against source or a stub; a lead, see the [Gemini CLI card](backends/gemini-cli.md)). |
| Do the terms allow automated driving of the vendor's **official CLI**? (Not a third-party client or token proxy.) | ahelpa types into the real CLI in tmux; if the terms forbid automated use the integration is a liability for every user. |
| Does it run on macOS and Linux (x64, arm64)? | The runtime and installer support exactly those platforms. |

### Step 3: Hard gates

Each gate is a primitive ahelpa cannot work without. Failing one means no driver, or defer until upstream changes.

| Gate | Because |
| --- | --- |
| **The process can live in tmux, or can be bridged into it.** | A session is a tmux session; the daemon captures its pane, `send-keys` delivers input, and `tmux attach` is the human escape hatch. |
| **Several turns in one session, or native resume.** | `send`/`task` deliver follow-ups into a live pane and `resume` rebuilds a settled session from a native token. Without either, a helper degrades to process-per-delivery, which is [declined](#rejected-designs). |
| **Unattended operation without editing global configuration** (proposal item A6). | Launch must not rewrite files such as the user's CLI settings: the blast radius would reach all of their own sessions. Hooks, permissions, and trust must be reachable by a launch flag, an environment variable, or a per-session file. Where trust must be persisted, it is a documented exception ([security](security.md)), not a default. |
| **Can read the task file, write the result directory, and print the sentinel.** | File handoff plus the sentinel are the only completion contract; ahelpa prefers files over parsing terminal output. |
| **Self-update cannot interrupt a running session.** Either a switch turns it off, or it provably waits for the next launch, or the driver can dismiss its dialog. | An update that replaces the binary or draws a blocking dialog mid-session breaks readiness detection and kills the persistent helper. The drivers in tree meet this three different ways (see the matrix); a background updater that replaces the binary is the worst case and must have a kill switch. |

### Step 4: Soft capabilities (decide the tier, not admission)

| Capability | Because |
| --- | --- |
| **Structured turn-end signal and input ownership** (a hook, notify command, or RPC event). | Without it the daemon infers turn end from inactivity; 47 of 63 archived Claude `needs_attention` sessions had already written their summary without printing the sentinel (proposal A6). |
| `--model` and `--effort` flags. | `launch --model/--effort` and the role presets set them. Without them the helper uses its native defaults; that is allowed. |
| A lower-permission posture (`--safe`). | `--safe` is promised "where supported". Where the upstream has none, the driver must **refuse** the flag, as Pi and DSH do, rather than ignore it. |
| Session-scoped trust. | Persistent trust writes state outside the session (Codex and Kimi do, documented in [security](security.md)). Session-scoped trust avoids that. |
| Runtime model switching. | `ahelpa model` drives a running helper. Optional. |

Passing the funnel answers **can** it be integrated, not **should** it be. The second question is the owner's: which need does this cover that an existing driver does not? A second provider-neutral open harness next to Pi, for example, needs a reason beyond "it works".

## Three ways to wire one in

The shapes below come from the code in `src/drivers/`. Pick by what the upstream offers.

| Shape | Drivers | How it works | Choose it when | Cost |
| --- | --- | --- | --- | --- |
| **TUI scrape plus hook** | `claude-code`, `codex`, `kimi` | The driver launches the vendor's own TUI in tmux, types with `send-keys`, and reads state from pane captures. Where the upstream accepts a per-invocation hook, the driver registers a session-local one that appends to `.ahelpa/<id>/turns.log` through the hidden `__turn-hook` command (Claude: `--settings` file; Codex: `-c notify=[...]`). Kimi has no hook and relies on inactivity heuristics. | The TUI is stable, a per-session hook exists, and you want the human to be able to attach to the real UI. | Every dialog is a screen-scraping case: trust prompts, update menus, model pickers, capacity stops (`codex.ts` handles several). Upstream UI changes break detection. |
| **Structured bridge in tmux** | `pi`, `agy`, `vibe` | A small bridge process runs inside tmux, speaks the upstream's structured mode, and presents ahelpa a plain line protocol (input lines queue, `/exit`, the sentinel; Pi also supports `/abort`). Settlement comes from structured events or child exit, not the screen. | The upstream is a closed-source or fast-moving TUI **and** offers a stable structured mode with turn settlement and native session ids. Prefer this over scraping. | You own a bridge: process-tree cleanup, locks against concurrent writers, refusing or cancelling approval requests you cannot answer. |
| **In-process app** | `dsh` | The upstream is a framework without a usable terminal UI. The driver generates a terminal app that the upstream loads through its patch or plugin overlay and drives its public Agent/Session APIs directly, keeping one process across turns. | The upstream is embeddable, exposes public APIs, and has no TUI worth scraping. | Most coupled to upstream internals; pinned to a release candidate. |

Tie-breakers: hook available and TUI stable → scrape plus hook. Structured mode available and TUI volatile → bridge. No TUI but a public in-process API → in-process app. The choice is made during the [spike](#spike-checklist), not before it.

Vibe uses this bridge shape with one headless child per turn: the bridge and native session persist, and every later child resumes that session. Child exit settles the turn; the driver does not depend on an RPC result event.

## The minimum acceptable driver

The floor is the [hard gates](#step-3-hard-gates) plus the 15 required members of `AgentDriver` (`src/drivers/types.ts`): `name`, `sessionPrefix`, `modelCatalog`, `resumeTokenAvailableAfterSubmit`, `buildLaunchCommand`, `buildResumeCommand`, `extractResumeToken`, `prepareForTask`, `prepareForResume`, `afterTaskSubmitted`, `switchModel`, `detectStatus`, `detectOutcome`, `detectActivity`, `gracefulExit`. The other seven (`turnHooks`, `prepareLaunchFiles`, `launchProfiles`, `checkReadiness`, `acceptsInput`, `acceptsInputAfterTurn`, `workingAfterTurn`) are optional.

The evidence that this floor is real is `kimi`: no turn hook, no `--effort`, no runtime model switch, and still a fully supported driver. Pi and DSH go further and refuse `--safe`. So answer two questions separately:

- **Can it be integrated?** The hard gates.
- **At which tier?** Floor (gates only) → plus a structured turn-end signal → plus model/effort, a safe posture, and runtime switching. A missing soft capability lowers the tier; it never blocks admission.

## Driver capability matrix

Hand-written from `src/drivers/*.ts` and `skill/references/*.md` on 2026-11-06. The same columns are the scoring grid for a new candidate: a card's "Grid" section fills them in.

| | `claude-code` | `codex` | `kimi` | `pi` | `dsh` (retired from default) | `agy` | `vibe` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shape | TUI + hook | TUI + hook | TUI, no hook | RPC bridge | In-process app | stream-json bridge (like `pi`) | Per-turn streaming child, persistent bridge |
| Resume token (`resumeTokenAvailableAfterSubmit`) | After exit only (captured while draining) | After exit only (captured while draining) | Right after the first submit (native `session_*` id) | Right after the first submit (native UUID) | Right after the first submit | Right after the first submit (conversation UUID from the `init` event, before the first message); the bridge fails a resume whose id agy does not know | sessionId from first event of first turn; `--resume`; unknown id fails |
| Turn-end signal | Hooks via `--settings` session file: `UserPromptSubmit`, `Stop`, `StopFailure` | Per-invocation `-c notify=[...]` override (`agent-turn-complete`) | None; inactivity heuristics plus sentinel | Native settlement events over RPC | In-app state markers | One stream-json `result` event per turn (`status`, `finished_reason`) | Child exit code + assistant-text sentinel |
| `--safe` means | Omits `--dangerously-skip-permissions`; native approvals remain; `--add-dir` for a result dir outside the project | `-s workspace-write -a never` (+ `--add-dir`) | `--yolo` instead of `--auto` (risky actions still ask); not a sandbox | Refused | Refused | Refused | Refused |
| Trust persisted | Not managed by the driver; the user must run `claude` in the project once or launch fails fast | Yes: answering "Folder access" (0.163+) writes the repository root as trusted in Codex's config; the hooks-trust prompt is declined with Escape | Yes: "Trust and continue" is selected in both modes and persisted by Kimi | No trust prompt; bridge passes `--approve --no-extensions --no-mcp --offline` | No trust prompt; `DSH_PERMISSION_MODE=danger-full-access` | No trust prompt in print mode; nothing persisted | `--trust` for invocation only; not persisted |
| Self-update | Not suppressed by the driver (upstream behavior not verified here) | Update dialog dismissed with "Skip"; not suppressed | `KIMI_CODE_NO_AUTO_UPDATE=1` | Not set by the driver (`--offline` is passed; its effect on update checks is not documented in tree) | Not controlled by the driver; telemetry off with `DSH_TELEMETRY_DISABLED=1` | `AGY_CLI_DISABLE_AUTO_UPDATE=true` (1.5.2 honours only lowercase `true`; `1` still starts the updater) | `VIBE_ENABLE_AUTO_UPDATE=false`, `VIBE_ENABLE_UPDATE_CHECKS=false` |
| Model / effort | `--model`, `--effort` at launch; runtime switch via the model menu | `--model`, `-c model_reasoning_effort=`; runtime switch via the model menu | `--model <config.toml alias>` only; no effort; no runtime switch | `--model provider/id`, `--effort`, verified at startup; no runtime switch | `--model [provider:]model`, `--effort off\|low\|high\|max`; no runtime switch | Default `--model gemini-4-argon --effort medium`; a suffixed id (`gemini-4-argon-high`) needs a matching `--effort`; no runtime switch | Session agent TOML: default `mistral-large-4-0-3` / `high`; no runtime switch |
| Last verified upstream | No pin recorded; `doctor` reports the installed version | 0.163+ (Folder access); capacity phrase seen on 0.154; update dialog formats ≤0.15x and 0.160 | Kimi Code 2.x (`--auto` needs it) | ≥ 1.4.0, tested 1.4.0; 1.5.0 seen 2026-11-06 | `@deepseek-ai/dsh@0.2.1-rc.2`; rc.5 seen in the 2026-10-30 comparison | Tested 1.5.2 (2026-11-06) | Tested 3.1.0 (2026-11-06) |

ponytail: hand-written, so it will drift from the code; generate it from `AgentDriver` when drift actually causes trouble.

## Spike checklist

Run this against any candidate that cleared funnel steps 1-2, in a scratch directory and a scratch home. These are the seven questions asked of agy, generalized. Record each answer with the command, the upstream version, and the date.

> Side effects first: running an agent binary can change the machine. agy's background updater can replace the installed binary even when you only run `agy models` (reported on 1.1.22 by a third party; on 1.5.2 a run with the switch set to `1` still started the updater, since only lowercase `true` works). Prefer `--help` and `--version`, and set the update kill switch before running anything else.

1. **Login and first-run onboarding in tmux.** Can sign-in be completed inside a pane? Where is the credential stored (file or system keyring; a headless user may lack a keyring)? Which account type works? What first-run screens (themes, tips, trust, telemetry consent) appear, and does each have a key that dismisses it?
2. **Self-update.** What triggers it (foreground check or detached background updater), what does it replace, and what disables it (flag, env var, config)? Can the version be pinned?
3. **Resume id.** When is it generated (launch, first submit, exit), where is it read from (pane, file, API), and can it be assigned in advance? Does resume compose with the posture, model, and effort flags?
4. **What prompts remain after skip-permissions.** With the upstream's skip/approve-all flag on, which dialogs still appear (folder trust, hooks trust, MCP approval, tool-specific "dangerous" confirmations, update, onboarding), and which can be answered by keystrokes?
5. **Session-scoped hooks and settings.** Can hooks, permissions, and trust be registered for one session only (flag, environment variable, per-session file)? If the only route is a global file, the A6 gate fails. How does a session file merge with the user's own?
6. **Does the sentinel survive rendering?** Make the agent print `[AHELPA:DONE]` through the real TUI and capture it with `tmux capture-pane` at narrow and wide widths: wrapping, markdown rendering, panels, color codes, scrollback. Also check whether the agent echoes the task text (a quoted sentinel is a false positive).
7. **Structured mode.** Does the non-interactive or RPC mode (`-p`, stream-json, RPC, ACP) keep context across turns, combine with resume, report turn-end events, and say what it does with approval requests headlessly (deny by default?)?

The spike result decides the wiring shape and the tier, and goes into the candidate's card.

## After the spike

1. **Implement.** `src/drivers/<name>.ts`, registration in `src/drivers/registry.ts`, tests with synthetic pane fixtures, and every other place a driver is enumerated (see [Adding a driver](development.md#adding-a-driver)).
2. **Closure gate.** Add a scenario to `bun run closure:gate`. Metered or paid backends run only when an `AHELPA_GATE_<NAME>=1` switch is set. The gate must show `wait`/`check` observing state and `kill` reclaiming the session; where the driver supports resume, also native resume with context continuity.
3. **Onboarding observation.** A dated record of what was run and what it established. [`dsh-onboarding.md`](dsh-onboarding.md) is the model: configuration and evidence boundary, observed working style, provisional delegation choices, an acceptance table that says what each exercise does **not** establish.
4. **Profile.** Add the helper to `skill/references/profiles.md` (best at / watch for / give it / runtime quirks, plus an observation status) and a `skill/references/<name>.md` setup page. Default-dispatch decisions follow the profile, not the other way around.

### Retiring a backend

Retirement is a documentation change, not a deletion. The precedent is DSH on 2026-11-06: a same-condition comparison (2026-10-30) and a short review of real use supported replacing it with Pi for default dispatch. The change was text only: `skill/references/profiles.md` (`## dsh`) now says the helper is retired from default dispatch, the install and driver stay, and a named launch still works for comparison or rollback. Deleting a driver would be a separate, larger decision. Update the registry row the same day.

## Rejected designs

These came out of the 2026-10-08 design proposal (ahelpa v0.9.0, §6) and still hold. They are listed here so a grep finds them. Read the reason before proposing one again.

| Design | Why it stays out |
| --- | --- |
| **An MCP server surface** | Hosts already shell out and the skill docs drive usage; `wait` can block for several minutes, which fits a CLI call. An MCP surface costs schema refresh and argument migration on every upgrade across every host. If one is ever wanted, generate it from `src/command-contract.ts` as a thin wrapper, never as a second contract. |
| **A workflow engine or team-file runner** | The host LLM is the conductor and must stay the one that reads evidence and decides to ship. A conductor that only summarizes performer claims is not enough: archived self-reports and independent reviews disagreed too often. Task-file templates are the zero-runtime alternative. |
| **Full permission as the only posture** | A tool that always runs with full permission never blocks, at the price of no lower posture. ahelpa launches with full local permissions by default (stated plainly in [security](security.md)), but keeps `--safe` wherever the upstream has a lower posture, and a driver without one refuses the flag. |
| **One process per delivery, no persistence** | It removes the daemon at the price of losing everything in flight. tmux plus SQLite means no in-flight work is lost when any ahelpa process dies. |
| **A shared transcript or an unbounded agent-to-agent loop** | Only the host relays. `--after` stays a host-chosen pointer to files. The bounded alternative is job-scoped, budgeted, file-based peer mail, which grants no control and cannot reassign work. |
| **ACP as the transport** | Wrong bet for four reasons: (1) Confer, the MCP tool that runs nine agents, does not depend on ACP for Claude or Codex either: it uses in-process bridges to the vendors' own official interfaces; (2) there is no first-party ACP for Claude Code or Codex, only their own structured interfaces, and a third-party adapter lags a fast-moving CLI; (3) CLI-only features are lost (slash commands, model menus, approval and trust dialogs, plugin triggers, `tmux attach`); (4) ACP is a stdio session, so whatever holds the client end becomes the process whose death loses the session, while ahelpa's design exists to have no such process. The incremental step that captured most of the value is the structured turn-end hook. This does not forbid a per-upstream [bridge](#three-ways-to-wire-one-in) over that upstream's own structured mode; judge each upstream on its own merits. |

## Evidence rules

Principles last; cards expire. Keep them apart: principles live on this page, dated facts live in cards and the registry.

- **Source priority.** (1) The local binary: `--help`, `--version`, changelog, embedded docs, and where harmless its strings. (2) The official repository and its changelog. (3) Official documentation. (4) Third-party writing. Web "migration guides" sometimes contain commands that do not exist, and an AI-drafted issue in someone else's repository is a lead, not evidence; label such facts as third-party.
- **Date and version every fact.** Write `(2026-11-06, agy 1.5.2, local --help)`, not "agy supports X". Upstream CLIs change weekly.
- **Unverified means unverified.** If you did not check it, write `Unverified` and say what you tried. Never fill a gap with a plausible guess.
- **Mind the side effects of checking.** See the note above the spike checklist.
- **Say where a verdict stopped.** The registry records the funnel step, so a later reader knows which facts were never examined.

### Card format

Cards live in `docs/backends/<name>.md`, English only (an exception to the bilingual rule in `AGENTS.md`: they are dated agent-facing evidence, not a user guide). Each card must answer on its own: what it is, which layer, which funnel step it stopped at, the verdict, and when to re-evaluate. Headings, in order: header lines (Evaluated, Class, Verdict, Stopped at, Version seen, Re-evaluate when), What it is, Facts (dated, sourced), Grid (the matrix columns), Unverified, Why this verdict, History. Update a card in place when you re-evaluate, add a History line, and update its registry row.

## Candidate registry

Updated 2026-11-06. "Stopped at" is the last funnel step the candidate was examined at; a step marked docs-only was read in upstream documentation and not run.

| Candidate | Layer | Status | Stopped at | Card |
| --- | --- | --- | --- | --- |
| `claude-code` | Helper backend; also host target | Integrated | n/a | `skill/references/claude-code.md`, [profiles](../skill/references/profiles.md) |
| `codex` | Helper backend; also host target | Integrated | n/a | `skill/references/codex.md`, [profiles](../skill/references/profiles.md) |
| `kimi` | Helper backend; also host target | Integrated | n/a | `skill/references/kimi.md`, [profiles](../skill/references/profiles.md) |
| `pi` | Helper backend | Integrated; default for work that would have gone to DSH (trial from 2026-10-30) | n/a | `skill/references/pi.md`, [profiles](../skill/references/profiles.md) |
| `dsh` | Helper backend | Retired from default dispatch (2026-11-06); install and driver kept; named launches still work | n/a | [profiles](../skill/references/profiles.md), [onboarding](dsh-onboarding.md) |
| Gemini CLI | Helper backend | **Declined (2026-11-06)**: personal accounts are no longer served | Step 2 | [gemini-cli](backends/gemini-cli.md) |
| `agy` (Antigravity CLI) | Helper backend | Integrated (2026-11-06) through a stream-json bridge; default `gemini-4-argon` / `medium` | n/a | [agy](backends/agy.md), `skill/references/agy.md` |
| `vibe` (Mistral Vibe CLI) | Helper backend | Integrated (2026-11-06); persistent bridge + native resume; default `mistral-large-4-0-3` / `high` | n/a | [vibe](backends/vibe.md), `skill/references/vibe.md` |
| OpenCode | Helper backend | **Candidate**: passes steps 1-2; steps 3-4 read from docs only, not spiked | Step 4, docs-only | [opencode](backends/opencode.md) |
| dimAgent | Helper backend (CLI) inside a wider product family | **Deferred (2026-11-06)**: two CLIs in flux, one still alpha | Step 2 | [dimagent](backends/dimagent.md) |
| Raft (formerly Slock) | Peer runtime | **Reference**; no driver | Step 1 | [raft](backends/raft.md) |
| mngr | Peer runtime | **Reference**; no driver | Step 1 | [mngr](backends/mngr.md) |
