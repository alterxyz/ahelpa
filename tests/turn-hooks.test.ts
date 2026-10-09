import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { getSelfCommand } from "../src/self-command";
import { parseTurnPayload, readTurnEvents, turnHookCommand, writeTurnHook } from "../src/turn-hooks";
import { claudeCodeDriver } from "../src/drivers/claude-code";
import { codexDriver } from "../src/drivers/codex";
import * as capabilities from "../src/drivers/codex-capabilities";
import { defaultRuntimeLayout } from "../src/runtime-layout";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/turn-hooks", name + ".json"), "utf8");
let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".ahelpa", "hooks-test-"));
  dir = join(root, ".ahelpa", "codex-fixture");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => { mock.restore(); rmSync(root, { recursive: true, force: true }); });

describe("turn hook payloads and append", () => {
  test("Claude Stop and StopFailure retain only identifiers and length/presence", () => {
    const stop = parseTurnPayload("claude-code", fixture("claude-stop"))!;
    expect(stop).toMatchObject({ agent: "claude-code", event: "stop", sessionId: "claude-native-1", promptId: "prompt-1", stopHookActive: false,
      assistantMessagePresent: true, assistantMessageLength: "private model output".length });
    const failure = parseTurnPayload("claude-code", fixture("claude-failure"))!;
    expect(failure).toMatchObject({ event: "stop_failure", error: "authentication_failed" });
    expect(JSON.stringify([stop, failure])).not.toContain("private");
    expect(parseTurnPayload("claude-code", fixture("claude-failure").replace("authentication_failed", "secret / arbitrary text"))?.error).toBe("unknown");
  });

  test("Codex binds the first task thread and ignores title notifications before and after binding", () => {
    writeTurnHook(dir, "codex", fixture("codex-title"));
    expect(existsSync(join(dir, "turns.log"))).toBe(false);
    writeTurnHook(dir, "codex", fixture("codex-complete"));
    writeTurnHook(dir, "codex", fixture("codex-title"));
    writeTurnHook(dir, "codex", fixture("codex-complete")); // duplicate delivery
    const followup = JSON.parse(fixture("codex-complete"));
    followup["turn-id"] = "turn-2";
    followup["input-messages"] = ["ordinary follow-up"];
    writeTurnHook(dir, "codex", JSON.stringify(followup));
    followup["thread-id"] = "foreign-thread";
    followup["input-messages"] = ["Please read and complete the task described in elsewhere"];
    writeTurnHook(dir, "codex", JSON.stringify(followup));
    const lines = readFileSync(join(dir, "turns.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ event: "turn_complete", threadId: "main-thread", turnId: "turn-1", inputMessagesPresent: true,
      inputMessagesLength: JSON.parse(fixture("codex-complete"))["input-messages"][0].length });
    expect(lines.join("\n")).not.toMatch(/private|ordinary follow-up|Please read/);
    expect(readTurnEvents(join(dir, "turns.log")).event?.turnId).toBe("turn-2");
  });

  test.each(["not json", "null", "[]", "{}", '{"type":"other"}', '{"hook_event_name":"Stop","session_id":"../escape"}'])("ignores malformed or unsupported input: %s", raw => {
    for (const agent of ["claude-code", "codex", "kimi"]) {
      expect(parseTurnPayload(agent, raw)).toBeNull();
      expect(() => writeTurnHook(dir, agent, raw)).not.toThrow();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("native resume binds its known main thread before an ordinary follow-up notify", async () => {
    const payload = JSON.parse(fixture("codex-complete"));
    payload["input-messages"] = ["ordinary follow-up"];
    const child = Bun.spawn([...turnHookCommand(dir, "codex", "main-thread"), JSON.stringify(payload)], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(readTurnEvents(join(dir, "turns.log")).event?.threadId).toBe("main-thread");
    writeTurnHook(dir, "codex", fixture("codex-title"), "main-thread");
    expect(readFileSync(join(dir, "turns.log"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("cursor skips complete malformed lines, waits for partial appends and filters old events", () => {
    writeTurnHook(dir, "codex", fixture("codex-complete"));
    const log = join(dir, "turns.log");
    const content = readFileSync(log, "utf8");
    writeFileSync(log, content + "broken\n{\"ts\":");
    const first = readTurnEvents(log);
    expect(first.offset).toBe(Buffer.byteLength(content + "broken\n"));
    expect(first.event?.turnId).toBe("turn-1");
    expect(readTurnEvents(log, first.offset).event).toBeNull();
    expect(readTurnEvents(log, 0, "2999-01-01T00:00:00.000Z").event).toBeNull();
    expect(readTurnEvents(log, 0, "", "claude-code").event).toBeNull();
  });

  test("subcommand is silent, exits zero, and cannot write outside its session directory", async () => {
    const forbiddenHome = join(root, "forbidden-home");
    const invoke = async (args: string[], input = "") => {
      const child = Bun.spawn([...getSelfCommand(), "__turn-hook", ...args], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, AHELPA_HOME: forbiddenHome } });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exit, out, err }).toEqual({ exit: 0, out: "", err: "" });
    };
    await invoke([dir, "claude-code"], fixture("claude-stop"));
    await invoke([dir, "codex", fixture("codex-complete")]);
    expect(readdirSync(dir)).toEqual(["turns.log"]);
    expect(existsSync(forbiddenHome)).toBe(false);
    mkdirSync(join(root, "not-a-session"));
    await invoke([join(root, "not-a-session"), "codex", fixture("codex-complete")]);
    expect(existsSync(join(root, "not-a-session", "turns.log"))).toBe(false);
    const victim = join(root, "victim");
    writeFileSync(victim, "unchanged");
    const badDir = join(root, ".ahelpa", "bad-session");
    mkdirSync(badDir);
    symlinkSync(victim, join(badDir, "turns.log"));
    await invoke([badDir, "codex", fixture("codex-complete")]);
    expect(readFileSync(victim, "utf8")).toBe("unchanged");
    const linked = join(root, ".ahelpa", "linked-session");
    symlinkSync(root, linked);
    await invoke([linked, "codex", fixture("codex-complete")]);
    expect(existsSync(join(root, "turns.log"))).toBe(false);
    await invoke([dir, "claude-code"], "malformed");
  });

  test("stdin left open cannot block the hook command", async () => {
    const start = Date.now();
    const child = Bun.spawn([...getSelfCommand(), "__turn-hook", dir, "claude-code"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(Date.now() - start).toBeLessThan(2000);
    } finally { child.stdin.end(); child.kill(); }
  });
});

describe("driver hook launch and resume", () => {
  test("self invocation supports source and compiled runtimes", () => {
    expect(getSelfCommand("/runtime/ahelpa", root)).toEqual(["/runtime/ahelpa"]);
    writeFileSync(join(root, "cli.ts"), "");
    expect(getSelfCommand("/runtime/bun", root)).toEqual(["/runtime/bun", join(root, "cli.ts")]);
  });

  test.each(["launch", "resume"])("Claude %s loads session settings with both command hooks", kind => {
    const sessionId = "claude-test";
    const sessionDir = defaultRuntimeLayout.sessionDeliveryDir(root, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    claudeCodeDriver.prepareLaunchFiles!({ cwd: root, sessionId });
    const settings = JSON.parse(readFileSync(defaultRuntimeLayout.claudeSettingsPath(root, sessionId), "utf8"));
    expect(Object.keys(settings)).toEqual(["hooks"]);
    expect(Object.keys(settings.hooks)).toEqual(["Stop", "StopFailure"]);
    const hook = settings.hooks.Stop[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain("__turn-hook");
    expect(hook.command).toContain(sessionDir);
    expect(settings.hooks.StopFailure).toEqual(settings.hooks.Stop);
    const command = kind === "launch" ? claudeCodeDriver.buildLaunchCommand({ cwd: root, sessionId })
      : claudeCodeDriver.buildResumeCommand({ cwd: root, sessionId, resumeId: "native" });
    expect(command).toContain(`--settings '${defaultRuntimeLayout.claudeSettingsPath(root, sessionId)}'`);
    expect(command).toContain("--dangerously-skip-permissions");
    if (kind === "resume") expect(command).toContain("--resume 'native'");
  });

  test.each(["launch", "resume"])("Codex %s passes a TOML notify array with lossless shell quoting", async kind => {
    spyOn(capabilities, "getCodexCapabilities").mockReturnValue({ executable: "/bin/echo", noDaemon: true });
    const project = join(root, `spaces 'quote' \\backslash`);
    mkdirSync(project);
    const opts = { cwd: project, sessionId: "codex-test", resumeId: "native", model: "m", effort: "high" };
    const command = kind === "launch" ? codexDriver.buildLaunchCommand({ cwd: project, sessionId: opts.sessionId, model: opts.model, effort: opts.effort }) : codexDriver.buildResumeCommand(opts);
    const child = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(out).toContain("--no-daemon");
    expect(command).not.toContain("hooks.");
    const array = out.slice(out.indexOf("notify=") + 7, out.indexOf("]", out.indexOf("notify=")) + 1);
    expect(JSON.parse(array)).toEqual(turnHookCommand(defaultRuntimeLayout.sessionDeliveryDir(project, "codex-test"), "codex", kind === "resume" ? "native" : undefined));
    if (kind === "resume") expect(out).toContain("resume native");
  });
});
