import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { shellEscape } from "../shell";
import { dshTerminalSource } from "./dsh-terminal-source";
import { addReadiness, executableReadiness, findReadinessExecutable, readLocalConfig, readPackageVersion, readinessRuntime } from "./readiness";
import type { AgentDriver, DriverRuntime, LaunchOptions, ReadinessRuntime, ResumeOptions } from "./types";

const EFFORTS = ["off", "low", "high", "max"] as const;
const STATE = /^\[AHELPA_DSH_STATE:(ready|running|idle|error|needs_attention)\]\s*$/gm;
const TURN = /^\[AHELPA_DSH_TURN:([a-f0-9-]{36})\]\s*$/gm;
const SESSION = /^\[AHELPA_DSH_SESSION:(session-[a-f0-9-]{36})\]\s*$/gm;

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

export function dshHome(cwd: string, runtime: ReadinessRuntime = readinessRuntime()): string {
  return resolve(cwd, runtime.env.DSH_HOME || join(runtime.homeDir, ".dsh"));
}

function files(opts: LaunchOptions) {
  const directory = opts.deliveryDir ?? join(opts.cwd, ".ahelpa", opts.sessionId ?? "dsh");
  return { directory, app: join(directory, "dsh-terminal.mjs"), patch: join(directory, "dsh.patch.yml") };
}

function validate(opts: LaunchOptions): void {
  const separator = opts.model?.indexOf(":") ?? -1;
  if (separator !== -1 && (!opts.model?.slice(0, separator).trim() || !opts.model?.slice(separator + 1).trim())) {
    throw new Error("DSH --model must be <model> or <provider>:<model>, with nonempty provider and model");
  }
  if (opts.safe) throw new Error("DSH --safe is not supported by the terminal profile yet; its approval UI requires DSH Web");
  if (opts.effort !== undefined && !EFFORTS.includes(opts.effort as typeof EFFORTS[number])) {
    throw new Error(`DSH --effort must be one of: ${EFFORTS.join(", ")}`);
  }
}

// A separate profile preserves Desktop and Web configuration. Existing user
// profile files are never rewritten; the per-launch overlay owns the app.
export function prepareDshFiles(opts: LaunchOptions): void {
  validate(opts);
  const profile = join(dshHome(opts.cwd), "profiles", "ahelpa");
  mkdirSync(profile, { recursive: true });
  for (const [name, content] of [
    ["package.json", JSON.stringify({ name: "dsh-profile-ahelpa", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }, null, 2) + "\n"],
    ["cordis.patch.yml", "[]\n"],
  ]) {
    try { writeFileSync(join(profile, name), content, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const paths = files(opts);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.app, dshTerminalSource, { mode: 0o600 });
  writeFileSync(paths.patch, [
    "- id: hmr", "  disabled: true",
    "- id: session-title-llm", "  disabled: true",
    "- id: session-log-deepseek", "  disabled: true",
    "- insert:", "    - id: ahelpa-terminal", `      name: ${JSON.stringify(paths.app)}`,
  ].join("\n") + "\n", { mode: 0o600 });
}

function command(opts: LaunchOptions, resumeId?: string): string {
  validate(opts);
  const model = opts.model ?? "";
  const separator = model.indexOf(":");
  const env = ["DSH_PERMISSION_MODE=danger-full-access", "DSH_TELEMETRY_DISABLED=1"];
  // Always clear inherited adapter options: a helper can launch another helper.
  for (const [key, value] of Object.entries({
    AHELPA_DSH_PROVIDER: separator === -1 ? "" : model.slice(0, separator),
    AHELPA_DSH_MODEL: separator === -1 ? model : model.slice(separator + 1), AHELPA_DSH_EFFORT: opts.effort ?? "", AHELPA_DSH_RESUME_ID: resumeId ?? "",
  })) env.push(`${key}=${shellEscape(value)}`);
  return `cd ${shellEscape(opts.cwd)} && ${env.join(" ")} dsh --profile ahelpa --patch ${shellEscape(files(opts).patch)}`;
}

async function waitReady(sessionId: string, runtime: DriverRuntime) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const output = await runtime.capture(sessionId, 60);
    if (state(output) === "ready") return;
    if (state(output) === "error") throw new Error(`DSH session ${sessionId} failed to start; inspect its last screen`);
    await runtime.sleep(500);
  }
  throw new Error(`DSH session ${sessionId} did not reach its input prompt`);
}

export function checkDshReadiness(cwd: string, runtime: ReadinessRuntime = readinessRuntime()) {
  const executable = findReadinessExecutable("dsh", cwd, runtime);
  const result = executableReadiness(executable, executable ? readPackageVersion(executable, "@deepseek-ai/dsh") : null);
  if (!executable) return result;
  // Never parse or display an account grant. The runtime owns its validation.
  const home = dshHome(cwd, runtime);
  const stored = existsSync(join(home, ".credentials.yaml")) || existsSync(join(home, ".env"));
  addReadiness(result, "unknown", stored || runtime.env.DEEPSEEK_API_KEY?.trim()
    ? "credentials are validated by DSH at launch" : "configure credentials with a provider key in $DSH_HOME/.env, DSH Web, or DEEPSEEK_API_KEY");
  // ponytail: bounded text sniff, not a YAML parse; provider configuration is validated by DSH at launch.
  const patch = readLocalConfig(join(home, "profiles", "ahelpa", "cordis.patch.yml"));
  if (!patch || !/^[ \t]*(?:magpie|"magpie"|'magpie')[ \t]*:/m.test(patch)) {
    addReadiness(result, "unknown", "default route needs a magpie provider in $DSH_HOME/profiles/ahelpa/cordis.patch.yml");
  }
  return result;
}

export const dshDriver: AgentDriver = {
  name: "dsh", sessionPrefix: "dsh", resumeTokenAvailableAfterSubmit: true,
  checkReadiness: checkDshReadiness,
  prepareLaunchFiles: prepareDshFiles,
  launchProfiles: { defaultRole: "worker", profiles: {
    worker: { model: "magpie:deepseek/deepseek-flash", effort: "high" },
    reviewer: { model: "magpie:deepseek/deepseek-flash", effort: "high" },
  } },
  modelCatalog: { models: [{ name: "magpie:deepseek/deepseek-flash", efforts: EFFORTS, defaultEffort: "high" }],
    effortNote: "DSH --model <model> keeps the profile default provider; <provider>:<model> selects a provider (split on the first colon). Model IDs are provider-specific: magpie uses deepseek/deepseek-v4-pro, deepseek-official uses deepseek-flash; availability is provider-dependent. Runtime model switching and --safe are not supported yet." },
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
  async switchModel() { throw new Error("DSH runtime model switching is not supported; launch with --model and --effort instead"); },
  detectStatus(output) { return dshDriver.detectOutcome(output).status; },
  detectOutcome(output) {
    const current = state(output);
    const status = current === "idle" || current === "error" || current === "needs_attention" ? current : "running";
    const tags = lastMatch(output, /^\[AHELPA_DSH_TAGS:([a-z0-9_, -]*)\]\s*$/gm);
    const lastTurn = lastMatch(output, TURN);
    const needHelpTags = status !== "running" && tags && tags.index! > (lastTurn?.index ?? -1)
      ? [...new Set(tags[1].split(",").map(tag => tag.trim()).filter(Boolean))] : null;
    return { status, needHelpTags };
  },
  detectActivity(output) { const current = state(output); return current === "running" ? "working" : current ? "idle" : "booting"; },
  acceptsInput(output) { return ["ready", "idle", "error", "needs_attention"].includes(state(output) ?? ""); },
  async gracefulExit(sessionId, runtime) { await runtime.sendKeys(sessionId, "/exit"); },
};
