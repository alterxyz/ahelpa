import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { getSelfCommand } from "../src/self-command";
import { shellEscape } from "../src/shell";
import { inputDigest, parseTurnPayload, readTurnEvents, turnHookCommand, writeTurnHook } from "../src/turn-hooks";
import { claudeCodeDriver } from "../src/drivers/claude-code";
import { codexDriver } from "../src/drivers/codex";
import { piDriver, piTurnHookSource } from "../src/drivers/pi";
import { vibeDriver, vibeHooksToml } from "../src/drivers/vibe";
import { agyDriver, agyHooksJson } from "../src/drivers/agy";
import * as capabilities from "../src/drivers/codex-capabilities";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { getDriver } from "../src/drivers/registry";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { defaultWakeup } from "../src/wakeup";
import * as daemon from "../src/daemon";
import { COMPLETION_NUDGE, refreshSessionStatuses } from "../src/daemon";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/turn-hooks", name + ".json"), "utf8");
let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "hooks-test-"));
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

  test("Pi agent_settled keeps identifiers, the input digest and the failure kind only", () => {
    const stop = parseTurnPayload("pi", fixture("pi-settled"))!;
    expect(stop).toMatchObject({ agent: "pi", event: "stop", sessionId: "01a1ba46-1991-7028-89ff-d13bd7453fb0",
      turnId: "f62d84d8-a956-49dc-a86e-b346f651e604", inputDigest: inputDigest("private task input") });
    expect(stop.error).toBeUndefined();
    const payload = JSON.parse(fixture("pi-settled"));
    expect(parseTurnPayload("pi", JSON.stringify({ ...payload, aborted: true }))).toMatchObject({ event: "stop_failure", error: "aborted" });
    expect(parseTurnPayload("pi", JSON.stringify({ ...payload, stopReason: "error" }))).toMatchObject({ event: "stop_failure", error: "error" });
    expect(parseTurnPayload("pi", JSON.stringify({ ...payload, stopReason: "length" }))?.event).toBe("stop");
    expect(parseTurnPayload("pi", JSON.stringify({ ...payload, input: undefined }))?.inputDigest).toBeUndefined();
    expect(parseTurnPayload("pi", JSON.stringify({ ...payload, turnId: undefined }))).toBeNull();
    expect(parseTurnPayload("pi", JSON.stringify({ ...payload, sessionId: undefined }))).toBeNull();
    expect(parseTurnPayload("pi", JSON.stringify({ ...payload, sessionId: "../escape" }))).toBeNull();
    expect(parseTurnPayload("pi", JSON.stringify({ ...payload, type: "agent_end" }))).toBeNull();
    writeTurnHook(dir, "pi", fixture("pi-settled"));
    writeTurnHook(dir, "pi", fixture("pi-settled")); // duplicate delivery
    writeTurnHook(dir, "pi", JSON.stringify({ ...payload, turnId: "turn-2" }));
    const log = readFileSync(join(dir, "turns.log"), "utf8");
    expect(log.trim().split("\n")).toHaveLength(2);
    expect(log).not.toContain("private");
    expect(readTurnEvents(join(dir, "turns.log")).event?.turnId).toBe("turn-2");
    const forged = JSON.parse(log.trim().split("\n")[0]);
    writeFileSync(join(dir, "turns.log"), JSON.stringify({ ...forged, inputDigest: "not-a-digest" }) + "\n");
    expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
  });

  test("agy Stop keeps the conversation id and the input digest, and waits for background tasks", () => {
    const stop = parseTurnPayload("agy", fixture("agy-stop"))!;
    expect(stop).toMatchObject({ agent: "agy", event: "stop", sessionId: "f76b791e-7046-483d-b6c3-9eaab2a2ae0d", inputDigest: inputDigest("private task input") });
    expect(JSON.stringify(stop)).not.toContain("private");
    const payload = JSON.parse(fixture("agy-stop"));
    expect(parseTurnPayload("agy", JSON.stringify({ ...payload, fullyIdle: false }))).toBeNull();
    expect(parseTurnPayload("agy", JSON.stringify({ ...payload, fullyIdle: undefined }))).toBeNull();
    expect(parseTurnPayload("agy", JSON.stringify({ ...payload, conversationId: "../x" }))).toBeNull();
    expect(parseTurnPayload("agy", JSON.stringify({ ...payload, terminationReason: undefined }))).toBeNull();
    expect(parseTurnPayload("agy", JSON.stringify({ ...payload, terminationReason: "ERROR", error: "provider text" }))).toMatchObject({ event: "stop_failure", error: "error" });
    expect(parseTurnPayload("agy", JSON.stringify({ ...payload, terminationReason: "USER_CANCELED" }))).toMatchObject({ event: "stop_failure", error: "user_canceled" });
    expect(parseTurnPayload("agy", JSON.stringify({ ...payload, terminationReason: "MAX_INVOCATIONS" }))?.event).toBe("stop");
    expect(parseTurnPayload("agy", JSON.stringify({ ...payload, lastUserInput: undefined }))?.inputDigest).toBeUndefined();
    writeTurnHook(dir, "agy", fixture("agy-stop"));
    writeTurnHook(dir, "agy", fixture("agy-stop")); // executionNum is 0 on every turn: still a new event
    const log = join(dir, "turns.log");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(log, "utf8")).not.toContain("private");
    expect(readTurnEvents(log, 0, "", "agy", inputDigest("private task input")).event?.agent).toBe("agy");
    expect(readTurnEvents(log, 0, "", "agy", inputDigest("other input")).event).toBeNull();
  });

  test("Vibe post_agent keeps the session id only, gets a fresh turn id, and skips subagents", () => {
    const stop = parseTurnPayload("vibe", fixture("vibe-post-agent"))!;
    expect(stop).toMatchObject({ agent: "vibe", event: "stop", sessionId: "4d047f6d-ab28-b6c5-c120-6f10228b82ba" });
    expect(stop.inputDigest).toBeUndefined();
    expect(JSON.stringify(stop)).not.toContain("private");
    const payload = JSON.parse(fixture("vibe-post-agent"));
    expect(parseTurnPayload("vibe", JSON.stringify({ ...payload, parent_session_id: "parent" }))).toBeNull();
    expect(parseTurnPayload("vibe", JSON.stringify({ ...payload, hook_event_name: "post_tool" }))).toBeNull();
    expect(parseTurnPayload("vibe", JSON.stringify({ ...payload, session_id: "../x" }))).toBeNull();
    writeTurnHook(dir, "vibe", fixture("vibe-post-agent"));
    writeTurnHook(dir, "vibe", fixture("vibe-post-agent")); // the next turn of the same session
    const lines = readFileSync(join(dir, "turns.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].turnId).not.toBe(lines[1].turnId);
  });

  test.each(["not json", "null", "[]", "{}", '{"type":"other"}', '{"hook_event_name":"Stop","session_id":"../escape"}'])("ignores malformed or unsupported input: %s", raw => {
    for (const agent of ["claude-code", "codex", "pi", "vibe", "agy", "kimi"]) {
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
    await invoke([dir, "pi"], fixture("pi-settled"));
    await invoke([dir, "vibe"], fixture("vibe-post-agent"));
    await invoke([dir, "agy"], fixture("agy-stop"));
    expect(readdirSync(dir)).toEqual(["turns.log"]);
    expect(readFileSync(join(dir, "turns.log"), "utf8")).toMatch(/"agent":"pi"[\s\S]*"agent":"vibe"[\s\S]*"agent":"agy"/);
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
    expect(Object.keys(settings)).toEqual(["promptSuggestionEnabled", "hooks"]);
    expect(settings.promptSuggestionEnabled).toBe(false);
    expect(Object.keys(settings.hooks)).toEqual(["UserPromptSubmit", "Stop", "StopFailure"]);
    const hook = settings.hooks.Stop[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain("__turn-hook");
    expect(hook.command).toContain(sessionDir);
    expect(settings.hooks.StopFailure).toEqual(settings.hooks.Stop);
    const command = kind === "launch" ? claudeCodeDriver.buildLaunchCommand({ cwd: root, sessionId })
      : claudeCodeDriver.buildResumeCommand!({ cwd: root, sessionId, resumeId: "native" });
    expect(command).toContain(`--settings '${defaultRuntimeLayout.claudeSettingsPath(root, sessionId)}'`);
    expect(command).toContain("--dangerously-skip-permissions");
    if (kind === "resume") expect(command).toContain("--resume 'native'");
  });

  test.each(["launch", "resume"])("Codex %s passes a TOML notify array with lossless shell quoting", async kind => {
    spyOn(capabilities, "getCodexCapabilities").mockReturnValue({ executable: "/bin/echo", noDaemon: true });
    const project = join(root, `spaces 'quote' \\backslash`);
    mkdirSync(project);
    const opts = { cwd: project, sessionId: "codex-test", resumeId: "native", model: "m", effort: "high" };
    const command = kind === "launch" ? codexDriver.buildLaunchCommand({ cwd: project, sessionId: opts.sessionId, model: opts.model, effort: opts.effort }) : codexDriver.buildResumeCommand!(opts);
    const child = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(out).toContain("--no-daemon");
    expect(command).not.toContain("hooks.");
    const array = out.slice(out.indexOf("notify=") + 7, out.lastIndexOf("]") + 1);
    expect(JSON.parse(array)).toEqual(turnHookCommand(defaultRuntimeLayout.sessionDeliveryDir(project, "codex-test"), "codex", kind === "resume" ? "native" : undefined));
    if (kind === "resume") expect(out).toContain("resume native");
  });
  test.each(["launch", "resume"])("Pi %s loads the session's turn-hook extension explicitly", kind => {
    const sessionId = "pi-test";
    const sessionDir = defaultRuntimeLayout.sessionDeliveryDir(root, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    piDriver.prepareLaunchFiles!({ cwd: root, sessionId });
    const extension = join(sessionDir, "pi-turn-hook.mjs");
    expect(readFileSync(extension, "utf8")).toBe(piTurnHookSource(turnHookCommand(sessionDir, "pi")));
    expect(() => piDriver.prepareLaunchFiles!({ cwd: root, sessionId })).toThrow(); // never overwrites
    const command = kind === "launch" ? piDriver.buildLaunchCommand({ cwd: root, sessionId })
      : piDriver.buildResumeCommand!({ cwd: root, sessionId, resumeId: "01a1ba46-1991-7028-89ff-d13bd7453fb0" });
    expect(command).toContain(`--no-extensions --no-mcp -e '${extension}'`);
    const elsewhere = join(root, "main", ".ahelpa", sessionId);
    expect(piDriver.buildLaunchCommand({ cwd: root, sessionId, deliveryDir: elsewhere })).toContain(`-e '${join(elsewhere, "pi-turn-hook.mjs")}'`);
  });

  test("Pi extension sends agent_settled with the last input and stop reason, then forgets them", async () => {
    const out = join(root, "payloads");
    mkdirSync(out);
    const path = join(root, "ext.mjs");
    writeFileSync(path, piTurnHookSource(["/bin/sh", "-c", `cat > '${out}'/$$.tmp && mv '${out}'/$$.tmp '${out}'/$$.json`]));
    const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
    (await import(path)).default({ on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => { handlers[name] = handler; } });
    const ctx = { sessionManager: { getSessionId: () => "native-session" } };
    const done = () => readdirSync(out).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(out, name), "utf8")));
    // The handler resolves only after the hook has written: Pi defers a new prompt until then.
    const settle = async (aborted = false) => {
      const seen = new Set(done().map(p => p.turnId));
      await handlers.agent_settled({ aborted }, ctx);
      const added = done().filter(p => !seen.has(p.turnId));
      expect(added).toHaveLength(1);
      return added[0];
    };
    expect(handlers.input({ text: "the task" })).toBeUndefined();
    expect(handlers.message_end({ message: { role: "assistant", stopReason: "toolUse" } })).toBeUndefined();
    handlers.message_end({ message: { role: "assistant", stopReason: "error", errorMessage: "provider text" } });
    handlers.message_end({ message: { role: "toolResult", stopReason: "stop" } }); // only assistant messages count
    expect(await settle()).toMatchObject({ type: "agent_settled", sessionId: "native-session", aborted: false, stopReason: "error", input: "the task" });
    const forgotten = await settle(true); // settled forgets the input and the stop reason
    expect(forgotten.aborted).toBe(true);
    expect([forgotten.input, forgotten.stopReason]).toEqual([undefined, undefined]);
    handlers.message_end({ message: { role: "assistant", stopReason: "error" } });
    handlers.input({ text: "next" }); // a new input forgets the old stop reason
    const next = await settle();
    expect([next.input, next.stopReason]).toEqual(["next", undefined]);
    const payloads = done();
    expect(new Set(payloads.map(p => p.turnId)).size).toBe(3);
    expect(JSON.stringify(payloads)).not.toContain("provider text");
  });
  test.each(["launch", "resume"])("Vibe %s adds its own hook root whose post_agent hook runs silently", async kind => {
    const sessionId = "mistral-test";
    const sessionDir = defaultRuntimeLayout.sessionDeliveryDir(root, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    vibeDriver.prepareLaunchFiles!({ cwd: root, sessionId });
    const hooks = join(sessionDir, "vibe-hook", ".vibe", "hooks.toml");
    expect(statSync(hooks).mode & 0o777).toBe(0o600);
    expect(() => vibeDriver.prepareLaunchFiles!({ cwd: root, sessionId })).toThrow(); // never overwrites
    const parsed = Bun.TOML.parse(readFileSync(hooks, "utf8")) as { hooks: Record<string, unknown>[] };
    expect(parsed.hooks).toEqual([{ name: "ahelpa-turn", type: "post_agent", match: "main", timeout: 10,
      command: turnHookCommand(sessionDir, "vibe").map(shellEscape).join(" ") }]);
    expect(vibeDriver.turnHooks).toBeUndefined(); // the event names no input: it wakes the daemon, never decides
    // Every path character survives TOML, DEL included (JSON leaves it raw; TOML forbids it).
    const odd = ["/tmp/a b/it's \"q\" \\ \u007f é\n\tx", "__turn-hook"];
    expect(Bun.TOML.parse(vibeHooksToml(odd))).toMatchObject({ hooks: [{ command: odd.map(shellEscape).join(" ") }] });
    // Without a session there is no result directory: nothing is written.
    const bare = join(root, "bare");
    mkdirSync(bare);
    vibeDriver.prepareLaunchFiles!({ cwd: bare });
    expect(readdirSync(bare)).toEqual([]);
    const command = kind === "launch" ? vibeDriver.buildLaunchCommand({ cwd: root, sessionId })
      : vibeDriver.buildResumeCommand!({ cwd: root, sessionId, resumeId: "d68ff081" });
    expect(command).toContain(`--add-dir '${join(sessionDir, "vibe-hook")}'`);
    // Vibe runs the line through a shell with the payload on stdin; empty stdout and exit 0 pass the turn through.
    const child = Bun.spawn(["/bin/sh", "-c", parsed.hooks[0].command as string], { stdin: new Blob([fixture("vibe-post-agent")]), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AHELPA_HOME: join(root, "home") } });
    expect([await child.exited, await new Response(child.stdout).text()]).toEqual([0, ""]);
    expect(readFileSync(join(sessionDir, "turns.log"), "utf8")).toContain('"agent":"vibe"');
  });
  test.each(["launch", "resume"])("agy %s adds its own hook root whose Stop hook prints {} and records the turn", async kind => {
    const sessionId = "gemini-test";
    const sessionDir = defaultRuntimeLayout.sessionDeliveryDir(root, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    agyDriver.prepareLaunchFiles!({ cwd: root, sessionId });
    const hooks = join(sessionDir, "agy-hook", ".agents", "hooks.json");
    expect(statSync(hooks).mode & 0o777).toBe(0o600);
    expect(readFileSync(hooks, "utf8")).toBe(agyHooksJson(turnHookCommand(sessionDir, "agy")));
    expect(() => agyDriver.prepareLaunchFiles!({ cwd: root, sessionId })).toThrow(); // never overwrites
    expect(() => agyDriver.prepareLaunchFiles!({ cwd: root, sessionId: "gemini-safe", safe: true })).toThrow("--safe");
    const bare = join(root, "bare");
    mkdirSync(bare);
    agyDriver.prepareLaunchFiles!({ cwd: bare });
    expect(readdirSync(bare)).toEqual([]);
    const command = kind === "launch" ? agyDriver.buildLaunchCommand({ cwd: root, sessionId })
      : agyDriver.buildResumeCommand!({ cwd: root, sessionId, resumeId: "f76b791e-7046-483d-b6c3-9eaab2a2ae0d" });
    expect(command).toContain(`--add-dir '${join(sessionDir, "agy-hook")}'`);
    // Another project or plugin Stop handler may still answer "continue": the event wakes, never decides.
    expect(agyDriver.turnHooks).toBeUndefined();
    const handler = JSON.parse(readFileSync(hooks, "utf8")).ahelpa.Stop[0];
    expect(handler).toMatchObject({ type: "command", timeout: 10 });
    // agy runs it with sh -c in the hooks.json folder, payload on stdin, and reads a JSON object from stdout.
    const child = Bun.spawn(["/bin/sh", "-c", handler.command], { cwd: join(sessionDir, "agy-hook", ".agents"), stdin: new Blob([fixture("agy-stop")]),
      stdout: "pipe", stderr: "pipe", env: { ...process.env, AHELPA_HOME: join(root, "home") } });
    expect([await child.exited, await new Response(child.stdout).text()]).toEqual([0, "{}"]);
    expect(readFileSync(join(sessionDir, "turns.log"), "utf8")).toContain('"agent":"agy"');
  });
});

describe("turn hook safety", () => {
  let root: string, dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "safety-test-"));
    dir = join(root, ".ahelpa", "session-test");
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const claude = JSON.stringify({ hook_event_name: "Stop", session_id: "native", prompt_id: "one" });
  const codex = JSON.stringify({ type: "agent-turn-complete", "thread-id": "main", "turn-id": "one", "input-messages": ["Please read and complete the task described in fixture"] });
  test("hardlinked turns.log never modifies the outside-session victim", () => {
    const victim = join(root, "outside-session.txt");
    writeFileSync(victim, "must remain unchanged\n");
    linkSync(victim, join(dir, "turns.log"));
    writeTurnHook(dir, "claude-code", claude);
    expect(readFileSync(victim, "utf8")).toBe("must remain unchanged\n");
  });
  test("saved Claude and Codex hooks stay silent and successful after compiled runtime moves or becomes unusable", async () => {
    const binary = join(root, "runtime 'quote' $literal 中文");
    const build = Bun.spawn([process.execPath, "build", join(process.cwd(), "src/cli.ts"), "--compile", `--outfile=${binary}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, , stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const cli = join(process.cwd(), "src/cli.ts");
    const saved = (agent: "claude-code" | "codex") => turnHookCommand(dir, agent).flatMap(arg => {
      if (arg === process.execPath) return [binary];
      if (arg === cli) return [];
      return [arg.replace(`${shellEscape(process.execPath)} ${shellEscape(cli)}`, shellEscape(binary))];
    });
    const commands = { "claude-code": saved("claude-code"), codex: saved("codex") };
    const invoke = async (agent: "claude-code" | "codex") => {
      const argv = [...commands[agent], ...(agent === "codex" ? [codex] : [])];
      const child = Bun.spawn(["/bin/sh", "-c", argv.map(shellEscape).join(" ")], { stdin: agent === "claude-code" ? new Blob([claude]) : "ignore", stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
    };
    for (const agent of ["claude-code", "codex"] as const) await invoke(agent);
    const events = readFileSync(join(dir, "turns.log"), "utf8");
    expect(events).toContain('"event":"stop"');
    expect(events).toContain('"event":"turn_complete"'); // final JSON arg survived sh forwarding
    renameSync(binary, binary + ".moved");
    for (const agent of ["claude-code", "codex"] as const) await invoke(agent);
    writeFileSync(binary, "not an executable image\n");
    chmodSync(binary, 0o700);
    for (const agent of ["claude-code", "codex"] as const) await invoke(agent);
    expect(readFileSync(join(dir, "turns.log"), "utf8")).toBe(events);
  }, 20000);
});

describe("turn hooks with Codex rollouts and subagents", () => {
  const input = "Please read and complete the task described in synthetic-task";
  const main = "01a1440e-2994-7843-9a53-6f872804dac4";
  const child = "01a1440e-a757-7f83-a65a-daa510ccf783";
  let root: string, dir: string, db: StateDB;
  let previousHome: string | undefined;
  const timezoneState = () => ({
    env: process.env.TZ,
    offsets: [new Date("2026-01-15T12:00:00Z").getTimezoneOffset(), new Date("2026-07-15T12:00:00Z").getTimezoneOffset()],
  });
  let timezoneBefore: ReturnType<typeof timezoneState>;

  beforeEach(() => {
    timezoneBefore = timezoneState();
    root = mkdtempSync(join(realpathSync(tmpdir()), "subagent-hooks-"));
    previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, "codex-home");
    mkdirSync(process.env.CODEX_HOME);
    dir = join(root, ".ahelpa", "session-test");
    mkdirSync(dir, { recursive: true });
    db = new StateDB(join(root, "state.db"));
    const row = db.createSession({ id: "session-test", parentId: "host", agentType: "codex", task: "fixture", ownerToken: "tok", projectPath: root });
    db.beginTurn(row.id, row.version, input);
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(session => session.id)));
    spyOn(Tmux, "capture").mockResolvedValue("Working (1s • esc to interrupt)");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
  });

  afterEach(() => {
    mock.restore();
    db.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
    // Per-test sentinel: no dependency on another test file's execution order.
    expect(timezoneState()).toEqual(timezoneBefore);
  });

  function rollout(thread: string, source: unknown, delay = 0): string {
    const date = new Date(parseInt(thread.replaceAll("-", "").slice(0, 12), 16) + delay * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    const path = join(process.env.CODEX_HOME!, "sessions", ...day.split("-"), `rollout-${day}T${time}-${thread}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: thread, source } }) + "\nsynthetic non-metadata content\n");
    return path;
  }

  function payload(thread: string, turn = "one", messages = [input]) {
    return JSON.stringify({ type: "agent-turn-complete", "thread-id": thread, "turn-id": turn, "input-messages": messages });
  }

  const subagent = { subagent: { thread_spawn: { parent_thread_id: main, depth: 1 } } };
  const log = () => existsSync(join(dir, "turns.log")) ? readFileSync(join(dir, "turns.log"), "utf8") : "";

  test("subagent completes first with matching input: no binding or settlement; main completion still settles", async () => {
    rollout(child, subagent);
    rollout(main, "cli");
    writeTurnHook(dir, "codex", payload(child));
    expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("running");
    writeTurnHook(dir, "codex", payload(main));
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("needs_attention");
    expect(log().trim().split("\n")).toHaveLength(1);
    expect(readTurnEvents(join(dir, "turns.log")).event?.threadId).toBe(main);
    expect(log()).not.toContain(child);
  });

  test("main completes first: later subagent cannot change its binding or settlement", async () => {
    rollout(main, "cli");
    rollout(child, subagent);
    writeTurnHook(dir, "codex", payload(main));
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("needs_attention");
    const before = log();
    writeTurnHook(dir, "codex", payload(child));
    expect(log()).toBe(before);
    expect(db.getSession("session-test")?.status).toBe("needs_attention");
  });

  test.each(["missing", "missing-source", "malformed", "wrong-id", "oversized", "symlink", "late"])("unavailable metadata (%s) preserves first-event binding and settlement", async kind => {
    if (kind !== "missing") {
      const path = rollout(child, kind === "missing-source" ? undefined : subagent, kind === "late" ? 5 : 0);
      if (kind === "malformed") writeFileSync(path, "not json\n");
      if (kind === "wrong-id") writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: main, source: subagent } }) + "\n");
      if (kind === "oversized") writeFileSync(path, " ".repeat(64 * 1024) + JSON.stringify({ type: "session_meta", payload: { id: child, source: subagent } }) + "\n");
      if (kind === "symlink") {
        const target = join(root, "metadata");
        writeFileSync(target, readFileSync(path));
        rmSync(path);
        symlinkSync(target, path);
      }
    }
    writeTurnHook(dir, "codex", payload(child));
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("needs_attention");
    writeTurnHook(dir, "codex", payload(main));
    expect(readTurnEvents(join(dir, "turns.log")).event?.threadId).toBe(child);
    expect(log().trim().split("\n")).toHaveLength(1);
  });

  test("bounded lookup includes a rollout created four seconds after the UUID", () => {
    rollout(child, subagent, 4);
    writeTurnHook(dir, "codex", payload(child));
    expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
  });

  // The daemon relaxes Codex readiness only for verified events; see turn-hook-daemon.test.ts.
  const verifiedFlags = () => log().trim().split("\n").map(line => JSON.parse(line).threadVerified);

  test("a thread whose rollout names it main is verified, and so are its later events", () => {
    rollout(main, "cli");
    writeTurnHook(dir, "codex", payload(main));
    writeTurnHook(dir, "codex", payload(main, "two", ["follow-up"]));
    expect(verifiedFlags()).toEqual([true, true]);
  });

  test.each(["missing", "missing-source"])("a fail-open binding (%s metadata) stays unverified, and so do its later events", kind => {
    if (kind === "missing-source") rollout(main, undefined);
    writeTurnHook(dir, "codex", payload(main));
    rollout(main, "cli"); // appearing later cannot upgrade the binding
    writeTurnHook(dir, "codex", payload(main, "two", ["follow-up"]));
    expect(verifiedFlags()).toEqual([false, false]);
  });

  test("a thread bound explicitly on resume is verified without rollout metadata", () => {
    writeTurnHook(dir, "codex", payload(main), main);
    expect(verifiedFlags()).toEqual([true]);
  });

  test("native resume rejects an earlier child and binds the explicit thread without rollout metadata", async () => {
    writeTurnHook(dir, "codex", payload(child), main);
    expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
    const command = Bun.spawn([...turnHookCommand(dir, "codex", main), payload(main, "resumed", ["ordinary follow-up"])], { stdout: "pipe", stderr: "pipe" });
    expect(await command.exited).toBe(0);
    expect(await new Response(command.stdout).text()).toBe("");
    expect(await new Response(command.stderr).text()).toBe("");
    expect(readTurnEvents(join(dir, "turns.log")).event).toMatchObject({ threadId: main, turnId: "resumed" });
  });

  test("symlinked CODEX_HOME root still identifies a child through its real rollout path", async () => {
    const actualHome = process.env.CODEX_HOME!;
    const alias = join(root, "codex-home-alias");
    symlinkSync(actualHome, alias);
    process.env.CODEX_HOME = alias;
    rollout(child, subagent);
    writeTurnHook(dir, "codex", payload(child));
    expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("running");
  });

  test("relative CODEX_HOME resolves against the same cwd for rollout and notify", async () => {
    const actualHome = process.env.CODEX_HOME!;
    process.env.CODEX_HOME = relative(process.cwd(), actualHome);
    expect(process.env.CODEX_HOME.startsWith("/")).toBe(false);
    rollout(child, subagent);
    writeTurnHook(dir, "codex", payload(child));
    expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("running");
  });

  const timeBoundaries = [
    { name: "local midnight", instant: "2026-01-14T23:59:58-08:00", day: "2026-01-15", time: "00-00-02" },
    { name: "month rollover", instant: "2026-04-30T23:59:58-07:00", day: "2026-05-01", time: "00-00-02" },
    { name: "year rollover", instant: "2026-12-31T23:59:58-08:00", day: "2027-01-01", time: "00-00-02" },
    { name: "spring DST gap", instant: "2026-03-08T01:59:58-08:00", day: "2026-03-08", time: "03-00-02" },
    { name: "fall DST fold", instant: "2026-11-01T01:59:58-07:00", day: "2026-11-01", time: "01-00-02" },
  ];

  test.each(timeBoundaries)("four-second probe crosses $name", ({ instant, day, time }) => {
    const timestamp = Date.parse(instant).toString(16).padStart(12, "0");
    const thread = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-000000000001`;
    // Independent LA wall-clock oracle; never change the parent process's TZ.
    const path = join(process.env.CODEX_HOME!, "sessions", ...day.split("-"), `rollout-${day}T${time}-${thread}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: thread, source: subagent } }) + "\n");
    const script = `import { isKnownCodexSubagent } from ${JSON.stringify(join(import.meta.dir, "../src/drivers/codex-rollout.ts"))};
      console.log(isKnownCodexSubagent(${JSON.stringify(thread)}));`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, TZ: "America/Los_Angeles", CODEX_HOME: process.env.CODEX_HOME! },
      stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    expect({ exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() })
      .toEqual({ exit: 0, stdout: "true\n", stderr: "" });
  });

  test.each(["cli", "exec"])("main source %s preserves immediate summary completion nudge", async source => {
    rollout(main, source);
    writeFileSync(join(dir, "summary.md"), "Synthetic completed result\n");
    spyOn(Tmux, "capture").mockResolvedValue("Response complete\n\n› \n\n  GPT-6.1-Sol · ~/proj\n  ? for shortcuts");
    writeTurnHook(dir, "codex", payload(main));
    expect(readTurnEvents(join(dir, "turns.log")).event).toMatchObject({ threadId: main, event: "turn_complete" });
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("running");
    expect(db.getSession("session-test")?.nudgedAt).toBeTruthy();
    expect(db.getSession("session-test")?.turnHookOffset).toBeGreaterThan(0);
    expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(Tmux.sendKeys).toHaveBeenCalledWith("session-test", COMPLETION_NUDGE);
    await refreshSessionStatuses(db, ["session-test"]);
    expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  test("explicit resumeThread accepts its matching thread even when rollout source is subagent", async () => {
    rollout(main, subagent);
    writeTurnHook(dir, "codex", payload(main, "resumed"), main);
    expect(readTurnEvents(join(dir, "turns.log")).event).toMatchObject({ threadId: main, turnId: "resumed" });
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("needs_attention");
  });
});

describe("turn hook launch orchestration", () => {
  let root: string;
  let db: StateDB;
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "hook-launch-test-"));
    db = new StateDB(join(root, "state.db"));
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(defaultWakeup, "prepare").mockResolvedValue();
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(Tmux, "capture").mockResolvedValue("");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(Tmux, "kill").mockResolvedValue();
    for (const agent of ["codex", "claude-code"]) {
      spyOn(getDriver(agent), "prepareForTask").mockResolvedValue();
      spyOn(getDriver(agent), "prepareForResume").mockResolvedValue();
      spyOn(getDriver(agent), "afterTaskSubmitted").mockResolvedValue(true);
    }
  });
  afterEach(() => {
    for (const row of db.listSessions()) {
      try { rmSync(defaultRuntimeLayout.taskFilePath(row.id), { force: true }); } catch {}
    }
    db.close(); mock.restore(); rmSync(root, { recursive: true, force: true });
  });

  describe("hook launch orchestration", () => {
    for (const agent of ["claude-code", "codex"]) {
      test.each(["launch", "resume"])(`${agent} %s creates only its new session resources before tmux starts`, async kind => {
        const create = spyOn(Tmux, "create").mockImplementation(async (id, command) => {
          expect(db.getSession(id)?.launchPid).toBe(process.pid);
          expect(existsSync(defaultRuntimeLayout.sessionDeliveryDir(root, id))).toBe(true);
          if (agent === "claude-code") {
            const file = defaultRuntimeLayout.claudeSettingsPath(root, id);
            expect(command).toContain(`--settings '${file}'`);
            expect(JSON.parse(readFileSync(file, "utf8")).hooks.StopFailure).toBeTruthy();
          } else {
            expect(command).toContain("notify=");
            expect(command).toContain(defaultRuntimeLayout.sessionDeliveryDir(root, id));
          }
        });
        if (kind === "launch") {
          await executeLaunch(planLaunch({ db, agentType: agent, task: "fixture", projectPath: root, parentId: "host" }));
        } else {
          db.createSession({ id: "old", parentId: "host", agentType: agent, task: "fixture", ownerToken: "tok", projectPath: root });
          db.updateStatus("old", "dead");
          db.updateResumeId("old", "native-thread");
          const result = await resume({ db, sessionId: "old", ownerToken: "tok" });
          expect(db.getSession(result.sessionId)?.status).toBe("needs_attention");
          expect(existsSync(defaultRuntimeLayout.sessionDeliveryDir(root, "old"))).toBe(false);
        }
        expect(create).toHaveBeenCalledTimes(1);
      });
    }

    test("failure after settings creation reclaims owned files and preserves a conflicting tmp task", async () => {
      const plan = planLaunch({ db, agentType: "claude-code", task: "fixture", projectPath: root, parentId: "host" });
      mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
      spyOn(Tmux, "create").mockImplementation(async () => {
        writeFileSync(plan.fileHandoff.taskFilePath, "foreign task");
      });
      try {
        await expect(executeLaunch(plan)).rejects.toThrow("Refusing to overwrite");
        expect(readFileSync(plan.fileHandoff.taskFilePath, "utf8")).toBe("foreign task");
        expect(existsSync(plan.fileHandoff.sessionDeliveryDir)).toBe(false);
        expect(db.getSession(plan.sessionId)).toBeNull();
      } finally { rmSync(plan.fileHandoff.taskFilePath, { force: true }); }
    });
  });
});
