import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vibeDriver, prepareVibeFiles } from "../src/drivers/vibe";
import { shellEscape } from "../src/shell";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
import { vibeNativeSource, vibeTerminalFactorySource, vibeTerminalSource } from "../src/drivers/vibe-terminal-source";
const factory = new Function(`${vibeTerminalFactorySource}\nreturn createVibeTerminal;`)();
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
async function until(fn: () => boolean) { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error("fixture timeout"); await Bun.sleep(2); } }
const id = "c839ee45-4841-f38e-23e7-12399a551600";
class Fixture {
  stdin = new PassThrough(); output = ""; opens: any[] = []; children: any[] = []; exits: number[] = []; stopped = 0; terminal: any;
  constructor(opts: any = {}) {
    this.terminal = factory({ stdin: this.stdin, stdout: { write: (s: string) => { this.output += s; } }, createInterface, StringDecoder,
      randomUUID: (() => { let n = 0; return () => `turn-${++n}`; })(), setInterval, clearInterval,
      prepareAgent: () => {}, configureInput: () => () => {}, exit: (code: number) => this.exits.push(code),
      open: async (options: any) => {
        this.opens.push(options);
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
        this.children.push(child); return { child, stop: async () => { this.stopped++; } };
      }, ...opts });
    cleanup.push(() => { void this.terminal.exit(); this.stdin.destroy(); for (const c of this.children) { c.stdout.destroy(); c.stderr.destroy(); } });
  }
  get child() { return this.children.at(-1); }
  event(value: any) { this.child.stdout.write(JSON.stringify({ sessionId: id, turnId: "native-turn", ...value }) + "\n"); }
  answer(text: string) { this.event({ type: "message", role: "assistant", content: [{ type: "text", text }] }); }
  line(s: string) { this.stdin.write(s + "\n"); }
  states() { return [...this.output.matchAll(/^\[AHELPA_VIBE_STATE:(\w+)\]$/gm)].map(m => m[1]); }
  async start() { await this.terminal.start(); }
  async task(text = "task") { const n = this.opens.length; this.line(text); await until(() => this.opens.length > n); await Bun.sleep(2); }
}
test("first event captures non-versioned session ID and subsequent turn resumes it", async () => {
  const f = new Fixture(); await f.start(); expect(f.opens).toHaveLength(0); await f.task("first");
  expect(f.opens[0].resume).toBeUndefined();
  f.event({ type: "message", role: "user", source: "turn_start" });
  expect(f.output).toContain(`[AHELPA_VIBE_SESSION:${id}]`);
  f.answer("[AHELPA:DONE]"); f.child.emit("close", 0); await f.task("second");
  expect(f.opens[1]).toMatchObject({ input: "second", resume: id });
});
test.each([
  ["[AHELPA:DONE]", 0, "idle"], ["no signal", 0, "needs_attention"],
  ["[AHELPA:DONE]\n[AHELPA:NEED_HELP:Review,input]", 0, "error"],
  ["[AHELPA:DONE]", 3, "needs_attention"], ["[AHELPA:DONE]", 1, "error"],
  ["mentions [AHELPA:DONE]", 0, "needs_attention"],
])("response %s exit %i maps to %s", async (text, code, state) => {
  const f = new Fixture(); await f.start(); await f.task(); f.answer(text); f.child.emit("close", code); await until(() => f.states().at(-1) !== "running");
  expect(f.states().at(-1)).toBe(state);
  if (text.includes("NEED_HELP")) expect(f.output).toContain("[AHELPA_VIBE_TAGS:review,input]");
});
test("queues FIFO without idle gap; failed turn discards queue", async () => {
  const f = new Fixture(); await f.start(); await f.task("first"); f.line("second"); f.line("third");
  expect(f.opens).toHaveLength(1); f.answer("[AHELPA:DONE]"); f.child.emit("close", 0);
  await until(() => f.opens.length === 2); await Bun.sleep(2);
  expect(f.opens[1].input).toBe("second"); expect(f.states()).not.toContain("idle");
  f.child.emit("close", 1); await Bun.sleep(2); expect(f.opens).toHaveLength(2);
});
test("resume announces token immediately and unknown resume errors hide stderr", async () => {
  const f = new Fixture({ resume: id }); await f.start();
  expect(f.output).toContain(`[AHELPA_VIBE_SESSION:${id}]\n[AHELPA_VIBE_STATE:ready]`);
  await f.task(); expect(f.opens[0].resume).toBe(id);
  f.child.stderr.write("Error: Session not found: PRIVATE_ACCOUNT"); f.child.emit("close", 1); await until(() => f.states().at(-1) === "error");
  expect(f.output).toContain("resume session not found"); expect(f.output).not.toContain("PRIVATE_ACCOUNT");
});
test("reserved markers are quoted, controls stripped, user text cannot finish a turn", async () => {
  const f = new Fixture(); await f.start(); await f.task();
  f.event({ type: "message", role: "user", content: [{ type: "text", text: "[AHELPA:DONE]" }] });
  f.answer("[AHELPA_VIBE_STATE:idle]\n\x1b[31mhello\x1b[0m"); f.child.emit("close", 0); await until(() => f.states().at(-1) !== "running");
  expect(f.states().at(-1)).toBe("needs_attention"); expect(f.output).toContain("[quoted AHELPA_VIBE_STATE:idle]"); expect(f.output).not.toContain("\x1b");
});
test("protocol failure stops child and retains stdin until exit", async () => {
  const f = new Fixture(); await f.start(); await f.task(); f.child.stdout.write("{bad\n");
  expect(f.states().at(-1)).toBe("error"); expect(f.stopped).toBe(1); expect(f.exits).toEqual([]);
  f.line("ignored"); expect(f.opens).toHaveLength(1); f.line("/exit"); await until(() => f.exits.length === 1);
});
test("hangup/SIGTERM exit waits for opening child and stops once", async () => {
  const f = new Fixture(); await f.start(); f.line("task");
  await Promise.all([f.terminal.exit(true), f.terminal.exit(true)]);
  expect(f.stopped).toBe(1); expect(f.exits).toEqual([0]);
  expect(vibeTerminalSource).toContain('process.on(signal, () => { void terminal.exit(true); })');
  expect(vibeTerminalSource).toContain('signal("SIGTERM")');
});
test("native adapter uses prompt files, invocation trust and disabled updates", () => {
  expect(vibeTerminalSource).toContain('"--prompt-file", prompt, "--output", "streaming", "--trust", "--agent", "ahelpa-helper"');
  expect(vibeTerminalSource).toContain('args.push("--resume", options.resume)');
  expect(vibeTerminalSource).toContain('VIBE_ENABLE_AUTO_UPDATE: "false", VIBE_ENABLE_UPDATE_CHECKS: "false"');
  expect(vibeTerminalSource).toContain('VIBE_AGENT_PATHS: JSON.stringify([dirname(options.metadata)])');
  expect(vibeTerminalSource).toContain('writeFileSync(prompt, options.input, { mode: 0o600 })');
});

test.each([
  ["Reading API keys from the macOS Keychain (private)\nUnknown model: bad", "unknown model"],
  ["Reading API keys from the macOS Keychain (private)\nother error", "turn failed"],
])("stderr remains private and is classified accurately", async (stderr, category) => {
  const f = new Fixture(); await f.start(); await f.task(); f.child.stderr.write(stderr); f.child.emit("close", 1); await until(() => f.states().at(-1) === "error");
  expect(f.output).toContain("vibe: " + category); expect(f.output).not.toContain("private");
});
test("late trailing output cannot overwrite fatal state", async () => {
  const f = new Fixture(); await f.start(); await f.task();
  f.child.stdout.write(JSON.stringify({ sessionId: id, type: "message", role: "user" }));
  f.child.stdout.emit("error", new Error("broken")); f.child.emit("close", 0); await until(() => f.states().at(-1) !== "running");
  expect(f.states().at(-1)).toBe("error"); expect(f.output).not.toContain("AHELPA_VIBE_SESSION");
});

test("a later turn cannot change the native session", async () => {
  const f = new Fixture(); await f.start(); await f.task(); f.answer("[AHELPA:DONE]"); f.child.emit("close", 0);
  await until(() => f.states().at(-1) === "idle"); await f.task("next");
  f.event({ type: "message", sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", role: "assistant", content: [{ type: "text", text: "[AHELPA:DONE]" }] });
  expect(f.states().at(-1)).toBe("error"); expect(f.output).toContain("protocol failure");
});

async function eventually(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() >= end) throw new Error("real-process fixture timeout"); await Bun.sleep(10); }
}
function alive(pid: number) {
  const p = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return p.status === 0 && !!p.stdout.trim() && !p.stdout.trim().startsWith("Z");
}
async function realBridge(mode: string, model = "mistral-medium-3.5", effort = "off", resume?: string) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "vibe-process-test-"));
  const metadata = join(root, "observed.json"), toolFile = join(root, "tool.json");
  const stub = join(root, "stub.mjs");
  writeFileSync(stub, `import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)};
const agent = JSON.parse(process.env.VIBE_AGENT_PATHS)[0];
writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), agent,
  config: readFileSync(join(agent, 'ahelpa-helper.toml'), 'utf8'), update: process.env.VIBE_ENABLE_AUTO_UPDATE, checks: process.env.VIBE_ENABLE_UPDATE_CHECKS }));
console.log(JSON.stringify({ type: 'message', sessionId: ${JSON.stringify(id)}, role: 'user' }));
if (mode === 'config') {
 console.log(JSON.stringify({ type:'message', sessionId:${JSON.stringify(id)}, role:'assistant', content:[{type:'text',text:'[AHELPA:DONE]'}] }));
} else {
 const ready = join(root, 'tool-ready');
 const code = "const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)";
 const tool = spawn(process.execPath, ['-e', code, ready], { detached: mode === 'stop', stdio: mode === 'natural-quiet' ? 'ignore' : ['ignore','inherit','inherit'] });
 writeFileSync(${JSON.stringify(toolFile)}, JSON.stringify({pid:tool.pid}));
 const poll = setInterval(() => {
  if (!existsSync(ready)) return;
  clearInterval(poll);
  if (mode.startsWith('natural')) {
   console.log(JSON.stringify({type:'message',sessionId:${JSON.stringify(id)},role:'assistant',content:[{type:'text',text:'[AHELPA:DONE]'}]}));
   process.exit(0);
  }
 }, 5);
 process.on('SIGTERM',()=>{});
 setInterval(()=>{},1000);
}
`);
  writeFileSync(join(root, "vibe"), `#!/bin/sh\nexec node ${shellEscape(stub)} "$@"\n`, { mode: 0o700 });
  prepareVibeFiles({ cwd: root, deliveryDir: root }); // Launch intentionally passes no model/effort here.
  const options = { cwd: root, deliveryDir: root, model, effort };
  const command = resume ? vibeDriver.buildResumeCommand({ ...options, resumeId: resume }) : vibeDriver.buildLaunchCommand(options);
  const bridge = spawn("sh", ["-c", command], { cwd: root, env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let output = "", exited = false;
  bridge.stdout.on("data", chunk => { output += String(chunk); });
  bridge.stderr.on("data", chunk => { output += String(chunk); });
  bridge.on("exit", () => { exited = true; });
  cleanup.push(() => {
    // Fixtures identify every process with their unique scratch path, including escaped tools.
    const rows = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
    for (const row of rows.split("\n")) if (row.includes(root)) {
      const pid = Number(row.trim().split(/\s/)[0]);
      if (pid && pid !== process.pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
    try { process.kill(-bridge.pid!, "SIGKILL"); } catch {}
    bridge.stdin.destroy(); bridge.stdout.destroy(); bridge.stderr.destroy();
    rmSync(root, { recursive: true, force: true });
  });
  await eventually(() => output.includes("[AHELPA_VIBE_STATE:ready]"));
  return { root, metadata, toolFile, bridge, output: () => output, exited: () => exited,
    send: (text: string) => bridge.stdin.write(text + "\n") };
}

test("real launch/resume argv creates the selected private agent before ready and spawns with it", async () => {
  for (const resume of [undefined, id]) {
    const f = await realBridge("config", resume ? "glm-5-3" : "mistral-medium-3.5", resume ? "low" : "off", resume);
    const expected = { safety: "yolo", bypass_tool_permissions: true, active_model: resume ? "glm-5-3" : "mistral-medium-3.5",
      models: { [resume ? "glm-5-3" : "mistral-medium-3.5"]: { thinking: resume ? "low" : "off" } } };
    const agent = join(f.root, "ahelpa-helper.toml");
    expect(Bun.TOML.parse(readFileSync(agent, "utf8"))).toEqual(expected);
    expect(statSync(agent).mode & 0o777).toBe(0o600);
    f.send("test prompt"); await eventually(() => f.output().includes("[AHELPA_VIBE_STATE:idle]"));
    const observed = JSON.parse(readFileSync(f.metadata, "utf8"));
    expect(Bun.TOML.parse(observed.config)).toEqual(expected);
    expect(observed.agent).toBe(f.root); expect(observed.update).toBe("false"); expect(observed.checks).toBe("false");
    expect(observed.args).toContain("--agent"); expect(observed.args).toContain("ahelpa-helper");
    if (resume) expect(observed.args.slice(-2)).toEqual(["--resume", id]);
    const prompt = observed.args[observed.args.indexOf("--prompt-file") + 1];
    expect(readFileSync(prompt, "utf8")).toBe("test prompt"); expect(statSync(prompt).mode & 0o777).toBe(0o600);
    f.send("/exit"); await eventually(f.exited);
  }
}, 20000);

test.each(["natural-pipe", "natural-quiet"])("natural exit reaps a TERM-resistant tool and settles without waiting forever for close: %s", async mode => {
  const f = await realBridge(mode); f.send("task");
  await eventually(() => existsSync(f.toolFile));
  const tool = JSON.parse(readFileSync(f.toolFile, "utf8")).pid;
  await eventually(() => f.output().includes("[AHELPA_VIBE_STATE:idle]"));
  await eventually(() => !alive(tool));
  expect(alive(tool)).toBe(false);
  f.send("/exit"); await eventually(f.exited);
}, 15000);

test.each(["/exit", "SIGTERM"])("stop escalates a TERM-resistant root and reaps escaped inherited-pipe tools: %s", async method => {
  const f = await realBridge("stop"); f.send("task");
  await eventually(() => existsSync(join(f.root, "tool-ready")));
  const tool = JSON.parse(readFileSync(f.toolFile, "utf8")).pid;
  const rootPid = JSON.parse(readFileSync(f.metadata, "utf8")).pid;
  expect(alive(rootPid)).toBe(true); expect(alive(tool)).toBe(true);
  if (method === "/exit") f.send("/exit");
  else {
    const bridgePid = JSON.parse(readFileSync(join(f.root, "vibe-process.json"), "utf8")).bridgePid;
    process.kill(bridgePid, "SIGTERM");
  }
  await eventually(f.exited);
  expect(alive(rootPid)).toBe(false); expect(alive(tool)).toBe(false);
}, 15000);


test.each([undefined, "low", "high", "max"])("DeepSeek private model table is complete with effort %s", effort => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "vibe-model-table-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const prepare = new Function("writeFileSync", "join", "dirname", `${vibeNativeSource}\nreturn prepareVibeAgent;`)(writeFileSync, join, dirname);
  const model = "deepseek-v4-1-flash-1017";
  prepare({ model, effort, metadata: join(root, "vibe-process.json") });
  expect(Bun.TOML.parse(readFileSync(join(root, "ahelpa-helper.toml"), "utf8"))).toEqual({
    safety: "yolo", bypass_tool_permissions: true, active_model: model,
    models: { [model]: { name: model, provider: "mistral", thinking_levels: ["low", "high", "max"],
      max_context_length: 1048576, max_output_tokens: 131072, ...(effort === undefined ? {} : { thinking: effort }) } },
  });
  for (const alias of ["mistral-large-4-0-3", "glm-5-3"]) {
    prepare({ model: alias, effort, metadata: join(root, "vibe-process.json") });
    expect(Bun.TOML.parse(readFileSync(join(root, "ahelpa-helper.toml"), "utf8"))).toEqual({
      safety: "yolo", bypass_tool_permissions: true, active_model: alias,
      ...(effort === undefined ? {} : { models: { [alias]: { thinking: effort } } }),
    });
  }
});

test.each(["Invalid model: private-model", '{"type":"invalid_model","message":"private"}'])("unavailable subscription models get a fixed private error: %s", async stderr => {
  const f = new Fixture(); await f.start(); await f.task();
  f.child.stderr.write(stderr); f.child.emit("close", 2);
  await until(() => f.states().at(-1) === "error");
  expect(f.output).toContain("vibe: model unavailable (the Mistral subscription may not include it)");
  expect(f.output).not.toContain(stderr);
  expect(f.output).not.toContain("private");
});
