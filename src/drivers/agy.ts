import { accessSync, constants, mkdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { delimiter, dirname, join, resolve } from "path";
import { defaultRuntimeLayout } from "../runtime-layout";
import { shellEscape } from "../shell";
import { turnHookCommand } from "../turn-hooks";
import { addReadiness, executableReadiness, findReadinessExecutable, readEmbeddedVersion, readinessRuntime } from "./readiness";
import { maskSentinels, scanSentinels } from "./sentinels";
import type { AgentDriver, DriverRuntime, LaunchOptions, ReadinessRuntime, ResumeOptions } from "./types";

export const AGY_TESTED_VERSION = "1.5.2";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const SUFFIX = new RegExp(`-(${EFFORTS.join("|")})$`);

// agy's own TUI in tmux (1.5.3, 2026-11-07, at 80x24 and 120x40). Rules frame
// the composer, and each submitted turn follows one. Menus, questions and the
// trust dialog also put rows like `> 1. red` at column 0, but after a blank line.
const RULE = String.raw`─{20,}[ \t]*`;
const EMPTY_COMPOSER = new RegExp(String.raw`^${RULE}\n>[ \t]*\n${RULE}$`, "gm");
// A turn echo keeps its wrapped lines (indented two) so repeated tasks differ by path.
const USER_TURN = new RegExp(String.raw`^${RULE}\n> \S.*(?:\n  \S.*)*`, "gm");
// The live status line above the composer: a Braille frame, then "Generating...".
const SPINNER = /^[⠀-⣿][ \t]+\S/m;
// A background task the agent will resume from when it ends ("· 1 task(s) · /tasks").
const TASKS = /\b\d+ task\(s\)/;
const TRUST = /^Do you trust the contents of this project\?/m;
// agy opens a new conversation, with only this warning, when the resume ID is unknown.
const NOT_FOUND = /^warning: conversation "[^"\n]*" not found/m;
const EXIT_ID = /^agy --conversation[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/gm;

const footer = (output: string) => output.trimEnd().split("\n").at(-1) ?? "";
const lastIndex = (output: string, pattern: RegExp) => [...maskSentinels(output).matchAll(pattern)].at(-1)?.index ?? -1;

function currentTurn(output: string): string {
  const index = lastIndex(output, USER_TURN);
  return index < 0 ? output : output.slice(index);
}

// The footer guard keeps a spinner frozen by a crashed agy from reading as work.
function spinning(output: string): boolean {
  return SPINNER.test(currentTurn(output)) && /^esc to cancel\b/.test(footer(output));
}

function working(output: string): boolean {
  return spinning(output) || TASKS.test(footer(output));
}

function ready(output: string): boolean {
  return !working(output) && !TRUST.test(output) && /^\? for shortcuts\s+\S/.test(footer(output))
    && lastIndex(output, EMPTY_COMPOSER) > lastIndex(output, USER_TURN);
}

// Submitted turns. Text still in the composer has no empty composer after it.
function userTurns(output: string): string[] {
  const turns = [...maskSentinels(output).matchAll(USER_TURN)];
  if (turns.length && turns.at(-1)!.index > lastIndex(output, EMPTY_COMPOSER)) turns.pop();
  return turns.map(turn => turn[0]);
}

function validate(opts: LaunchOptions): void {
  if (opts.safe) throw new Error("agy --safe is not supported; the helper runs agy with --dangerously-skip-permissions");
  if (opts.model !== undefined && !/^[\w.:-]+$/.test(opts.model)) throw new Error("agy --model must be a model ID from `agy models`, such as gemini-4-argon-high");
  if (opts.effort !== undefined && !EFFORTS.includes(opts.effort as typeof EFFORTS[number])) {
    throw new Error(`agy --effort must be one of: ${EFFORTS.join(", ")}`);
  }
  // agy model IDs carry their effort; it refuses a contradicting --effort.
  const suffix = opts.model?.match(SUFFIX)?.[1];
  if (suffix && opts.effort !== undefined && opts.effort !== suffix) {
    const family = opts.model!.slice(0, -suffix.length - 1);
    throw new Error(`agy model ${opts.model} already selects effort ${suffix}; pass --effort ${suffix}, or --model ${family} --effort ${opts.effort}`);
  }
}

// --settings applies to this session only and is never saved. agy matches the
// literal working directory, not its real path or a parent, so pass both forms.
function trustSettings(cwd: string): string {
  const paths = [cwd];
  try { const real = realpathSync(cwd); if (real !== cwd) paths.push(real); } catch {}
  return JSON.stringify({ trustedWorkspaces: paths });
}

// The turn-end hook: agy reads <root>/.agents/hooks.json from each --add-dir
// folder (`--settings` refuses a hooks key), with no trust dialog. A root of
// its own keeps the result directory out of agy's workspace. Stop runs
// synchronously in the agent loop, via sh -c in the hooks.json folder, and
// must print a JSON object: `{}` (no "decision") lets the turn stop.
function hookRoot(opts: LaunchOptions & { sessionId: string }): string {
  return join(opts.deliveryDir ?? defaultRuntimeLayout.sessionDeliveryDir(opts.cwd, opts.sessionId), "agy-hook");
}

export function agyHooksJson(command: string[]): string {
  return JSON.stringify({ ahelpa: { Stop: [{ type: "command", command: `printf '{}'; ${command.map(shellEscape).join(" ")}`, timeout: 10 }] } }) + "\n";
}

function command(opts: LaunchOptions, resumeId?: string): string {
  validate(opts);
  const args = ["--dangerously-skip-permissions", "--settings", shellEscape(trustSettings(opts.cwd))];
  if (opts.sessionId) args.push("--add-dir", shellEscape(hookRoot({ ...opts, sessionId: opts.sessionId })));
  if (resumeId !== undefined) args.push("--conversation", shellEscape(resumeId));
  if (opts.model !== undefined) args.push("--model", shellEscape(opts.model));
  if (opts.effort !== undefined) args.push("--effort", shellEscape(opts.effort));
  // agy 1.5.2 honours exactly "true"; "1" still spawns its background updater.
  return `cd ${shellEscape(opts.cwd)} && AGY_CLI_DISABLE_AUTO_UPDATE=true agy ${args.join(" ")}`;
}

async function waitReady(sessionId: string, runtime: DriverRuntime) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const output = await runtime.capture(sessionId, 60);
    if (NOT_FOUND.test(output)) throw new Error(`agy session ${sessionId} could not resume: agy did not find the conversation`);
    // Answering would trust the folder for good; only session-only trust is automatic.
    if (TRUST.test(output)) throw new Error(`agy session ${sessionId} asked to trust the project folder; session-only trust did not apply`);
    if (ready(output)) return;
    await runtime.sleep(500);
  }
  throw new Error(`agy session ${sessionId} did not reach its input prompt`);
}

function older(version: string, than: string): boolean {
  const a = version.split(/[.+-]/).slice(0, 3).map(Number), b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return /^\d+\.\d+\.\d+-/.test(version);
}

// Every distinct agy on PATH, in lookup order. The desktop app can ship its own.
function pathExecutables(cwd: string, runtime: ReadinessRuntime): string[] {
  const found: string[] = [];
  for (const dir of (runtime.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      const file = resolve(cwd, dir, "agy");
      accessSync(file, constants.X_OK);
      if (!statSync(file).isFile()) continue;
      const physical = realpathSync(file);
      if (!found.includes(physical)) found.push(physical);
    } catch {}
  }
  return found;
}

export function checkAgyReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  const executable = findReadinessExecutable("agy", cwd, runtime);
  // The Go binary keeps its version string next to the build date. Never execute it.
  const result = executableReadiness(executable, executable ? readEmbeddedVersion(executable, /(\d+\.\d+\.\d+)\nDate: /) : null);
  if (!executable) return result;
  if (result.version && older(result.version, AGY_TESTED_VERSION)) addReadiness(result, false, `upgrade agy to >= ${AGY_TESTED_VERSION}`);
  const all = pathExecutables(cwd, runtime);
  if (all.length > 1) {
    const desktop = /\.app\//.test(all[0]) ? "; the first belongs to a desktop app bundle" : "";
    addReadiness(result, "unknown", `${all.length} different agy executables on PATH; ${all[0]} shadows ${all.slice(1).join(", ")}${desktop}`);
  }
  addReadiness(result, "unknown", `agy keeps its sign-in in the OS keychain, so sign-in is verified at launch; tested with ${AGY_TESTED_VERSION}`);
  return result;
}

export const agyDriver: AgentDriver = {
  // The TUI prints the conversation ID only on exit, so the daemon reads it while draining.
  name: "agy", sessionPrefix: "agy", resumeTokenAvailableAfterSubmit: false,
  checkReadiness: checkAgyReadiness,
  turnHooks: true,
  prepareLaunchFiles(opts) {
    validate(opts);
    if (!opts.sessionId) return;
    const root = hookRoot({ ...opts, sessionId: opts.sessionId });
    mkdirSync(join(root, ".agents"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, ".agents", "hooks.json"), agyHooksJson(turnHookCommand(dirname(root), "agy")), { flag: "wx", mode: 0o600 });
  },
  launchProfiles: { defaultRole: "worker", profiles: {
    worker: { model: "gemini-4-argon", effort: "medium" },
    reviewer: { model: "gemini-4-argon", effort: "medium" },
  } },
  modelCatalog: {
    models: [
      { name: "gemini-4-argon", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { name: "gemini-3.8-flash", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { name: "claude-opus-5-5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { name: "claude-sonnet-5-5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { name: "gpt-oss-120b", efforts: ["medium"], defaultEffort: "medium" },
    ],
    effortNote: "agy model IDs carry their effort (gemini-4-argon-high = --model gemini-4-argon --effort high); a suffixed --model needs a matching --effort. `agy models` lists what your account offers. Runtime model switching and --safe are not supported.",
  },
  buildLaunchCommand: command,
  buildResumeCommand(opts: ResumeOptions) { return command(opts, opts.resumeId); },
  extractResumeToken(output) { return [...output.matchAll(EXIT_ID)].at(-1)?.[1] ?? null; },
  prepareForTask: waitReady, prepareForResume: waitReady,
  async afterTaskSubmitted(sessionId, runtime, context) {
    const before = context?.beforeOutput;
    const prior = before === undefined ? [] : userTurns(before);
    for (let attempt = 0; attempt < 20; attempt++) {
      await runtime.sleep(500);
      const output = await runtime.capture(sessionId, 80);
      const turns = userTurns(output);
      if (before === undefined ? turns.length > 0 && agyDriver.detectStatus(output) === "running"
        // A repeated task can scroll the old echo out of the capture: then only the spinner shows it.
        : turns.length > prior.length || (turns.length > 0 && turns.at(-1) !== prior.at(-1)) || (!working(before) && spinning(output))) return true;
    }
    return false;
  },
  async switchModel() { throw new Error("agy runtime model switching is not supported; launch with --model and --effort instead"); },
  detectStatus(output) { return agyDriver.detectOutcome(output).status; },
  // The screen decides: a signal in the current turn settles it once nothing is working after it.
  detectOutcome(output) {
    const sentinel = scanSentinels(currentTurn(output)).at(-1);
    return sentinel && !working(output)
      ? { status: sentinel.status, needHelpTags: sentinel.needHelpTags }
      : { status: "running", needHelpTags: null };
  },
  detectActivity(output) { return working(output) ? "working" : TRUST.test(output) ? "booting" : "idle"; },
  acceptsInput: ready,
  // Esc stops one turn and keeps the session (2026-11-07, agy 1.5.3).
  interrupt: { key: "Escape", stopped: /Interrupted · What should Antigravity CLI do instead\?/ },

  async gracefulExit(sessionId, runtime) { await runtime.sendKeys(sessionId, "/exit"); },
};
