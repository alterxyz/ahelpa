import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkPiReadiness, piDriver as driver, preparePiFiles } from "../src/drivers/pi";
import { getDriver } from "../src/drivers/registry";
import type { DriverRuntime } from "../src/drivers/types";
const id = "11111111-1234-1234-1234-123456789abc";
const first = "aaaaaaaa-1234-1234-1234-123456789abc";
const second = "bbbbbbbb-1234-1234-1234-123456789abc";
const frame = (state: string, turn = first) => `[AHELPA_PI_SESSION:${id}]\n[AHELPA_PI_TURN:${turn}]\n[AHELPA_PI_STATE:${state}]\n`;
const roots: string[] = [];
function root() { const path = mkdtempSync(join(realpathSync(tmpdir()), "pi-driver-test-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function runtime(screens: string[]): DriverRuntime & { sent: string[]; captures: number } {
  return { sent: [], captures: 0, async capture() { return screens[Math.min(this.captures++, screens.length - 1)]; },
    async sleep() {}, async sendKey(_id, key) { this.sent.push(key); }, async sendKeys(_id, text) { this.sent.push(text); } };
}
test("Pi is registered", () => { expect(getDriver("pi")).toBe(driver); });
test("Pi quotes all arguments and uses the supplied result directory", () => {
  const command = driver.buildLaunchCommand({ cwd: "/tmp/project's files", deliveryDir: "/tmp/results", model: "provider/model's id", effort: "high" });
  expect(command).toContain("cd '/tmp/project'\\''s files'");
  expect(command).toContain("node '/tmp/results/pi-terminal.mjs' --cwd '/tmp/project'\\''s files'");
  expect(command).toContain("--model 'provider/model'\\''s id'");
  expect(command).toContain("--effort 'high'");
  const resume = driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id });
  expect(resume).toContain(`--resume '${id}'`);
  expect(resume).not.toContain("--model");
  expect(resume).not.toContain("--effort");
});
test.each(["", "model", "/model", "provider/", " /model", "provider/ \t"])("Pi rejects ambiguous model %s", model => {
  expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", model })).toThrow("<provider>/<model>");
  expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id, model })).toThrow("<provider>/<model>");
});
test("Pi rejects safe launch/resume and unsupported model switching", async () => {
  expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", safe: true })).toThrow("--safe");
  expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id, safe: true })).toThrow("--safe");
  expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", effort: "wrong" })).toThrow("--effort");
  for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) expect(driver.buildLaunchCommand({ cwd: "/tmp/project", effort })).toContain(`--effort '${effort}'`);
  const io = runtime([]);
  await expect(driver.switchModel("test", io, { model: "provider/model", persist: true })).rejects.toThrow("not supported; launch with --model and --effort");
  expect(io.sent).toEqual([]);
  await driver.gracefulExit("test", io);
  expect(io.sent).toEqual(["/exit"]);
});
test("Pi writes only the bridge in its delivery directory", () => {
  const cwd = root(); const deliveryDir = join(cwd, "results");
  preparePiFiles({ cwd, deliveryDir });
  expect(readFileSync(join(deliveryDir, "pi-terminal.mjs"), "utf8").length).toBeGreaterThan(100);
  expect(existsSync(join(cwd, ".pi"))).toBe(false);
  expect(() => preparePiFiles({ cwd, deliveryDir, safe: true })).toThrow("--safe");
});
test("Pi uses only latest complete turn frames and current help tags", () => {
  expect(driver.detectStatus("[AHELPA:DONE]\n")).toBe("running");
  expect(driver.detectStatus(frame("idle") + frame("running", second))).toBe("running");
  expect(driver.detectStatus(frame("idle") + `[AHELPA_PI_TURN:${second}]\n`)).toBe("running");
  for (const state of ["idle", "error", "needs_attention"] as const) expect(driver.detectStatus(frame(state))).toBe(state);
  expect(driver.extractResumeToken(frame("ready"))).toBe(id);
  expect(driver.detectActivity("loading")).toBe("booting");
  expect(driver.detectActivity(frame("running"))).toBe("working");
  expect(driver.acceptsInput!(frame("running"))).toBe(false);
  expect(driver.acceptsInput!(frame("error"))).toBe(false);
  expect(driver.acceptsInput!(frame("ready"))).toBe(true);
  const help = `[AHELPA_PI_TURN:${first}]\n[AHELPA_PI_TAGS:review,input,review]\n[AHELPA_PI_STATE:needs_attention]\n`;
  expect(driver.detectOutcome(help)).toEqual({ status: "needs_attention", needHelpTags: ["review", "input"] });
  expect(driver.detectOutcome(help + frame("idle", second))).toEqual({ status: "idle", needHelpTags: null });
});
test("Pi submission requires a new turn, including fast completion and repeated tasks", async () => {
  const beforeOutput = frame("idle");
  expect(await driver.afterTaskSubmitted("test", runtime([beforeOutput]), { beforeOutput })).toBe(false);
  expect(await driver.afterTaskSubmitted("test", runtime([frame("idle", second)]), { beforeOutput })).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([beforeOutput]))).toBe(false);
  expect(await driver.afterTaskSubmitted("test", runtime([frame("running", second)]))).toBe(true);
});
test.each(["prepareForTask", "prepareForResume"] as const)("Pi %s has bounded startup", async method => {
  await driver[method]("test", runtime(["loading", frame("ready")]));
  await expect(driver[method]("test", runtime([frame("error")]))).rejects.toThrow("failed to start");
  const io = runtime(["loading"]);
  await expect(driver[method]("test", io)).rejects.toThrow("input prompt");
  expect(io.captures).toBe(60);
});
test.each(["1.3.9", "1.4.0", "1.4.1", "2.0.0"])("Pi doctor metadata %s never executes binaries or opens credentials", version => {
  const cwd = root(); const bin = join(cwd, "bin"); const pkg = join(cwd, "package");
  mkdirSync(bin); mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "dist/cli.js" } }));
  writeFileSync(join(pkg, "dist/cli.js"), "#!/bin/sh\nexit 99\n"); chmodSync(join(pkg, "dist/cli.js"), 0o755);
  symlinkSync(join(pkg, "dist/cli.js"), join(bin, "pi"));
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 99\n"); chmodSync(join(bin, "node"), 0o755);
  const result = checkPiReadiness(cwd, { homeDir: cwd, env: { PATH: bin, API_KEY: "unique-secret" } });
  expect(result.version).toBe(version);
  expect(result.locally_ready).toBe(version === "1.3.9" ? false : "unknown");
  expect(JSON.stringify(result)).not.toContain("unique-secret");
  if (version === "1.3.9") expect(result.reasons.join(" ")).toContain("upgrade Pi");
  rmSync(join(bin, "node"));
  expect(checkPiReadiness(cwd, { homeDir: cwd, env: { PATH: bin } }).locally_ready).toBe(false);
});

test("Pi readiness only reads package metadata, never models or authentication files", () => {
  const cwd = root(); const bin = join(cwd, "bin"); const pkg = join(cwd, "package");
  mkdirSync(bin); mkdirSync(join(pkg, "dist"), { recursive: true });
  const metadata = join(pkg, "package.json");
  writeFileSync(metadata, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.4.0", bin: { pi: "dist/cli.js" } }));
  writeFileSync(join(pkg, "dist/cli.js"), "#!/bin/sh\nexit 99\n"); chmodSync(join(pkg, "dist/cli.js"), 0o755);
  symlinkSync(join(pkg, "dist/cli.js"), join(bin, "pi"));
  const reads = spyOn(fs, "readFileSync");
  try {
    checkPiReadiness(cwd, { homeDir: cwd, env: { PATH: bin } });
    const paths = reads.mock.calls.map(([path]) => String(path));
    expect(paths).toContain(metadata);
    expect(paths.some(path => /(?:models|auth)\.json$/.test(path))).toBe(false);
  } finally { reads.mockRestore(); }
  rmSync(join(bin, "pi"));
  const missing = checkPiReadiness(cwd, { homeDir: cwd, env: { PATH: bin } });
  expect(missing.executable).toBeNull();
  expect(missing.locally_ready).toBe(false);
  expect(missing.reasons).toContain("binary not found");
});

test("Pi doctor recognizes bundled CLI package metadata three directories up", () => {
  const cwd = root(); const bin = join(cwd, "bin"); const pkg = join(cwd, "package");
  mkdirSync(bin); mkdirSync(join(pkg, "dist/bundle"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.4.0", bin: { pi: "dist/bundle/cli.js" } }));
  writeFileSync(join(pkg, "dist/bundle/cli.js"), "#!/bin/sh\nexit 99\n"); chmodSync(join(pkg, "dist/bundle/cli.js"), 0o755);
  symlinkSync(join(pkg, "dist/bundle/cli.js"), join(bin, "pi"));
  expect(checkPiReadiness(cwd, { homeDir: cwd, env: { PATH: bin } }).version).toBe("1.4.0");
  // Metadata is valid only if its bin identifies this exact executable.
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.4.0", bin: { pi: "dist/bundle/other.js" } }));
  expect(checkPiReadiness(cwd, { homeDir: cwd, env: { PATH: bin } }).version).toBeNull();
});
