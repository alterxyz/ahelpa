import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { shellEscape } from "../shell";
import { vibeTerminalSource } from "./vibe-terminal-source";
import { addReadiness, executableReadiness, findReadinessExecutable, readLocalConfig, readinessRuntime } from "./readiness";
import type { AgentDriver, DriverRuntime, LaunchOptions, ReadinessRuntime, ResumeOptions } from "./types";

export const VIBE_TESTED_VERSION = "3.1.0";
const EFFORTS = ["off", "low", "medium", "high", "max"] as const;
const STATE = /^\[AHELPA_VIBE_STATE:(ready|running|idle|error|needs_attention)\]\s*$/gm;
const TURN = /^\[AHELPA_VIBE_TURN:([a-f0-9-]{36})\]\s*$/gm;
const SESSION = /^\[AHELPA_VIBE_SESSION:([a-f0-9-]{36})\]\s*$/gm;

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
  const directory = opts.deliveryDir ?? join(opts.cwd, ".ahelpa", opts.sessionId ?? "vibe");
  return { directory, app: join(directory, "vibe-terminal.mjs") };
}

function validate(opts: LaunchOptions): void {
  if (opts.safe) throw new Error("vibe --safe is not supported; lower-permission headless agents are unverified");
  if (opts.model !== undefined && !/^[\w.:-]+$/.test(opts.model)) throw new Error("vibe --model must be a model alias, such as mistral-large-4-0-3");
  if (opts.effort !== undefined && !EFFORTS.includes(opts.effort as typeof EFFORTS[number])) {
    throw new Error(`vibe --effort must be one of: ${EFFORTS.join(", ")}`);
  }
}

export function prepareVibeFiles(opts: LaunchOptions): void {
  validate(opts);
  const paths = files(opts);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.app, vibeTerminalSource, { mode: 0o600 });
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
    if (state(output) === "error") throw new Error(`vibe session ${sessionId} failed to start; inspect its last screen`);
    await runtime.sleep(500);
  }
  throw new Error(`vibe session ${sessionId} did not reach its input prompt`);
}

function older(version: string, than: string): boolean {
  const a = version.split(/[.+-]/).slice(0, 3).map(Number), b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return /^\d+\.\d+\.\d+-/.test(version);
}

// ponytail: recognize the standard uv/pip virtualenv layout; other installs report
// an unknown version instead of executing a potentially writing PATH wrapper.
function installedVersion(executable: string): string | null {
  try {
    const lib = join(dirname(dirname(realpathSync(executable))), "lib");
    for (const python of readdirSync(lib).filter(name => /^python\d+\.\d+$/.test(name))) {
      const packages = join(lib, python, "site-packages");
      for (const name of readdirSync(packages).filter(name => /^mistral_vibe-[\w.+-]+\.dist-info$/.test(name))) {
        const metadata = readLocalConfig(join(packages, name, "METADATA"));
        if (!metadata || !/^Name: mistral-vibe\r?$/m.test(metadata)) continue;
        const version = metadata.match(/^Version: (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\r?$/m)?.[1];
        if (version) return version;
      }
    }
  } catch {}
  return null;
}

export function checkVibeReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  const executable = findReadinessExecutable("vibe", cwd, runtime);
  const result = executableReadiness(executable, executable ? installedVersion(executable) : null);
  if (!findReadinessExecutable("node", cwd, runtime)) addReadiness(result, false, "Node.js is required for the vibe streaming bridge");
  if (!executable) return result;
  if (result.version && older(result.version, VIBE_TESTED_VERSION)) addReadiness(result, false, `upgrade vibe to >= ${VIBE_TESTED_VERSION}`);
  addReadiness(result, "unknown", `vibe keeps its sign-in in the OS keychain, so sign-in is verified at first turn; tested with ${VIBE_TESTED_VERSION}`);
  return result;
}

export const vibeDriver: AgentDriver = {
  name: "vibe", sessionPrefix: "vibe", resumeTokenAvailableAfterSubmit: true,
  checkReadiness: checkVibeReadiness,
  prepareLaunchFiles: prepareVibeFiles,
  launchProfiles: { defaultRole: "worker", profiles: {
    worker: { model: "mistral-large-4-0-3", effort: "high" },
    reviewer: { model: "mistral-large-4-0-3", effort: "high" },
  } },
  modelCatalog: {
    models: [
      { name: "mistral-large-4-0-3", efforts: ["low", "medium", "high"], defaultEffort: "high" },
      { name: "mistral-medium-3.5", efforts: ["off", "high"], defaultEffort: "high" },
      { name: "glm-5-3", efforts: ["low", "high", "max"], defaultEffort: "high" },
      { name: "zai-glm-5-3-flash", efforts: ["low", "high", "max"], defaultEffort: "high" },
    ],
    effortNote: "vibe selects model and thinking through a session-local agent TOML file on every turn. Omitted effort keeps the model default. Runtime model switching and --safe are not supported.",
  },
  buildLaunchCommand: command,
  buildResumeCommand(opts: ResumeOptions) { return command(opts, opts.resumeId); },
  extractResumeToken(output) { return lastMatch(output, SESSION)?.[1] ?? null; },
  prepareForTask: waitReady, prepareForResume: waitReady,
  async afterTaskSubmitted(sessionId, runtime, context) {
    const previous = context?.beforeOutput === undefined ? undefined : turn(context.beforeOutput);
    let accepted = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const output = await runtime.capture(sessionId, 80);
      const current = turn(output);
      const currentState = state(output);
      const failed = currentState === "error" || currentState === "needs_attention";
      // The bridge starts the turn before Vibe emits its native session ID.
      // Try to retain that ID at launch, but never destroy an accepted slow turn.
      if (current && current !== previous && currentState && currentState !== "ready"
        && (context?.beforeOutput !== undefined || currentState === "running" || failed)) {
        accepted = true;
        if (lastMatch(output, SESSION) || failed) return true;
      }
      await runtime.sleep(500);
    }
    return accepted;
  },
  async switchModel() { throw new Error("vibe runtime model switching is not supported; launch with --model and --effort instead"); },
  detectStatus(output) { return vibeDriver.detectOutcome(output).status; },
  detectOutcome(output) {
    const current = state(output);
    const status = current === "idle" || current === "error" || current === "needs_attention" ? current : "running";
    const tags = lastMatch(output, /^\[AHELPA_VIBE_TAGS:([a-z0-9_, -]*)\]\s*$/gm);
    const lastTurn = lastMatch(output, TURN);
    const needHelpTags = status !== "running" && tags && tags.index! > (lastTurn?.index ?? -1)
      ? [...new Set(tags[1].split(",").map(tag => tag.trim()).filter(Boolean))] : null;
    return { status, needHelpTags };
  },
  detectActivity(output) { const current = state(output); return current === "running" ? "working" : current ? "idle" : "booting"; },
  acceptsInput(output) { return ["ready", "idle", "needs_attention"].includes(state(output) ?? ""); },
  async gracefulExit(sessionId, runtime) { await runtime.sendKeys(sessionId, "/exit"); },
};
