import { accessSync, constants, mkdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { delimiter, join, resolve } from "path";
import { shellEscape } from "../shell";
import { agyTerminalSource } from "./agy-terminal-source";
import { addReadiness, executableReadiness, findReadinessExecutable, readEmbeddedVersion, readinessRuntime } from "./readiness";
import type { AgentDriver, DriverRuntime, LaunchOptions, ReadinessRuntime, ResumeOptions } from "./types";

export const AGY_TESTED_VERSION = "1.5.2";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const SUFFIX = new RegExp(`-(${EFFORTS.join("|")})$`);
const STATE = /^\[AHELPA_AGY_STATE:(ready|running|idle|error|needs_attention)\]\s*$/gm;
const TURN = /^\[AHELPA_AGY_TURN:([a-f0-9-]{36})\]\s*$/gm;
const SESSION = /^\[AHELPA_AGY_SESSION:([a-f0-9-]{36})\]\s*$/gm;

function lastMatch(output: string, pattern: RegExp): RegExpMatchArray | undefined {
  return [...output.matchAll(new RegExp(pattern.source, pattern.flags))].at(-1);
}

function state(output: string): string | undefined {
  const current = lastMatch(output, STATE);
  const latestTurn = lastMatch(output, TURN);
  // A capture can land between writes in one control block. Never attach the
  // preceding turn's settled state to a newly emitted turn marker.
  return current && (current.index ?? -1) > (latestTurn?.index ?? -1) ? current[1] : undefined;
}
function turn(output: string): string | undefined { return lastMatch(output, TURN)?.[1]; }

function files(opts: LaunchOptions) {
  const directory = opts.deliveryDir ?? join(opts.cwd, ".ahelpa", opts.sessionId ?? "agy");
  return { directory, app: join(directory, "agy-terminal.mjs") };
}

function validate(opts: LaunchOptions): void {
  if (opts.safe) throw new Error("agy --safe is not supported; the stream-json bridge runs with --dangerously-skip-permissions");
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

export function prepareAgyFiles(opts: LaunchOptions): void {
  validate(opts);
  const paths = files(opts);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.app, agyTerminalSource, { mode: 0o600 });
}

function command(opts: LaunchOptions, resumeId?: string): string {
  validate(opts);
  const args = [shellEscape(files(opts).app), "--cwd", shellEscape(opts.cwd)];
  if (resumeId !== undefined) args.push("--resume", shellEscape(resumeId));
  if (opts.model !== undefined) args.push("--model", shellEscape(opts.model));
  if (opts.effort !== undefined) args.push("--effort", shellEscape(opts.effort));
  return `cd ${shellEscape(opts.cwd)} && node ${args.join(" ")}`;
}

async function waitReady(sessionId: string, runtime: DriverRuntime) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const output = await runtime.capture(sessionId, 60);
    if (state(output) === "ready") return;
    if (state(output) === "error") throw new Error(`agy session ${sessionId} failed to start; inspect its last screen`);
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
  if (!findReadinessExecutable("node", cwd, runtime)) addReadiness(result, false, "Node.js is required for the agy stream-json bridge");
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
  name: "agy", sessionPrefix: "agy", resumeTokenAvailableAfterSubmit: true,
  checkReadiness: checkAgyReadiness,
  prepareLaunchFiles: prepareAgyFiles,
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
  extractResumeToken(output) { return lastMatch(output, SESSION)?.[1] ?? null; },
  prepareForTask: waitReady, prepareForResume: waitReady,
  async afterTaskSubmitted(sessionId, runtime, context) {
    const previous = context?.beforeOutput === undefined ? undefined : turn(context.beforeOutput);
    for (let attempt = 0; attempt < 20; attempt++) {
      const output = await runtime.capture(sessionId, 80);
      const current = turn(output);
      if (current && current !== previous && state(output) !== "ready"
        && (context?.beforeOutput !== undefined || state(output) === "running")) return true;
      await runtime.sleep(250);
    }
    return false;
  },
  async switchModel() { throw new Error("agy runtime model switching is not supported; launch with --model and --effort instead"); },
  detectStatus(output) { return agyDriver.detectOutcome(output).status; },
  detectOutcome(output) {
    const current = state(output);
    const status = current === "idle" || current === "error" || current === "needs_attention" ? current : "running";
    const tags = lastMatch(output, /^\[AHELPA_AGY_TAGS:([a-z0-9_, -]*)\]\s*$/gm);
    const lastTurn = lastMatch(output, TURN);
    const needHelpTags = status !== "running" && tags && tags.index! > (lastTurn?.index ?? -1)
      ? [...new Set(tags[1].split(",").map(tag => tag.trim()).filter(Boolean))] : null;
    return { status, needHelpTags };
  },
  detectActivity(output) { const current = state(output); return current === "running" ? "working" : current ? "idle" : "booting"; },
  acceptsInput(output) { return ["ready", "idle", "needs_attention"].includes(state(output) ?? ""); },
  async gracefulExit(sessionId, runtime) { await runtime.sendKeys(sessionId, "/exit"); },
};
