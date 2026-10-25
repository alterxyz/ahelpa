import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dshTerminalFactorySource, dshTerminalSource } from "../src/drivers/dsh-terminal-source";

interface Event { type: string; seq: number; data: any; }
interface NativeSession { id: string; header: Record<string, unknown>; seq: number; eventAt(seq: number): Event | undefined; }
type Turn = (fixture: Fixture, input: string, index: number) => void | Promise<void>;

const factory = new Function(`${dshTerminalFactorySource}\nreturn createDshTerminal;`)();
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class Fixture {
  stdin = new PassThrough();
  output = "";
  inputs: string[] = [];
  exits: number[] = [];
  flushed: string[] = [];
  observationsDisposed = 0;
  inputConfigurations: Array<{ output: string; readers: number }> = [];
  inputRestored = 0;
  created = 0;
  resumed = 0;
  readers = 0;
  timerId = 0;
  timers = new Map<number, () => void>();
  selections: any[] = [];
  agentOptions: any[] = [];
  records: Event[] = [];
  disposers: Array<() => void> = [];
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  native: NativeSession = { id: "session-native", header: { cwd: "/project" }, seq: 0, eventAt: (seq: number) => this.records[seq] };
  agent: any;
  services: Record<string, any>;
  plugin: any;
  ctx: any;
  flushBarrier: Promise<void> | undefined;
  behavior: Turn;

  constructor(options: { defaultModel?: { provider: string; model: string; reasoningEffort: string }; env?: Record<string, string>; behavior?: Turn; header?: Record<string, unknown>; loader?: Promise<void>; missingResume?: boolean; configureInput?: () => () => void } = {}) {
    // The getter belongs to this fixture rather than a module-global session.
    Object.defineProperty(this.native, "seq", { get: () => this.records.length });
    this.native.header = options.header ?? { cwd: "/project" };
    this.behavior = options.behavior ?? ((fixture, _input, index) => { fixture.assistant(`turn ${index}\n[AHELPA:DONE]`); fixture.terminal("completed"); });
    let idle: Promise<void> = Promise.resolve();
    this.agent = {
      session: this.native, status: "idle", ctx: {},
      followup: (message: any) => {
        const input = message.content[0].text;
        this.inputs.push(input);
        this.agent.status = "running";
        this.append("turn/start", {});
        this.append("user/message", { message });
        idle = Promise.resolve().then(() => this.behavior(this, input, this.inputs.length))
          .finally(() => { this.agent.status = "idle"; });
      },
      whenIdle: () => idle,
    };
    const handle = { agent: this.agent };
    this.services = {
      appExit: (code: number) => { this.exits.push(code); },
      loader: { await: () => options.loader ?? Promise.resolve() },
      agentDefaultModel: { currentSelection: () => options.defaultModel ?? ({ provider: "deepseek-official", model: "native-default", reasoningEffort: "high" }) },
      sessionPersistence: {},
      sessions: { flush: async (session: NativeSession) => { await this.flushBarrier; this.flushed.push(session.id); } },
      agents: {
        get: () => undefined,
        create: async (opts: any) => { this.created++; this.agentOptions.push(opts.agentOptions); this.native.id = opts.sessionId; opts.setup(this.agent.ctx, this.agent); return handle; },
        resume: async (opts: any) => { this.resumed++; this.agentOptions.push(opts.agentOptions); this.native.id = opts.resumeSessionId; opts.setup(this.agent.ctx, this.agent); return handle; },
      },
      sessionQuery: {
        observeSession: async () => {
          if (options.missingResume) throw { code: "SESSION_QUERY_SESSION_NOT_FOUND", message: "fixture-secret" };
          return { header: this.native.header, events: [...this.records], [Symbol.dispose]: () => { this.observationsDisposed++; } };
        },
      },
    };
    this.ctx = {
      get: (name: string) => this.services[name],
      effect: (effect: () => () => void) => { this.disposers.push(effect()); },
      on: (name: string, listener: (...args: any[]) => void) => {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener); this.listeners.set(name, listeners);
        return () => { listeners.delete(listener); };
      },
    };
    this.plugin = factory({
      createInterface: (opts: any) => { this.readers++; return createInterface(opts); },
      randomUUID: () => `00000000-0000-4000-8000-${String(++this.timerId).padStart(12, "0")}`,
      createUserMessage: (value: any) => value,
      installModelSelection: (_ctx: any, selection: any) => { this.selections.push(selection); },
      configureInput: () => {
        this.inputConfigurations.push({ output: this.output, readers: this.readers });
        const restore = options.configureInput?.() ?? (() => {});
        return () => { this.inputRestored++; restore(); };
      },
      env: options.env ?? {}, stdin: this.stdin,
      stdout: { write: (value: string) => { this.output += value; } }, cwd: () => "/project",
      setInterval: (callback: () => void, ms: number) => { expect(ms).toBe(3000); const id = ++this.timerId; this.timers.set(id, callback); return id; },
      clearInterval: (id: number) => { this.timers.delete(id); },
    });
    cleanup.push(() => { for (const dispose of this.disposers) dispose(); this.stdin.destroy(); });
  }

  append(type: string, data: any) {
    const event = { type, data, seq: this.records.length };
    this.records.push(event);
    this.emit("session/event", this.native, event);
  }
  assistant(text: string) { this.append("assistant/message", { message: { content: [{ type: "text", text }] } }); }
  terminal(kind: string) { this.append("turn/end", { reason: { kind } }); }
  emit(name: string, ...args: any[]) { for (const listener of this.listeners.get(name) ?? []) listener(...args); }
  line(text: string) { this.stdin.write(`${text}\n`); }
  mount() { return this.plugin.apply(this.ctx); }
  states() { return [...this.output.matchAll(/^\[AHELPA_DSH_STATE:(\w+)\]$/gm)].map(match => match[1]); }
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("terminal fixture did not settle");
    await Bun.sleep(1);
  }
}

describe("DSH persistent terminal app", () => {
  test("the generated ESM resolves DSH dependencies from a symlinked CLI with non-hoisted packages", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-dsh-terminal-"));
    cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
    const cli = join(root, "installation", "bin", "dsh.mjs");
    const headless = join(root, "installation", "node_modules", "@deepseek-ai", "dsh-headless");
    const plugin = join(root, "separate results", "terminal.mjs");
    const launcher = join(root, "bin", "dsh.mjs");
    for (const path of [join(root, "installation", "bin"), headless, join(root, "separate results"), join(root, "bin")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(headless, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-headless", exports: "./index.mjs" }));
    writeFileSync(join(headless, "index.mjs"), "export {};\n");
    for (const [name, source] of [
      ["dsh-agent", "export function installModelSelection() {}\n"],
      ["dsh-llm", "export function createUserMessage(value) { return value; }\n"],
    ]) {
      const directory = join(headless, "node_modules", "@deepseek-ai", name!);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, exports: "./index.mjs" }));
      writeFileSync(join(directory, "index.mjs"), source!);
    }
    writeFileSync(plugin, dshTerminalSource);
    writeFileSync(cli, `import { pathToFileURL } from "node:url";\nconst plugin = await import(pathToFileURL(process.argv[2]).href);\nconsole.log(JSON.stringify({ name: plugin.name, inject: plugin.inject, apply: typeof plugin.apply }));\n`);
    symlinkSync(cli, launcher);
    const child = Bun.spawn([process.execPath, launcher, plugin], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ name: "ahelpa-dsh-terminal", inject: ["agentDefaultModel", "agents", "sessions"], apply: "function" });
  });

  test("mount does not occupy Loader settlement; stdin begins after services settle", async () => {
    const loader = deferred();
    const fixture = new Fixture({ loader: loader.promise });
    expect(fixture.mount()).toBeUndefined();
    expect(fixture.readers).toBe(0);
    expect(fixture.created).toBe(0);
    loader.resolve();
    await until(() => fixture.states().includes("ready"));
    expect(fixture.flushed).toHaveLength(1);
    expect(fixture.readers).toBe(1);
    expect(dshTerminalSource).toContain('export const inject = ["agentDefaultModel", "agents", "sessions"]');
  });

  test.each(["exit", "eof", "shutdown"] as const)("input echo is configured before readiness and restored once on %s", async mode => {
    const fixture = new Fixture(); fixture.mount(); await until(() => fixture.readers === 1);
    expect(fixture.inputConfigurations).toHaveLength(1);
    expect(fixture.inputConfigurations[0]!.readers).toBe(0);
    expect(fixture.inputConfigurations[0]!.output).not.toContain("[AHELPA_DSH_STATE:ready]");
    expect(fixture.inputRestored).toBe(0);
    if (mode === "exit") fixture.line("/exit");
    else if (mode === "eof") fixture.stdin.end();
    else for (const dispose of fixture.disposers) dispose();
    await until(() => fixture.inputRestored === 1);
    for (const dispose of fixture.disposers) dispose();
    expect(fixture.inputRestored).toBe(1);
    expect(fixture.exits).toEqual(mode === "shutdown" ? [] : [0]);
  });

  test("an input configuration failure aborts startup before readiness without exposing the cause", async () => {
    const fixture = new Fixture({ configureInput: () => { throw new Error("fixture-secret"); } });
    fixture.mount(); await until(() => fixture.exits.length === 1);
    expect(fixture.readers).toBe(0);
    expect(fixture.states()).toEqual(["error"]);
    expect(fixture.exits).toEqual([1]);
    expect(fixture.output).toContain("cannot disable terminal input echo");
    expect(fixture.output).not.toContain("fixture-secret");
  });

  test("two queued turns share one native Session and publish only after persistence", async () => {
    const first = deferred();
    const fixture = new Fixture({ behavior: async (run, _input, index) => {
      if (index === 1) await first.promise;
      run.assistant(`answer ${index}\n[AHELPA:DONE]`); run.terminal("completed");
    } });
    fixture.mount(); await until(() => fixture.readers === 1);
    fixture.line("first"); fixture.line("second");
    await until(() => fixture.inputs.length === 1);
    expect(fixture.created).toBe(1);
    for (const pulse of fixture.timers.values()) pulse();
    expect(fixture.states().at(-1)).toBe("running");
    const flush = deferred(); fixture.flushBarrier = flush.promise;
    first.resolve(); await Bun.sleep(1);
    expect(fixture.states()).not.toContain("idle");
    expect(fixture.inputs).toEqual(["first"]);
    flush.resolve();
    await until(() => fixture.states().filter(state => state === "idle").length === 2);
    expect(fixture.inputs).toEqual(["first", "second"]);
    expect(fixture.created).toBe(1); expect(fixture.resumed).toBe(0);
    expect(new Set(fixture.flushed).size).toBe(1);
    expect(fixture.flushed).toHaveLength(3);
    expect(fixture.timers.size).toBe(0);
    const turns = [...fixture.output.matchAll(/^\[AHELPA_DSH_TURN:([^\]]+)\]$/gm)].map(match => match[1]);
    expect(new Set(turns).size).toBe(2);
    fixture.line("/exit"); await until(() => fixture.exits.length === 1);
    expect(fixture.exits).toEqual([0]); expect(fixture.timers.size).toBe(0);
  });

  test.each([
    { header: { cwd: "/other" }, expected: "working directory" },
    { header: {}, expected: "working directory" },
    { header: { cwd: "/project", agentPreset: "coding" }, expected: "preset" },
    { header: { cwd: "/project", origin: "subagent" }, expected: "subagent" },
    { header: { cwd: "/project", parentSession: "parent" }, expected: "forked" },
  ])("resume rejects incompatible native history: $expected", async ({ header, expected }) => {
    const fixture = new Fixture({ env: { AHELPA_DSH_RESUME_ID: "session-existing" }, header });
    fixture.mount(); await until(() => fixture.exits.length > 0);
    expect(fixture.created).toBe(0); expect(fixture.resumed).toBe(0);
    expect(fixture.output).toContain(expected); expect(fixture.states()).toEqual(["error"]);
    expect(fixture.exits).toEqual([1]); expect(fixture.observationsDisposed).toBe(1);
  });

  test("a missing resume id fails without creating a substitute or exposing exception text", async () => {
    const fixture = new Fixture({ env: { AHELPA_DSH_RESUME_ID: "session-missing" }, missingResume: true });
    fixture.mount(); await until(() => fixture.exits.length > 0);
    expect(fixture.created).toBe(0); expect(fixture.resumed).toBe(0);
    expect(fixture.output).toContain("does not exist"); expect(fixture.output).not.toContain("fixture-secret");
  });

  test.each([undefined, "", " \t "])("a non-official default provider reaches ready with provider override %s", async provider => {
    const defaults = { provider: "magpie", model: "deepseek/deepseek-flash", reasoningEffort: "high" };
    const fixture = new Fixture({ defaultModel: defaults, env: provider === undefined ? {} : { AHELPA_DSH_PROVIDER: provider } });
    fixture.mount();
    await until(() => fixture.states().includes("ready"));
    expect(fixture.selections[0].current).toEqual(defaults);
    expect(fixture.agentOptions[0]).toMatchObject({ provider: "magpie", model: "deepseek/deepseek-flash" });
  });

  test.each([false, true])("provider override reaches native Agent on resume=%s", async resume => {
    const fixture = new Fixture({ env: {
      AHELPA_DSH_PROVIDER: "magpie", AHELPA_DSH_MODEL: "deepseek/deepseek-flash",
      ...(resume ? { AHELPA_DSH_RESUME_ID: "session-existing" } : {}),
    } });
    fixture.mount();
    await until(() => fixture.states().includes("ready"));
    expect(fixture.selections[0].current.provider).toBe("magpie");
    expect(fixture.agentOptions[0]).toMatchObject({ provider: "magpie", model: "deepseek/deepseek-flash" });
    expect(fixture.resumed).toBe(resume ? 1 : 0);
  });

  test("resume rechecks the leased log, and model/effort only alter the selected Agent", async () => {
    const fixture = new Fixture({ env: { AHELPA_DSH_RESUME_ID: "session-existing", AHELPA_DSH_MODEL: "deepseek-v4-pro", AHELPA_DSH_EFFORT: "max" } });
    fixture.mount(); await until(() => fixture.readers === 1);
    expect(fixture.created).toBe(0); expect(fixture.resumed).toBe(1);
    expect(fixture.selections[0].current).toEqual({ provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" });
    expect(fixture.observationsDisposed).toBe(1);

    const raced = new Fixture({ env: { AHELPA_DSH_RESUME_ID: "session-raced" } });
    raced.services.agents.resume = async (options: any) => {
      raced.append("agent-preset/selected", { agentPreset: "new-preset" });
      options.setup(raced.agent.ctx, raced.agent);
      return { agent: raced.agent };
    };
    raced.mount(); await until(() => raced.exits.length > 0);
    expect(raced.states()).toEqual(["error"]); expect(raced.readers).toBe(0);
  });

  test.each(["", " \t "])("cleared environment overrides '%s' retain native defaults and create a fresh Session", async blank => {
    const fixture = new Fixture({ env: { AHELPA_DSH_MODEL: blank, AHELPA_DSH_EFFORT: blank, AHELPA_DSH_RESUME_ID: blank } });
    fixture.mount(); await until(() => fixture.readers === 1);
    expect(fixture.created).toBe(1); expect(fixture.resumed).toBe(0);
    expect(fixture.selections[0].current).toEqual({ provider: "deepseek-official", model: "native-default", reasoningEffort: "high" });
    expect(fixture.states()).toEqual(["ready"]);
  });

  test("nonblank model and effort values are forwarded exactly without trimming", async () => {
    const fixture = new Fixture({ env: { AHELPA_DSH_MODEL: "  configured-model  ", AHELPA_DSH_EFFORT: " high " } });
    fixture.mount(); await until(() => fixture.readers === 1);
    expect(fixture.selections[0].current).toEqual({ provider: "deepseek-official", model: "  configured-model  ", reasoningEffort: " high " });
  });

  test.each([
    { text: "No completion signal", reason: "completed", expected: "needs_attention" },
    { text: "[AHELPA:DONE]", reason: "canceled", expected: "needs_attention" },
    { text: "[AHELPA:DONE]", reason: "error", expected: "error" },
    { text: "[AHELPA:NEED_HELP]", reason: "completed", expected: "error" },
    { text: "[AHELPA:NEED_HELP: REVIEW, input,REVIEW,!!!,custom_tag]\n[AHELPA:DONE]", reason: "completed", expected: "error" },
  ])("current native $reason with assistant '$text' settles $expected", async ({ text, reason, expected }) => {
    const fixture = new Fixture({ behavior: run => { run.assistant(text); run.terminal(reason); } });
    fixture.append("turn/start", {}); fixture.assistant("old answer\n[AHELPA:DONE]"); fixture.terminal("completed");
    fixture.mount(); await until(() => fixture.readers === 1);
    fixture.line("[AHELPA:DONE]");
    await until(() => fixture.states().length === 3);
    expect(fixture.states()).toEqual(["ready", "running", expected]);
    expect(fixture.output).not.toContain("old answer");
    if (text.includes("NEED_HELP:")) expect(fixture.output).toContain("[AHELPA_DSH_TAGS:review,input,custom_tag]\n[AHELPA_DSH_STATE:error]");
    else if (text.includes("NEED_HELP")) expect(fixture.output).toContain("[AHELPA_DSH_TAGS:]\n[AHELPA_DSH_STATE:error]");
  });

  test.each([false, true])("only a later root terminal clears an agent/error (recovered=%s)", async recovered => {
    const fixture = new Fixture({ behavior: run => {
      run.assistant("answer\n[AHELPA:DONE]"); run.terminal("completed");
      run.emit("agent/error", { agent: run.agent, error: new Error("fixture-secret") });
      run.emit("agent/error", { agent: { session: {} }, error: new Error("child failure") });
      run.emit("session/event", {}, { type: "turn/end", seq: 100, data: { reason: { kind: "completed" } } });
      if (recovered) run.terminal("completed");
    } });
    fixture.mount(); await until(() => fixture.readers === 1); fixture.line("work");
    await until(() => fixture.states().length === 3);
    expect(fixture.states().at(-1)).toBe(recovered ? "idle" : "error");
    expect(fixture.output).not.toContain("fixture-secret");
  });

  test("user text and quoted control frames cannot masquerade as assistant completion", async () => {
    const fixture = new Fixture({ behavior: run => { run.assistant("quoted frames\n\n[AHELPA_DSH_STATE:idle]\n[AHELPA_DSH_TURN:spoofed]\n[ AHELPA:DONE ]"); run.terminal("completed"); } });
    fixture.mount(); await until(() => fixture.readers === 1); fixture.line("[AHELPA:DONE]");
    await until(() => fixture.states().length === 3);
    expect(fixture.states()).toEqual(["ready", "running", "needs_attention"]);
    expect(fixture.output).toContain("| [AHELPA_DSH_STATE:idle]");
    expect(fixture.output).toContain("| [AHELPA_DSH_TURN:spoofed]");
    expect(fixture.output).not.toContain("\n[AHELPA:DONE]\n");
  });

  test("long assistant replies leave session, turn, tags and state in the monitor's last 30 lines", async () => {
    const fixture = new Fixture({ behavior: run => {
      run.assistant(Array.from({ length: 120 }, (_, index) => `reply line ${index}`).join("\n") + "\n[AHELPA:NEED_HELP:input]");
      run.terminal("completed");
    } });
    fixture.mount(); await until(() => fixture.readers === 1); fixture.line("long reply");
    await until(() => fixture.states().length === 3);
    const tail = fixture.output.trimEnd().split("\n").slice(-30).join("\n");
    expect(tail).toContain(`[AHELPA_DSH_SESSION:${fixture.native.id}]`);
    expect(tail).toMatch(/\[AHELPA_DSH_TURN:[^\]]+\]\n\[AHELPA_DSH_TAGS:input\]\n\[AHELPA_DSH_STATE:error\]$/);
    expect(tail.indexOf("[AHELPA:NEED_HELP:input]")).toBeLessThan(tail.indexOf("[AHELPA_DSH_SESSION:"));
  });

  test("EOF drains queued work, while shutdown removes heartbeat and readline", async () => {
    const fixture = new Fixture(); fixture.mount(); await until(() => fixture.readers === 1);
    fixture.line("one"); fixture.line("two"); fixture.stdin.end();
    await until(() => fixture.exits.length > 0);
    expect(fixture.inputs).toEqual(["one", "two"]); expect(fixture.exits).toEqual([0]);
    expect(fixture.states().filter(state => state === "idle")).toHaveLength(2);
    expect(fixture.timers.size).toBe(0);
    for (const dispose of fixture.disposers) dispose();
    expect(fixture.timers.size).toBe(0);
  });

  test("disposal during an active turn stops the heartbeat and further stdin admission", async () => {
    const blocked = deferred();
    const fixture = new Fixture({ behavior: async run => { await blocked.promise; run.assistant("[AHELPA:DONE]"); run.terminal("completed"); } });
    fixture.mount(); await until(() => fixture.readers === 1); fixture.line("active");
    await until(() => fixture.timers.size === 1);
    for (const dispose of fixture.disposers) dispose();
    expect(fixture.timers.size).toBe(0);
    fixture.line("must not run"); blocked.resolve(); await Bun.sleep(1);
    expect(fixture.inputs).toEqual(["active"]);
    expect(fixture.states()).toEqual(["ready", "running"]);
  });
});
