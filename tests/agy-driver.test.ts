import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { agyDriver as driver, checkAgyReadiness } from "../src/drivers/agy";
import { getDriver } from "../src/drivers/registry";
import { resolveLaunchProfile } from "../src/launch-profiles";
import type { DriverRuntime } from "../src/drivers/types";

const id = "57cf11da-8ca6-4a6b-95aa-199967ed2c72";
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

// Screens as agy 1.5.3 draws them in an 80x24 tmux pane (2026-11-07 spike).
const rule = "─".repeat(80), turnRule = "─".repeat(60);
const idleFooter = "? for shortcuts                                             Gemini 4 Argon · low";
const busyFooter = "esc to cancel                                               Gemini 4 Argon · low";
const banner = "  Antigravity CLI 1.5.3\n  Gemini 4 Argon (Low)\n  /tmp/project\n\n";
const composer = (footer = idleFooter, text = "") => `${rule}\n>${text && ` ${text}`}\n${rule}\n${footer}`;
const turn = (task = "a") => `${turnRule}\n> Please read and complete the task described in\n  /tmp/runtime/task-${task}.md. When you are finished, output [AHELPA:DONE] on its\n  own line.\n`;
const ready = banner + composer();
const working = (task = "a") => `${banner}${turn(task)}\n● Explored 1 file (task-${task}.md)\n⣟  Reading file...\n${composer(busyFooter)}`;
const answered = (task = "a", signal = "[AHELPA:DONE]") => `${turn(task)}\n● Edited 1 file (summary.md)\n\n  Finished.\n\n  ${signal}\n\n`;
const done = (task = "a") => banner + answered(task) + composer();
const exitScreen = `${done()}\n\nResume with -c (or command below):\nagy --conversation=${id}\n\nbash-3.2$`;

test("agy is registered with the Gemini 4 Argon medium default", () => {
  expect(getDriver("agy")).toBe(getDriver("gemini"));
  expect(resolveLaunchProfile(driver, {})).toEqual({ role: "worker", model: "gemini-4-argon", effort: "medium" });
  expect(resolveLaunchProfile(driver, { role: "reviewer", effort: "high" })).toEqual({ role: "reviewer", model: "gemini-4-argon", effort: "high" });
  expect(() => resolveLaunchProfile(driver, { role: "advisor" })).toThrow('does not support role "advisor"');
});

test("agy runs its own TUI with updates off, permissions skipped and session-only trust", () => {
  const command = driver.buildLaunchCommand({ cwd: "/tmp/project's files", deliveryDir: "/tmp/results", model: "gemini-4-argon", effort: "high" });
  expect(command).toBe(`cd '/tmp/project'\\''s files' && AGY_CLI_DISABLE_AUTO_UPDATE=true agy --dangerously-skip-permissions --settings '{"trustedWorkspaces":["/tmp/project'\\''s files"]}' --model 'gemini-4-argon' --effort 'high'`);
  const resume = driver.buildResumeCommand!({ cwd: "/tmp/project", resumeId: id });
  expect(resume).toEndWith(`--conversation '${id}'`);
  // agy compares the literal working directory, so a linked path also trusts its real path.
  const real = root(); const link = join(root(), "link"); symlinkSync(real, link);
  expect(driver.buildLaunchCommand({ cwd: link })).toContain(`--settings '${JSON.stringify({ trustedWorkspaces: [link, real] })}'`);
  // Without a session there is no result directory, so no hook root either.
  expect(command).not.toContain("--add-dir");
});

test("agy validates model and effort before launch", () => {
  const launch = (opts: object) => driver.buildLaunchCommand({ cwd: "/tmp/project", ...opts });
  expect(() => launch({ safe: true })).toThrow("--safe is not supported");
  expect(() => driver.buildResumeCommand!({ cwd: "/tmp/project", resumeId: id, safe: true })).toThrow("--safe");
  expect(() => launch({ model: "gemini 4" })).toThrow("agy models");
  expect(() => launch({ effort: "minimal" })).toThrow("low, medium, high, xhigh, max");
  // A suffixed ID carries its effort; agy itself refuses a contradiction.
  expect(() => launch({ model: "gemini-4-argon-high", effort: "medium" }))
    .toThrow("pass --effort high, or --model gemini-4-argon --effort medium");
  expect(launch({ model: "gemini-4-argon-high", effort: "high" })).toContain("--model 'gemini-4-argon-high' --effort 'high'");
  expect(launch({ model: "gemini-3.8-flash-low" })).toContain("--model 'gemini-3.8-flash-low'");
});

test("agy settles only on a signal in the current turn with nothing working after it", () => {
  // The task echo mentions the signals mid-line; that is not a signal.
  expect(driver.detectStatus(working())).toBe("running");
  expect(driver.detectOutcome(done())).toEqual({ status: "idle", needHelpTags: null });
  const help = banner + answered("a", "[AHELPA:NEED_HELP:review,input,review]") + composer();
  expect(driver.detectOutcome(help)).toEqual({ status: "error", needHelpTags: ["review", "input"] });
  // Still streaming after the signal, or a background task agy will resume from.
  expect(driver.detectStatus(banner + answered() + "⣾  Generating...\n" + composer(busyFooter))).toBe("running");
  const task = `${rule}\n>\n${rule}\n  ● [18:10:03] sleep 179 running\n${rule}\n${idleFooter} · 1 task(s) · /tasks`;
  expect(driver.detectStatus(banner + answered() + task)).toBe("running");
  expect(driver.detectActivity(banner + answered() + task)).toBe("working");
  // A resumed conversation replays its old turns; their signals belong to them.
  expect(driver.detectStatus(banner + answered("a") + working("b").slice(banner.length))).toBe("running");
  const unsignalled = banner + answered("a") + turn("b") + "\n  I stopped without the signal.\n\n" + composer();
  expect(driver.detectStatus(unsignalled)).toBe("running");
  expect(driver.detectActivity(unsignalled)).toBe("idle");
  expect(driver.acceptsInput!(unsignalled)).toBe(true);
});

test("agy reads working, dialogs and the ready composer from the screen", () => {
  expect(driver.detectActivity(working())).toBe("working");
  expect(driver.acceptsInput!(working())).toBe(false);
  expect(driver.acceptsInput!(ready)).toBe(true);
  // The footer only names the model once the session has loaded.
  expect(driver.acceptsInput!(banner + composer("? for shortcuts"))).toBe(false);
  // Its own question tool waits for a person: no composer, rows at column 0.
  const question = `${banner}${answered()}${turn("b")}\n? Which color do you prefer?\n\nQuestion\n${rule}\n\nQuestion 1/1: Which color do you prefer?\n\n> 1. red\n  2. blue\n  3. Write-in...\n\n  ↑/↓ Navigate · enter Select · esc Skip\n${busyFooter}`;
  expect(driver.detectStatus(question)).toBe("running");
  expect(driver.detectActivity(question)).toBe("idle");
  expect(driver.acceptsInput!(question)).toBe(false);
  const menu = `${banner}${rule}\n> /exit\n${rule}\n> /exit  Exit the CLI\n\n  ↑/↓ Navigate · enter Select · tab Complete\n${busyFooter}`;
  expect(driver.acceptsInput!(menu)).toBe(false);
  expect(driver.acceptsInput!(banner + composer(idleFooter, "Please read and complete the task"))).toBe(false);
  const trust = "Accessing workspace:\n\n/tmp/project\n\nDo you trust the contents of this project?\n\n> Yes, I trust this folder\n  No, exit\n\n  ↑/↓ Navigate · enter Confirm\n                                                 Gemini 4 Argon · medium";
  expect(driver.detectActivity(trust)).toBe("booting");
  expect(driver.acceptsInput!(trust)).toBe(false);
  // A spinner frozen above a shell prompt is not work.
  expect(driver.detectActivity(working() + "\n\nbash-3.2$")).toBe("idle");
});

test("agy finds the conversation ID it prints on exit", async () => {
  expect(driver.resumeTokenAvailableAfterSubmit).toBe(false);
  expect(driver.extractResumeToken!(done())).toBeNull();
  expect(driver.extractResumeToken!(exitScreen)).toBe(id);
  await expect(driver.switchModel("test", runtime([]), { model: "gemini-4-argon-high" })).rejects.toThrow("not supported");
  const io = runtime([]); await driver.gracefulExit("test", io); expect(io.sent).toEqual(["/exit"]);
});

test("agy submission needs a turn that left the composer", async () => {
  expect(await driver.afterTaskSubmitted("test", runtime([working()]), { beforeOutput: ready })).toBe(true);
  // Text still in the composer was not submitted.
  const typed = banner + composer(idleFooter, "Please read and complete the task described in");
  expect(await driver.afterTaskSubmitted("test", runtime([typed]), { beforeOutput: ready })).toBe(false);
  // A follow-up repeats the same text; a scrolled capture shows the same last echo.
  const before = done();
  expect(await driver.afterTaskSubmitted("test", runtime([before]), { beforeOutput: before })).toBe(false);
  expect(await driver.afterTaskSubmitted("test", runtime([before + "\n" + working().slice(banner.length)]), { beforeOutput: before })).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([working()]), { beforeOutput: before })).toBe(true);
  // At 80 columns every echo starts with the same words; the wrapped path tells turns apart.
  const quick = banner + turn("b") + "\n  Finished quickly.\n\n" + composer();
  expect(await driver.afterTaskSubmitted("test", runtime([quick]), { beforeOutput: before })).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([working()]))).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([done()]))).toBe(false);
});

test("agy startup is bounded and refuses a lost conversation or a trust dialog", async () => {
  await driver.prepareForTask("test", runtime(["", banner, ready]));
  const io = runtime([banner]);
  await expect(driver.prepareForTask("test", io)).rejects.toThrow("input prompt");
  expect(io.captures).toBe(120);
  // agy starts a new conversation, with only this warning, when the ID is unknown.
  await expect(driver.prepareForResume!("test", runtime([`warning: conversation "${id}" not found\n\n${ready}`])))
    .rejects.toThrow("did not find the conversation");
  await expect(driver.prepareForTask("test", runtime(["Do you trust the contents of this project?\n\n> Yes, I trust this folder"])))
    .rejects.toThrow("session-only trust did not apply");
});

test.each(["1.5.1", "1.5.2", "1.6.0"])("agy doctor reads embedded version %s without executing agy", version => {
  const cwd = root(); const bin = join(cwd, "bin");
  fakeAgy(bin, version);
  const result = checkAgyReadiness(cwd, { homeDir: cwd, env: { PATH: bin } });
  expect(result.version).toBe(version);
  expect(result.locally_ready).toBe(version === "1.5.1" ? false : "unknown");
  expect(result.reasons.join(" ")).toContain(version === "1.5.1" ? "upgrade agy to >= 1.5.2" : "verified at launch");
  // The TUI needs no Node.js.
  expect(result.reasons.join(" ")).not.toContain("Node");
  expect(existsSync(join(cwd, "executed-marker"))).toBe(false);
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
