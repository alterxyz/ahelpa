import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { agyDriver as driver, checkAgyReadiness, prepareAgyFiles } from "../src/drivers/agy";
import { getDriver } from "../src/drivers/registry";
import { resolveLaunchProfile } from "../src/launch-profiles";
import type { DriverRuntime } from "../src/drivers/types";

const id = "11111111-1234-1234-1234-123456789abc";
const first = "aaaaaaaa-1234-1234-1234-123456789abc";
const second = "bbbbbbbb-1234-1234-1234-123456789abc";
const frame = (state: string, turn = first) => `[AHELPA_AGY_SESSION:${id}]\n[AHELPA_AGY_TURN:${turn}]\n[AHELPA_AGY_STATE:${state}]\n`;
const roots: string[] = [];
function root() { const path = mkdtempSync(join(realpathSync(tmpdir()), "agy-driver-test-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function runtime(screens: string[]): DriverRuntime & { sent: string[]; captures: number } {
  return { sent: [], captures: 0, async capture() { return screens[Math.min(this.captures++, screens.length - 1)]; },
    async sleep() {}, async sendKey(_id, key) { this.sent.push(key); }, async sendKeys(_id, text) { this.sent.push(text); } };
}
// A fake Go binary: agy's version sits next to the build date in its string table.
function fakeAgy(dir: string, version = "1.5.2") {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "agy");
  writeFileSync(file, `#!/bin/sh\nprintf executed > "$HOME/executed-marker"\nexit 99\n# false${version}\nDate: 2026\n`);
  chmodSync(file, 0o755);
  return file;
}

test("agy is registered with the Gemini 4 Argon medium default", () => {
  expect(getDriver("agy")).toBe(driver);
  expect(resolveLaunchProfile(driver, {})).toEqual({ role: "worker", model: "gemini-4-argon", effort: "medium" });
  expect(resolveLaunchProfile(driver, { role: "reviewer", effort: "high" })).toEqual({ role: "reviewer", model: "gemini-4-argon", effort: "high" });
  expect(() => resolveLaunchProfile(driver, { role: "advisor" })).toThrow('does not support role "advisor"');
});

test("agy quotes all arguments and uses the supplied result directory", () => {
  const command = driver.buildLaunchCommand({ cwd: "/tmp/project's files", deliveryDir: "/tmp/results", model: "gemini-4-argon", effort: "high" });
  expect(command).toBe("cd '/tmp/project'\\''s files' && node '/tmp/results/agy-terminal.mjs' --cwd '/tmp/project'\\''s files' --model 'gemini-4-argon' --effort 'high'");
  const resume = driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id });
  expect(resume).toContain(`--resume '${id}'`);
  expect(resume).not.toContain("--model");
});

test("agy validates model and effort before launch", () => {
  const launch = (opts: object) => driver.buildLaunchCommand({ cwd: "/tmp/project", ...opts });
  expect(() => launch({ safe: true })).toThrow("--safe is not supported");
  expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id, safe: true })).toThrow("--safe");
  expect(() => launch({ model: "gemini 4" })).toThrow("agy models");
  expect(() => launch({ effort: "minimal" })).toThrow("low, medium, high, xhigh, max");
  // A suffixed ID carries its effort; agy itself refuses a contradiction.
  expect(() => launch({ model: "gemini-4-argon-high", effort: "medium" }))
    .toThrow("pass --effort high, or --model gemini-4-argon --effort medium");
  expect(launch({ model: "gemini-4-argon-high", effort: "high" })).toContain("--model 'gemini-4-argon-high' --effort 'high'");
  expect(launch({ model: "gemini-3.8-flash-low" })).toContain("--model 'gemini-3.8-flash-low'");
});

test("agy writes only the bridge in its delivery directory", () => {
  const cwd = root(); const deliveryDir = join(cwd, "results");
  prepareAgyFiles({ cwd, deliveryDir });
  expect(readFileSync(join(deliveryDir, "agy-terminal.mjs"), "utf8")).toContain("createAgyTerminal");
  expect(existsSync(join(cwd, ".agents"))).toBe(false);
  expect(() => prepareAgyFiles({ cwd, deliveryDir, safe: true })).toThrow("--safe");
});

test("agy reads only the latest complete turn frame and current help tags", async () => {
  expect(driver.detectStatus("[AHELPA:DONE]\n")).toBe("running");
  expect(driver.detectStatus(frame("idle") + `[AHELPA_AGY_TURN:${second}]\n`)).toBe("running");
  for (const state of ["idle", "error", "needs_attention"] as const) expect(driver.detectStatus(frame(state))).toBe(state);
  expect(driver.extractResumeToken(frame("ready"))).toBe(id);
  expect(driver.detectActivity("loading")).toBe("booting");
  expect(driver.detectActivity(frame("running"))).toBe("working");
  expect(driver.acceptsInput!(frame("running"))).toBe(false);
  expect(driver.acceptsInput!(frame("error"))).toBe(false);
  expect(driver.acceptsInput!(frame("needs_attention"))).toBe(true);
  const help = `[AHELPA_AGY_TURN:${first}]\n[AHELPA_AGY_TAGS:review,input,review]\n[AHELPA_AGY_STATE:error]\n`;
  expect(driver.detectOutcome(help)).toEqual({ status: "error", needHelpTags: ["review", "input"] });
  expect(driver.detectOutcome(help + frame("idle", second))).toEqual({ status: "idle", needHelpTags: null });
  await expect(driver.switchModel("test", runtime([]), { model: "gemini-4-argon-high" })).rejects.toThrow("not supported");
  const io = runtime([]); await driver.gracefulExit("test", io); expect(io.sent).toEqual(["/exit"]);
});

test("agy submission requires a new turn and startup is bounded", async () => {
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

test.each(["1.5.1", "1.5.2", "1.6.0"])("agy doctor reads embedded version %s without executing agy", version => {
  const cwd = root(); const bin = join(cwd, "bin");
  fakeAgy(bin, version);
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 99\n"); chmodSync(join(bin, "node"), 0o755);
  const result = checkAgyReadiness(cwd, { homeDir: cwd, env: { PATH: bin } });
  expect(result.version).toBe(version);
  expect(result.locally_ready).toBe(version === "1.5.1" ? false : "unknown");
  expect(result.reasons.join(" ")).toContain(version === "1.5.1" ? "upgrade agy to >= 1.5.2" : "verified at launch");
  expect(existsSync(join(cwd, "executed-marker"))).toBe(false);
  rmSync(join(bin, "node"));
  expect(checkAgyReadiness(cwd, { homeDir: cwd, env: { PATH: bin } }).reasons).toContain("Node.js is required for the agy stream-json bridge");
});

test("agy doctor reports PATH shadowing, including a desktop app shim", () => {
  const cwd = root();
  const shim = fakeAgy(join(cwd, "Antigravity.app/Contents/Resources/bin"));
  const cli = fakeAgy(join(cwd, "local-bin"));
  mkdirSync(join(cwd, "link-bin")); symlinkSync(cli, join(cwd, "link-bin", "agy"));
  const lone = checkAgyReadiness(cwd, { homeDir: cwd, env: { PATH: [join(cwd, "local-bin"), join(cwd, "link-bin")].join(":") } });
  expect(lone.reasons.join(" ")).not.toContain("shadows");
  const shadowed = checkAgyReadiness(cwd, { homeDir: cwd, env: { PATH: [join(cwd, "Antigravity.app/Contents/Resources/bin"), join(cwd, "local-bin")].join(":") } });
  expect(shadowed.executable).toBe(shim);
  expect(shadowed.reasons.join(" ")).toContain(`2 different agy executables on PATH; ${shim} shadows ${cli}; the first belongs to a desktop app bundle`);
});
