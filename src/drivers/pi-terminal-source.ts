// The generated Node bridge speaks only Pi's public RPC protocol. Keeping the
// factory dependency-injected lets tests drive races without provider calls.
export const piTerminalFactorySource = String.raw`
function createPiTerminal(deps) {
  let native, active, heartbeat, reader, restore;
  let disconnected = false;
  let ready = false, fatal = false, exiting = false, opening, exitPromise, control;
  const queue = [], pending = new Map();
  let sequence = 0;
  const write = text => { if (!disconnected) deps.stdout.write(text + "\n"); };
  function frames(value, tags) {
    let text = native ? "[AHELPA_PI_SESSION:" + native.sessionId + "]\n" : "";
    if (active) text += "[AHELPA_PI_TURN:" + active.id + "]\n";
    if (tags !== undefined) text += "[AHELPA_PI_TAGS:" + tags.join(",") + "]\n";
    write(text + "[AHELPA_PI_STATE:" + value + "]");
  }
  function stopPulse() { if (heartbeat) deps.clearInterval(heartbeat); heartbeat = undefined; }
  function rejectPending() {
    for (const request of pending.values()) { deps.clearTimeout(request.timer); request.reject(new Error("RPC stopped")); }
    pending.clear();
  }
  async function fail(category) {
    if (fatal || exiting) return;
    fatal = true; ready = false; queue.length = 0; stopPulse();
    write("pi: " + category); frames("error"); rejectPending();
    try { await native?.stop(); } catch {}
    // Deliberately retain stdin: tmux's fallback shell must never receive tasks.
  }
  function send(value) { native.child.stdin.write(JSON.stringify(value) + "\n"); }
  function rpc(type, data = {}) {
    if (fatal) return Promise.reject(new Error("RPC stopped"));
    return new Promise((resolve, reject) => {
      const id = "ahelpa-" + ++sequence;
      const timer = deps.setTimeout(() => { pending.delete(id); reject(new Error("RPC timeout")); }, deps.requestTimeout ?? 15000);
      pending.set(id, { type, resolve, reject, timer });
      try { send({ ...data, id, type }); }
      catch { pending.delete(id); deps.clearTimeout(timer); reject(new Error("RPC write failed")); }
    });
  }
  function idle(state) {
    return state && state.isStreaming === false && state.isCompacting === false && state.pendingMessageCount === 0;
  }
  function safeProse(text) {
    // Drop terminal controls and quote every reserved marker, even mid-line.
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
      .replace(/\[AHELPA_PI_/g, "[quoted AHELPA_PI_");
  }
  function finish(turn, aborted = false, handled = false) {
    if (active !== turn || fatal || exiting || control) return;
    stopPulse();
    const text = turn.answer;
    const signals = [...text.matchAll(/^\s*(?:[-•●⏺]\s*)?\[AHELPA:(DONE|NEED_HELP(?::([^\]\r\n]*))?)\]\s*$/gmu)];
    const help = signals.filter(match => match[1] !== "DONE").at(-1);
    const tags = help ? [...new Set((help[2] ?? "").split(",").map(tag => tag.trim().toLowerCase()).filter(tag => /^[a-z0-9_-]+$/.test(tag)))] : [];
    const status = turn.ui || turn.cancelRequested ? "needs_attention" : turn.failed || help ? "error"
      : aborted || turn.aborted || turn.interrupted || handled ? "needs_attention" : turn.valid && signals.some(match => match[1] === "DONE") ? "idle" : "needs_attention";
    if (text) write(safeProse(text));
    if (status === "error") write("pi: native turn failed");
    // Failure stops queued work; successful FIFO handoff has no visible idle gap.
    if (status !== "idle") queue.length = 0;
    if (queue.length) { active = undefined; next(); }
    else { frames(status, help ? tags : []); active = undefined; }
  }
  async function settle(turn, aborted) {
    turn.settled = true; turn.aborted ||= aborted;
    if (!turn.accepted || control || fatal || exiting) return;
    try {
      const state = await rpc("get_state");
      if (active !== turn || fatal || exiting || control) return;
      if (!idle(state)) { await fail("settlement state mismatch"); return; }
      finish(turn, turn.aborted);
    } catch { await fail("settlement verification failed"); }
  }
  function next() {
    if (!ready || fatal || exiting || control || active || !queue.length) return;
    const input = queue.shift();
    const turn = active = { id: deps.randomUUID(), answer: "", valid: false, failed: false, activity: false, accepted: false, settled: false, aborted: false };
    frames("running"); heartbeat = deps.setInterval(() => { if (!fatal && !exiting && active === turn) frames("running"); }, 3000);
    void rpc("prompt", { message: input }).then(async result => {
      if (active !== turn || fatal || exiting) return;
      if (!["started", "queued", "handled"].includes(result?.disposition)) { await fail("invalid prompt response"); return; }
      turn.accepted = true;
      if (turn.settled) { await settle(turn, turn.aborted); return; }
      if (result.disposition === "handled" && !turn.activity) {
        const state = await rpc("get_state");
        if (active === turn && !turn.activity && idle(state)) finish(turn, false, true);
        else if (!turn.activity && !idle(state)) await fail("handled prompt state mismatch");
      }
    }).catch(() => { void fail("prompt rejected"); });
  }
  function abort() {
    if (control) return control;
    queue.length = 0;
    const turn = active;
    if (turn) { turn.aborted = true; turn.cancelRequested = true; }
    control = (async () => {
      await rpc("clear_queue"); await rpc("abort");
    })();
    const operation = control;
    void operation.then(() => {
      if (control !== operation) return;
      control = undefined;
      if (fatal || exiting) return;
      if (turn && active === turn) finish(turn, true);
      else { frames("needs_attention", []); next(); }
    }).catch(() => { control = undefined; void fail("abort failed"); });
    return operation;
  }
  function onEvent(event) {
    if (!event || typeof event !== "object" || typeof event.type !== "string") throw new Error("invalid event");
    if (event.type === "response") {
      const request = pending.get(event.id);
      if (!request) return;
      if (event.command !== request.type || typeof event.success !== "boolean") throw new Error("invalid response");
      pending.delete(event.id); deps.clearTimeout(request.timer);
      if (event.success) request.resolve(event.data); else request.reject(new Error("RPC rejected"));
      return;
    }
    if (fatal || exiting) return;
    if (event.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        send({ type: "extension_ui_response", id: event.id, cancelled: true });
        if (active) active.ui = true;
        void abort();
      } else if (!["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(event.method)) {
        void fail("unsupported extension UI request");
      }
      return;
    }
    if (event.type === "extension_error") { void fail("extension failed"); return; }
    const turn = active;
    if (!turn) return;
    if (["agent_start", "message_start", "message_update", "message_end", "tool_execution_start", "compaction_start"].includes(event.type)) turn.activity = true;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        turn.answer = ""; turn.valid = false; turn.failed = message.stopReason === "error"; turn.interrupted = message.stopReason === "aborted";
      } else {
        if (!Array.isArray(message.content)) throw new Error("invalid assistant message");
        turn.answer = message.content.filter(item => item.type === "text" && typeof item.text === "string").map(item => item.text).join("");
        turn.valid = message.stopReason === "stop";
        turn.failed = false; turn.interrupted = false;
      }
    }
    if (event.type === "auto_retry_end" && event.success === false) { turn.failed = true; turn.answer = ""; turn.valid = false; }
    if (event.type === "compaction_end" && event.errorMessage) { turn.failed = true; turn.answer = ""; turn.valid = false; }
    if (event.type === "compaction_end" && event.aborted) { turn.interrupted = true; turn.answer = ""; turn.valid = false; }
    if (event.type === "agent_settled") {
      if (typeof event.aborted !== "boolean") throw new Error("invalid settlement");
      void settle(turn, event.aborted);
    }
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
          if (Buffer.byteLength(buffered.slice(0, index)) > 1024 * 1024) throw new Error("oversize");
          const line = buffered.slice(0, index).replace(/\r$/, ""); buffered = buffered.slice(index + 1);
          onEvent(JSON.parse(line));
        }
        if (Buffer.byteLength(buffered) > 1024 * 1024) throw new Error("oversize");
      } catch { void fail("protocol failure"); }
    });
    child.stdout.on("end", () => {
      const truncated = buffered.length || decoder.end().length;
      if (!exiting && !fatal) void fail(truncated ? "truncated protocol" : "protocol stream closed");
    });
    child.stdout.on("error", () => { void fail("protocol stream failed"); });
    child.stderr.on("data", () => {});
    child.stderr.on("error", () => { void fail("stderr stream failed"); });
    child.stdin.on("error", () => { void fail("input stream failed"); });
    child.on("error", () => { void fail("child failed"); });
    child.on("close", () => { if (!exiting && !fatal) void fail("child exited unexpectedly"); });
  }
  async function start() {
    reader = deps.createInterface({ input: deps.stdin, terminal: false });
    // A dead pane fails stdin reads (EIO) and readline re-emits the error; left
    // unhandled it crashes the bridge before cleanup releases the lock.
    reader.on("error", () => { void exit(true); });
    reader.on("line", line => {
      if (line.trim() === "/exit") { void exit(); return; }
      if (fatal || exiting || !line.trim()) return;
      if (line.trim() === "/abort") { if (ready) void abort(); return; }
      if (control) return;
      queue.push(line); next();
    });
    reader.on("close", () => { void exit(); });
    opening = (async () => {
      try {
        restore = deps.configureInput();
        native = await deps.open(); attach();
        if (exiting) return;
        const state = await rpc("get_state");
        if (state?.sessionId !== native.sessionId || !idle(state)) throw new Error("state mismatch");
        if (deps.model && state.model?.provider + "/" + state.model?.id !== deps.model) throw new Error("model mismatch");
        if (deps.effort) {
          const supported = await rpc("get_available_thinking_levels");
          if (!Array.isArray(supported?.levels) || !supported.levels.includes(deps.effort) || state.thinkingLevel !== deps.effort) throw new Error("thinking mismatch");
        }
        if (fatal || exiting) return;
        ready = true; frames("ready"); next();
      } catch (error) {
        // Only errors constructed locally by the launcher may expose a fixed category/path.
        await fail(deps.LaunchError && error instanceof deps.LaunchError ? error.message : "startup verification failed");
      }
    })();
    await opening;
  }
  function exit(hangup = false) {
    disconnected ||= hangup;
    if (hangup) rejectPending();
    if (exitPromise) return exitPromise;
    exiting = true; ready = false; queue.length = 0; stopPulse();
    exitPromise = (async () => {
      await opening;
      if (native && !fatal && !disconnected) {
        try { if (active || control) await abort(); } catch {}
      }
      rejectPending();
      try { await native?.stop(); } catch {}
      reader?.close();
      try { if (!disconnected) restore?.(); } catch {}
      deps.exit(0);
    })();
    return exitPromise;
  }
  return { start, exit };
}
`;

export const piNativeSource = String.raw`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class PiLaunchError extends Error {}
function category(message) { return new PiLaunchError(message); }
// Pi 1.4 config.getAgentDir / utils.paths.normalizePath on supported POSIX hosts.
function normalizePath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (/^file:\/\//.test(value)) return fileURLToPath(value);
  return value;
}
function sessionDirectory(cwd, agentDir) {
  let physicalCwd = resolve(normalizePath(cwd));
  // Node's process.cwd() in the spawned Pi resolves cwd symlinks (including /tmp).
  try { physicalCwd = realpathSync(physicalCwd); } catch {}
  const home = resolve(physicalCwd, normalizePath(agentDir));
  return join(home, "sessions", "--" + physicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--");
}

function findTranscript(directory, id) {
  const matches = readdirSync(directory).filter(name => name.endsWith("_" + id + ".jsonl"));
  if (matches.length !== 1) throw category("resume history missing or ambiguous");
  const file = join(directory, matches[0]);
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(65536), size = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(10, 0);
    if (newline < 0 || newline >= size) throw new Error("header too long");
    const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    if (header.type !== "session" || header.id !== id) throw new Error("wrong header");
  } catch { throw category("resume history malformed"); }
  finally { if (fd !== undefined) closeSync(fd); }
  return file;
}
function executable() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const file = resolve(dir, "pi");
    try { accessSync(file, constants.X_OK); return realpathSync(file); } catch {}
  }
  throw category("Pi executable not found");
}
function verifyVersion(file) {
  for (const dir of [dirname(file), dirname(dirname(file)), dirname(dirname(dirname(file)))]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name !== "@earendil-works/pi-coding-agent") continue;
      const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(pkg.version);
      if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 4) || /^1\.4\.0-/.test(pkg.version)) throw category("upgrade Pi to >= 1.4.0");
      return;
    } catch (error) { if (error instanceof PiLaunchError) throw error; }
  }
  throw category("Pi version unavailable; install Pi >= 1.4.0");
}
function verifyNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw category("Node.js >= 22.19.0 is required for Pi");
}
async function openPi(options) {
  verifyNode();
  const file = executable(); verifyVersion(file);
  const id = options.resume ?? randomUUID();
  if (!UUID.test(id)) throw category("invalid resume UUID");
  const directory = sessionDirectory(options.cwd, process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, ".ahelpa-" + id + ".lock");
  try { closeSync(openSync(lock, "wx", 0o600)); }
  catch { throw category("session locked; remove stale lock manually: " + lock.replace(/[\x00-\x1f\x7f]/g, "?")); }
  let child;
  try {
    const sessionArgs = options.resume ? ["--session", findTranscript(directory, id)] : ["--session-id", id];
    const args = ["--mode", "rpc", ...sessionArgs, "--session-dir", directory, "--approve", "--no-extensions", "--no-mcp", "--offline"];
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--thinking", options.effort);
    child = spawn(file, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (error) { unlinkSync(lock); throw error; }
  // lstart is available on both macOS and Linux. A PID alone is not an identity:
  // tools (and even Pi) may exit and have their PID reused during the grace period.
  // ponytail: lstart has one-second resolution, so a PID reused within the same
  // second still matches; that needs the PID space to wrap within a second. Use
  // /proc starttime (Linux) or proc_pidinfo (macOS) if that ceiling ever matters.
  function processes(pid) {
    const result = spawnSync("ps", pid ? ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart="] : ["-axo", "pid=,ppid=,pgid=,lstart="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000, env: { ...process.env, LC_ALL: "C" } });
    if (result.error || (result.status !== 0 && !(pid && result.status === 1 && !result.stdout?.trim()))) return;
    const rows = new Map();
    for (const line of (result.stdout ?? "").trim().split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) {
        const [, id, parent, group, start] = match;
        rows.set(Number(id), { pid: Number(id), parent: Number(parent), group: Number(group), start });
      }
    }
    return rows;
  }
  const root = child.pid ? processes(child.pid)?.get(child.pid) : undefined;
  let exited = false, closed = false, stopping;
  child.once("exit", () => { exited = true; });
  const closure = new Promise(resolveClose => {
    child.once("close", () => { closed = true; resolveClose(); void stop(); });
  });
  // A spawn error is followed by close; install a handler before returning.
  child.on("error", () => {});
  const wait = async ms => {
    let timer;
    await Promise.race([closure, new Promise(done => { timer = setTimeout(done, ms); })]); clearTimeout(timer);
  };
  function stop() {
    if (stopping) return stopping;
    // Snapshot descendants only while the original Pi identity still owns the
    // root. A close-triggered stop must not adopt a replacement PID's children.
    const tree = new Map();
    const rows = processes();
    if (root && (!rows || rows.get(root.pid)?.start === root.start)) {
      tree.set(root.pid, root);
      let added;
      do {
        added = false;
        for (const row of rows?.values() ?? []) if (tree.has(row.parent) && !tree.has(row.pid)) {
          tree.set(row.pid, row); added = true;
        }
      } while (added);
    }
    function current(record) {
      // Once Node has reaped Pi, its PID belongs to nobody we know.
      if (record.pid === child.pid && (exited || closed)) { tree.delete(record.pid); return; }
      const observed = processes(record.pid);
      if (!observed) return; // An observation failure never authorizes a signal.
      const row = observed.get(record.pid);
      if (row?.start === record.start) return row;
      tree.delete(record.pid);
    }
    const remaining = () => {
      for (const record of tree.values()) current(record);
      return tree.size > 0;
    };
    const signalTree = signal => {
      for (const record of [...tree.values()].reverse()) {
        // Only a recorded group leader with the same identity can authorize a
        // group signal. Recheck again before the individual signal: the group
        // signal may already have killed it and allowed the PID to be reused.
        if (record.group === record.pid && current(record)?.group === record.group) {
          try { process.kill(-record.pid, signal); } catch {}
        }
        if (tree.has(record.pid) && current(record)) {
          try { process.kill(record.pid, signal); } catch {}
        }
      }
      // Before Node reports exit, its unreaped child PID cannot be reused. This
      // fallback is only needed if ps could not record Pi at launch.
      if (!root && child.pid && !exited && !closed) {
        try { process.kill(child.pid, signal); } catch {}
      }
    };
    stopping = (async () => {
      child.stdin.end(); await wait(1500);
      signalTree("SIGTERM");
      const deadline = Date.now() + 1500;
      while (remaining() && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
      signalTree("SIGKILL");
      if (!closed) await closure;
      // Keep the lock until child streams close and descendants have been stopped.
      const killedDeadline = Date.now() + 1000;
      while (remaining() && Date.now() < killedDeadline) await new Promise(done => setTimeout(done, 25));
      if (!remaining()) { try { unlinkSync(lock); } catch {} }
    })();
    return stopping;
  }
  try {
    writeFileSync(options.metadata, JSON.stringify({ lockPath: lock, bridgePid: process.pid, childPid: child.pid }), { mode: 0o600 });
  } catch (error) { await stop(); throw error; }

  return { sessionId: id, child, stop };
}
`;

export const piTerminalSource = String.raw`import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, closeSync, openSync, readSync, readdirSync, readFileSync, realpathSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
${piNativeSource}
${piTerminalFactorySource}
// Eagerly initialise all TTY streams while the pane still exists. Node may lazily
// open /dev/tty during process.exit, which can block forever after pane hangup.
void process.stderr;
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const options = { cwd: process.cwd(), metadata: join(dirname(fileURLToPath(import.meta.url)), "pi-process.json") };
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
const terminal = createPiTerminal({ ...options, LaunchError: PiLaunchError, open: () => openPi(options), configureInput,
  stdin: process.stdin, stdout: process.stdout, createInterface, StringDecoder, randomUUID,
  setInterval, clearInterval, setTimeout, clearTimeout, exit: code => process.exit(code) });
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(signal, () => { void terminal.exit(true); });
void terminal.start();
`;
