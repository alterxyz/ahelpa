import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkDshReadiness, dshDriver as driver, prepareDshFiles } from "../src/drivers/dsh";
import { getDriver } from "../src/drivers/registry";
import { resolveLaunchProfile } from "../src/launch-profiles";
import type { DriverRuntime } from "../src/drivers/types";

const id = "session-12345678-1234-1234-1234-123456789abc";
const first = "aaaaaaaa-1234-1234-1234-123456789abc";
const second = "bbbbbbbb-1234-1234-1234-123456789abc";
const frame = (state: string, turn = first) => `[AHELPA_DSH_SESSION:${id}]\n[AHELPA_DSH_TURN:${turn}]\n[AHELPA_DSH_STATE:${state}]\n`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(realpathSync(tmpdir()), "dsh-driver-test-")); roots.push(path); return path; }
function runtime(screens: string[]): DriverRuntime & { sent: string[]; captures: number } {
  return {
    sent: [], captures: 0,
    async capture() { return screens[Math.min(this.captures++, screens.length - 1)]; },
    async sleep() {}, async sendKey(_id, key) { this.sent.push(key); }, async sendKeys(_id, text) { this.sent.push(text); },
  };
}

describe("DSH driver", () => {
  test("registers worker and reviewer profiles without inventing capability rankings", () => {
    expect(getDriver("dsh")).toBe(driver);
    expect(resolveLaunchProfile(driver, {})).toEqual({ role: "worker", model: "magpie:deepseek/deepseek-flash", effort: "high" });
    expect(resolveLaunchProfile(driver, { role: "reviewer", effort: "max" })).toEqual({ role: "reviewer", model: "magpie:deepseek/deepseek-flash", effort: "max" });
    expect(() => resolveLaunchProfile(driver, { role: "advisor" })).toThrow("does not support role");
  });
  test("quotes launch values, clears inherited options and locates startup files in the delivery directory", () => {
    const command = driver.buildLaunchCommand({ cwd: "/tmp/project's files", deliveryDir: "/tmp/main/.ahelpa/dsh-test", model: "deepseek-flash", effort: "max" });
    expect(command).toContain("cd '/tmp/project'\\''s files'");
    expect(command).toContain("dsh --profile ahelpa --patch '/tmp/main/.ahelpa/dsh-test/dsh.patch.yml'");
    expect(command).toContain("AHELPA_DSH_RESUME_ID=''");
    expect(command).toContain("AHELPA_DSH_EFFORT='max'");
    expect(command).toContain("DSH_PERMISSION_MODE=danger-full-access");
    expect(command).toContain("DSH_TELEMETRY_DISABLED=1");
    const resumed = driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id });
    expect(resumed).toContain(`AHELPA_DSH_RESUME_ID='${id}'`);
    expect(resumed).toContain("AHELPA_DSH_MODEL=''");
    expect(resumed).toContain("AHELPA_DSH_EFFORT=''");
  });
  test.each([
    { model: undefined, provider: "", nativeModel: "" },
    { model: "deepseek-flash", provider: "", nativeModel: "deepseek-flash" },
    { model: "magpie:deepseek/deepseek-flash", provider: "magpie", nativeModel: "deepseek/deepseek-flash" },
    { model: "magpie:vendor/model:variant", provider: "magpie", nativeModel: "vendor/model:variant" },
    { model: " \tmagpie : model:variant \t", provider: " \tmagpie ", nativeModel: " model:variant \t" },
  ])("launch and resume forward provider/model separately for $model", ({ model, provider, nativeModel }) => {
    for (const command of [
      driver.buildLaunchCommand({ cwd: "/tmp/project", model }),
      driver.buildResumeCommand({ cwd: "/tmp/project", model, resumeId: id }),
    ]) {
      expect(command).toContain(`AHELPA_DSH_PROVIDER='${provider}'`);
      expect(command).toContain(`AHELPA_DSH_MODEL='${nativeModel}'`);
    }
  });
  test.each([":model", "provider:", ":", " \t:model", "magpie: \t", " \t: \t"])("rejects invalid qualified model %s before launch or resume", model => {
    const message = "DSH --model must be <model> or <provider>:<model>, with nonempty provider and model";
    expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", model })).toThrow(message);
    expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", model, resumeId: id })).toThrow(message);
    // A regression must fail here without writing a profile into the real DSH home.
    const priorHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(root(), "dsh-home");
    try { expect(() => prepareDshFiles({ cwd: root(), model })).toThrow(message); }
    finally { if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome; }
  });
  test("rejects unsupported permissions, efforts and runtime model switching before terminal input", async () => {
    expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", safe: true })).toThrow("--safe");
    expect(() => driver.buildResumeCommand({ cwd: "/tmp/project", resumeId: id, safe: true })).toThrow("--safe");
    expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", effort: "xhigh" })).toThrow("off, low, high, max");
    const io = runtime([]);
    await expect(driver.switchModel("test", io, { model: "other" })).rejects.toThrow("not supported");
    expect(io.sent).toEqual([]);
  });
  test("uses only current adapter control frames, including during native failures", () => {
    const old = frame("idle");
    expect(driver.detectStatus(old + frame("running", second) + "[AHELPA:DONE]\n")).toBe("running");
    expect(driver.detectActivity(old + frame("running", second))).toBe("working");
    expect(driver.acceptsInput!(old + frame("running", second))).toBe(false);
    expect(driver.detectStatus(old + frame("error", second))).toBe("error");
    expect(driver.detectStatus(frame("needs_attention"))).toBe("needs_attention");
    expect(driver.detectStatus("[AHELPA:DONE]\n")).toBe("running");
    expect(driver.detectActivity("loading")).toBe("booting");
    expect(driver.extractResumeToken(frame("ready"))).toBe(id);
  });
  test("tags cannot leak from a historical turn", () => {
    const help = `[AHELPA_DSH_TURN:${first}]\n[AHELPA_DSH_TAGS:auth,quota]\n[AHELPA_DSH_STATE:needs_attention]\n`;
    expect(driver.detectOutcome(help)).toEqual({ status: "needs_attention", needHelpTags: ["auth", "quota"] });
    expect(driver.detectOutcome(help + frame("idle", second))).toEqual({ status: "idle", needHelpTags: null });
  });
  test("partial control blocks cannot reuse a preceding settled state", async () => {
    const beforeOutput = frame("idle");
    const partial = beforeOutput + `[AHELPA_DSH_TURN:${second}]\n`;
    expect(driver.detectStatus(partial)).toBe("running");
    expect(driver.acceptsInput!(partial)).toBe(false);
    expect(await driver.afterTaskSubmitted("test", runtime([partial]), { beforeOutput })).toBe(true);
    expect(driver.detectStatus(frame("error") + `[AHELPA_DSH_TURN:${first}]\n`)).toBe("running");
    expect(driver.acceptsInput!(`[AHELPA_DSH_SESSION:${id}]\n[AHELPA_DSH_STATE:ready]\n`)).toBe(true);
  });
  test("requires a new turn identity, including repeated prompts and a fast completion", async () => {
    const beforeOutput = frame("idle");
    expect(await driver.afterTaskSubmitted("test", runtime([beforeOutput]), { beforeOutput })).toBe(false);
    expect(await driver.afterTaskSubmitted("test", runtime([frame("idle", second)]), { beforeOutput })).toBe(true);
    expect(await driver.afterTaskSubmitted("test", runtime([beforeOutput]))).toBe(false);
    expect(await driver.afterTaskSubmitted("test", runtime([frame("running", second)]))).toBe(true);
  });
  test.each(["prepareForTask", "prepareForResume"] as const)("%s waits only for an adapter prompt and bounds failures", async method => {
    await driver[method]("test", runtime(["loading", frame("ready")]));
    await expect(driver[method]("test", runtime([frame("error")]))).rejects.toThrow("failed to start");
    const io = runtime(["loading"]);
    await expect(driver[method]("test", io)).rejects.toThrow("input prompt");
    expect(io.captures).toBe(60);
  });
  test("startup files preserve existing profile configuration and never change Desktop", () => {
    const directory = root();
    const priorHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(directory, "dsh-home");
    try {
      const profile = join(process.env.DSH_HOME, "profiles", "ahelpa");
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, "cordis.patch.yml"), "# user configuration\n[]\n");
      const opts = { cwd: directory, deliveryDir: join(directory, "results"), sessionId: "dsh-test" };
      prepareDshFiles(opts);
      const manifest = readFileSync(join(profile, "package.json"), "utf8");
      expect(JSON.parse(manifest).dsh.profile.bundles).toEqual(["@deepseek-ai/dsh-base"]);
      expect(readFileSync(join(profile, "cordis.patch.yml"), "utf8")).toBe("# user configuration\n[]\n");
      expect(existsSync(join(opts.deliveryDir, "dsh-terminal.mjs"))).toBe(true);
      expect(readFileSync(join(opts.deliveryDir, "dsh.patch.yml"), "utf8")).toContain("- id: session-log-deepseek\n  disabled: true");
      prepareDshFiles(opts);
      expect(readFileSync(join(profile, "package.json"), "utf8")).toBe(manifest);
      expect(existsSync(join(process.env.DSH_HOME, "profiles", "desktop"))).toBe(false);
    } finally { if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome; }
  });
  test("doctor reads package metadata without executing dsh or reading a stored secret", () => {
    const directory = root();
    const bin = join(directory, "bin"); const pkg = join(directory, "package");
    mkdirSync(bin); mkdirSync(join(pkg, "lib"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.2", bin: { dsh: "lib/bin.js" } }));
    writeFileSync(join(pkg, "lib/bin.js"), "#!/bin/sh\nexit 99\n"); chmodSync(join(pkg, "lib/bin.js"), 0o755);
    symlinkSync(join(pkg, "lib/bin.js"), join(bin, "dsh"));
    const result = checkDshReadiness(directory, { homeDir: directory, env: { PATH: bin, DEEPSEEK_API_KEY: "fixture-secret" } });
    expect(result.version).toBe("0.2.1-rc.2");
    expect(result.locally_ready).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
  test.each([".env", ".credentials.yaml"])("doctor recognizes %s by existence without reading or leaking contents", source => {
    const directory = root();
    const bin = join(directory, "bin"); const home = join(directory, "dsh-home");
    mkdirSync(bin); mkdirSync(home);
    writeFileSync(join(bin, "dsh"), "#!/bin/sh\nexit 99\n"); chmodSync(join(bin, "dsh"), 0o755);
    writeFileSync(join(home, source), "MAGPIE_API_KEY=fixture-stored-secret\n");
    const profile = join(home, "profiles", "ahelpa");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "cordis.patch.yml"), "[]\n");
    const reads = spyOn(fs, "readFileSync");
    try {
      const result = checkDshReadiness(directory, { homeDir: directory, env: { PATH: bin, DSH_HOME: home } });
      const pathsRead = reads.mock.calls.map(([path]) => String(path));
      // Positive control: the spy must observe the driver's imported fs binding.
      expect(pathsRead).toContain(join(home, "profiles", "ahelpa", "cordis.patch.yml"));
      expect(pathsRead).not.toContain(join(home, ".env"));
      expect(pathsRead).not.toContain(join(home, ".credentials.yaml"));
      expect(result.reasons).toContain("credentials are validated by DSH at launch");
      expect(result.reasons.some(reason => reason.includes("configure credentials"))).toBe(false);
      expect(JSON.stringify(result)).not.toContain("fixture-stored-secret");
    } finally { reads.mockRestore(); }
  });
  test.each([
    { patch: undefined, missing: true },
    { patch: "[]\n# magpie: ignored comment\n", missing: true },
    { patch: "- id: llm-pi-ai\n  config:\n    providers:\n      magpie-other: {}\n", missing: true },
    { patch: "- id: llm-pi-ai\n  config:\n    providers:\n      magpie:\n        apiKeyEnv: FIXTURE_KEY\n", missing: false },
  ])("doctor reports missing Magpie route: $patch", ({ patch, missing }) => {
    const directory = root(); const bin = join(directory, "bin"); const home = join(directory, "dsh-home");
    const profile = join(home, "profiles", "ahelpa");
    mkdirSync(bin); mkdirSync(profile, { recursive: true });
    writeFileSync(join(bin, "dsh"), "#!/bin/sh\nexit 99\n"); chmodSync(join(bin, "dsh"), 0o755);
    if (patch !== undefined) writeFileSync(join(profile, "cordis.patch.yml"), patch + "# fixture-profile-secret\n");
    const result = checkDshReadiness(directory, { homeDir: directory, env: { PATH: bin, DSH_HOME: home } });
    expect(result.locally_ready).toBe("unknown");
    expect(result.reasons).toContain("configure credentials with a provider key in $DSH_HOME/.env, DSH Web, or DEEPSEEK_API_KEY");
    expect(result.reasons.includes("default route needs a magpie provider in $DSH_HOME/profiles/ahelpa/cordis.patch.yml")).toBe(missing);
    expect(JSON.stringify(result)).not.toContain("fixture-profile-secret");
  });
});
