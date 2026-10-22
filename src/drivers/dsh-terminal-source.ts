// A small Cordis app keeps one native DSH Agent alive behind the normal tmux
// transport. The dependency-injected factory is also executable without DSH in
// unit tests; the installed plugin adds only DSH's public model/message APIs.
export const dshTerminalFactorySource = String.raw`
function createDshTerminal(deps) {
  const { createInterface, randomUUID, installModelSelection, createUserMessage } = deps;
  const env = deps.env;
  const write = (line) => deps.stdout.write(String(line) + "\n");
  const state = (value) => write("[AHELPA_DSH_STATE:" + value + "]");
  let closed = false;
  let reader;
  let heartbeat;
  let handle;
  let restoreInput;
  let queue = Promise.resolve();
  let eof = false;
  let exitRequested = false;

  class TerminalError extends Error {}
  function stopHeartbeat() {
    if (heartbeat !== undefined) deps.clearInterval(heartbeat);
    heartbeat = undefined;
  }
  function restoreInputSettings() {
    const restore = restoreInput;
    restoreInput = undefined;
    try { restore?.(); } catch { write("dsh: could not restore terminal input settings"); }
  }
  function fail(error, exit) {
    // Provider exceptions can contain credentials, request bodies, or URLs.
    // Only our own fixed validation messages are safe to print verbatim.
    write("dsh: " + (error instanceof TerminalError ? error.message : "terminal operation failed"));
    state("error");
    if (exit) requestExit(exit, 1);
  }
  function requestExit(exit, code) {
    if (exitRequested) return;
    exitRequested = true;
    closed = true;
    stopHeartbeat();
    reader?.close();
    restoreInputSettings();
    exit(code);
  }
  function frames(sessionId, turnId) {
    write("[AHELPA_DSH_SESSION:" + sessionId + "]");
    if (turnId) write("[AHELPA_DSH_TURN:" + turnId + "]");
  }
  function events(session, from = 0) {
    const result = [];
    const end = session.seq;
    for (let seq = from; seq < end; seq++) {
      const event = session.eventAt(seq);
      if (!event) throw new TerminalError("session history is incomplete");
      result.push(event);
    }
    return result;
  }
  function assertAdoptable(header, history, cwd) {
    let preset = header.agentPreset;
    for (const event of history) {
      if (event.type !== "agent-preset/selected") continue;
      if (typeof event.data?.agentPreset !== "string" || !event.data.agentPreset) {
        throw new TerminalError("cannot resume a malformed preset selection");
      }
      preset = event.data.agentPreset;
    }
    if (preset !== undefined) throw new TerminalError("cannot resume an agent preset session");
    if (header.origin === "subagent" || header.parentSession !== undefined) {
      throw new TerminalError("cannot resume a subagent or forked session");
    }
    if (header.cwd !== cwd) throw new TerminalError("resume working directory does not match this project");
  }
  function summarize(history) {
    let started = false;
    let text = "";
    let reason;
    for (const event of history) {
      if (event.type === "turn/start") started = true;
      if (!started) continue;
      if (event.type === "assistant/message") {
        const joined = event.data.message.content.filter(block => block.type === "text")
          .map(block => block.text).join("");
        if (joined) text = joined;
      }
      if (event.type === "turn/end") reason = event.data.reason;
    }
    const signals = [...text.matchAll(/^\s*(?:[-•●⏺]\s*)?\[AHELPA:(DONE|NEED_HELP(?::([^\]\r\n]*))?)\]\s*$/gmu)];
    const help = signals.filter(match => match[1] !== "DONE").at(-1);
    const tags = help ? [...new Set((help[2] ?? "").split(",").map(tag => tag.trim().toLowerCase())
      .filter(tag => /^[a-z0-9_-]+$/.test(tag)))] : [];
    return { text, reason, help: help !== undefined, done: signals.some(match => match[1] === "DONE"), tags };
  }
  function assistantText(text) {
    // Assistant prose may quote this protocol. Only frames emitted by this
    // app are allowed to change the host's session/turn/state interpretation.
    return text.replace(/^[^\S\r\n]*\[AHELPA_DSH_(?:SESSION|TURN|STATE|TAGS):[^\r\n]*\][^\S\r\n]*$/gmu, "| $&");
  }

  async function start(ctx, exit) {
    await ctx.get("loader")?.await();
    if (closed) return;
    const agents = ctx.get("agents");
    const sessions = ctx.get("sessions");
    const defaults = ctx.get("agentDefaultModel");
    if (!agents || !sessions || !defaults || !ctx.get("sessionPersistence")) {
      throw new TerminalError("terminal requires persistent DSH agent services");
    }
    const selection = { ...defaults.currentSelection() };
    if (selection.provider !== "deepseek-official") {
      throw new TerminalError("terminal currently requires the deepseek-official provider");
    }
    for (const [key, field] of [["AHELPA_DSH_MODEL", "model"], ["AHELPA_DSH_EFFORT", "reasoningEffort"]]) {
      // The driver clears absent overrides explicitly to block inherited values.
      // Trim only to recognize that sentinel; preserve every nonblank value.
      if (env[key] === undefined || !env[key].trim()) continue;
      selection[field] = env[key];
    }
    const fs = ctx.get("fs");
    const cwd = fs ? fs.processPath(await fs.resolve(".")) : deps.cwd();
    const resumeId = env.AHELPA_DSH_RESUME_ID?.trim() ? env.AHELPA_DSH_RESUME_ID : undefined;
    if (resumeId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(resumeId)) {
      throw new TerminalError("resume session id is invalid");
    }
    const agentOptions = { provider: selection.provider, model: selection.model };
    const setup = (agentCtx, agent) => {
      // Validate after acquiring the native write lease as well as before it.
      if (resumeId !== undefined) assertAdoptable(agent.session.header, events(agent.session), cwd);
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    };
    if (resumeId !== undefined) {
      const query = ctx.get("sessionQuery");
      if (!query) throw new TerminalError("resume requires the DSH session query service");
      if (agents.get(resumeId)) throw new TerminalError("resume session is already live in this process");
      let observation;
      try {
        observation = await query.observeSession(resumeId);
        assertAdoptable(observation.header, observation.events, cwd);
        handle = await agents.resume({ resumeSessionId: resumeId, agentOptions, setup });
      } catch (error) {
        if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") throw new TerminalError("resume session does not exist");
        throw error;
      } finally {
        observation?.[Symbol.dispose]?.();
      }
    } else {
      handle = await agents.create({ sessionId: "session-" + randomUUID(), meta: { cwd }, agentOptions, setup });
    }
    const agent = handle.agent;
    if (resumeId !== undefined && agent.session.id !== resumeId) throw new TerminalError("resume returned a different session");
    await agent.whenIdle();
    if (closed) return;
    assertAdoptable(agent.session.header, events(agent.session), cwd);
    await sessions.flush(agent.session);
    if (closed) return;
    try { restoreInput = deps.configureInput(); }
    catch { throw new TerminalError("cannot disable terminal input echo"); }
    frames(agent.session.id);
    state("ready");

    async function turn(input) {
      if (closed) return;
      const turnId = randomUUID();
      const firstSeq = agent.session.seq;
      let failure;
      const stopErrors = ctx.on("agent/error", ({ agent: subject }) => {
        if (subject === agent) failure = agent.session.seq;
      });
      const stopTerminals = ctx.on("session/event", (session, event) => {
        if (session === agent.session && event.type === "turn/end" && failure !== undefined && event.seq >= failure) {
          failure = undefined;
        }
      });
      const pulse = () => { if (!closed) { frames(agent.session.id, turnId); state("running"); } };
      pulse();
      heartbeat = deps.setInterval(pulse, 3000);
      let thrown = false;
      try {
        agent.followup(createUserMessage({ content: [{ type: "text", text: input }], source: { kind: "user" } }));
        while (!closed) {
          await agent.whenIdle();
          const idleSeq = agent.session.seq;
          if (!await ctx.get("subagents")?.waitForChildren(agent) && agent.status === "idle" && agent.session.seq === idleSeq) break;
        }
      } catch {
        thrown = true;
      } finally {
        stopErrors();
        stopTerminals();
      }
      if (closed) return;
      // Settlement must not promise a resumable result before its log is durable.
      try { await sessions.flush(agent.session); } finally { stopHeartbeat(); }
      if (closed) return;
      const outcome = summarize(events(agent.session, firstSeq));
      const failed = thrown || failure !== undefined || outcome.reason?.kind === "error";
      if (outcome.text) write(assistantText(outcome.text));
      if (failed) write("dsh: native turn failed");
      // Keep identity and terminal evidence in the monitor's bounded capture,
      // even when the assistant's final answer is hundreds of lines long.
      frames(agent.session.id, turnId);
      if (outcome.help) write("[AHELPA_DSH_TAGS:" + outcome.tags.join(",") + "]");
      state(failed || outcome.help ? "error"
        : outcome.reason?.kind === "completed" && outcome.done ? "idle" : "needs_attention");
    }
    reader = createInterface({ input: deps.stdin, terminal: false });
    reader.on("line", input => {
      if (closed || !input.trim()) return;
      if (input.trim() === "/exit") { requestExit(exit, 0); return; }
      queue = queue.then(() => turn(input)).catch(error => { fail(error); });
    });
    reader.on("close", () => {
      if (closed || eof) return;
      eof = true;
      void queue.then(() => { if (!closed) requestExit(exit, 0); });
    });
  }
  return {
    apply(ctx) {
      const exit = ctx.get("appExit");
      if (typeof exit !== "function") throw new Error("DSH terminal requires appExit");
      ctx.effect(() => () => {
        closed = true;
        stopHeartbeat();
        reader?.close();
        restoreInputSettings();
      });
      // Deliberately detached: stdin lifetime must never hold Loader settlement.
      void start(ctx, exit).catch(error => { fail(error, exit); });
    },
  };
}
`;

export const dshTerminalSource = String.raw`import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
function configureInput() {
  if (!process.stdin.isTTY) return () => {};
  const options = { stdio: [process.stdin.fd, "pipe", "pipe"], encoding: "utf8" };
  const stty = (args) => {
    const result = spawnSync("stty", args, options);
    if (result.error || result.status !== 0) throw new Error("terminal input configuration failed");
    return result.stdout.trim();
  };
  const previous = stty(["-g"]);
  if (!previous) throw new Error("terminal input configuration is unavailable");
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stty([previous]);
  };
  try { stty(["-echo"]); }
  catch (error) { try { restore(); } catch {} throw error; }
  return restore;
}
// The plugin lives in ahelpa's result directory, outside DSH's package tree.
// Resolve from the real CLI, then from the headless package that declares
// these dependencies; this also works with pnpm's non-hoisted installation.
const cliRequire = createRequire(realpathSync(process.argv[1]));
const headlessRequire = createRequire(cliRequire.resolve("@deepseek-ai/dsh-headless"));
const [{ installModelSelection }, { createUserMessage }] = await Promise.all([
  import(pathToFileURL(headlessRequire.resolve("@deepseek-ai/dsh-agent")).href),
  import(pathToFileURL(headlessRequire.resolve("@deepseek-ai/dsh-llm")).href),
]);
${dshTerminalFactorySource}
export const name = "ahelpa-dsh-terminal";
export const inject = ["agentDefaultModel", "agents", "sessions"];
const terminal = createDshTerminal({ createInterface, randomUUID, installModelSelection, createUserMessage, configureInput,
  env: process.env, stdin: process.stdin, stdout: process.stdout, cwd: () => process.cwd(), setInterval, clearInterval });
export function apply(ctx) { terminal.apply(ctx); }
`;
