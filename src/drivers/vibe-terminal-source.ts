// One persistent bridge resumes Vibe's native session for each headless turn.
export const vibeTerminalFactorySource = String.raw`
function createVibeTerminal(deps) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let conversation = deps.resume, active, native, heartbeat, restore, opening, exitPromise;
  let fatal = false, exiting = false, disconnected = false;
  const queue = [];
  const write = text => { if (!disconnected) deps.stdout.write(text + "\n"); };
  function frames(state, tags) {
    let text = conversation ? "[AHELPA_VIBE_SESSION:" + conversation + "]\n" : "";
    if (active) text += "[AHELPA_VIBE_TURN:" + active.id + "]\n";
    if (tags !== undefined) text += "[AHELPA_VIBE_TAGS:" + tags.join(",") + "]\n";
    write(text + "[AHELPA_VIBE_STATE:" + state + "]");
  }
  function safeProse(text) {
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
      .replace(/\[AHELPA_VIBE_/g, "[quoted AHELPA_VIBE_");
  }
  function stopPulse() { if (heartbeat) deps.clearInterval(heartbeat); heartbeat = undefined; }
  function fail(category) {
    if (fatal || exiting) return;
    fatal = true; queue.length = 0; stopPulse();
    write("vibe: " + category); frames("error", []);
    void native?.stop();
    // Retain stdin so tmux's fallback shell never receives a task.
  }
  function finish(turn, code) {
    if (active !== turn || fatal || exiting) return;
    stopPulse();
    const signals = [...turn.text.matchAll(/^\s*(?:[-•●⏺]\s*)?\[AHELPA:(DONE|NEED_HELP(?::([^\]\r\n]*))?)\]\s*$/gmu)];
    const help = signals.filter(match => match[1] !== "DONE").at(-1);
    const tags = help ? [...new Set((help[2] ?? "").split(",").map(tag => tag.trim().toLowerCase()).filter(tag => /^[a-z0-9_-]+$/.test(tag)))] : [];
    const status = code === 3 ? "needs_attention" : code !== 0 ? "error"
      : help ? "error" : signals.some(match => match[1] === "DONE") ? "idle" : "needs_attention";
    if (code !== 0) {
      const category = code === 3 ? "interrupted" : /Session not found/i.test(turn.stderr) ? "resume session not found"
        : /Invalid model|invalid_model/i.test(turn.stderr) ? "model unavailable (the Mistral subscription may not include it)"
        : /Unknown model/i.test(turn.stderr) ? "unknown model" : /not (logged|signed) in|not authenticated|sign in|(?:invalid|missing) api key/i.test(turn.stderr) ? "authentication failed" : "turn failed";
      write("vibe: " + category);
    }
    if (status !== "idle") queue.length = 0;
    if (queue.length) { active = undefined; next(); }
    else { frames(status, tags); active = undefined; }
  }
  function attach(turn, adapter) {
    const child = adapter.child;
    let settling = false;
    const decoder = new deps.StringDecoder("utf8");
    let buffered = "";
    function event(line) {
      if (!line.trim()) return;
      const value = JSON.parse(line);
      if (!value || typeof value.type !== "string" || !UUID.test(value.sessionId ?? "")) throw new Error("invalid event");
      if (conversation && conversation.toLowerCase() !== value.sessionId.toLowerCase()) throw new Error("session changed");
      if (!conversation) { conversation = value.sessionId; frames("running"); }
      if (value.type === "message" && value.role === "assistant") {
        for (const part of value.content ?? []) if (part.type === "text" && typeof part.text === "string") {
          turn.text += part.text + "\n"; write(safeProse(part.text));
        }
      } else if (value.type === "effect") write("vibe tool: " + safeProse(String(value.title ?? "tool")).replace(/\n/g, " ").slice(0, 200));
    }
    child.stdout.on("data", chunk => {
      if (fatal || exiting || active !== turn) return;
      try {
        buffered += decoder.write(chunk);
        let index;
        while ((index = buffered.indexOf("\n")) !== -1) {
          if (Buffer.byteLength(buffered.slice(0, index)) > 16 * 1024 * 1024) throw new Error("oversize");
          event(buffered.slice(0, index)); buffered = buffered.slice(index + 1);
        }
        if (Buffer.byteLength(buffered) > 16 * 1024 * 1024) throw new Error("oversize");
      } catch { fail("protocol failure"); }
    });
    child.stdout.on("error", () => fail("protocol stream failed"));
    // ponytail: only the first 4 KB is needed to classify errors; never print stderr.
    child.stderr.on("data", chunk => { turn.stderr += String(chunk).slice(0, Math.max(0, 4096 - turn.stderr.length)); });
    child.stderr.on("error", () => {});
    child.on("error", () => fail("vibe failed to start"));
    async function settle(code) {
      if (settling) return;
      settling = true;
      // Root exit owns settlement. A tool may hold its inherited pipes open forever.
      await adapter.stop();
      if (fatal || exiting || active !== turn) return;
      try { buffered += decoder.end(); if (buffered.trim()) event(buffered); }
      catch { fail("protocol failure"); }
      finish(turn, code);
    }
    child.on("exit", code => { void settle(code); });
    child.on("close", code => { void settle(code); });
  }
  function next() {
    if (fatal || exiting || active || !queue.length) return;
    const input = queue.shift();
    const turn = active = { id: deps.randomUUID(), text: "", stderr: "" };
    frames("running");
    heartbeat = deps.setInterval(() => { if (!fatal && !exiting && active === turn) frames("running"); }, 3000);
    opening = (async () => {
      try {
        native = await deps.open({ input, resume: conversation, turnId: turn.id });
        attach(turn, native);
      } catch { fail("vibe failed to start"); }
    })();
  }
  async function start() {
    const reader = deps.createInterface({ input: deps.stdin, terminal: false });
    reader.on("error", () => { void exit(true); });
    reader.on("line", line => {
      if (line.trim() === "/exit") { void exit(); return; }
      if (fatal || exiting || !line.trim()) return;
      queue.push(line); next();
    });
    reader.on("close", () => { void exit(); });
    try { deps.prepareAgent(); restore = deps.configureInput(); frames("ready"); }
    catch { fail("startup configuration failed"); }
  }
  function exit(hangup = false) {
    disconnected ||= hangup;
    if (exitPromise) return exitPromise;
    exiting = true; queue.length = 0; stopPulse();
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

export const vibeNativeSource = String.raw`
function prepareVibeAgent(options) {
  if (options.model !== undefined && !/^[\w.:-]+$/.test(options.model)) throw new Error("invalid model");
  if (options.effort !== undefined && !["off", "low", "medium", "high", "max"].includes(options.effort)) throw new Error("invalid effort");
  const model = options.model ?? (options.effort === undefined ? undefined : "mistral-large-4-0-3");
  let agent = 'safety = "yolo"\nbypass_tool_permissions = true\n';
  if (model !== undefined) agent += 'active_model = ' + JSON.stringify(model) + "\n";
  const knownModels = {
    "deepseek-v4-1-flash-1017": {
      name: "deepseek-v4-1-flash-1017", provider: "mistral",
      thinking_levels: ["low", "high", "max"], max_context_length: 1048576, max_output_tokens: 131072,
    },
  };
  const definition = Object.hasOwn(knownModels, model) ? knownModels[model] : undefined;
  if (definition) {
    agent += '[models.' + JSON.stringify(model) + ']\n';
    for (const [key, value] of Object.entries(definition)) agent += key + " = " + JSON.stringify(value) + "\n";
    if (options.effort !== undefined) agent += 'thinking = ' + JSON.stringify(options.effort) + "\n";
  } else if (options.effort !== undefined) agent += '[models.' + JSON.stringify(model) + ']\nthinking = ' + JSON.stringify(options.effort) + "\n";
  writeFileSync(join(dirname(options.metadata), "ahelpa-helper.toml"), agent, { mode: 0o600 });
}
function openVibe(options) {
  const prompt = join(dirname(options.metadata), "vibe-prompt-" + options.turnId + ".txt");
  writeFileSync(prompt, options.input, { mode: 0o600 });
  const args = ["--prompt-file", prompt, "--output", "streaming", "--trust", "--agent", "ahelpa-helper"];
  if (options.resume) args.push("--resume", options.resume);
  const child = spawn("vibe", args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true,
    env: { ...process.env, VIBE_ENABLE_AUTO_UPDATE: "false", VIBE_ENABLE_UPDATE_CHECKS: "false",
      VIBE_AGENT_PATHS: JSON.stringify([dirname(options.metadata)]) } });
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
  // The detached child leads a process group. Reap it even after the root exits:
  // a surviving group keeps that PID reserved. ESRCH means it is already gone.
  let groupGone = !child.pid;
  const signal = name => {
    if (!groupGone) {
      try { process.kill(-child.pid, name); }
      catch (error) { if (error.code === "ESRCH") groupGone = true; }
    }
    if (!exited && child.pid) { try { process.kill(child.pid, name); } catch {} }
  };
  // lstart exists on macOS and Linux; a PID alone is not an identity once vibe exits.
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
  // Snapshot at interruption also catches tools that escaped the native group.
  // ponytail: naturally exiting roots cannot identify already-reparented setsid
  // tools; the guaranteed natural-exit cleanup boundary is the native process group.
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
      // Snapshot while vibe is unreaped: afterwards its tools are reparented away.
      const tools = exited || closed ? [] : descendants();
      // Interrupt the turn before reaping its descendants.
      signal("SIGTERM"); await wait(exit, 3000);
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

export const vibeTerminalSource = String.raw`import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
${vibeNativeSource}
${vibeTerminalFactorySource}
// Eagerly initialise all TTY streams while the pane still exists. Node may lazily
// open /dev/tty during process.exit, which can block forever after pane hangup.
void process.stderr;
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const options = { cwd: process.cwd(), metadata: join(dirname(fileURLToPath(import.meta.url)), "vibe-process.json") };
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
const terminal = createVibeTerminal({ prepareAgent: () => prepareVibeAgent(options), resume: options.resume, open: async turn => openVibe({ ...options, ...turn }), configureInput,
  stdin: process.stdin, stdout: process.stdout, createInterface, StringDecoder, randomUUID,
  setInterval, clearInterval, setTimeout, clearTimeout, exit: code => process.exit(code) });
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(signal, () => { void terminal.exit(true); });
void terminal.start();
`;
