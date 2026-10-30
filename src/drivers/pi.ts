import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { shellEscape } from "../shell";
import { piTerminalSource } from "./pi-terminal-source";
import { addReadiness, executableReadiness, findReadinessExecutable, isVersion, readLocalConfig, readPackageVersion, readinessRuntime } from "./readiness";
import type { AgentDriver, DriverRuntime, LaunchOptions, ReadinessRuntime, ResumeOptions } from "./types";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const STATE = /^\[AHELPA_PI_STATE:(ready|running|idle|error|needs_attention)\]\s*$/gm;
const TURN = /^\[AHELPA_PI_TURN:([a-f0-9-]{36})\]\s*$/gm;
const SESSION = /^\[AHELPA_PI_SESSION:([a-f0-9-]{36})\]\s*$/gm;

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
  const directory = opts.deliveryDir ?? join(opts.cwd, ".ahelpa", opts.sessionId ?? "pi");
  return { directory, app: join(directory, "pi-terminal.mjs") };
}

function validate(opts: LaunchOptions): void {
  if (opts.safe) throw new Error("Pi --safe is not supported; the RPC helper requires full local permissions");
  if (opts.model !== undefined) {
    const separator = opts.model.indexOf("/");
    if (separator < 1 || !opts.model.slice(0, separator).trim() || !opts.model.slice(separator + 1).trim()) {
      throw new Error("Pi --model must be <provider>/<model>, with nonempty provider and model");
    }
  }
  if (opts.effort !== undefined && !EFFORTS.includes(opts.effort as typeof EFFORTS[number])) {
    throw new Error(`Pi --effort must be one of: ${EFFORTS.join(", ")}`);
  }
}

export function preparePiFiles(opts: LaunchOptions): void {
  validate(opts);
  const paths = files(opts);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.app, piTerminalSource, { mode: 0o600 });
}

function command(opts: LaunchOptions, resumeId?: string): string {
  validate(opts);
  const args = [shellEscape(files(opts).app), "--cwd", shellEscape(opts.cwd)];
  if (resumeId !== undefined) args.push("--resume", shellEscape(resumeId));
  if (opts.model !== undefined) args.push("--model", shellEscape(opts.model));
  if (opts.effort !== undefined) args.push("--effort", shellEscape(opts.effort));
  // Options travel as argv, not inherited environment overrides.
  return `cd ${shellEscape(opts.cwd)} && node ${args.join(" ")}`;
}

async function waitReady(sessionId: string, runtime: DriverRuntime) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const output = await runtime.capture(sessionId, 60);
    if (state(output) === "ready") return;
    if (state(output) === "error") throw new Error(`Pi session ${sessionId} failed to start; inspect its last screen`);
    await runtime.sleep(500);
  }
  throw new Error(`Pi session ${sessionId} did not reach its input prompt`);
}

function packageVersion(executable: string): string | null {
  const version = readPackageVersion(executable, "@earendil-works/pi-coding-agent");
  if (version) return version;
  // Pi 1.4.0 also ships dist/bundle/cli.js, one level deeper than the
  // shared probe. Verify bin ownership rather than trusting nearby metadata.
  try {
    const physical = realpathSync(executable);
    const directory = dirname(dirname(dirname(physical)));
    const raw = readLocalConfig(join(directory, "package.json"));
    if (!raw) return null;
    const pkg = JSON.parse(raw);
    if (pkg?.name !== "@earendil-works/pi-coding-agent" || !isVersion(pkg.version)) return null;
    const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
    if (bins.some(bin => typeof bin === "string" && realpathSync(resolve(directory, bin)) === physical)) return pkg.version;
  } catch {}
  return null;
}

export function checkPiReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  const executable = findReadinessExecutable("pi", cwd, runtime);
  const result = executableReadiness(executable, executable ? packageVersion(executable) : null);
  if (!findReadinessExecutable("node", cwd, runtime)) addReadiness(result, false, "Node.js is required for the Pi RPC bridge");
  if (!executable) return result;
  if (result.version) {
    const [major, minor, patch] = result.version.split(/[.+-]/).map(Number);
    if (major < 1 || (major === 1 && minor < 4) || (major === 1 && minor === 4 && patch === 0 && /^\d+\.\d+\.\d+-/.test(result.version))) {
      addReadiness(result, false, "upgrade Pi to >= 1.4.0");
    }
  }
  addReadiness(result, "unknown", "Pi credentials and effective model are validated at launch; tested with 1.4.0");
  return result;
}

export const piDriver: AgentDriver = {
  name: "pi", sessionPrefix: "pi", resumeTokenAvailableAfterSubmit: true,
  checkReadiness: checkPiReadiness,
  prepareLaunchFiles: preparePiFiles,
  launchProfiles: { defaultRole: "worker", profiles: { worker: {}, reviewer: {} } },
  modelCatalog: { models: [],
    effortNote: "Pi uses its native configured model and thinking level. --model <provider>/<model> selects an exact model; --effort support is model-dependent and verified at startup. Runtime model switching and --safe are not supported." },
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
  async switchModel() { throw new Error("Pi runtime model switching is not supported; launch with --model and --effort instead"); },
  detectStatus(output) { return piDriver.detectOutcome(output).status; },
  detectOutcome(output) {
    const current = state(output);
    const status = current === "idle" || current === "error" || current === "needs_attention" ? current : "running";
    const tags = lastMatch(output, /^\[AHELPA_PI_TAGS:([a-z0-9_, -]*)\]\s*$/gm);
    const lastTurn = lastMatch(output, TURN);
    const needHelpTags = status !== "running" && tags && tags.index! > (lastTurn?.index ?? -1)
      ? [...new Set(tags[1].split(",").map(tag => tag.trim()).filter(Boolean))] : null;
    return { status, needHelpTags };
  },
  detectActivity(output) { const current = state(output); return current === "running" ? "working" : current ? "idle" : "booting"; },
  acceptsInput(output) { return ["ready", "idle", "needs_attention"].includes(state(output) ?? ""); },
  async gracefulExit(sessionId, runtime) { await runtime.sendKeys(sessionId, "/exit"); },
};
