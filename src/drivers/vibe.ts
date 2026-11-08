import { readdirSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { shellEscape } from "../shell";
import { addReadiness, executableReadiness, findReadinessExecutable, readLocalConfig, readinessRuntime } from "./readiness";
import { maskSentinels, scanSentinels } from "./sentinels";
import type { AgentDriver, DriverRuntime, LaunchOptions, ReadinessRuntime, ResumeOptions } from "./types";

export const VIBE_TESTED_VERSION = "3.1.0";
const EFFORTS = ["off", "low", "medium", "high", "max"] as const;
// Models Vibe does not ship need their full definition in the session agent file.
const KNOWN_MODELS: Record<string, Record<string, unknown>> = {
  "deepseek-v4-1-flash-1017": {
    name: "deepseek-v4-1-flash-1017", provider: "mistral",
    thinking_levels: ["low", "high", "max"], max_context_length: 1048576, max_output_tokens: 131072,
  },
};

// Vibe 3.1 TUI (full screen, alternate screen: a capture is the visible viewport).
// The scrollbar thumb is drawn in the last column of any row, sentinel rows included.
const SCROLLBAR = /[^\S\r\n]*[▁-█]$/gm;
// The composer's top rule carries the model and agent: "──── Mistral Large 4[high] · ahelpa helper ─".
const COMPOSER_RULE = /^─+ \S.* ─\s*$/;
// Startup first draws the default agent ("· accept edits") while it initializes.
const SESSION_AGENT = /· ahelpa helper ─\s*$/;
// A submitted turn: "> text" at column 0, wrapped lines indented by two spaces.
const USER_TURN = /^> \S.*(?:\n {2}\S.*)*/gm;
// "⠴ Generating… (12s Esc/Ctrl+C to interrupt)", also "Running command…" and "Thinking…".
const WORKING = /Esc\/Ctrl\+C to interrupt\)/g;
// The question tool replaces the composer with a dialog and keeps the hint line.
const QUESTION = /User input required…/;
const MODEL_MISSING = /Model '([^']+)' is not available/;
// "✕ Error: API error occurred: Status 400. Body: {... "type":"invalid_model" ...}".
const FAILURE = /^✕ Error:/gm;
// Wording the deepseek fallback policy names; keep it in step with the registry.
export const VIBE_MODEL_UNAVAILABLE = "model unavailable (the Mistral subscription may not include it)";
// Printed by /exit: "Or: vibe --resume d68ff081" (the first 8 hex digits of the session ID).
const RESUME = /^Or: vibe --resume ([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)\s*$/gim;

interface Screen { text: string; masked: string; turnStart: number; rule: string | undefined; composer: string | undefined }

function parse(output: string): Screen {
  const full = output.replace(SCROLLBAR, "");
  const lines = maskSentinels(full).split("\n");
  let rule = -1;
  for (let i = lines.length - 1; i >= 0 && rule < 0; i--) if (COMPOSER_RULE.test(lines[i])) rule = i;
  // Everything above the composer is transcript; a dialog leaves no composer.
  const end = rule < 0 ? full.length : lines.slice(0, rule).join("\n").length;
  const text = full.slice(0, end);
  const masked = maskSentinels(text);
  const turnStart = [...masked.matchAll(USER_TURN)].at(-1)?.index ?? 0;
  return { text, masked, turnStart, rule: lines[rule], composer: rule < 0 ? undefined : lines[rule + 1] };
}

function lastWorking(screen: Screen): number {
  return [...screen.masked.slice(screen.turnStart).matchAll(WORKING)].at(-1)?.index ?? -1;
}

function working(screen: Screen): boolean {
  return screen.composer !== undefined && lastWorking(screen) >= 0 && !QUESTION.test(screen.masked.slice(screen.turnStart));
}

function ready(screen: Screen): boolean {
  return SESSION_AGENT.test(screen.rule ?? "") && /^>\s*$/.test(screen.composer ?? "") && !working(screen);
}

function userTurns(screen: Screen): string[] {
  return [...screen.masked.matchAll(USER_TURN)].map(match => match[0]);
}

function newTurn(before: string | undefined, output: string): boolean {
  const after = parse(output);
  if (before === undefined) return working(after);
  const previous = parse(before);
  const turns = userTurns(after), earlier = userTurns(previous);
  // The viewport can scroll the old turn away, so a start of work also counts.
  return turns.length > earlier.length || turns.at(-1) !== earlier.at(-1) || (!working(previous) && working(after));
}

function deliveryDir(opts: LaunchOptions): string {
  return opts.deliveryDir ?? join(opts.cwd, ".ahelpa", opts.sessionId ?? "vibe");
}

function validate(opts: LaunchOptions): void {
  if (opts.safe) throw new Error("vibe --safe is not supported; lower-permission Vibe agents are unverified");
  if (opts.model !== undefined && !/^[\w.:-]+$/.test(opts.model)) throw new Error("vibe --model must be a model alias, such as mistral-large-4-0-3");
  if (opts.effort !== undefined && !EFFORTS.includes(opts.effort as typeof EFFORTS[number])) {
    throw new Error(`vibe --effort must be one of: ${EFFORTS.join(", ")}`);
  }
}

export function vibeAgentToml(opts: { model?: string; effort?: string }): string {
  const model = opts.model ?? (opts.effort === undefined ? undefined : "mistral-large-4-0-3");
  let agent = 'safety = "yolo"\nbypass_tool_permissions = true\n';
  if (model === undefined) return agent;
  agent += `active_model = ${JSON.stringify(model)}\n`;
  const definition = Object.hasOwn(KNOWN_MODELS, model) ? KNOWN_MODELS[model] : undefined;
  // A quoted key keeps dotted aliases whole; the sparse table merges onto Vibe's routed model.
  if (definition || opts.effort !== undefined) agent += `[models.${JSON.stringify(model)}]\n`;
  for (const [key, value] of Object.entries(definition ?? {})) agent += `${key} = ${JSON.stringify(value)}\n`;
  if (opts.effort !== undefined) agent += `thinking = ${JSON.stringify(opts.effort)}\n`;
  return agent;
}

function command(opts: LaunchOptions, resumeId?: string): string {
  validate(opts);
  const dir = deliveryDir(opts);
  const args = ["--trust", "--agent", "ahelpa-helper"];
  if (resumeId !== undefined) args.push("--resume", shellEscape(resumeId));
  // ponytail: the pane writes the agent file, because launch files are prepared
  // before model and effort reach the driver. The umask stays in the subshell.
  const agent = `(umask 077 && printf %s ${shellEscape(vibeAgentToml(opts))} > ${shellEscape(join(dir, "ahelpa-helper.toml"))})`;
  const env = `VIBE_ENABLE_AUTO_UPDATE=false VIBE_ENABLE_UPDATE_CHECKS=false VIBE_AGENT_PATHS=${shellEscape(JSON.stringify([dir]))}`;
  return `cd ${shellEscape(opts.cwd)} && ${agent} && ${env} vibe ${args.join(" ")}`;
}

async function waitReady(sessionId: string, runtime: DriverRuntime) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const output = await runtime.capture(sessionId, 60);
    // Vibe falls back to another model with only a warning; never run the wrong one.
    const missing = maskSentinels(output).match(MODEL_MISSING)?.[1];
    if (missing) throw new Error(`vibe model ${missing} is not available; inspect its last screen`);
    if (ready(parse(output))) return;
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
  if (!executable) return result;
  if (result.version && older(result.version, VIBE_TESTED_VERSION)) addReadiness(result, false, `upgrade vibe to >= ${VIBE_TESTED_VERSION}`);
  addReadiness(result, "unknown", `vibe keeps its sign-in in the OS keychain, so sign-in is verified at first turn; tested with ${VIBE_TESTED_VERSION}`);
  return result;
}

export const vibeDriver: AgentDriver = {
  name: "vibe", sessionPrefix: "vibe", resumeTokenAvailableAfterSubmit: false,
  checkReadiness: checkVibeReadiness,
  // Launch only needs the delivery directory reserved before the pane writes into it.
  prepareLaunchFiles: validate,
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
    effortNote: "vibe selects model and thinking through a session-local agent TOML file read at launch and resume. Omitted effort keeps the model default. Runtime model switching and --safe are not supported.",
  },
  buildLaunchCommand: command,
  buildResumeCommand(opts: ResumeOptions) { return command(opts, opts.resumeId); },
  extractResumeToken(output) { return [...output.matchAll(RESUME)].at(-1)?.[1] ?? null; },
  prepareForTask: waitReady, prepareForResume: waitReady,
  async afterTaskSubmitted(sessionId, runtime, context) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await runtime.sleep(500);
      if (newTurn(context?.beforeOutput, await runtime.capture(sessionId, 80))) return true;
    }
    return false;
  },
  async switchModel() { throw new Error("vibe runtime model switching is not supported; launch with --model and --effort instead"); },
  detectStatus(output) { return vibeDriver.detectOutcome(output).status; },
  detectOutcome(output) {
    const screen = parse(output);
    // Resumed Vibe shows earlier turns; only the latest turn's signal after its last work counts.
    const turn = screen.text.slice(screen.turnStart);
    const sentinel = scanSentinels(turn).at(-1);
    const failure = [...screen.masked.slice(screen.turnStart).matchAll(FAILURE)].at(-1)?.index ?? -1;
    const settled = Math.max(sentinel?.index ?? -1, failure);
    if (settled <= lastWorking(screen)) return { status: "running", needHelpTags: null };
    if (sentinel && sentinel.index === settled) return { status: sentinel.status, needHelpTags: sentinel.needHelpTags };
    // Vibe wraps the API error body mid-word; rejoin its indented lines.
    if (/invalid_model/.test(turn.slice(failure).replace(/\n {2}/g, ""))) {
      return { status: "needs_attention", needHelpTags: null, reason: VIBE_MODEL_UNAVAILABLE };
    }
    // Other failures end the turn without a signal and settle through the idle fallback.
    return { status: "running", needHelpTags: null };
  },
  // A dialog, an exited TUI or an unknown screen is idle, so the daemon can settle it.
  detectActivity(output) { return working(parse(output)) ? "working" : "idle"; },
  acceptsInput(output) { return ready(parse(output)); },
  // Esc stops one turn and its tool and keeps the session (2026-11-07, vibe 3.1.0).
  interrupt: { key: "Escape", stopped: /Interrupted · What should Vibe do instead\?/ },

  async gracefulExit(sessionId, runtime) { await runtime.sendKeys(sessionId, "/exit"); },
};
