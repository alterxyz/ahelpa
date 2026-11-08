import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vibeDriver as driver, checkVibeReadiness, vibeAgentToml } from "../src/drivers/vibe";
import { getDriver } from "../src/drivers/registry";
import { resolveLaunchProfile } from "../src/launch-profiles";
import type { DriverRuntime } from "../src/drivers/types";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(realpathSync(tmpdir()), "vibe-driver-test-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function runtime(screens: string[]): DriverRuntime & { sent: string[]; captures: number } {
  return { sent: [], captures: 0, async capture() { return screens[Math.min(this.captures++, screens.length - 1)]; },
    async sleep() {}, async sendKey(_id, key) { this.sent.push(key); }, async sendKeys(_id, text) { this.sent.push(text); } };
}
function fakeVibe(dir: string, version = "3.1.0") {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "vibe");
  writeFileSync(file, `#!/bin/sh\nprintf executed > "$HOME/executed-marker"\nexit 99\n`);
  chmodSync(file, 0o755);
  const info = join(dir, "../lib/python3.14/site-packages", `mistral_vibe-${version}.dist-info`);
  mkdirSync(info, { recursive: true });
  writeFileSync(join(info, "METADATA"), `Name: mistral-vibe\nVersion: ${version}\n`);
  return file;
}

// Screens as Vibe 3.1.0 draws them in an 80x24 tmux pane (spike, 2026-11-07).
const banner = ["    ⢀⠔⠒⠒⡔⢄⠔⡄  Mistral Vibe v3.1.0", "⢔⣒⣒⣒⡇  ⠰⣁⡐⣔⡱  Mistral Large 4[high] · Student", "   ⠸⠤⠤⠤⠭⠦⠵⠬⠆  Type /help for more information", ""];
const composer = (typed = "") => ["──────────────────────────────────────── Mistral Large 4[high] · ahelpa helper ─",
  typed ? `> ${typed}` : ">", "", "", "─".repeat(80), "…/project ⧉   usage ▁ 4% · ctx ▁ 4%"];
const task = (name = "task") => ["> Please read and complete the task described in",
  `  /tmp/project/.ahelpa/mistral-0123456789ab/${name}.md. When you are finished, output [AHELPA:DONE] on its`,
  "  own line.", "─".repeat(79), ""];
const spinner = "⠴ Generating… (3s Esc/Ctrl+C to interrupt)";
const progress = "□ Reading 1 file, running 1 command, thinking";
const answer = (...lines: string[]) => ["⏵ Read 1 file, ran 1 command, wrote 1 file, thought", "", ...lines.map(line => line && `  ${line}`), ""];
const screen = (...parts: string[][]) => parts.flat().join("\n");
const readyScreen = screen(banner, composer());
const workingScreen = screen(banner, task(), [progress, spinner], composer());
const doneScreen = screen(banner, task(), answer("Wrote summary.md.", "", "[AHELPA:DONE]"), composer());

test("vibe is registered with the Large 4 high default", () => {
  expect(getDriver("vibe")).toBe(getDriver("mistral"));
  expect(resolveLaunchProfile(driver, {})).toEqual({ role: "worker", model: "mistral-large-4-0-3", effort: "high" });
  expect(resolveLaunchProfile(driver, { role: "reviewer", effort: "high" })).toEqual({ role: "reviewer", model: "mistral-large-4-0-3", effort: "high" });
  expect(() => resolveLaunchProfile(driver, { role: "advisor" })).toThrow('does not support role "advisor"');
  for (const model of ["glm-5-3", "zai-glm-5-3-flash"]) {
    expect(driver.modelCatalog.models.find(entry => entry.name === model)?.defaultEffort).toBe("high");
  }
  expect(driver.resumeTokenAvailableAfterSubmit).toBe(false);
});

test("vibe launch writes a private agent file in the pane and starts the TUI with session-only trust", async () => {
  const cwd = root(); const project = join(cwd, "project's files"); const deliveryDir = join(cwd, "results");
  mkdirSync(project); mkdirSync(deliveryDir);
  const bin = join(cwd, "bin"); mkdirSync(bin);
  // A stand-in vibe records what the pane gave it; the real TUI never starts.
  writeFileSync(join(bin, "vibe"), `#!/bin/sh\n{ printf '%s\\n' "$@"; umask; pwd; env | grep '^VIBE_' | sort; } > "${join(cwd, "argv")}"\n`, { mode: 0o755 });
  const run = async (command: string) => {
    const proc = Bun.spawn(["bash", "-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(await proc.exited).toBe(0);
    return readFileSync(join(cwd, "argv"), "utf8").split("\n");
  };
  const launch = await run(`umask 022; ${driver.buildLaunchCommand({ cwd: project, deliveryDir, model: "mistral-large-4-0-3", effort: "high" })}`);
  expect(launch.slice(0, 5)).toEqual(["--trust", "--agent", "ahelpa-helper", "0022", realpathSync(project)]);
  expect(launch).toContain(`VIBE_AGENT_PATHS=${JSON.stringify([deliveryDir])}`);
  expect(launch).toContain("VIBE_ENABLE_AUTO_UPDATE=false");
  expect(launch).toContain("VIBE_ENABLE_UPDATE_CHECKS=false");
  const agent = join(deliveryDir, "ahelpa-helper.toml");
  expect(statSync(agent).mode & 0o777).toBe(0o600);
  expect(readFileSync(agent, "utf8")).toBe(vibeAgentToml({ model: "mistral-large-4-0-3", effort: "high" }));
  rmSync(agent);
  const id = "d68ff081-471f-e406-e656-19de4c5781d5";
  const resume = await run(driver.buildResumeCommand({ cwd: project, deliveryDir, resumeId: id, model: "deepseek-v4-1-flash-1017" }));
  expect(resume.slice(0, 5)).toEqual(["--trust", "--agent", "ahelpa-helper", "--resume", id]);
  expect(readFileSync(agent, "utf8")).toContain('name = "deepseek-v4-1-flash-1017"');
  expect(driver.buildLaunchCommand({ cwd: "/tmp/project", sessionId: "mistral-0123456789ab" }))
    .toContain("'/tmp/project/.ahelpa/mistral-0123456789ab/ahelpa-helper.toml'");
});

test("vibe agent files select the model and thinking, with full definitions for models Vibe does not ship", () => {
  expect(vibeAgentToml({})).toBe('safety = "yolo"\nbypass_tool_permissions = true\n');
  expect(Bun.TOML.parse(vibeAgentToml({ model: "mistral-medium-3.5", effort: "off" }))).toEqual({
    safety: "yolo", bypass_tool_permissions: true, active_model: "mistral-medium-3.5",
    models: { "mistral-medium-3.5": { thinking: "off" } },
  });
  expect(Bun.TOML.parse(vibeAgentToml({ effort: "low" }))).toMatchObject({
    active_model: "mistral-large-4-0-3", models: { "mistral-large-4-0-3": { thinking: "low" } },
  });
  expect(Bun.TOML.parse(vibeAgentToml({ model: "glm-5-3" }))).toEqual({ safety: "yolo", bypass_tool_permissions: true, active_model: "glm-5-3" });
  const deepseek = { name: "deepseek-v4-1-flash-1017", provider: "mistral", thinking_levels: ["low", "high", "max"],
    max_context_length: 1048576, max_output_tokens: 131072 };
  expect(Bun.TOML.parse(vibeAgentToml({ model: "deepseek-v4-1-flash-1017" }))).toMatchObject({ models: { "deepseek-v4-1-flash-1017": deepseek } });
  expect(Bun.TOML.parse(vibeAgentToml({ model: "deepseek-v4-1-flash-1017", effort: "max" })))
    .toMatchObject({ models: { "deepseek-v4-1-flash-1017": { ...deepseek, thinking: "max" } } });
});

test("vibe validates model and effort before launch", () => {
  const launch = (opts: object) => driver.buildLaunchCommand({ cwd: "/tmp/project", ...opts });
  expect(() => launch({ safe: true })).toThrow("--safe is not supported");
  expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: "d68ff081", safe: true })).toThrow("--safe");
  expect(() => launch({ model: "gemini 4" })).toThrow("model alias");
  expect(() => launch({ effort: "minimal" })).toThrow("off, low, medium, high, max");
  expect(() => launch({ model: 'alias"\nmalicious' })).toThrow("model alias");
  expect(() => launch({ model: "mistral-medium-3.5", effort: "off" })).not.toThrow();
  expect(() => driver.prepareLaunchFiles!({ cwd: "/tmp/project", safe: true })).toThrow("--safe");
});

test("vibe reads the composer, work and the latest turn's signal from the screen", () => {
  expect(driver.acceptsInput!(readyScreen)).toBe(true);
  expect(driver.detectActivity(readyScreen)).toBe("idle");
  expect(driver.detectStatus(readyScreen)).toBe("running");
  expect(driver.detectActivity(workingScreen)).toBe("working");
  expect(driver.acceptsInput!(workingScreen)).toBe(false);
  expect(driver.detectStatus(workingScreen)).toBe("running");
  expect(driver.detectOutcome(doneScreen)).toEqual({ status: "idle", needHelpTags: null });
  expect(driver.acceptsInput!(doneScreen)).toBe(true);
  // The scrollbar thumb can sit on the sentinel's row in the last column.
  const thumb = doneScreen.replace("\n  [AHELPA:DONE]\n", `\n  [AHELPA:DONE]${" ".repeat(64)}▆\n`);
  expect(thumb).not.toBe(doneScreen);
  expect(driver.detectStatus(thumb)).toBe("idle");
  expect(driver.detectStatus(screen(banner, task(), answer("[AHELPA:DONE]"), [progress, spinner], composer()))).toBe("running");
  expect(driver.detectOutcome(screen(banner, task(), answer("Blocked.", "", "[AHELPA:NEED_HELP:review,Input,review]"), composer())))
    .toEqual({ status: "error", needHelpTags: ["review", "input"] });
  // The echoed instruction names the signal inline, and a resumed screen keeps old turns.
  expect(driver.detectStatus(screen(banner, task(), composer()))).toBe("running");
  expect(driver.detectStatus(screen(task("old"), answer("[AHELPA:DONE]"), task("new"), [spinner], composer()))).toBe("running");
  expect(driver.detectStatus(screen(task("old"), answer("[AHELPA:DONE]"), task("new"), answer("Done."), composer()))).toBe("running");
  // Vibe renders Markdown: a sentinel after a single newline joins the paragraph and is not a signal.
  expect(driver.detectStatus(screen(banner, task(), answer("spike-ok [AHELPA:DONE]"), composer()))).toBe("running");
  // Esc keeps the session and returns to the composer.
  const interrupted = screen(banner, task(), ["⏵ Ran 1 command, thought", "  ⎣ Interrupted · What should Vibe do instead?", ""], composer());
  expect(driver.acceptsInput!(interrupted)).toBe(true);
  expect(driver.detectActivity(interrupted)).toBe("idle");
  // Text typed into the composer is not yet a turn and is not an empty composer.
  expect(driver.acceptsInput!(screen(banner, composer("If your task is finished")))).toBe(false);
});

test("vibe waits for its session agent and reports a model the subscription lacks", async () => {
  // Startup draws the default agent while it initializes; typing then would run without the session agent.
  const booting = screen(banner, ["■ Resuming session…", " ⠇ Initializing…"],
    ["───────────────────────────────────────── Mistral Large 4[high] · accept edits ─", ">", "", "─".repeat(80), "…/project ⧉   ctx   0%"]);
  expect(driver.acceptsInput!(booting)).toBe(false);
  const io = runtime([booting, readyScreen]);
  await driver.prepareForResume("test", io);
  expect(io.captures).toBe(2);
  const failed = screen(banner, task(), ["✕ Error: API error occurred: Status 400. Body:", '  {"object":"error","message":"Invalid model:',
    '  deepseek-v4-1-flash-1017","type":"invalid_mo', '  del","param":null,"code":"1500","raw_status_code":400}', "  Run /retry [additional instructions] to try again.", ""],
    composer().map(line => line.replace("Mistral Large 4[high]", "deepseek-v4-1-flash-1017[high]")));
  expect(driver.detectOutcome(failed)).toEqual({ status: "needs_attention", needHelpTags: null,
    reason: "model unavailable (the Mistral subscription may not include it)" });
  expect(getDriver("deepseek-vibe").detectOutcome(failed).reason).toBe(getDriver("deepseek").detectOutcome(failed).reason);
  expect(driver.detectStatus(failed.replace("Run /retry", `Run /retry\n${spinner}`))).toBe("running");
  expect(driver.detectStatus(screen(banner, task(), ["✕ Error: API error occurred: Status 500.", ""], composer()))).toBe("running");
  expect(driver.detectStatus(screen(banner, task(), ["✕ Error: invalid_model", ""], answer("[AHELPA:DONE]"), composer()))).toBe("idle");
});

test("vibe treats the question dialog and screens without a composer as needing a human", () => {
  const question = screen(banner, task(), ["⏵ Thought", "", "□ Asking Which color do you prefer?", "",
    "⡆  User input required… (1s Esc/Ctrl+C to interrupt)",
    "┌──────────────────────────────────────────────────────────────────────────────┐",
    "│ Which color do you prefer?                                                   │",
    "│   1. Red - Warm, bold, energetic                                             │",
    "│ ↑↓/jk navigate  Enter select  Esc cancel                                     │",
    "└──────────────────────────────────────────────────────────────────────────────┘",
    "…/project ⧉   usage ▁ 4% · ctx ▁ 4%"]);
  expect(driver.detectActivity(question)).toBe("idle");
  expect(driver.acceptsInput!(question)).toBe(false);
  expect(driver.detectStatus(question)).toBe("running");
  expect(driver.detectActivity("$ ")).toBe("idle");
  expect(driver.acceptsInput!("")).toBe(false);
});

test("vibe takes its resume ID from the exit message only", async () => {
  const exit = "Total tokens used this session: input=181,868 output=714 (total=182,582)\nTo continue this session, run: vibe --continue\nOr: vibe --resume d68ff081\n";
  expect(driver.extractResumeToken(exit)).toBe("d68ff081");
  expect(driver.extractResumeToken("Or: vibe --resume d68ff081-471f-e406-e656-19de4c5781d5")).toBe("d68ff081-471f-e406-e656-19de4c5781d5");
  expect(driver.extractResumeToken(doneScreen)).toBeNull();
  expect(driver.extractResumeToken("  • /branch, /fork: Resume the copy with vibe --resume <id>.")).toBeNull();
  expect(driver.extractResumeToken("  Or: vibe --resume deadbeef")).toBeNull();
  await expect(driver.switchModel("test", runtime([]), { model: "mistral-large-4-0-3" })).rejects.toThrow("not supported");
  const io = runtime([]); await driver.gracefulExit("test", io); expect(io.sent).toEqual(["/exit"]);
});

test("vibe submission requires a new turn and startup is bounded", async () => {
  const submitted = screen(banner, task(), composer());
  expect(await driver.afterTaskSubmitted("test", runtime([submitted]), { beforeOutput: readyScreen })).toBe(true);
  const idle = runtime([doneScreen]);
  expect(await driver.afterTaskSubmitted("test", idle, { beforeOutput: doneScreen })).toBe(false);
  expect(idle.captures).toBe(20);
  // A follow-up can scroll the old turn away; the start of work still proves the new turn.
  const followUp = screen(answer("[AHELPA:DONE]"), [spinner], composer());
  expect(await driver.afterTaskSubmitted("test", runtime([followUp]), { beforeOutput: screen(answer("[AHELPA:DONE]"), composer()) })).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([workingScreen]))).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([submitted]))).toBe(false);
  await driver.prepareForTask("test", runtime(["", screen(banner), readyScreen]));
  await driver.prepareForResume("test", runtime([screen(task(), answer("[AHELPA:DONE]"), ["✓ Resumed session d68ff081.", ""], composer())]));
  const fallback = screen(banner, ["┌─ Warnings ───────────────────────────────────────────────────────────────────┐",
    "│ • Model 'no-such-alias' is not available — running 'Mistral Large 4'. Pick   │", "└──────────────────────────────────────────────────────────────────────────────┘"], composer());
  await expect(driver.prepareForTask("test", runtime([fallback]))).rejects.toThrow("vibe model no-such-alias is not available");
  const io = runtime([screen(banner)]);
  await expect(driver.prepareForTask("test", io)).rejects.toThrow("input prompt");
  expect(io.captures).toBe(60);
});

test.each(["3.0.0", "3.1.0", "3.2.0"])("vibe doctor reads installed version %s without executing vibe", version => {
  const cwd = root(); const bin = join(cwd, "bin");
  fakeVibe(bin, version);
  const result = checkVibeReadiness(cwd, { homeDir: cwd, env: { PATH: bin } });
  expect(result.version).toBe(version);
  expect(result.locally_ready).toBe(version === "3.0.0" ? false : "unknown");
  expect(result.reasons.join(" ")).toContain(version === "3.0.0" ? "upgrade vibe to >= 3.1.0" : "verified at first turn");
  expect(result.reasons.join(" ")).not.toContain("Node.js");
  expect(existsSync(join(cwd, "executed-marker"))).toBe(false);
});

test("vibe doctor reports missing and unknown installations without executing them", () => {
  const cwd = root();
  expect(checkVibeReadiness(cwd, { homeDir: cwd, env: { PATH: cwd } }).locally_ready).toBe(false);
  writeFileSync(join(cwd, "vibe"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  expect(checkVibeReadiness(cwd, { homeDir: cwd, env: { PATH: cwd } }).version).toBeNull();
});
