import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
import { agyTerminalFactorySource, agyTerminalSource } from "../src/drivers/agy-terminal-source";

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
