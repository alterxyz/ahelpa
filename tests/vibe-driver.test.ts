import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vibeDriver as driver, checkVibeReadiness, prepareVibeFiles } from "../src/drivers/vibe";
import { getDriver } from "../src/drivers/registry";
import { resolveLaunchProfile } from "../src/launch-profiles";
import type { DriverRuntime } from "../src/drivers/types";

const id = "11111111-1234-1234-1234-123456789abc";
const first = "aaaaaaaa-1234-1234-1234-123456789abc";
const second = "bbbbbbbb-1234-1234-1234-123456789abc";
const frame = (state: string, turn = first) => `[AHELPA_VIBE_SESSION:${id}]\n[AHELPA_VIBE_TURN:${turn}]\n[AHELPA_VIBE_STATE:${state}]\n`;
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

test("vibe is registered with the Large 4 high default", () => {
  expect(getDriver("vibe")).toBe(driver);
  expect(resolveLaunchProfile(driver, {})).toEqual({ role: "worker", model: "mistral-large-4-0-3", effort: "high" });
  expect(resolveLaunchProfile(driver, { role: "reviewer", effort: "high" })).toEqual({ role: "reviewer", model: "mistral-large-4-0-3", effort: "high" });
  expect(() => resolveLaunchProfile(driver, { role: "advisor" })).toThrow('does not support role "advisor"');
  for (const model of ["glm-5-3", "zai-glm-5-3-flash"]) {
    expect(driver.modelCatalog.models.find(entry => entry.name === model)?.defaultEffort).toBe("high");
  }
});

test("vibe quotes all arguments and uses the supplied result directory", () => {
  const command = driver.buildLaunchCommand({ cwd: "/tmp/project's files", deliveryDir: "/tmp/results", model: "mistral-large-4-0-3", effort: "high" });
  expect(command).toBe("cd '/tmp/project'\\''s files' && node '/tmp/results/vibe-terminal.mjs' --cwd '/tmp/project'\\''s files' --model 'mistral-large-4-0-3' --effort 'high'");
  const resume = driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id });
  expect(resume).toContain(`--resume '${id}'`);
  expect(resume).not.toContain("--model");
  const changed = driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id, model: "glm-5-3", effort: "low" });
  expect(changed).toContain(`--resume '${id}' --model 'glm-5-3' --effort 'low'`);
});

test("vibe validates model and effort before launch", () => {
  const launch = (opts: object) => driver.buildLaunchCommand({ cwd: "/tmp/project", ...opts });
  expect(() => launch({ safe: true })).toThrow("--safe is not supported");
  expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id, safe: true })).toThrow("--safe");
  expect(() => launch({ model: "gemini 4" })).toThrow("model alias");
  expect(() => launch({ effort: "minimal" })).toThrow("off, low, medium, high, max");
  expect(() => launch({ model: 'alias"\nmalicious' })).toThrow("model alias");
  expect(() => launch({ model: "mistral-medium-3.5", effort: "off" })).not.toThrow();
});

test("vibe prepares only the private bridge before launch options reach startup", () => {
  const cwd = root(); const deliveryDir = join(cwd, "results");
  prepareVibeFiles({ cwd, deliveryDir });
  expect(readFileSync(join(deliveryDir, "vibe-terminal.mjs"), "utf8")).toContain("createVibeTerminal");
  const agent = join(deliveryDir, "ahelpa-helper.toml");
  expect(existsSync(agent)).toBe(false);
  expect(statSync(join(deliveryDir, "vibe-terminal.mjs")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(cwd, ".agents"))).toBe(false);
  expect(() => prepareVibeFiles({ cwd, deliveryDir, safe: true })).toThrow("--safe");
});

test("vibe reads only the latest complete turn frame and current help tags", async () => {
  expect(driver.detectStatus("[AHELPA:DONE]\n")).toBe("running");
  expect(driver.detectStatus("[AHELPA:DONE]\n" + frame("error"))).toBe("error");
  expect(driver.detectStatus("[AHELPA:NEED_HELP]\n" + frame("idle"))).toBe("idle");
  expect(driver.detectStatus(frame("idle") + `[AHELPA_VIBE_TURN:${second}]\n`)).toBe("running");
  for (const state of ["idle", "error", "needs_attention"] as const) expect(driver.detectStatus(frame(state))).toBe(state);
  expect(driver.extractResumeToken(frame("ready"))).toBe(id);
  expect(driver.detectActivity("loading")).toBe("booting");
  expect(driver.detectActivity(frame("running"))).toBe("working");
  expect(driver.acceptsInput!(frame("running"))).toBe(false);
  expect(driver.acceptsInput!(frame("error"))).toBe(false);
  expect(driver.acceptsInput!(frame("needs_attention"))).toBe(true);
  const help = `[AHELPA_VIBE_TURN:${first}]\n[AHELPA_VIBE_TAGS:review,input,review]\n[AHELPA_VIBE_STATE:error]\n`;
  expect(driver.detectOutcome(help)).toEqual({ status: "error", needHelpTags: ["review", "input"] });
  expect(driver.detectOutcome(help + frame("idle", second))).toEqual({ status: "idle", needHelpTags: null });
  await expect(driver.switchModel("test", runtime([]), { model: "mistral-large-4-0-3-high" })).rejects.toThrow("not supported");
  const io = runtime([]); await driver.gracefulExit("test", io); expect(io.sent).toEqual(["/exit"]);
});

test("vibe submission requires a new turn and startup is bounded", async () => {
  const beforeOutput = frame("idle");
  expect(await driver.afterTaskSubmitted("test", runtime([beforeOutput]), { beforeOutput })).toBe(false);
  expect(await driver.afterTaskSubmitted("test", runtime([frame("idle", second)]), { beforeOutput })).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([frame("running", second)]))).toBe(true);
  await driver.prepareForTask("test", runtime(["loading", frame("ready")]));
  await expect(driver.prepareForResume("test", runtime([frame("error")]))).rejects.toThrow("failed to start");
  const io = runtime(["loading"]);
  await expect(driver.prepareForTask("test", io)).rejects.toThrow("input prompt");
  expect(io.captures).toBe(120);
});

test("vibe submission waits for delayed native session identity but exposes bootstrap failures", async () => {
  const beforeOutput = "[AHELPA_VIBE_STATE:ready]\n";
  const starting = `[AHELPA_VIBE_TURN:${first}]\n[AHELPA_VIBE_STATE:running]\n`;
  const io = runtime([...Array(12).fill(starting), frame("running")]);
  expect(await driver.afterTaskSubmitted("test", io, { beforeOutput })).toBe(true);
  expect(io.captures).toBe(13);
  const stalled = runtime([starting]);
  expect(await driver.afterTaskSubmitted("test", stalled, { beforeOutput })).toBe(true);
  expect(stalled.captures).toBe(120);
  for (const state of ["error", "needs_attention"]) {
    const failed = runtime([starting.replace("STATE:running", `STATE:${state}`)]);
    expect(await driver.afterTaskSubmitted("test", failed, { beforeOutput })).toBe(true);
    expect(failed.captures).toBe(1);
  }
});

test.each(["3.0.0", "3.1.0", "3.2.0"])("vibe doctor reads installed version %s without executing vibe", version => {
  const cwd = root(); const bin = join(cwd, "bin");
  fakeVibe(bin, version);
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 99\n"); chmodSync(join(bin, "node"), 0o755);
  const result = checkVibeReadiness(cwd, { homeDir: cwd, env: { PATH: bin } });
  expect(result.version).toBe(version);
  expect(result.locally_ready).toBe(version === "3.0.0" ? false : "unknown");
  expect(result.reasons.join(" ")).toContain(version === "3.0.0" ? "upgrade vibe to >= 3.1.0" : "verified at first turn");
  expect(existsSync(join(cwd, "executed-marker"))).toBe(false);
  rmSync(join(bin, "node"));
  expect(checkVibeReadiness(cwd, { homeDir: cwd, env: { PATH: bin } }).reasons).toContain("Node.js is required for the vibe streaming bridge");
});

test("vibe doctor reports missing and unknown installations without executing them", () => {
  const cwd = root();
  expect(checkVibeReadiness(cwd, { homeDir: cwd, env: { PATH: cwd } }).locally_ready).toBe(false);
  writeFileSync(join(cwd, "vibe"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  expect(checkVibeReadiness(cwd, { homeDir: cwd, env: { PATH: cwd } }).version).toBeNull();
});
