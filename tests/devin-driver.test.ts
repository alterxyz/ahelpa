import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkDevinReadiness, devinDriver as driver } from "../src/drivers/devin";
import { getDriver } from "../src/drivers/registry";
import { resolveLaunchProfile } from "../src/launch-profiles";
import type { DriverRuntime } from "../src/drivers/types";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(realpathSync(tmpdir()), "devin-driver-test-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function runtime(screens: string[]): DriverRuntime & { sent: string[]; captures: number } {
  return { sent: [], captures: 0, async capture() { return screens[Math.min(this.captures++, screens.length - 1)]; },
    async sleep() {}, async sendKey(_id, key) { this.sent.push(key); }, async sendKeys(_id, text) { this.sent.push(text); } };
}

// Screens as Devin CLI 3000.14.30821 draws them in an 80x24 tmux pane (2026-11-19 spike).
const rule = "─".repeat(80);
const titled = `${"─".repeat(42)} Complete task described in task-a.md ─`;
const banner = "⠀⣴⣾⣶⡄⠀⠀⠀⠀\n⠀⠛⠿⠟⠻⣶⣾⣶⡄  Devin CLI\n⠀⣤⣶⣦⣴⠿⢿⠿⠃  v3000.14.30821\n\n Free plan, use /upgrade to access better models · 100% remaining (resets in 7h…\n\n";
const idle = (top = rule) => ` ⏺ /tmp/project\n${top}\n❭ Ask Devin to build features, fix bugs, or work on your code\n${rule}\nSWE-2 Flash Medium · bypass                               ctrl+o to expand edits`;
const busy = (status = "⢀⡄ Running tools · 6s (esc twice to interrupt)") => `${status}\n${titled}\n❭ Guide Devin while it works\n${rule}\nSWE-2 Flash Medium · bypass                    Context: 66k / 262k tokens (25%)`;
// The echo wraps at 80 columns; this width leaves [AHELPA:DONE] alone on a wrapped line.
const turn = (task = "a") => `❭ Please read and complete the task described in /tmp/runtime/task-${task}.md.\n  Use /tmp/r as your result directory. When you are finished, output\n  [AHELPA:DONE]\n  on its own line. If you are stuck, output [AHELPA:NEED_HELP] on its own line.\n\n`;
const ready = banner + idle();
const working = (task = "a") => `${banner}${turn(task)} ✓ Read ./task-${task}.md · 2 lines\n\n${busy()}`;
const answered = (task = "a", signal = "[AHELPA:DONE]") => `${turn(task)} ✓ Read ./task-${task}.md · 2 lines\n ✓ Wrote ./r/summary.md +1\n\n Finished.\n\n ${signal}\n\n`;
const done = (task = "a") => banner + answered(task) + idle(titled);
const exitScreen = `${banner}${answered()}❭ /exit\n\n devin -r maddening-trawler\n resumes this session · devin -r lists recent sessions\n\nbash-3.2$`;

test("devin is registered with the free SWE-2 Flash medium default", () => {
  expect(getDriver("swe")).toBe(getDriver("devin"));
  expect(resolveLaunchProfile(driver, {})).toEqual({ role: "worker", model: "swe-2-flash", effort: "medium" });
  expect(resolveLaunchProfile(driver, { role: "reviewer" })).toEqual({ role: "reviewer", model: "swe-2-flash", effort: "medium" });
  expect(() => resolveLaunchProfile(driver, { role: "advisor" })).toThrow('does not support role "advisor"');
});

test("devin runs its own TUI in the pane with permissions bypassed and run-only trust", () => {
  const command = driver.buildLaunchCommand({ cwd: "/tmp/project's files", model: "swe-2-flash", effort: "medium" });
  expect(command).toBe(`cd '/tmp/project'\\''s files' && devin --process-model in-process --permission-mode dangerous --respect-workspace-trust false --model 'swe-2-flash-medium'`);
  expect(command).not.toContain("--config");
  expect(driver.buildResumeCommand!({ cwd: "/tmp/project", resumeId: "maddening-trawler", model: "swe-2-flash", effort: "medium" }))
    .toEndWith("--model 'swe-2-flash-medium' -r 'maddening-trawler'");
});

test("devin folds effort into the model ID and validates both", () => {
  const launch = (opts: object) => driver.buildLaunchCommand({ cwd: "/tmp/project", ...opts });
  expect(launch({ model: "claude-opus-5-5", effort: "high" })).toContain("--model 'claude-opus-5-5-high'");
  expect(launch({ model: "claude-opus-5-5-high-fast", effort: "high" })).toContain("--model 'claude-opus-5-5-high-fast'");
  expect(launch({ model: "swe-1-6-slow" })).toContain("--model 'swe-1-6-slow'");
  expect(() => launch({ model: "swe-2-flash-max", effort: "medium" })).toThrow("pass --effort max");
  expect(() => launch({ effort: "high" })).toThrow("needs --model");
  expect(() => launch({ model: "swe 2" })).toThrow("devin models");
  expect(() => launch({ model: "swe-2-flash", effort: "minimal" })).toThrow("low, medium, high, xhigh, max");
  expect(() => launch({ safe: true })).toThrow("--safe is not supported");
});

test("devin settles only on a signal written after the latest echo, with nothing working", () => {
  // The echo names both signals, one wrapped alone onto its own line; neither counts.
  expect(driver.detectStatus(working())).toBe("running");
  expect(driver.detectStatus(banner + turn() + "\n" + idle())).toBe("running");
  expect(driver.detectOutcome(done())).toEqual({ status: "idle", needHelpTags: null });
  expect(driver.detectOutcome(banner + answered("a", "[AHELPA:NEED_HELP:input,review]") + idle()))
    .toEqual({ status: "error", needHelpTags: ["input", "review"] });
  // Still working after the signal.
  expect(driver.detectStatus(banner + answered() + busy("⠀⣠ Thinking · 2s (esc twice to interrupt)"))).toBe("running");
  // A resumed conversation replays old turns; their signals belong to them.
  expect(driver.detectStatus(banner + answered("a") + working("b").slice(banner.length))).toBe("running");
  const unsignalled = banner + answered("a") + turn("b") + " Finished without the signal.\n\n" + idle(titled);
  expect(driver.detectStatus(unsignalled)).toBe("running");
  expect(driver.detectActivity(unsignalled)).toBe("idle");
  expect(driver.acceptsInput!(unsignalled)).toBe(true);
});

test("devin reads work, dialogs and the empty composer from the screen", () => {
  expect(driver.detectActivity(working())).toBe("working");
  expect(driver.acceptsInput!(working())).toBe(false);
  expect(driver.acceptsInput!(ready)).toBe(true);
  // Its question tool replaces the composer; the options are indented.
  const question = `${banner}${turn("b")} ✓ Read ./task-b.md · 2 lines\n\n── Color ${"─".repeat(71)}\n  Should I write "red" or "blue"?\n\n  ❭ 1 red\n      Write "red"\n    2 blue\n${rule}\n↑↓ select · ↵ confirm · ? help me out · esc cancel`;
  expect(driver.detectStatus(question)).toBe("running");
  expect(driver.detectActivity(question)).toBe("idle");
  expect(driver.acceptsInput!(question)).toBe(false);
  // Typed but not submitted text is a draft, not an empty composer.
  const draft = `${banner} ⏺ /tmp/project\n${rule}\n❭ Please read and complete the task\n${rule}\nSWE-2 Flash Medium · bypass`;
  expect(driver.acceptsInput!(draft)).toBe(false);
  // One C-c on an idle composer only arms the exit; the composer stays ready.
  expect(driver.acceptsInput!(`${banner} ⏺ /tmp/project\n${rule}\n❭ Ask Devin to build features, fix bugs, or work on your code\n${rule}\nPress Ctrl+C again to exit.`)).toBe(true);
  // Shell after the TUI left: nothing works and nothing accepts a task.
  expect(driver.detectActivity(exitScreen)).toBe("idle");
  expect(driver.acceptsInput!(exitScreen)).toBe(false);
  // A TUI that died leaves its last frame above the shell prompt; that frame is not live.
  expect(driver.acceptsInput!(`${ready}\nbash-3.2$`)).toBe(false);
  const crashed = `${working()}\nKilled: 9\nbash-3.2$`;
  expect(driver.detectActivity(crashed)).toBe("idle");
  expect(driver.detectStatus(`${done()}\nKilled: 9\nbash-3.2$`)).toBe("idle");
  // Only the placeholder itself, or a truncation of it, is an empty composer.
  const composerWith = (text: string) => `${banner} ⏺ /tmp/project\n${rule}\n❭ ${text}\n${rule}\nSWE-2 Flash Medium · bypass`;
  expect(driver.acceptsInput!(composerWith("Ask Devin to fix the parser"))).toBe(false);
  expect(driver.acceptsInput!(composerWith("Ask Devin to build features, fix bugs, or…"))).toBe(true);
  expect(driver.acceptsInput!(composerWith("Ask Devin to fix…"))).toBe(false);
});

test("devin submission needs a turn that left the composer", async () => {
  expect(await driver.afterTaskSubmitted("test", runtime([working()]), { beforeOutput: ready })).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([draftOf()]), { beforeOutput: ready })).toBe(false);
  const before = done();
  expect(await driver.afterTaskSubmitted("test", runtime([before]), { beforeOutput: before })).toBe(false);
  expect(await driver.afterTaskSubmitted("test", runtime([before + working("b").slice(banner.length)]), { beforeOutput: before })).toBe(true);
  const quick = banner + answered("b") + idle(titled);
  expect(await driver.afterTaskSubmitted("test", runtime([quick]), { beforeOutput: before })).toBe(true);
  expect(await driver.afterTaskSubmitted("test", runtime([working()]))).toBe(true);
  function draftOf() { return `${banner} ⏺ /tmp/project\n${rule}\n❭ Please read and complete the task described in\n${rule}\nSWE-2 Flash Medium · bypass`; }
});

test("devin startup is bounded, reports a refused model and never types into setup", async () => {
  await driver.prepareForTask("test", runtime(["", banner, ready]));
  await expect(driver.prepareForTask("test", runtime(["Error: Upgrade to Pro to access this model (https://devin.ai/pricing)\n\nbash-3.2$"])))
    .rejects.toThrow("did not start: Upgrade to Pro to access this model");
  await expect(driver.prepareForTask("test", runtime(["Error: Unknown model: 'nope'\nAvailable: adaptive, swe-2\n\nbash-3.2$"])))
    .rejects.toThrow("did not start: Unknown model: 'nope'");
  const setup = runtime([" Connect GitHub\n   1 via gh CLI (github.com)\n   4 Skip for now\n ↑↓ select · ↵ confirm · esc skip"]);
  await expect(driver.prepareForTask("test", setup)).rejects.toThrow("devin setup");
  expect(setup.captures).toBe(120);
  expect(setup.sent).toEqual([]);
});

test("devin resume needs the old conversation on screen and reads the name printed on exit", async () => {
  await driver.prepareForResume!("test", runtime([done()]));
  // An unknown name opens a new, empty conversation without a word.
  await expect(driver.prepareForResume!("test", runtime([ready]))).rejects.toThrow("did not find the conversation");
  expect(driver.resumeTokenAvailableAfterSubmit).toBe(false);
  expect(driver.extractResumeToken!(done())).toBeNull();
  expect(driver.extractResumeToken!(exitScreen)).toBe("maddening-trawler");
  expect(driver.interrupt!.stopped.test(" ✱ Canceled. What should Devin do?")).toBe(true);
  await expect(driver.switchModel("test", runtime([]), { model: "swe-2-flash-high" })).rejects.toThrow("not supported");
  const io = runtime([]); await driver.gracefulExit("test", io); expect(io.sent).toEqual(["/exit"]);
});

test("devin doctor reads the version from the install path without executing devin", () => {
  const home = root();
  const release = join(home, ".local/share/devin/cli/_versions/3000.14.30821/bin");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "devin"), `#!/bin/sh\nprintf executed > "${home}/executed-marker"\n`);
  chmodSync(join(release, "devin"), 0o755);
  mkdirSync(join(home, "bin")); symlinkSync(join(release, "devin"), join(home, "bin", "devin"));
  const unsigned = checkDevinReadiness(home, { homeDir: home, env: { PATH: join(home, "bin") } });
  expect(unsigned.version).toBe("3000.14.30821");
  expect(unsigned.locally_ready).toBe("unknown");
  expect(unsigned.reasons.join(" ")).toContain("devin setup");
  writeFileSync(join(home, ".local/share/devin/credentials.toml"), "");
  const signed = checkDevinReadiness(home, { homeDir: home, env: { PATH: join(home, "bin") } });
  expect(signed.locally_ready).toBe(true);
  expect(existsSync(join(home, "executed-marker"))).toBe(false);
});
