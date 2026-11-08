import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkPiReadiness, piDriver as driver } from "../src/drivers/pi";
import { getDriver } from "../src/drivers/registry";
import type { DriverRuntime } from "../src/drivers/types";
const id = "01a1b8e2-7a54-7263-8a4c-692c479607b9";
const roots: string[] = [];
function root() { const path = mkdtempSync(join(realpathSync(tmpdir()), "pi-driver-test-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function runtime(screens: string[]): DriverRuntime & { sent: string[]; captures: number } {
  return { sent: [], captures: 0, async capture() { return screens[Math.min(this.captures++, screens.length - 1)]; },
    async sleep() {}, async sendKey(_id, key) { this.sent.push(key); }, async sendKeys(_id, text) { this.sent.push(text); } };
}
// Frames follow captures of Pi 1.5.0 fullscreen at 80 columns: the transcript
// is padded one column, the editor sits between column-0 borders, then the footer.
const border = "─".repeat(80);
const spinner = `── ⠼ Working ${"─".repeat(67)}`;
const task = " Please read and complete the task described in\n /tmp/project/task.md";
function screen(transcript: string, { top = border, draft = "", right = "deepseek-flash • high", after = "" } = {}) {
  return `${transcript}\n\n${top}\n${draft}\n${border}\n/tmp/project\n0.0%/1.0M (auto)${" ".repeat(43)}${right}${after}`;
}
const done = `${task}\n\n\n Hello!\n\n [AHELPA:DONE]`;

test("Pi is registered", () => { expect(getDriver("pi")).toBe(getDriver("deepseek-pi")); });
test("Pi launches its fullscreen TUI with quoted arguments and resumes by exact native UUID", () => {
  const command = driver.buildLaunchCommand({ cwd: "/tmp/project's files", model: "provider/model's id", effort: "high" });
  expect(command).toBe("cd '/tmp/project'\\''s files' && pi --tui-mode fullscreen --offline --approve --no-extensions --no-mcp --model 'provider/model'\\''s id' --thinking 'high'");
  const resume = driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id });
  expect(resume).toBe(`cd '/tmp/project' && pi --tui-mode fullscreen --offline --approve --no-extensions --no-mcp --session '${id}'`);
  for (const resumeId of ["01a1b8e2", "/tmp/session.jsonl", `${id} --model x`]) {
    expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", resumeId })).toThrow("native session UUID");
  }
});
test.each(["", "model", "/model", "provider/", " /model", "provider/ \t"])("Pi rejects ambiguous model %s", model => {
  expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", model })).toThrow("<provider>/<model>");
  expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id, model })).toThrow("<provider>/<model>");
});
test("Pi rejects safe launch/resume and unsupported model switching, and exits with /quit", async () => {
  expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", safe: true })).toThrow("--safe");
  expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id, safe: true })).toThrow("--safe");
  expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", effort: "wrong" })).toThrow("--effort");
  for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) expect(driver.buildLaunchCommand({ cwd: "/tmp/project", effort })).toContain(`--thinking '${effort}'`);
  const io = runtime([]);
  await expect(driver.switchModel("test", io, { model: "provider/model", persist: true })).rejects.toThrow("not supported; launch with --model and --effort");
  expect(io.sent).toEqual([]);
  await driver.gracefulExit("test", io);
  expect(io.sent).toEqual(["/quit"]);
});
test("Pi settles only on a signal that ends the transcript while no spinner runs", () => {
  expect(driver.detectOutcome(screen(done))).toEqual({ status: "idle", needHelpTags: null });
  expect(driver.detectStatus(screen(done, { top: spinner }))).toBe("running");
  // Too narrow for the label: only the spinner remains in the border.
  expect(driver.detectStatus(screen(done, { top: `───⠋${"─".repeat(36)}` }))).toBe("running");
  // An old signal above a newer user message or later text is not this turn's.
  expect(driver.detectStatus(screen(`${done}\n\n\n${task}`))).toBe("running");
  expect(driver.detectStatus(screen(`${done}\n\n More notes after the signal.`))).toBe("running");
  // The echoed instruction names the signals inline, never alone on a line.
  expect(driver.detectStatus(screen(" When you are finished, output [AHELPA:DONE] on its own line."))).toBe("running");
  expect(driver.detectOutcome(screen(`${task}\n\n [AHELPA:NEED_HELP:review,input,review]`)))
    .toEqual({ status: "error", needHelpTags: ["review", "input"] });
  // After /quit or a crash the last frame stays above the resume hint and the shell.
  const exited = screen(done, { after: `\nTo resume this session: pi --session ${id}\nbash-3.2$` });
  expect(driver.detectStatus(exited)).toBe("running");
  expect(driver.acceptsInput!(exited)).toBe(false);
  expect(driver.detectStatus("loading")).toBe("running");
});
test("Pi reports a failed turn's status code as the reason, never the provider's text", () => {
  // Pi 1.5.0 at 80 columns after the official API answered 401 (request ID redacted).
  const failed = (code: string, body = '{"message":"Service is too busy. We advise users to temporarily switch (request_id:\n <redacted>)","type":"service_unavailable_error"}') =>
    screen(`${task}\n\n\n Error: ${code}: ${body}\n If this looks like a pi bug, /bug sends a report to the developers.`);
  for (const [code, reason] of [["503", "provider overloaded (503)"], ["529", "provider overloaded (529)"], ["429", "rate limited (429)"],
    ["401", "authentication failed (401)"], ["403", "authentication failed (403)"], ["500", "native turn failed"]]) {
    expect(driver.detectOutcome(failed(code))).toEqual({ status: "needs_attention", needHelpTags: null, reason: `Pi: ${reason}` });
  }
  expect(JSON.stringify(driver.detectOutcome(failed("503")))).not.toContain("busy");
  expect(driver.detectOutcome(screen(`${task}\n\n Command aborted\n\n\n Error: This operation was aborted`)))
    .toEqual({ status: "needs_attention", needHelpTags: null, reason: "Pi: turn aborted" });
  // Retries keep the spinner; a later message retires the error; prose is not Pi's error block.
  expect(driver.detectStatus(screen(`${task}\n\n Error: 503: {}`, { top: spinner }))).toBe("running");
  expect(driver.detectStatus(screen(`${task}\n\n Error: 503: {}\n\n\n${task}`))).toBe("running");
  expect(driver.detectStatus(screen(`${task}\n\n Error: the file was missing, so I stopped.`))).toBe("running");
});
test("Pi accepts input only into the empty idle composer", () => {
  expect(driver.acceptsInput!(screen(done))).toBe(true);
  expect(driver.acceptsInput!(screen(done, { top: spinner }))).toBe(false);
  expect(driver.acceptsInput!(screen(done, { draft: "/session" }))).toBe(false);
  // The trust selector also sits between borders, with many rows.
  expect(driver.acceptsInput!(`${border}\n Trust project folder?\n → Trust\n   Do not trust\n${border}`)).toBe(false);
  expect(driver.detectActivity(screen(done, { top: spinner }))).toBe("working");
  expect(driver.detectActivity(screen(done))).toBe("idle");
  expect(driver.detectActivity("bash-3.2$")).toBe("idle");
});
test("Pi reads the native session UUID from the exit hint", () => {
  expect(driver.resumeTokenAvailableAfterSubmit).toBe(false);
  expect(driver.extractResumeToken(`${done}\nTo resume this session: pi --session ${id}\n`)).toBe(id);
  expect(driver.extractResumeToken(`To resume this session: pi --session-dir /tmp/s --session ${id}`)).toBe(id);
  expect(driver.extractResumeToken(screen(done))).toBeNull();
});
test("Pi submission requires a running turn or a signal that was not there before", async () => {
  const ready = screen(task);
  expect(await driver.afterTaskSubmitted("test", runtime([ready, screen(task, { top: spinner })]), { beforeOutput: ready })).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([screen(done)]), { beforeOutput: ready })).toBe(true);
  const unchanged = runtime([screen(done)]);
  expect(await driver.afterTaskSubmitted("test", unchanged, { beforeOutput: screen(done) })).toBe(false);
  expect(unchanged.captures).toBe(10);
  expect(await driver.afterTaskSubmitted("test", runtime([screen(done)]))).toBe(false);
});
test.each(["prepareForTask", "prepareForResume"] as const)("Pi %s has bounded startup and fails fast on startup errors", async method => {
  await driver[method]("test", runtime(["loading", screen("")]));
  for (const [output, message] of [
    ['Error: Model "nosuchprov/x" not found. Use --list-models to see available models.\nbash-3.2$', "nosuchprov"],
    ["No session found matching 'abc'\nbash-3.2$", "No session found"],
    ["Session found in different project: /other\nFork this session into current directory? [y/N] ", "Fork this session"],
    [screen(' Warning: Model "zz" not found for provider "p". Using custom model id.', { right: "zz • high" }), "custom model id"],
  ]) await expect(driver[method]("test", runtime([output]))).rejects.toThrow(message);
  // A resumed transcript's own errors are padded and do not stop startup.
  await driver[method]("test", runtime([screen(" Error: This operation was aborted")]));
  const io = runtime(["loading"]);
  await expect(driver[method]("test", io)).rejects.toThrow("input prompt");
  expect(io.captures).toBe(30);
});
test("Pi startup rejects a model or thinking level the footer shows Pi did not apply", async () => {
  const start = (model: string | undefined, effort: string | undefined, right: string) => {
    driver.buildLaunchCommand({ cwd: "/tmp/project", sessionId: "pi-check", model, effort });
    return driver.prepareForTask("pi-check", runtime([screen("", { right })]));
  };
  await start("cc-switch-deep-seek/deepseek-flash", "high", "deepseek-flash • high");
  await start("cc-switch-deep-seek/deepseek-flash", "high", "(cc-switch-deep-seek) deepseek-flash • high");
  await start("p/m", "off", "m • thinking off");
  await start(undefined, undefined, "anything • xhigh");
  // Pi clamps an unsupported level silently; the footer is where it shows.
  await expect(start("cc-switch-deep-seek/deepseek-flash", "minimal", "deepseek-flash • high")).rejects.toThrow("applied deepseek-flash • high");
  await expect(start("p/m", "high", "m")).rejects.toThrow("instead of the requested m / high");
  await expect(start("p/m", undefined, "other • high")).rejects.toThrow("applied other");
  // Each launch is checked once; a later startup without a launch command is not.
  await driver.prepareForTask("pi-check", runtime([screen("", { right: "other • low" })]));
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
