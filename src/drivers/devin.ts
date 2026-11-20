import { existsSync, realpathSync } from "fs";
import { join } from "path";
import { shellEscape } from "../shell";
import { addReadiness, executableReadiness, findReadinessExecutable, isVersion, readinessRuntime } from "./readiness";
import { scanSentinels } from "./sentinels";
import type { AgentDriver, DriverRuntime, LaunchOptions, ReadinessRuntime, ResumeOptions } from "./types";

export const DEVIN_TESTED_VERSION = "3000.14.30821";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// Devin model IDs carry their effort, sometimes followed by a speed tier
// ("claude-opus-5-5-high-fast", "gpt-6-2-astra-high-priority", "swe-2-high-lightning").
const SUFFIX = new RegExp(`-(${EFFORTS.join("|")})(?:-(?:fast|priority|lightning))?$`);

// Devin CLI's own TUI in tmux (3000.14.30821, 2026-11-19, at 80x24, 120x30 and
// 160x45). An inline renderer: earlier turns stay in scrollback, and the live
// region at the bottom is a status line, the composer between two rules (the
// top one may carry the session title at its right), then a footer.
const RULE = /^─{3,}/;
const BOTTOM_RULE = /^─{3,}\s*$/;
// The composer prompt sits at column 0; question-dialog options are indented ("  ❭ 1 red").
const PROMPT = /^❭/;
// The empty composer while no turn runs. A narrower pane may cut it short with "…"
// (unobserved; 80 columns show it whole); a draft that only starts the same way is a draft.
const PLACEHOLDER = "Ask Devin to build features, fix bugs, or work on your code";
// The live status line: "⢀⡄ Running tools · 6s (esc twice to interrupt)", also "Thinking".
const WORKING = /\(esc twice to interrupt\)\s*$/;
// A submitted turn: "❭ text" at column 0, wrapped lines indented by two spaces.
const USER_TURN = /^❭ \S.*(?:\n {2}\S.*)*/gm;
// devin prints one line and exits for a model it does not know or the plan excludes:
// "Error: Unknown model: 'x'", "Error: Upgrade to Pro to access this model (...)".
const START_ERROR = /^Error: (.+)$/m;
// Printed by /exit: " devin -r maddening-trawler", then " resumes this session · ...".
const EXIT_ID = /^\s*devin -r ([\w-]+)\s*$/gm;

// composer: its first line, and only when it is one line long.
interface Screen { transcript: string; composer: string | undefined; draft: boolean; working: boolean }

function parse(output: string): Screen {
  const lines = output.split("\n");
  let at = -1;
  for (let i = lines.length - 1; i > 0 && at < 0; i--) if (PROMPT.test(lines[i]) && RULE.test(lines[i - 1])) at = i;
  const end = at < 0 ? -1 : lines.findIndex((line, i) => i > at && BOTTOM_RULE.test(line));
  // The composer is live only with at most the footer below its bottom rule. Otherwise
  // this is a question or approval dialog, a setup screen, or the shell after devin
  // exited or died, which can leave its last frame above the prompt.
  if (end < 0 || lines.slice(end + 1).filter(line => line.trim()).length > 1) {
    return { transcript: output, composer: undefined, draft: false, working: false };
  }
  const above = lines.slice(0, at - 1);
  const status = above.filter(line => line.trim()).at(-1) ?? "";
  return { transcript: above.join("\n"), composer: lines[at], draft: end > at + 1, working: WORKING.test(status) };
}

function emptyComposer(line: string): boolean {
  const text = line.replace(/^❭ /, "").trimEnd();
  return text === PLACEHOLDER || (text.endsWith("…") && text.length > 30 && PLACEHOLDER.startsWith(text.slice(0, -1)));
}

function ready(screen: Screen): boolean {
  return !screen.working && !screen.draft && screen.composer !== undefined && emptyComposer(screen.composer);
}

// Unmasked on purpose: the echo names the sentinels, and a narrow pane can wrap
// one onto a line of its own, which must stay part of the echo. The agent's
// reply always follows a blank line, so it never joins the echo.
// A "❭" line right below a rule is a composer frame (one a dead TUI left behind), not an echo.
function userTurns(screen: Screen): RegExpExecArray[] {
  return [...screen.transcript.matchAll(USER_TURN)]
    .filter(match => !RULE.test(screen.transcript.slice(0, Math.max(0, match.index - 1)).split("\n").at(-1) ?? ""));
}

// What the agent wrote after the latest task echo.
function turnBody(screen: Screen): string {
  const last = userTurns(screen).at(-1);
  return last ? screen.transcript.slice(last.index + last[0].length) : screen.transcript;
}

function modelId(opts: { model?: string; effort?: string }): string | undefined {
  if (opts.model === undefined || opts.effort === undefined) return opts.model;
  const suffix = opts.model.match(SUFFIX)?.[1];
  if (suffix === undefined) return `${opts.model}-${opts.effort}`;
  if (suffix !== opts.effort) {
    throw new Error(`devin model ${opts.model} already selects effort ${suffix}; pass --effort ${suffix}, or a model family such as swe-2-flash with --effort ${opts.effort}`);
  }
  return opts.model;
}

function validate(opts: LaunchOptions): string | undefined {
  if (opts.safe) throw new Error("devin --safe is not supported; the helper runs devin with --permission-mode dangerous");
  if (opts.model !== undefined && !/^[\w.-]+$/.test(opts.model)) throw new Error("devin --model must be a model ID from `devin models`, such as swe-2-flash-medium");
  if (opts.effort !== undefined && !EFFORTS.includes(opts.effort as typeof EFFORTS[number])) {
    throw new Error(`devin --effort must be one of: ${EFFORTS.join(", ")}`);
  }
  if (opts.effort !== undefined && opts.model === undefined) throw new Error("devin --effort needs --model, such as --model swe-2-flash --effort medium");
  return modelId(opts);
}

// --process-model in-process keeps the agent and its tools in the pane, even
// when the user's config prefers the shared background daemon. Workspace trust
// is skipped for this run only; devin stores no trust (2026-11-19). Never pass
// --config: it replaces the user's config and starts the setup wizard.
function command(opts: LaunchOptions, resumeId?: string): string {
  const model = validate(opts);
  const args = ["--process-model", "in-process", "--permission-mode", "dangerous", "--respect-workspace-trust", "false"];
  if (model !== undefined) args.push("--model", shellEscape(model));
  if (resumeId !== undefined) args.push("-r", shellEscape(resumeId));
  return `cd ${shellEscape(opts.cwd)} && devin ${args.join(" ")}`;
}

async function waitReady(sessionId: string, runtime: DriverRuntime): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const output = await runtime.capture(sessionId, 60);
    const screen = parse(output);
    const error = screen.composer === undefined ? output.match(START_ERROR)?.[1] : undefined;
    if (error) throw new Error(`devin session ${sessionId} did not start: ${error.trim()}`);
    if (ready(screen)) return;
    await runtime.sleep(500);
  }
  // Typing into a setup or login screen would answer it, so never do.
  throw new Error(`devin session ${sessionId} did not reach its input prompt; if devin shows a sign-in or setup screen, finish \`devin setup\` in a terminal first`);
}

export function checkDevinReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  const executable = findReadinessExecutable("devin", cwd, runtime);
  // The installer keeps each release in .../_versions/<version>/bin/devin. Never execute it.
  let version: string | null = null;
  try { if (executable) version = realpathSync(executable).match(/\/_versions\/([^/]+)\/bin\/devin$/)?.[1] ?? null; } catch {}
  const result = executableReadiness(executable, isVersion(version) ? version : null);
  if (!executable) return result;
  if (!existsSync(join(runtime.homeDir, ".local", "share", "devin", "credentials.toml"))) {
    addReadiness(result, "unknown", "no Devin sign-in found in ~/.local/share/devin; run `devin setup` in a terminal first");
  }
  addReadiness(result, true, `tested with ${DEVIN_TESTED_VERSION}`);
  return result;
}

export const devinDriver: AgentDriver = {
  // The TUI prints the session name only on exit, so the daemon reads it while draining.
  name: "devin", sessionPrefix: "devin", resumeTokenAvailableAfterSubmit: false,
  checkReadiness: checkDevinReadiness,
  launchProfiles: { defaultRole: "worker", profiles: {
    worker: { model: "swe-2-flash", effort: "medium" },
    reviewer: { model: "swe-2-flash", effort: "medium" },
  } },
  modelCatalog: {
    models: [
      { name: "swe-2-flash", efforts: ["medium", "high", "max"], defaultEffort: "medium" },
      { name: "swe-2", efforts: ["medium", "high", "max"], defaultEffort: "medium" },
    ],
    effortNote: "Devin model IDs carry their effort (swe-2-flash-medium = --model swe-2-flash --effort medium); a suffixed --model needs a matching --effort. The Free plan offers swe-2-flash-medium only; `devin models` lists what your account offers. Runtime model switching and --safe are not supported.",
  },
  buildLaunchCommand: command,
  buildResumeCommand(opts: ResumeOptions) { return command(opts, opts.resumeId); },
  extractResumeToken(output) { return [...output.matchAll(EXIT_ID)].at(-1)?.[1] ?? null; },
  prepareForTask: waitReady,
  async prepareForResume(sessionId, runtime) {
    await waitReady(sessionId, runtime);
    // An unknown ID opens a new, empty conversation without a word (2026-11-19).
    if (!userTurns(parse(await runtime.capture(sessionId, 2000))).length) {
      throw new Error(`devin session ${sessionId} could not resume: devin did not find the conversation and opened a new one`);
    }
  },
  async afterTaskSubmitted(sessionId, runtime, context) {
    const before = context?.beforeOutput === undefined ? undefined : parse(context.beforeOutput);
    const prior = before ? userTurns(before).map(match => match[0]) : [];
    for (let attempt = 0; attempt < 20; attempt++) {
      await runtime.sleep(500);
      const after = parse(await runtime.capture(sessionId, 80));
      const turns = userTurns(after).map(match => match[0]);
      // A repeated task can scroll the old echo out of the capture: then only the start of work shows it.
      if (turns.length > prior.length || (turns.length > 0 && turns.at(-1) !== prior.at(-1)) || (!before?.working && after.working)) return true;
    }
    return false;
  },
  async switchModel() { throw new Error("devin runtime model switching is not supported; launch with --model and --effort instead"); },
  detectStatus(output) { return devinDriver.detectOutcome(output).status; },
  // The screen decides: a signal after the latest task echo settles the turn once nothing works.
  detectOutcome(output) {
    const screen = parse(output);
    const sentinel = screen.working ? undefined : scanSentinels(turnBody(screen)).at(-1);
    return sentinel ? { status: sentinel.status, needHelpTags: sentinel.needHelpTags } : { status: "running", needHelpTags: null };
  },
  // A dialog, an exited TUI or an unknown screen is idle, so the daemon can call a person.
  detectActivity(output) { return parse(output).working ? "working" : "idle"; },
  acceptsInput(output) { return ready(parse(output)); },
  // One C-c with an empty composer stops the turn and its tool and keeps the
  // session (2026-11-19, devin 3000.14.30821); Esc needs two presses.
  interrupt: { key: "C-c", stopped: /Canceled\. What should Devin do\?/ },

  async gracefulExit(sessionId, runtime) { await runtime.sendKeys(sessionId, "/exit"); },
};
