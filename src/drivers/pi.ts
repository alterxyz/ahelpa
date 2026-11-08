import { realpathSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { defaultRuntimeLayout } from "../runtime-layout";
import { shellEscape } from "../shell";
import { turnHookCommand } from "../turn-hooks";
import { addReadiness, executableReadiness, findReadinessExecutable, isVersion, readLocalConfig, readPackageVersion, readinessRuntime } from "./readiness";
import { scanSentinels } from "./sentinels";
import type { AgentDriver, DetectedOutcome, DriverRuntime, LaunchOptions, ReadinessRuntime } from "./types";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Pi's fullscreen TUI (verified on 1.5.0): the transcript, padded one column,
// then the editor between two column-0 `─` borders, then a two-line footer.
// A running turn puts a braille spinner in the editor's top border:
// `── ⠼ Working ───` (retry and compaction use the same spinner).
const SPINNER = /^─+ ?[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;
const RESUME_HINT = /To resume this session:\s+pi\b.*?\s--session\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
// Startup exits print at column 0 before the TUI starts; a session found in
// another project asks to fork it, which only a human may answer.
const STARTUP_FAILURE = /^(?:Error: .+|No session found matching .+|Fork this session into current directory\?.*)$|^ ?Warning: Model ".+" not found for provider .+$/m;
const RUNNING: DetectedOutcome = { status: "running", needHelpTags: null };

// prepareForTask receives no launch options, yet only the footer shows the
// model and thinking level Pi applied. command() leaves them here for the
// startup check in the same launcher process.
// ponytail: one entry per launch, removed when read; a launcher that fails before startup leaves one small entry.
const requested = new Map<string, { model?: string; effort?: string }>();

function editor(output: string) {
  const lines = output.split("\n");
  const bottom = lines.findLastIndex(line => line.startsWith("─"));
  const top = bottom < 0 ? -1 : lines.slice(0, bottom).findLastIndex(line => line.startsWith("─"));
  return top < 0 ? null : { lines, top, bottom, working: SPINNER.test(lines[top]) };
}

// Only the footer may follow the editor: after /quit or a crash the last
// frame stays on screen above the resume hint and the shell prompt.
function composerReady(output: string): boolean {
  const box = editor(output);
  return box !== null && !box.working && box.bottom - box.top === 2 && box.lines[box.top + 1].trim() === ""
    && box.lines.length - box.bottom - 1 <= 2;
}

// A turn Pi gave up on ends with its own block, ` Error: 503: {provider JSON}`
// wrapped over lines; Escape ends it with ` Error: This operation was aborted`.
// The host chooses retry or another route from the status code. Only
// whitelisted codes reach the reason: provider text may name the account.
function turnFailure(transcript: string[]): string | undefined {
  const end = transcript.findLastIndex(line => line.trim());
  const first = transcript[transcript.slice(0, end + 1).findLastIndex(line => !line.trim()) + 1] ?? "";
  if (first === " Error: This operation was aborted") return "Pi: turn aborted";
  const code = first.match(/^ Error: (\d{3}): /)?.[1];
  if (!code) return undefined;
  const kind = ["503", "529"].includes(code) ? "provider overloaded" : code === "429" ? "rate limited"
    : ["401", "403"].includes(code) ? "authentication failed" : undefined;
  return kind ? `Pi: ${kind} (${code})` : "Pi: native turn failed";
}

// A user message has no text marker, so the current turn is what the
// transcript ends with: a signal counts only as its last line, with no spinner.
function outcome(output: string): DetectedOutcome {
  const box = editor(output);
  if (!box || box.working || box.lines.length - box.bottom - 1 > 2) return RUNNING;
  const transcript = box.lines.slice(0, box.top);
  const tail = transcript.findLast(line => line.trim());
  const signal = tail === undefined ? undefined : scanSentinels(tail)[0];
  if (signal) return { status: signal.status, needHelpTags: signal.needHelpTags };
  const reason = turnFailure(transcript);
  return reason ? { status: "needs_attention", needHelpTags: null, reason } : RUNNING;
}

function validate(opts: LaunchOptions): void {
  if (opts.safe) throw new Error("Pi --safe is not supported; the helper requires full local permissions");
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

// The turn-end hook: a one-file extension in the session's result directory,
// loaded with -e (--no-extensions still loads an explicit file, and nothing is
// saved to Pi's settings). `agent_settled` fires once per prompt, after retries
// and compaction, also after an error or Escape; `turn_end` (per model request)
// and `agent_end` (Pi may still continue) are not final. Plain ESM so Pi's jiti
// loader imports it natively without a transform cache.
function hookPath(opts: LaunchOptions & { sessionId: string }): string {
  return join(opts.deliveryDir ?? defaultRuntimeLayout.sessionDeliveryDir(opts.cwd, opts.sessionId), "pi-turn-hook.mjs");
}

export function piTurnHookSource(command: string[]): string {
  return `import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const command = ${JSON.stringify(command)};
export default function (pi) {
  let input, stopReason;
  pi.on("input", event => { input = event.text; stopReason = undefined; });
  pi.on("message_end", event => { if (event.message?.role === "assistant") stopReason = event.message.stopReason; });
  pi.on("agent_settled", (event, ctx) => {
    const payload = JSON.stringify({ type: "agent_settled", sessionId: ctx.sessionManager.getSessionId(), turnId: randomUUID(),
      aborted: event.aborted === true, stopReason, input });
    input = stopReason = undefined;
    try {
      const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(payload);
    } catch {}
  });
}
`;
}

function command(opts: LaunchOptions, resumeId?: string): string {
  validate(opts);
  // `--session` also takes paths and ID prefixes; a stored ID must name exactly one session.
  if (resumeId !== undefined && !UUID.test(resumeId)) throw new Error("Pi resume ID must be a native session UUID");
  if (opts.sessionId) requested.set(opts.sessionId, { model: opts.model, effort: opts.effort });
  // --offline: no startup update or catalog checks. --approve: trust project
  // files for this run only, without the dialog or a saved decision.
  const args = ["--tui-mode", "fullscreen", "--offline", "--approve", "--no-extensions", "--no-mcp"];
  if (opts.sessionId) args.push("-e", shellEscape(hookPath({ ...opts, sessionId: opts.sessionId })));
  if (resumeId !== undefined) args.push("--session", shellEscape(resumeId));
  if (opts.model !== undefined) args.push("--model", shellEscape(opts.model));
  if (opts.effort !== undefined) args.push("--thinking", shellEscape(opts.effort));
  return `cd ${shellEscape(opts.cwd)} && pi ${args.join(" ")}`;
}

// The footer's right side: `[(provider) ]model[ • level]`. Pi clamps an
// unsupported thinking level without a warning; this is where it shows.
function verifyModel(output: string, expected: { model?: string; effort?: string } | undefined): void {
  const right = output.split("\n").at(-1)?.match(/ {2,}(\S.*)$/)?.[1];
  if (!expected || !right) return;
  const applied = right.replace(/^\([^)]*\) /, "").split(" → ")[0];
  const [model, level = "none"] = applied.split(" • ");
  const wantModel = expected.model?.slice(expected.model.indexOf("/") + 1);
  const wantLevel = expected.effort === "off" ? "thinking off" : expected.effort;
  if ((wantModel !== undefined && model !== wantModel) || (wantLevel !== undefined && level !== wantLevel)) {
    throw new Error(`Pi applied ${applied} instead of the requested ${[wantModel, expected.effort].filter(Boolean).join(" / ")}`);
  }
}

async function waitReady(sessionId: string, runtime: DriverRuntime): Promise<void> {
  const expected = requested.get(sessionId);
  requested.delete(sessionId);
  for (let attempt = 0; attempt < 30; attempt++) {
    await runtime.sleep(1000);
    const output = await runtime.capture(sessionId, 60);
    const failure = output.match(STARTUP_FAILURE)?.[0];
    if (failure) throw new Error(`Pi session ${sessionId} could not start: ${failure.trim()}`);
    if (!composerReady(output)) continue;
    verifyModel(output, expected);
    return;
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
  if (!findReadinessExecutable("node", cwd, runtime)) addReadiness(result, false, "Node.js is required to run Pi");
  if (!executable) return result;
  if (result.version) {
    const [major, minor, patch] = result.version.split(/[.+-]/).map(Number);
    if (major < 1 || (major === 1 && minor < 4) || (major === 1 && minor === 4 && patch === 0 && /^\d+\.\d+\.\d+-/.test(result.version))) {
      addReadiness(result, false, "upgrade Pi to >= 1.4.0");
    }
  }
  addReadiness(result, "unknown", "Pi credentials and effective model are validated at launch; the terminal driver is tested with 1.5.0");
  return result;
}

export const piDriver: AgentDriver = {
  name: "pi", sessionPrefix: "pi",
  // The native ID appears in the exit hint, which the daemon reads while draining.
  resumeTokenAvailableAfterSubmit: false,
  checkReadiness: checkPiReadiness,
  turnHooks: true,
  prepareLaunchFiles(opts) {
    if (!opts.sessionId) return;
    const path = hookPath({ ...opts, sessionId: opts.sessionId });
    writeFileSync(path, piTurnHookSource(turnHookCommand(dirname(path), "pi")), { flag: "wx", mode: 0o600 });
  },
  launchProfiles: { defaultRole: "worker", profiles: { worker: {}, reviewer: {} } },
  modelCatalog: { models: [],
    effortNote: "Pi uses its native configured model and thinking level. --model <provider>/<model> selects an exact model; --effort support is model-dependent and verified at startup. Runtime model switching and --safe are not supported." },
  buildLaunchCommand: opts => command(opts),
  buildResumeCommand: opts => command(opts, opts.resumeId),
  extractResumeToken(output) { return output.match(RESUME_HINT)?.[1] ?? null; },
  prepareForTask: waitReady, prepareForResume: waitReady,
  async afterTaskSubmitted(sessionId, runtime, context) {
    const before = context?.beforeOutput;
    for (let attempt = 0; attempt < 10; attempt++) {
      await runtime.sleep(500);
      const output = await runtime.capture(sessionId, 80);
      if (editor(output)?.working) return true;
      // A turn that settled before the first probe ends the transcript with a new signal.
      if (before !== undefined && outcome(before).status === "running" && outcome(output).status !== "running") return true;
    }
    return false;
  },
  async switchModel() { throw new Error("Pi runtime model switching is not supported; launch with --model and --effort instead"); },
  detectStatus: output => outcome(output).status,
  detectOutcome: outcome,
  detectActivity: output => editor(output)?.working ? "working" : "idle",
  acceptsInput: composerReady,
  // Esc aborts the turn and its tool and keeps the session (2026-11-07, Pi 1.5.0).
  interrupt: { key: "Escape", stopped: /^ Error: This operation was aborted\b/m },

  async gracefulExit(sessionId, runtime) { await runtime.sendKeys(sessionId, "/quit"); },
};
