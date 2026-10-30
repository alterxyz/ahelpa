import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
import { piTerminalFactorySource } from "../src/drivers/pi-terminal-source";

const factory = new Function(`${piTerminalFactorySource}\nreturn createPiTerminal;`)();
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
async function until(fn: () => boolean) { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error("fixture timeout"); await Bun.sleep(2); } }
const id = "12345678-1234-4321-8234-123456789abc";
const secret = "UNIQUE-PI-ERROR-SECRET-947281";
class Fixture {
  stdin = new PassThrough(); output = ""; requests: any[] = []; exits: number[] = []; closed = false; released = false;
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  state: any = { sessionId: id, isStreaming: false, isCompacting: false, pendingMessageCount: 0, model: { provider: "provider", id: "model" }, thinkingLevel: "high" };
  behavior?: (req: any) => boolean | void; terminal: any; stopped = 0;
  constructor(opts: any = {}) {
    createInterface({ input: this.child.stdin }).on("line", line => {
      const req = JSON.parse(line); this.requests.push(req);
      if (this.behavior?.(req)) return;
      if (req.type === "get_state") this.response(req, this.state);
      if (req.type === "get_available_thinking_levels") this.response(req, { levels: ["off", "high"] });
      if (req.type === "prompt") this.response(req, { disposition: "started" });
      if (req.type === "clear_queue" || req.type === "abort") this.response(req);
    });
    this.terminal = factory({ stdin: this.stdin, stdout: { write: (s: string) => { this.output += s; } }, createInterface, StringDecoder,
      randomUUID: (() => { let n = 0; return () => `turn-${++n}`; })(), setInterval, clearInterval, setTimeout, clearTimeout,
      configureInput: () => () => {}, exit: (code: number) => this.exits.push(code), requestTimeout: 100,
      open: async () => ({ child: this.child, sessionId: id, stop: async () => { this.stopped++; this.closed = true; this.child.emit("close", 0); this.released = true; } }), ...opts,
    });
    cleanup.push(() => { this.terminal.exit(); this.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.stdin.destroy(); });
  }
  response(req: any, data?: any, success = true) { this.event({ type: "response", id: req.id, command: req.type, success, data, error: secret }); }
  event(event: any) { this.child.stdout.write(JSON.stringify(event) + "\n"); }
  line(s: string) { this.stdin.write(s + "\n"); }
  states() { return [...this.output.matchAll(/^\[AHELPA_PI_STATE:(\w+)\]$/gm)].map(m => m[1]); }
  async start() { this.terminal.start(); await until(() => this.states().includes("ready")); }
  async task() { this.line("task"); await until(() => this.requests.some(r => r.type === "prompt")); await Bun.sleep(2); }
  answer(text = "[AHELPA:DONE]", stopReason = "stop") { this.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage: secret } }); }
  settle(aborted = false) { this.event({ type: "agent_settled", aborted }); }
}

test("LF/CRLF framing preserves Unicode separators and split UTF-8", async () => {
  const f = new Fixture(); await f.start(); await f.task();
  const bytes = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你\u2028好\u2029\n[AHELPA:DONE]" }], stopReason: "stop" } }) + "\r\n");
  for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
  f.settle(); await until(() => f.states().at(-1) === "idle"); expect(f.output).toContain("你");
});
test.each(["{bad\n", "x".repeat(1024 * 1024 + 1), '{"type":'])("invalid/oversize/truncated protocol enters fatal shell", async input => {
  const f = new Fixture(); await f.start(); await f.task(); f.child.stdout.write(input); if (input === '{"type":') f.child.stdout.end();
  await until(() => f.states().at(-1) === "error"); const n = f.requests.length; f.line("must be discarded"); await Bun.sleep(5);
  expect(f.requests.length).toBe(n); expect(f.exits).toEqual([]); f.line("/exit"); await until(() => f.exits.length === 1);
});
test.each(["started", "queued"])("%s waits for settled; agent_end is provisional", async disposition => {
  const f = new Fixture(); f.behavior = req => { if (req.type === "prompt") { f.response(req, { disposition }); return true; } };
  await f.start(); await f.task(); f.answer(); f.event({ type: "agent_end", willRetry: false }); await Bun.sleep(5);
  expect(f.states().at(-1)).toBe("running"); f.settle(); await until(() => f.states().at(-1) === "idle");
});
test("handled without activity releases current turn without stale DONE", async () => {
  const f = new Fixture(); f.behavior = req => { if (req.type === "prompt") { f.response(req, { disposition: "handled" }); return true; } };
  await f.start(); await f.task(); await until(() => f.states().at(-1) === "needs_attention");
});
test.each([true, false])("retry recovery=%s requires final assistant and settlement", async recover => {
  const f = new Fixture(); await f.start(); await f.task(); f.answer(secret, "error");
  f.event({ type: "auto_retry_start", errorMessage: secret }); f.event({ type: "auto_retry_end", success: recover, finalError: secret });
  if (recover) f.answer(); f.settle(); await until(() => f.states().at(-1) === (recover ? "idle" : "error")); expect(f.output).not.toContain(secret);
});
test.each([true, false])("compaction recovery=%s holds running", async recover => {
  const f = new Fixture(); await f.start(); await f.task(); f.answer(); f.event({ type: "compaction_start", reason: "overflow" });
  f.event({ type: "compaction_end", aborted: false, willRetry: recover, errorMessage: secret });
  expect(f.states().at(-1)).toBe("running"); if (recover) f.answer(); f.settle(); await until(() => f.states().at(-1) === (recover ? "idle" : "error")); expect(f.output).not.toContain(secret);
});
test("FIFO exposes no idle gap and does not send next prompt early", async () => {
  const f = new Fixture(); await f.start(); await f.task(); f.line("second"); f.line("third");
  expect(f.requests.filter(r => r.type === "prompt")).toHaveLength(1); f.answer(); f.settle();
  await until(() => f.requests.filter(r => r.type === "prompt").length === 2); expect(f.states()).not.toContain("idle");
  f.answer(); f.settle(); await until(() => f.requests.filter(r => r.type === "prompt").length === 3); expect(f.states()).not.toContain("idle");
  f.answer(); f.settle(); await until(() => f.states().at(-1) === "idle");
});
test.each([true, false])("abort active=%s clears queue and tolerates settlement before response", async active => {
  const f = new Fixture(); await f.start(); if (active) { await f.task(); f.line("queued"); f.answer(); }
  f.behavior = req => { if (req.type === "abort") { if (active) f.settle(true); setTimeout(() => f.response(req), 5); return true; } };
  f.line("/abort"); await until(() => f.states().at(-1) === "needs_attention");
  expect(f.requests.slice(-2).map(r => r.type)).toEqual(["clear_queue", "abort"]); expect(f.states()).not.toContain("idle");
  expect(f.requests.filter(r => r.type === "prompt")).toHaveLength(active ? 1 : 0);
});
test("aborted plus stale DONE cannot succeed; NEED_HELP tags take precedence", async () => {
  const f = new Fixture(); await f.start(); await f.task(); f.answer(); f.settle(true); await until(() => f.states().at(-1) === "needs_attention");
  f.line("new"); await until(() => f.requests.filter(r => r.type === "prompt").length === 2);
  f.answer("[AHELPA:NEED_HELP: REVIEW,input,review,!!]\n[AHELPA:DONE]"); f.settle(); await until(() => f.output.includes("[AHELPA_PI_TAGS:review,input]"));
  expect(f.states().at(-1)).toBe("error");
});
test.each(["select", "confirm", "input", "editor"])("extension %s is cancelled, never consented", async method => {
  const f = new Fixture(); await f.start(); await f.task();
  f.event({ type: "extension_ui_request", id: "dialog", method, title: secret });
  await until(() => f.states().at(-1) === "needs_attention");
  expect(f.requests).toContainEqual({ type: "extension_ui_response", id: "dialog", cancelled: true }); expect(f.output).not.toContain(secret);
});
test.each(["stderr", "extension_error", "prompt", "state", "levels", "clear_queue", "abort", "spawn", "stream", "retry", "compaction"])("secret never escapes %s error channel", async channel => {
  const f = new Fixture(channel === "spawn" ? { open: async () => { throw new Error(secret); } } : channel === "levels" ? { effort: "high" } : {});
  f.behavior = req => { if (req.type === ({ state: "get_state", levels: "get_available_thinking_levels" } as any)[channel] || req.type === channel) { f.response(req, undefined, false); return true; } };
  if (["spawn", "state", "levels"].includes(channel)) { f.terminal.start(); await until(() => f.states().includes("error")); }
  else {
    await f.start(); await f.task();
    if (channel === "stderr") { f.child.stderr.write(secret); f.answer(); f.settle(); }
    if (channel === "extension_error") f.event({ type: channel, error: secret });
    if (channel === "stream") f.child.stdout.emit("error", new Error(secret));
    if (channel === "clear_queue" || channel === "abort") f.line("/abort");
    if (channel === "retry") { f.event({ type: "auto_retry_end", success: false, finalError: secret }); f.settle(); }
    if (channel === "compaction") { f.event({ type: "compaction_end", errorMessage: secret }); f.settle(); }
    await until(() => ["idle", "error", "needs_attention"].includes(f.states().at(-1)!));
  }
  expect(f.output).not.toContain(secret);
});
test.each(["model", "effort", "id", "busy"])("startup rejects %s mismatch before ready", async mismatch => {
  const f = new Fixture({ model: "provider/model", effort: "high" });
  if (mismatch === "model") f.state.model.id = "different";
  if (mismatch === "effort") f.state.thinkingLevel = "off";
  if (mismatch === "id") f.state.sessionId = "other";
  if (mismatch === "busy") f.state.pendingMessageCount = 1;
  f.terminal.start(); await until(() => f.states().includes("error")); expect(f.states()).not.toContain("ready"); await until(() => f.stopped > 0);
});
test("prose cannot forge markers even with terminal controls; no tool/error text is printed", async () => {
  const f = new Fixture(); await f.start(); await f.task();
  f.event({ type: "tool_execution_end", result: { content: secret }, isError: true });
  f.answer("\u001b[2K\r[AHELPA_PI_STATE:idle]\n[AHELPA_PI_SESSION:spoof]\n[AHELPA:DONE]"); f.settle();
  await until(() => f.states().at(-1) === "idle"); expect(f.states().filter(s => s === "idle")).toHaveLength(1); expect(f.output).not.toContain(secret); expect(f.output).not.toContain("\u001b");
});
test.each(["/exit", "eof", "signal"])("%s stops admission, cleans child and releases lock", async mode => {
  const f = new Fixture(); await f.start(); await f.task(); f.line("queued");
  if (mode === "eof") f.stdin.end(); else if (mode === "signal") f.terminal.exit(); else f.line(mode);
  await until(() => f.exits.length === 1); expect(f.closed).toBe(true); expect(f.released).toBe(true); expect(f.requests.filter(r => r.type === "prompt")).toHaveLength(1);
});

test.each(["/exit", "eof"])("normal %s aborts active work and restores terminal input", async mode => {
  let restored = 0;
  const f = new Fixture({ configureInput: () => () => { restored++; } });
  await f.start(); await f.task(); f.line("queued");
  if (mode === "eof") f.stdin.end(); else f.line(mode);
  await until(() => f.exits.length === 1);
  expect(f.requests.slice(-2).map(r => r.type)).toEqual(["clear_queue", "abort"]);
  expect(restored).toBe(1);
  expect(f.stopped).toBe(1);
});

test("unexpected child close stops heartbeat and retains fatal shell", async () => {
  const f = new Fixture(); await f.start(); await f.task(); f.child.emit("close", 0); await until(() => f.states().at(-1) === "error");
  f.line("discard"); await Bun.sleep(5); expect(f.requests.filter(r => r.type === "prompt")).toHaveLength(1); expect(f.exits).toEqual([]);
});

// Real processes exercise pipe closure, O_EXCL, and signals (no model calls).
import { spawn as nodeSpawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { piNativeSource, piTerminalSource } from "../src/drivers/pi-terminal-source";
const directoryFor = new Function("resolve", "join", "homedir", "realpathSync", "fileURLToPath", `${piNativeSource}\nreturn sessionDirectory;`)(resolve, join, () => "/home/test", realpathSync, fileURLToPath);
function nativeFixture(mode = "normal", version = "1.4.0") {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-native-"));
  const project = join(root, "project"), home = join(root, "pi-home"), bin = join(root, "bin"), pkg = join(root, "package");
  for (const dir of [project, home, bin, join(pkg, "dist", "bundle")]) mkdirSync(dir, { recursive: true });
  const executable = join(pkg, "dist", "bundle", "cli.js");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, type: "module", bin: { pi: "dist/bundle/cli.js" } }));
  writeFileSync(executable, `#!${Bun.which("node")}\nimport {spawn} from 'node:child_process'; import {createInterface} from 'node:readline'; import {writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2); const arg=k=>args[args.indexOf(k)+1]; const id=args.includes('--session-id')?arg('--session-id'):${JSON.stringify(id)};
writeFileSync(${JSON.stringify(join(root, "spawned"))},JSON.stringify({pid:process.pid,args}));
const mode=${JSON.stringify(mode)};
if(mode==='tree') {
 const tool=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
 writeFileSync(${JSON.stringify(join(root, "tool-pid"))},String(tool.pid));
}
if(mode==='stubborn'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
const reply=(r,data)=>process.stdout.write(JSON.stringify({type:'response',command:r.type,id:r.id,success:true,data})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line); if(r.type==='get_state') reply(r,{sessionId:id,isStreaming:false,isCompacting:false,pendingMessageCount:0}); else if(r.type==='prompt') reply(r,{disposition:'handled'}); else reply(r);}).on('close',()=>{if(mode==='stubborn')return; setTimeout(()=>process.exit(0),mode==='delayed'?250:0);});
process.on('exit',()=>appendFileSync(${JSON.stringify(join(root, "closed"))},'closed'));
`);
  chmodSync(executable, 0o755); symlinkSync(executable, join(bin, "pi"));
  const bridge = join(root, "bridge.mjs"); writeFileSync(bridge, piTerminalSource);
  const directory = directoryFor(project, home); mkdirSync(directory, { recursive: true });
  const lock = join(directory, `.ahelpa-${id}.lock`);
  const children: ChildProcessWithoutNullStreams[] = [];
  cleanup.push(() => { for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); } rmSync(root, { recursive: true, force: true }); });
  const history = (name = "time") => writeFileSync(join(directory, `${name}_${id}.jsonl`), JSON.stringify({ type: "session", id }) + "\n");
  function launch(resume: string | undefined = id) {
    const child = nodeSpawn(Bun.which("node")!, [bridge, "--cwd", project, ...(resume ? ["--resume", resume] : [])], { env: { ...process.env, PATH: bin + ":" + process.env.PATH, PI_CODING_AGENT_DIR: home }, stdio: "pipe" });
    children.push(child); let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    return { child, output: () => output, line: (text: string) => child.stdin.write(text + "\n") };
  }
  return { root, project, bin, bridge, home, directory, lock, history, launch };
}
test("native cwd encoding matches Pi 1.4 fixed examples and agent-home override", () => {
  expect(directoryFor("/Users/test/a:b/project", "/custom/pi")).toBe("/custom/pi/sessions/--Users-test-a-b-project--");
  expect(directoryFor("/project", "~/custom")).toBe("/home/test/custom/sessions/--project--");
});
test.each(["missing", "ambiguous", "malformed", "wrong-id"])("resume %s history refuses before spawn", async kind => {
  const f = nativeFixture(); if (kind !== "missing") f.history(); if (kind === "ambiguous") f.history("other");
  if (kind === "malformed" || kind === "wrong-id") writeFileSync(join(f.directory, `time_${id}.jsonl`), kind === "malformed" ? secret + "\n" : JSON.stringify({ type: "session", id: "wrong" }) + "\n");
  const run = f.launch(); await until(() => run.output().includes("STATE:error")); expect(existsSync(join(f.root, "spawned"))).toBe(false); expect(run.output()).not.toContain(secret); expect(existsSync(f.lock)).toBe(false);
  run.line("/exit"); await until(() => run.child.exitCode !== null);
});
test("stale lock is fail-closed and names its path", async () => {
  const f = nativeFixture(); f.history(); writeFileSync(f.lock, "999999999 stale"); const run = f.launch();
  await until(() => run.output().includes("STATE:error")); expect(run.output()).toContain(f.lock); expect(existsSync(join(f.root, "spawned"))).toBe(false); expect(existsSync(f.lock)).toBe(true);
  run.line("/exit"); await until(() => run.child.exitCode !== null);
});
test("concurrent resumes permit one child; lock persists until child closes", async () => {
  const f = nativeFixture("delayed"); f.history(); const a = f.launch(), b = f.launch();
  await until(() => [a, b].some(run => run.output().includes("STATE:ready")) && [a, b].some(run => run.output().includes("STATE:error")));
  const winner = a.output().includes("STATE:ready") ? a : b, loser = winner === a ? b : a;
  expect(existsSync(f.lock)).toBe(true); winner.line("/exit"); await Bun.sleep(80); expect(existsSync(f.lock)).toBe(true);
  await until(() => winner.child.exitCode !== null); expect(existsSync(join(f.root, "closed"))).toBe(true); expect(existsSync(f.lock)).toBe(false);
  const info = JSON.parse(readFileSync(join(f.root, "spawned"), "utf8"));
  expect(info.args).toContain("--session"); expect(info.args).not.toContain("--session-id");
  expect(info.args).toContain(join(f.directory, `time_${id}.jsonl`)); expect(info.args).toContain("--approve"); expect(info.args).toContain("--no-mcp"); expect(info.args).toContain("--no-extensions"); expect(info.args).toContain("--offline");
  expect(() => process.kill(info.pid, 0)).toThrow(); loser.line("/exit"); await until(() => loser.child.exitCode !== null);
});
test.each(["SIGHUP", "SIGTERM", "SIGINT"] as const)("%s cleans native process and releases lock", async signal => {
  const f = nativeFixture(); f.history(); const run = f.launch(); await until(() => run.output().includes("STATE:ready"));
  const info = JSON.parse(readFileSync(join(f.root, "spawned"), "utf8")); run.child.kill(signal); await until(() => run.child.exitCode !== null);
  expect(existsSync(f.lock)).toBe(false); expect(() => process.kill(info.pid, 0)).toThrow();
});
test("stubborn child escalates EOF to TERM then KILL before releasing lock", async () => {
  const f = nativeFixture("stubborn"); f.history(); const run = f.launch(); await until(() => run.output().includes("STATE:ready"));
  const info = JSON.parse(readFileSync(join(f.root, "spawned"), "utf8")); run.line("/exit"); await Bun.sleep(1700); expect(existsSync(f.lock)).toBe(true);
  await until(() => run.child.exitCode !== null); expect(existsSync(f.lock)).toBe(false); expect(() => process.kill(info.pid, 0)).toThrow();
}, 6000);
test.each(["1.3.99", "1.4.0-beta.1", "1.4.0", "1.9.0", "2.0.0"])("version %s follows minimum-only policy", async version => {
  const f = nativeFixture("normal", version); f.history(); const run = f.launch();
  const old = version === "1.3.99" || version === "1.4.0-beta.1";
  await until(() => run.output().includes(old ? "STATE:error" : "STATE:ready")); if (old) expect(run.output()).toContain("upgrade Pi");
  expect(existsSync(join(f.root, "spawned"))).toBe(!old); run.line("/exit"); await until(() => run.child.exitCode !== null);
});

test("arbitrary startup error cannot label itself as a safe diagnostic", async () => {
  const f = new Fixture({ open: async () => { throw Object.assign(new Error(secret), { piCategory: secret }); } });
  f.terminal.start(); await until(() => f.states().includes("error")); expect(f.output).not.toContain(secret);
});
test.each(["length", "toolUse"])("DONE with %s stop reason is not normal completion", async reason => {
  const f = new Fixture(); await f.start(); await f.task(); f.answer("[AHELPA:DONE]", reason); f.settle(); await until(() => f.states().at(-1) !== "running"); expect(f.states().at(-1)).toBe("needs_attention");
});
test("unexpected clean stdout EOF is a protocol failure even before close", async () => {
  const f = new Fixture(); await f.start(); await f.task(); f.child.stdout.end(); await until(() => f.states().at(-1) === "error"); expect(f.exits).toEqual([]);
});
test("recovered compaction cancellation does not poison a later successful answer", async () => {
  const f = new Fixture(); await f.start(); await f.task(); f.event({ type: "compaction_end", aborted: true, willRetry: false });
  f.answer(); f.settle(); await until(() => f.states().at(-1) !== "running"); expect(f.states().at(-1)).toBe("idle");
});
test("unknown extension dialog cannot leave native work waiting forever", async () => {
  const f = new Fixture(); await f.start(); await f.task(); f.event({ type: "extension_ui_request", id: "dialog", method: "future_dialog", title: secret });
  await until(() => f.states().at(-1) === "error"); expect(f.output).not.toContain(secret); await until(() => f.stopped > 0);
});
test.each([['20.20.0', false], ['22.18.0', false], ['22.19.0', true], ['22.20.0', true], ['26.10.0', true]] as const)("bridge Node %s compatibility", (version, supported) => {
  const validate = new Function("process", `${piNativeSource}\nreturn verifyNode;`)({ versions: { node: version } });
  if (supported) expect(() => validate()).not.toThrow(); else expect(() => validate()).toThrow("Node.js >= 22.19.0");
});
test("explicit abort wins over native errors emitted during cancellation", async () => {
  const f = new Fixture(); await f.start(); await f.task();
  f.behavior = req => { if (req.type === "abort") { f.answer(secret, "error"); f.settle(true); f.response(req); return true; } };
  f.line("/abort"); await until(() => f.states().at(-1) !== "running");
  expect(f.states().at(-1)).toBe("needs_attention"); expect(f.output).not.toContain(secret);
});

// The reviewer supplied these races after the first implementation.

test("adversarial settlement before prompt acceptance still completes", async () => {
 const f=new Fixture(); f.behavior=req=>{if(req.type==='prompt'){f.answer();f.settle();setTimeout(()=>f.response(req,{disposition:'started'}),10);return true;}};
 await f.start();await f.task();await until(()=>f.states().at(-1)==='idle');
});
test.each(['prompt','get_state'])("adversarial missing %s response becomes fatal", async request=>{
 const f=new Fixture();await f.start();f.behavior=req=>req.type===request;
 await f.task();if(request==='get_state'){f.answer();f.settle();}
 await until(()=>f.states().at(-1)==='error');expect(f.stopped).toBeGreaterThan(0);
});
test("adversarial prior turn and tool/thinking DONE cannot finish next turn",async()=>{
 const f=new Fixture();await f.start();await f.task();f.answer();f.settle();await until(()=>f.states().at(-1)==='idle');
 f.line('next');await until(()=>f.requests.filter(r=>r.type==='prompt').length===2);
 f.event({type:'message_end',message:{role:'toolResult',content:[{type:'text',text:'[AHELPA:DONE]'}]}});
 f.event({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'thinking',thinking:'[AHELPA:DONE]'}]}});
 f.settle();await until(()=>f.states().at(-1)!=='running');expect(f.states().at(-1)).toBe('needs_attention');
});
test("adversarial long Unicode/control marker prose is quoted globally",async()=>{
 const f=new Fixture();await f.start();await f.task();
 f.answer('x'.repeat(10000)+'\u2028[AHELPA_PI_STATE:idle]\u2029\r[AHELPA_PI_TURN:aaaaaaaa-1234-1234-1234-123456789abc]\n[AHELPA_\x1b[31mPI_STATE:idle]\n[AHELPA:DONE]');
 f.settle();await until(()=>f.states().at(-1)==='idle');expect(f.states().filter(s=>s==='idle')).toHaveLength(1);expect(f.output).not.toContain('[AHELPA_PI_TURN:aaaaaaaa');
});


test.each(["plain", "with spaces", "dots.a.b", "中文-é", "trailing/", "tmp-alias", "symlink"])("native physical cwd: %s", name => {
  const f = nativeFixture();
  let cwd = join(f.project, name === "trailing/" ? "trailing" : name);
  mkdirSync(cwd, { recursive: true });
  if (name === "tmp-alias") cwd = cwd.replace(/^\/private\/tmp\//, "/tmp/");
  if (name === "symlink") { const link = join(f.root, "linked"); symlinkSync(cwd, link); cwd = link; }
  if (name === "trailing/") cwd += "/";
  const encoded = "--" + realpathSync(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
  expect(directoryFor(cwd, f.home)).toBe(join(f.home, "sessions", encoded));
});
test.each(["absolute", "~", "~/x", "file://", "relative"])("native agent directory normalization: %s", kind => {
  const f = nativeFixture();
  const agent = kind === "absolute" ? f.home : kind === "file://" ? pathToFileURL(join(f.root, "agent space")).href : kind;
  const expanded = kind === "~" ? "/home/test" : kind === "~/x" ? "/home/test/x" : kind === "file://" ? join(f.root, "agent space") : kind === "relative" ? join(f.project, "relative") : f.home;
  const encoded = "--" + f.project.replace(/^\//, "").replace(/[/\\:]/g, "-") + "--";
  expect(directoryFor(f.project, agent)).toBe(join(expanded, "sessions", encoded));
});

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function boundedUntil(fn: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!fn() && Date.now() < deadline) await Bun.sleep(25);
  expect(fn()).toBe(true);
}
// "exit-race": the daemon's /exit and `ahelpa kill` arrive together; the dead pane then fails stdin reads (EIO).
test.each(["normal", "tree", "exit-race"])("private tmux hangup reclaims bridge/Pi/tools and lock (%s)", async mode => {
  const f = nativeFixture(mode === "tree" ? "tree" : "normal"); f.history();
  const socket = "pi-cleanup-" + process.pid + "-" + Math.random().toString(16).slice(2);
  const tmux = (...args: string[]) => spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  let bridgePid = 0, piPid = 0, toolPid = 0;
  try {
    const bridge = "env " + ["PATH=" + f.bin + ":" + process.env.PATH, "PI_CODING_AGENT_DIR=" + f.home, Bun.which("node")!, f.bridge, "--cwd", f.project, "--resume", id].map(quote).join(" ");
    // Mirror Tmux.create: the bridge runs under a shell that falls back to bash.
    const command = mode === "exit-race" ? "bash -c " + quote(bridge + "; exec bash") : "exec " + bridge;
    expect(tmux("new-session", "-d", "-s", "test", command).status).toBe(0);
    await boundedUntil(() => tmux("capture-pane", "-p", "-t", "test").stdout.includes("STATE:ready"), 5000);
    bridgePid = JSON.parse(readFileSync(join(dirname(f.bridge), "pi-process.json"), "utf8")).bridgePid;
    piPid = JSON.parse(readFileSync(join(f.root, "spawned"), "utf8")).pid;
    if (mode === "tree") toolPid = Number(readFileSync(join(f.root, "tool-pid"), "utf8"));
    expect(existsSync(f.lock)).toBe(true);
    if (mode === "exit-race") expect(tmux("send-keys", "-t", "test", "/exit", "Enter").status).toBe(0);
    expect(tmux("kill-session", "-t", "test").status).toBe(0);
    await boundedUntil(() => [bridgePid, piPid, toolPid].filter(Boolean).every(pid => !alive(pid)) && !existsSync(f.lock), 5000);
  } finally {
    tmux("kill-server");
    for (const pid of [toolPid, piPid, bridgePid]) if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}, 15000);

test("SIGKILL of bridge leaves a stale lock and detached tool for manual cleanup", async () => {
  const f = nativeFixture("tree"); f.history(); const run = f.launch();
  let toolPid = 0;
  try {
    await until(() => run.output().includes("STATE:ready"));
    const piPid = JSON.parse(readFileSync(join(f.root, "spawned"), "utf8")).pid;
    toolPid = Number(readFileSync(join(f.root, "tool-pid"), "utf8"));
    run.child.kill("SIGKILL");
    await boundedUntil(() => run.child.signalCode === "SIGKILL" && !alive(piPid), 3000);
    expect(existsSync(f.lock)).toBe(true);
    expect(alive(toolPid)).toBe(true);
  } finally {
    if (toolPid && alive(toolPid)) process.kill(toolPid, "SIGKILL");
  }
});

// Deterministic PID/PGID reuse simulation: no real OS signals are sent.
test.each(["after-eof", "after-term", "between-signals", "already-closed", "non-leader", "root-same-second"])("native cleanup checks process identity (%s)", async scenario => {
  const signals: Array<{ pid: number; signal: string; replacement: boolean }> = [];
  const live = new Map([
    [42001, { parent: 42000, group: 42001, start: "Fri Oct 30 10:00:00 2026", replacement: false }],
    [42002, { parent: 42001, group: scenario === "non-leader" ? 42001 : 42002, start: "Fri Oct 30 10:00:01 2026", replacement: false }],
  ]);
  let released = false, closed = false;
  const close = () => { if (!closed) { closed = true; child.emit("exit", 0); child.emit("close", 0); } };
  const reuse = () => { for (const row of live.values()) { row.start = "Fri Oct 30 10:01:00 2026"; row.replacement = true; } };
  const child = Object.assign(new EventEmitter(), { pid: 42001, stdin: { end() {
    if (scenario === "after-eof") queueMicrotask(() => { reuse(); close(); });
    // Node has reaped Pi and its PID is reused within the same lstart second.
    if (scenario === "root-same-second") queueMicrotask(() => { live.get(42001)!.replacement = true; close(); });
  } } });
  const deps = {
    resolve, join, dirname: (value: string) => value.slice(0, value.lastIndexOf("/")), delimiter: ":",
    homedir: () => "/home/test", realpathSync: (value: string) => value, fileURLToPath,
    randomUUID: () => id, process: { env: { PATH: "/bin" }, versions: { node: "24.0.0" }, pid: 42000,
      kill(pid: number, signal: string | number) {
        const row = live.get(Math.abs(pid));
        if (!row) throw new Error("gone");
        if (signal === 0) return;
        signals.push({ pid, signal: String(signal), replacement: row.replacement });
        if (scenario === "after-term") setTimeout(() => { reuse(); close(); }, 10);
        else if (scenario === "between-signals") { reuse(); close(); }
        else { live.delete(Math.abs(pid)); if (Math.abs(pid) === child.pid) close(); }
      },
    },
    accessSync() {}, constants: { X_OK: 1 },
    readFileSync: () => JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.4.0" }),
    mkdirSync() {}, openSync: () => 1, closeSync() {}, unlinkSync() { released = true; }, writeFileSync() {},
    spawn: () => child,
    spawnSync: (_command: string, args: string[]) => ({ status: 0, stdout: [...live].filter(([pid]) => !args.includes("-p") || pid === Number(args[args.indexOf("-p") + 1])).map(([pid, row]) =>
      args.some(arg => arg.includes("lstart")) ? `${pid} ${row.parent} ${row.group} ${row.start}` : `${pid} ${row.parent}`).join("\n") + "\n" }),
    setTimeout, clearTimeout,
  };
  const open = new Function(...Object.keys(deps), `${piNativeSource}\nreturn openPi;`)(...Object.values(deps));
  const native = await open({ cwd: "/project", metadata: "/metadata" });
  if (scenario === "already-closed") { reuse(); close(); }
  await native.stop();
  expect(signals.filter(entry => entry.replacement)).toEqual([]);
  if (scenario === "after-eof" || scenario === "already-closed") expect(signals).toEqual([]);
  if (scenario === "non-leader") {
    expect(signals.some(entry => entry.pid === -42002)).toBe(false);
    expect(signals.some(entry => entry.pid === 42002)).toBe(true);
    expect(signals.some(entry => entry.pid === -42001)).toBe(true);
  }
  // The detached tool still has its recorded identity and must still be reclaimed.
  if (scenario === "root-same-second") expect(signals.some(entry => Math.abs(entry.pid) === 42002)).toBe(true);
  expect(released).toBe(true);
}, 7000);
