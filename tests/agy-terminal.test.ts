import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyTerminalFactorySource, agyTerminalSource } from "../src/drivers/agy-terminal-source";
import { agyDriver, prepareAgyFiles } from "../src/drivers/agy";
import { shellEscape } from "../src/shell";

const factory = new Function(`${agyTerminalFactorySource}\nreturn createAgyTerminal;`)();
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
async function until(fn: () => boolean) { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error("fixture timeout"); await Bun.sleep(2); } }
const id = "12345678-1234-4321-8234-123456789abc";
const secret = "UNIQUE-AGY-STDERR-SECRET-5531";

class Fixture {
  stdin = new PassThrough(); output = ""; sent: any[] = []; exits: number[] = []; stopped = 0; terminal: any;
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  constructor(opts: any = {}) {
    createInterface({ input: this.child.stdin }).on("line", line => { this.sent.push(JSON.parse(line)); });
    this.terminal = factory({ stdin: this.stdin, stdout: { write: (s: string) => { this.output += s; } }, createInterface, StringDecoder,
      randomUUID: (() => { let n = 0; return () => `turn-${++n}`; })(), setInterval, clearInterval, setTimeout, clearTimeout,
      configureInput: () => () => {}, exit: (code: number) => this.exits.push(code), startupTimeout: 200,
      open: async () => ({ child: this.child, stop: async () => { this.stopped++; } }), ...opts });
    cleanup.push(() => { this.terminal.exit(); this.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.stdin.destroy(); });
  }
  event(event: any) { this.child.stdout.write(JSON.stringify(event) + "\n"); }
  init(conversation = id) { this.event({ event: "init", conversation_id: conversation, init: { model: "gemini-4-argon" } }); }
  result(response: string, status = "SUCCESS", extra: any = {}) {
    this.event({ event: "result", result: { conversation_id: id, status, response, ...extra } });
  }
  line(s: string) { this.stdin.write(s + "\n"); }
  states() { return [...this.output.matchAll(/^\[AHELPA_AGY_STATE:(\w+)\]$/gm)].map(m => m[1]); }
  async start() { this.terminal.start(); await Bun.sleep(2); this.init(); await until(() => this.states().includes("ready")); }
  async task(text = "task") { const n = this.sent.length; this.line(text); await until(() => this.sent.length > n); }
}

test("startup announces the conversation before any task, then sends one NDJSON user message per task", async () => {
  const f = new Fixture(); await f.start();
  expect(f.output).toContain(`[AHELPA_AGY_SESSION:${id}]\n[AHELPA_AGY_STATE:ready]`);
  await f.task("read the task file");
  expect(f.sent).toEqual([{ event: "user", message: { role: "user", content: "read the task file" } }]);
  expect(f.states().at(-1)).toBe("running");
  f.result("work\n[AHELPA:DONE]\n"); await until(() => f.states().at(-1) === "idle");
  expect(f.output).toContain("work\n[AHELPA:DONE]");
});

test.each([
  ["no signal\n", "SUCCESS", {}, "needs_attention"],
  ["  [AHELPA:NEED_HELP:Review, input]\n", "SUCCESS", {}, "error"],
  ["[AHELPA:DONE]", "ERROR", { finished_reason: "interrupted", error: secret }, "needs_attention"],
  ["[AHELPA:DONE]", "ERROR", { finished_reason: "error", error: secret }, "error"],
  ["[AHELPA:DONE]", "SUCCESS", { finished_reason: "print_timeout" }, "needs_attention"],
  ["mentions [AHELPA:DONE] mid-line", "SUCCESS", {}, "needs_attention"],
])("result %j %s %j settles as %s", async (response, status, extra, expected) => {
  const f = new Fixture(); await f.start(); await f.task();
  f.result(response, status, extra); await until(() => f.states().at(-1) === expected);
  expect(f.output).not.toContain(secret);
  if (expected === "error" && status === "SUCCESS") expect(f.output).toContain("[AHELPA_AGY_TAGS:review,input]");
});

test("FIFO queue sends one prompt at a time and exposes no idle gap", async () => {
  const f = new Fixture(); await f.start(); await f.task("first"); f.line("second");
  await Bun.sleep(5); expect(f.sent).toHaveLength(1);
  f.result("[AHELPA:DONE]"); await until(() => f.sent.length === 2);
  expect(f.states()).not.toContain("idle");
  f.result("[AHELPA:DONE]"); await until(() => f.states().at(-1) === "idle");
});

test("a failed turn drops queued work", async () => {
  const f = new Fixture(); await f.start(); await f.task("first"); f.line("second");
  f.result("", "ERROR", { finished_reason: "error" }); await until(() => f.states().at(-1) === "error");
  await Bun.sleep(5); expect(f.sent).toHaveLength(1);
  await f.task("third"); expect(f.sent.at(-1).message.content).toBe("third");
});

test("resume refuses the new conversation agy silently opens for an unknown ID", async () => {
  const f = new Fixture({ resume: id }); f.terminal.start(); await Bun.sleep(2);
  f.init("aaaaaaaa-1234-4321-8234-123456789abc");
  await until(() => f.states().at(-1) === "error");
  expect(f.output).toContain("agy: resume conversation not found"); expect(f.stopped).toBe(1);
  const ok = new Fixture({ resume: id.toUpperCase() }); ok.terminal.start(); await Bun.sleep(2); ok.init();
  await until(() => ok.states().at(-1) === "ready");
});

test.each([
  [`error: invalid model selection (--model "x"): ${secret}`, "agy rejected the model or effort"],
  [`You are not logged into Antigravity. ${secret}`, "agy is not signed in"],
  [secret, "agy exited during startup"],
])("startup exit is reduced to a fixed category: %s", async (stderr, category) => {
  const f = new Fixture(); f.terminal.start(); await Bun.sleep(2);
  f.child.stderr.write(stderr); await Bun.sleep(2); f.child.emit("close", 1);
  await until(() => f.states().at(-1) === "error");
  expect(f.output).toContain("agy: " + category); expect(f.output).not.toContain(secret);
});

test("startup without init times out", async () => {
  const f = new Fixture(); f.terminal.start();
  await until(() => f.states().at(-1) === "error"); expect(f.output).toContain("agy did not start in time");
});

test.each(["{bad\n", JSON.stringify({ event: "result", result: { conversation_id: "other", status: "SUCCESS", response: "[AHELPA:DONE]" } }) + "\n"])("protocol failures enter a fatal loop that discards tasks: %s", async input => {
  const f = new Fixture(); await f.start(); await f.task();
  f.child.stdout.write(input); await until(() => f.states().at(-1) === "error");
  const n = f.sent.length; f.line("must be discarded"); await Bun.sleep(5);
  expect(f.sent.length).toBe(n); expect(f.exits).toEqual([]);
  f.line("/exit"); await until(() => f.exits.length === 1);
});

test("unexpected agy exit is fatal; /exit stops agy and exits once", async () => {
  const f = new Fixture(); await f.start(); f.child.emit("close", 1);
  await until(() => f.states().at(-1) === "error"); expect(f.output).toContain("agy exited unexpectedly");
  const g = new Fixture(); await g.start(); g.line("/exit"); await until(() => g.exits.length === 1);
  expect(g.stopped).toBe(1); g.line("/exit"); await Bun.sleep(5); expect(g.exits).toEqual([0]);
});

test("reserved markers and terminal controls in answers are neutralised", async () => {
  const f = new Fixture(); await f.start(); await f.task();
  f.result(`[AHELPA_AGY_STATE:idle]\n\x1b[31mred\x1b[0m\n[AHELPA:DONE]`);
  await until(() => f.states().at(-1) === "idle");
  expect(f.states()).toEqual(["ready", "running", "idle"]);
  expect(f.output).toContain("[quoted AHELPA_AGY_STATE:idle]"); expect(f.output).not.toContain("\x1b");
});

test("the generated bridge runs agy headless with interruption-based cleanup", () => {
  expect(agyTerminalSource).toContain('"--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"');
  expect(agyTerminalSource).toContain('args.push("-p", "")');
  expect(agyTerminalSource).toContain("detached: true");
  expect(agyTerminalSource).toContain('AGY_CLI_DISABLE_AUTO_UPDATE: "true"');
  expect(agyTerminalSource).toContain('signal("SIGINT")');
  expect(agyTerminalSource).not.toContain("child.stdin.end()");
});

// Real processes: a fake agy starts a tool that inherits its stdout/stderr and
// outlives it, so the child's "close" never fires on its own.
async function eventually(fn: () => boolean) {
  const end = Date.now() + 8000;
  while (!fn()) { if (Date.now() >= end) throw new Error("real-process fixture timeout"); await Bun.sleep(10); }
}
function alive(pid: number) {
  const p = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return p.status === 0 && !!p.stdout.trim() && !p.stdout.trim().startsWith("Z");
}
test.each(["/exit", "SIGHUP"])("stop reclaims a tool that holds agy's pipes after agy exits: %s", async method => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agy-process-test-"));
  const toolFile = join(root, "tool.json"), ready = join(root, "tool-ready"), stub = join(root, "stub.mjs");
  writeFileSync(stub, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ event: 'init', conversation_id: ${JSON.stringify(id)} }));
createInterface({ input: process.stdin }).on('line', () => {
  // Like agy: the tool gets its own process group; it ignores SIGINT and SIGTERM.
  const code = "const fs=require('fs');process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)";
  const tool = spawn(process.execPath, ['-e', code, ${JSON.stringify(ready)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  writeFileSync(${JSON.stringify(toolFile)}, JSON.stringify({ tool: tool.pid, agy: process.pid }));
});
`);
  writeFileSync(join(root, "agy"), `#!/bin/sh\nexec node ${shellEscape(stub)} "$@"\n`, { mode: 0o700 });
  prepareAgyFiles({ cwd: root, deliveryDir: root });
  const bridge = spawn("sh", ["-c", agyDriver.buildLaunchCommand({ cwd: root, deliveryDir: root })],
    { cwd: root, env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let output = "", exited = false;
  bridge.stdout.on("data", chunk => { output += String(chunk); });
  bridge.on("exit", () => { exited = true; });
  cleanup.push(() => {
    // Every fixture process carries the unique scratch path in its command line.
    for (const row of (spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "").split("\n")) if (row.includes(root)) {
      const pid = Number(row.trim().split(/\s/)[0]);
      if (pid && pid !== process.pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
    try { process.kill(-bridge.pid!, "SIGKILL"); } catch {}
    bridge.stdin.destroy(); bridge.stdout.destroy(); bridge.stderr.destroy();
    rmSync(root, { recursive: true, force: true });
  });
  await eventually(() => output.includes("[AHELPA_AGY_STATE:ready]"));
  bridge.stdin.write("task\n");
  await eventually(() => existsSync(ready) && existsSync(toolFile));
  const pids = JSON.parse(readFileSync(toolFile, "utf8"));
  expect(alive(pids.agy)).toBe(true); expect(alive(pids.tool)).toBe(true);
  if (method === "/exit") bridge.stdin.write("/exit\n");
  else process.kill(JSON.parse(readFileSync(join(root, "agy-process.json"), "utf8")).bridgePid, "SIGHUP");
  await eventually(() => exited);
  expect(alive(pids.agy)).toBe(false); expect(alive(pids.tool)).toBe(false);
}, 20000);
