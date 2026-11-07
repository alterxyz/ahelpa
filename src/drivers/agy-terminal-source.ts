// The generated Node bridge drives agy's headless stream-json mode: one agy
// process, one NDJSON user message per task, one `result` event per turn.
// The factory is dependency-injected so tests can drive it without agy.
export const agyTerminalFactorySource = String.raw`
function createAgyTerminal(deps) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let native, active, heartbeat, startup, restore, conversation;
  let ready = false, fatal = false, exiting = false, disconnected = false, exitPromise, opening;
  const queue = [];
  let stderr = "";
  const write = text => { if (!disconnected) deps.stdout.write(text + "\n"); };
  function frames(value, tags) {
    let text = conversation ? "[AHELPA_AGY_SESSION:" + conversation + "]\n" : "";
    if (active) text += "[AHELPA_AGY_TURN:" + active.id + "]\n";
    if (tags !== undefined) text += "[AHELPA_AGY_TAGS:" + tags.join(",") + "]\n";
    write(text + "[AHELPA_AGY_STATE:" + value + "]");
  }
  function stopPulse() { if (heartbeat) deps.clearInterval(heartbeat); heartbeat = undefined; }
  function safeProse(text) {
    // Drop terminal controls and quote every reserved marker, even mid-line.
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
      .replace(/\[AHELPA_AGY_/g, "[quoted AHELPA_AGY_");
  }
  // Raw stderr can carry account names and paths: only fixed categories leave the bridge.
  function startupCategory() {
    if (/invalid model selection/i.test(stderr)) return "agy rejected the model or effort; run agy models";
    if (/not (logged|signed) in|not authenticated|sign in/i.test(stderr)) return "agy is not signed in; run agy once to sign in";
    return "agy exited during startup";
  }
  async function fail(category) {
    if (fatal || exiting) return;
    fatal = true; ready = false; queue.length = 0; stopPulse();
    if (startup) deps.clearTimeout(startup);
    write("agy: " + category); frames("error");
    try { await native?.stop(); } catch {}
    // Deliberately retain stdin: tmux's fallback shell must never receive tasks.
  }
  function finish(result) {
    stopPulse();
    const text = typeof result.response === "string" ? result.response : "";
    const signals = [...text.matchAll(/^\s*(?:[-•●⏺]\s*)?\[AHELPA:(DONE|NEED_HELP(?::([^\]\r\n]*))?)\]\s*$/gmu)];
    const help = signals.filter(match => match[1] !== "DONE").at(-1);
    const tags = help ? [...new Set((help[2] ?? "").split(",").map(tag => tag.trim().toLowerCase()).filter(tag => /^[a-z0-9_-]+$/.test(tag)))] : [];
    // A finished_reason on SUCCESS means a partial answer; interrupted turns need a person.
    const success = result.status === "SUCCESS" && !result.finished_reason;
    const status = result.status !== "SUCCESS" && result.finished_reason !== "interrupted" ? "error"
      : !success ? "needs_attention" : help ? "error" : signals.some(match => match[1] === "DONE") ? "idle" : "needs_attention";
    if (text) write(safeProse(text));
    if (!success) write("agy: turn " + (result.finished_reason === "interrupted" ? "interrupted" : status === "error" ? "failed" : "ended early"));
    // Failure stops queued work; successful FIFO handoff has no visible idle gap.
    if (status !== "idle") queue.length = 0;
    if (queue.length) { active = undefined; next(); }
    else { frames(status, help ? tags : []); active = undefined; }
  }
  function next() {
    if (!ready || fatal || exiting || active || !queue.length) return;
    const input = queue.shift();
    const turn = active = { id: deps.randomUUID() };
    frames("running");
    heartbeat = deps.setInterval(() => { if (!fatal && !exiting && active === turn) frames("running"); }, 3000);
    try { native.child.stdin.write(JSON.stringify({ event: "user", message: { role: "user", content: input } }) + "\n"); }
    catch { void fail("input stream failed"); }
  }
  function onEvent(event) {
    if (!event || typeof event !== "object" || typeof event.event !== "string") throw new Error("invalid event");
    if (fatal || exiting) return;
    if (event.event === "init") {
      const id = event.conversation_id;
      if (ready || typeof id !== "string" || !UUID.test(id)) throw new Error("invalid init");
      // agy starts a new conversation, with only a warning, when --conversation is unknown.
      if (deps.resume && id.toLowerCase() !== deps.resume.toLowerCase()) { void fail("resume conversation not found"); return; }
      deps.clearTimeout(startup); startup = undefined;
      conversation = id; ready = true;
      frames("ready"); next();
      return;
    }
    if (event.event === "result") {
      const result = event.result;
      if (!result || typeof result !== "object" || typeof result.status !== "string") throw new Error("invalid result");
      if (!ready) { void fail(startupCategory()); return; }
      if (!active) throw new Error("result without turn");
      if (result.conversation_id !== conversation) throw new Error("conversation changed");
      finish(result);
    }
    // step_update and future events are progress only.
  }
  function attach() {
    const child = native.child, decoder = new deps.StringDecoder("utf8");
    let buffered = "";
    child.stdout.on("data", chunk => {
      if (fatal) return;
      try {
        buffered += decoder.write(chunk);
        let index;
        while ((index = buffered.indexOf("\n")) !== -1) {
          if (Buffer.byteLength(buffered.slice(0, index)) > 16 * 1024 * 1024) throw new Error("oversize");
          const line = buffered.slice(0, index).replace(/\r$/, ""); buffered = buffered.slice(index + 1);
          if (line.trim()) onEvent(JSON.parse(line));
        }
        if (Buffer.byteLength(buffered) > 16 * 1024 * 1024) throw new Error("oversize");
      } catch { void fail("protocol failure"); }
    });
    child.stdout.on("error", () => { void fail("protocol stream failed"); });
    // ponytail: the first 4 KB of stderr is enough to classify a startup failure.
    child.stderr.on("data", chunk => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
    child.stderr.on("error", () => {});
    child.stdin.on("error", () => { void fail("input stream failed"); });
    child.on("error", () => { void fail("agy executable not found"); });
    child.on("close", () => { if (!exiting && !fatal) void fail(ready ? "agy exited unexpectedly" : startupCategory()); });
  }
  async function start() {
    const reader = deps.createInterface({ input: deps.stdin, terminal: false });
    // A dead pane fails stdin reads (EIO); left unhandled it crashes the bridge before cleanup.
    reader.on("error", () => { void exit(true); });
    reader.on("line", line => {
      if (line.trim() === "/exit") { void exit(); return; }
      if (fatal || exiting || !line.trim()) return;
      queue.push(line); next();
    });
    reader.on("close", () => { void exit(); });
    opening = (async () => {
      try {
        restore = deps.configureInput();
        native = await deps.open();
        if (exiting) return;
        attach();
        startup = deps.setTimeout(() => { void fail("agy did not start in time"); }, deps.startupTimeout ?? 90000);
      } catch { await fail("agy failed to start"); }
    })();
    await opening;
  }
  function exit(hangup = false) {
    disconnected ||= hangup;
    if (exitPromise) return exitPromise;
    exiting = true; ready = false; queue.length = 0; stopPulse();
    if (startup) deps.clearTimeout(startup);
    exitPromise = (async () => {
      await opening;
      try { await native?.stop(); } catch {}
      try { if (!disconnected) restore?.(); } catch {}
      deps.exit(0);
    })();
    return exitPromise;
  }
  return { start, exit };
}
`;

export const agyNativeSource = String.raw`
function openAgy(options) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"];
  if (options.resume) args.push("--conversation", options.resume);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  // -p consumes the next argument; stream-json input supplies the prompts.
  args.push("-p", "");
  // detached: agy gets its own session, so pane hangup reaches only the bridge,
  // which then stops agy with SIGINT (SIGTERM leaves agy's tool processes behind).
  const child = spawn("agy", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true,
    // agy 1.5.2 honours exactly "true"; "1" still spawns its background updater.
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" } });
  let exited = false, closed = false, stopping;
  const exit = new Promise(done => {
    child.once("exit", () => { exited = true; done(); });
    child.once("error", () => { exited = true; done(); });
  });
  const closure = new Promise(done => { child.once("close", () => { closed = true; done(); }); });
  const wait = async (promise, ms) => {
    let timer;
    await Promise.race([promise, new Promise(done => { timer = setTimeout(done, ms); })]); clearTimeout(timer);
  };
  // Until Node reports exit, the child PID is unreaped and cannot be reused.
  const signal = name => { if (!exited && !closed && child.pid) { try { process.kill(child.pid, name); } catch {} } };
  // lstart exists on macOS and Linux; a PID alone is not an identity once agy exits.
  // ponytail: lstart has one-second resolution; a PID reused within that second
  // still matches. Use /proc starttime or proc_pidinfo if that ever matters.
  function processes(pid) {
    const result = spawnSync("ps", pid ? ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart="] : ["-axo", "pid=,ppid=,pgid=,lstart="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000, env: { ...process.env, LC_ALL: "C" } });
    if (result.error || (result.status !== 0 && !(pid && result.status === 1 && !result.stdout?.trim()))) return;
    const rows = new Map();
    for (const line of (result.stdout ?? "").trim().split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) rows.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), start: match[4] });
    }
    return rows;
  }
  const root = child.pid ? processes(child.pid)?.get(child.pid) : undefined;
  // agy runs each tool command in its own process group and its SIGINT cleanup
  // races its exit, so the bridge reaps whatever agy leaves behind.
  function descendants() {
    const rows = processes();
    if (!root || !rows || rows.get(root.pid)?.start !== root.start) return [];
    const tree = new Map([[root.pid, root]]);
    let added;
    do {
      added = false;
      for (const row of rows.values()) if (tree.has(row.parent) && !tree.has(row.pid)) { tree.set(row.pid, row); added = true; }
    } while (added);
    tree.delete(root.pid);
    return [...tree.values()];
  }
  function same(record) {
    const row = processes(record.pid)?.get(record.pid); // An observation failure never authorizes a signal.
    return row?.start === record.start ? row : undefined;
  }
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      // Snapshot while agy is unreaped: afterwards its tools are reparented away.
      const tools = exited || closed ? [] : descendants();
      // stdin EOF lets agy finish the running turn first, so interrupt instead.
      // Wait on exit, not close: a tool may hold agy's inherited pipes open forever.
      signal("SIGINT"); await wait(exit, 3000);
      signal("SIGKILL"); await wait(exit, 1000);
      for (const name of ["SIGTERM", "SIGKILL"]) {
        let live = false;
        for (const record of tools) {
          const row = same(record);
          if (!row) continue;
          live = true;
          // Only a group leader with the recorded identity authorizes a group signal.
          try { process.kill(row.group === row.pid ? -row.pid : row.pid, name); } catch {}
        }
        if (!live) break;
        if (name === "SIGTERM") await new Promise(done => setTimeout(done, 1000));
      }
      // Drain final output briefly, then release pipes held by escaped tools.
      await wait(closure, 250);
      child.stdout.destroy(); child.stderr.destroy();
    })();
    return stopping;
  }
  try { writeFileSync(options.metadata, JSON.stringify({ bridgePid: process.pid, childPid: child.pid ?? null }), { mode: 0o600 }); } catch {}
  return { child, stop };
}
`;

export const agyTerminalSource = String.raw`import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
${agyNativeSource}
${agyTerminalFactorySource}
// Eagerly initialise all TTY streams while the pane still exists. Node may lazily
// open /dev/tty during process.exit, which can block forever after pane hangup.
void process.stderr;
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const options = { cwd: process.cwd(), metadata: join(dirname(fileURLToPath(import.meta.url)), "agy-process.json") };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].slice(2);
  if (!["cwd", "resume", "model", "effort"].includes(key) || !process.argv[i + 1]) throw new Error("invalid bridge argument");
  options[key] = process.argv[i + 1];
}
function configureInput() {
  if (!process.stdin.isTTY) return () => {};
  const run = args => {
    const result = spawnSync("stty", args, { stdio: [process.stdin.fd, "pipe", "pipe"], encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error("input configuration failed");
    return result.stdout.trim();
  };
  const previous = run(["-g"]); run(["-echo"]);
  return () => { run([previous]); };
}
const terminal = createAgyTerminal({ resume: options.resume, open: async () => openAgy(options), configureInput,
  stdin: process.stdin, stdout: process.stdout, createInterface, StringDecoder, randomUUID,
  setInterval, clearInterval, setTimeout, clearTimeout, exit: code => process.exit(code) });
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(signal, () => { void terminal.exit(true); });
void terminal.start();
`;
