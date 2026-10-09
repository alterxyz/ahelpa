import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { deliverTurn } from "../src/turn-delivery";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import * as daemon from "../src/daemon";
import { executeLaunch, planLaunch } from "../src/commands/launch";
import { send, sendTask, kill } from "../src/commands/session-ops";
import { getDriver } from "../src/drivers/registry";
import { inputDigest, writeTurnHook } from "../src/turn-hooks";
import { defaultWakeup } from "../src/wakeup";
import { defaultRuntimeLayout } from "../src/runtime-layout";

let root: string, dir: string, db: StateDB;
const initial = "Please read and complete the task described in fixture";
const pane = readFileSync(join(import.meta.dir, "fixtures/turn-hooks/claude-completed.txt"), "utf8");
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".ahelpa", "delivery-test-"));
  dir = join(root, ".ahelpa", "session-test");
  mkdirSync(dir, { recursive: true });
  mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
  db = new StateDB(join(root, "state.db"));
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "capture").mockResolvedValue("✻ Working…\nWorking (1s • esc to interrupt)");
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
});
afterEach(() => {
  mock.restore(); defaultWakeup.cleanup("session-test");
  for (const row of db.listSessions()) {
    rmSync(defaultRuntimeLayout.taskFilePath(row.id), { force: true });
  }
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function seed(agent = "claude-code") {
  const row = db.createSession({ id: "session-test", parentId: "host", agentType: agent, task: "fixture", ownerToken: "tok", projectPath: root });
  db.beginTurn(row.id, row.version, initial);
}
function prompt(input: string, key: string) {
  writeTurnHook(dir, "claude-code", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native", prompt_id: key, prompt: input }));
}
function stop(key: string, failure = false) {
  writeTurnHook(dir, "claude-code", JSON.stringify({ hook_event_name: failure ? "StopFailure" : "Stop", session_id: "native", prompt_id: key, error: "authentication_failed" }));
}

for (const duration of ["0s", "0.0s", "7s", "1m 7s", "1h 2m 3s", "1d 1h 1m"]) {
  test(`completed elapsed ${duration} can nudge; ellipsis, interrupt and spinner still veto`, async () => {
    seed(); prompt(initial, "current"); stop("current");
    writeFileSync(join(dir, "summary.md"), "done");
    const screen = pane.replace("7s · done", `${duration} · done`);
    const driver = getDriver("claude-code");
    expect(driver.acceptsInputAfterTurn!(screen)).toBe(true);
    expect(driver.acceptsInputAfterTurn!(screen.replace("Crunched for", "Crunched… for"))).toBe(false);
    expect(driver.acceptsInputAfterTurn!(screen + "\nesc to interrupt")).toBe(false);
    expect(driver.acceptsInputAfterTurn!("✻ Working\n" + screen)).toBe(false);
    spyOn(Tmux, "capture").mockResolvedValue(screen);
    await daemon.refreshSessionStatuses(db, ["session-test"]);
    expect(Tmux.sendKeys).toHaveBeenCalledWith("session-test", daemon.COMPLETION_NUDGE);
  });
}

for (const hook of [true, false]) {
  test(`${hook ? "hook" : "idle"} completion nudge registers its own turn before send and attributes StopFailure`, async () => {
    seed();
    if (hook) { prompt(initial, "original"); stop("original"); }
    writeFileSync(join(dir, "summary.md"), "written");
    spyOn(Tmux, "capture").mockResolvedValue(hook ? pane : "Reply ended\n❯ \n");
    spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
      expect(db.getSession("session-test")?.turnInputDigest).toBe(inputDigest(text));
      prompt(text, "nudge"); stop("nudge", true);
    });
    for (let i = 0; i < (hook ? 1 : 4); i++) await daemon.refreshSessionStatuses(db, ["session-test"]);
    expect(Tmux.sendKeys).toHaveBeenCalledWith("session-test", daemon.COMPLETION_NUDGE);
    spyOn(Tmux, "capture").mockResolvedValue("⏺ Failure while responding to the completion request\n❯ \n");
    await daemon.refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("needs_attention");
  });
  test(`${hook ? "hook" : "idle"} failed nudge restores registration and can retry`, async () => {
    seed();
    if (hook) { prompt(initial, "original"); stop("original"); }
    writeFileSync(join(dir, "summary.md"), "written");
    const before = db.getSession("session-test")!;
    spyOn(Tmux, "capture").mockResolvedValue(hook ? pane : "Reply ended\n❯ \n");
    spyOn(Tmux, "sendKeys").mockRejectedValue(new Error("tmux delivery failed"));
    for (let i = 0; i < (hook ? 1 : 4); i++) await daemon.refreshSessionStatuses(db, ["session-test"]);
    const failed = db.getSession("session-test")!;
    expect(failed.turnStartedAt).toBe(before.turnStartedAt);
    expect(failed.turnInputDigest).toBe(before.turnInputDigest);
    expect(failed.turnHookOffset).toBe(before.turnHookOffset);
    expect(failed.nudgedAt).toBeNull();
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    for (let i = 0; i < (hook ? 1 : 4); i++) await daemon.refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.turnInputDigest).toBe(inputDigest(daemon.COMPLETION_NUDGE));
    expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(false);
  });
}

test("literal-envelope-collision ignores delayed old prompt/Stop and retains inactivity fallback across reopen", async () => {
  seed();
  const body = "current plain task";
  const literal = '<pasted_content id="abcd">\n' + body + '\n</pasted_content id="abcd">';
  await send(db, "session-test", "tok", literal);
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
  await send(db, "session-test", "tok", body);
  db.close(); db = new StateDB(join(root, "state.db"));
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
  await Bun.sleep(3); prompt(literal, "old-literal"); stop("old-literal");
  await daemon.refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
  spyOn(Tmux, "capture").mockResolvedValue("Reply ended\n❯ \n");
  for (let i = 0; i < 3; i++) {
    await daemon.refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("running");
  }
  await daemon.refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
});

test.each(["<pasted_content id=\"abcd\">literal", "partial </pasted_content>"])("literal markup %s conservatively disables hooks", async input => {
  seed(); await send(db, "session-test", "tok", input);
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
});

for (const operation of ["send", "task"]) {
  for (const status of ["running", "needs_attention"] as const) {
    test(`${operation} in ${status}: failed send restores prior turn and history`, async () => {
      seed("codex"); if (status !== "running") db.updateStatus("session-test", status);
      const before = db.getSession("session-test")!;
      const file = join(root, "next.md"); writeFileSync(file, "next task");
      let submitted = "";
      spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
        submitted = text;
        expect(db.getSession("session-test")?.turnInputDigest).toBe(inputDigest(text));
        throw new Error("send failed");
      });
      await expect(operation === "send" ? send(db, "session-test", "tok", "new A") : sendTask(db, "session-test", "tok", file)).rejects.toThrow("send failed");
      expect(db.getSession("session-test")?.turnStartedAt).toBe(before.turnStartedAt);
      expect(db.getSession("session-test")?.turnInputDigest).toBe(before.turnInputDigest);
      expect(db.getSession("session-test")?.status).toBe(status);
      spyOn(Tmux, "sendKeys").mockResolvedValue();
      spyOn(getDriver("codex"), "afterTaskSubmitted").mockResolvedValue(true);
      await send(db, "session-test", "tok", submitted);
      expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(false);
    });
  }
}

test.each(["running", "needs_attention"] as const)("overlapping sends in %s register B across connections and ignore both hooks until a clean turn", async status => {
  seed("codex");
  writeTurnHook(dir, "codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "main", "turn-id": "bind", "input-messages": [initial] }));
  if (status !== "running") db.updateStatus("session-test", status);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const pending = new Promise<void>(resolve => started = resolve);
  spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => { if (text === "new A") { started(); await gate; } });
  spyOn(getDriver("codex"), "afterTaskSubmitted").mockResolvedValue(true);
  const other = new StateDB(join(root, "state.db"));
  const a = send(db, "session-test", "tok", "new A");
  try {
    await pending;
    await send(other, "session-test", "tok", "new B");
    expect(Tmux.sendKeys).toHaveBeenCalledTimes(2);
    expect(other.getSession("session-test")?.turnInputDigest).toBe(inputDigest("new B"));
    expect(other.getSession("session-test")?.turnInputAmbiguous).toBe(true);
    // Even B's matching event cannot take the fast path while A is sending.
    writeTurnHook(dir, "codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "main", "turn-id": "B", "input-messages": [initial, "new B"] }));
    await daemon.refreshSessionStatuses(other, ["session-test"]);
    expect(other.getSession("session-test")?.status).toBe("running");
  } finally { release(); await a; other.close(); }
  db.close(); db = new StateDB(join(root, "state.db"));
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
  writeTurnHook(dir, "codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "main", "turn-id": "delayed-A", "input-messages": [initial, "new A"] }));
  expect(db.getSession("session-test")?.turnInputDigest).toBe(inputDigest("new B"));
  await daemon.refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
  spyOn(Tmux, "capture").mockResolvedValue("Ready\n› ");
  for (let i = 0; i < 4; i++) await daemon.refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
  await send(db, "session-test", "tok", "clean C");
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(false);
  writeTurnHook(dir, "codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "main", "turn-id": "C", "input-messages": [initial, "clean C"] }));
  await daemon.refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
});

test("stale registration CAS still sends and persists ambiguity", async () => {
  seed(); const snapshot = db.getSession("session-test")!;
  await send(db, "session-test", "tok", "newer registration");
  const transport = mock(async () => {});
  await deliverTurn(db, snapshot, "stale snapshot input", transport);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(db.getSession("session-test")?.turnInputDigest).toBe(inputDigest("stale snapshot input"));
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
  prompt("stale snapshot input", "stale"); stop("stale", true);
  await daemon.refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
});

test.each([false, true])("overlap preserves ambiguity when A succeeds/fails after B fails (A fails=%s)", async failA => {
  seed();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), pending = new Promise<void>(resolve => started = resolve);
  spyOn(Tmux, "sendKeys").mockImplementation(async (_id, input) => {
    if (input === "A") { started(); await gate; if (failA) throw new Error("A failed"); }
    if (input === "B") throw new Error("B failed");
  });
  const a = send(db, "session-test", "tok", "A");
  const observedA = a.catch(error => error);
  await pending;
  await expect(send(db, "session-test", "tok", "B")).rejects.toThrow("B failed");
  release(); const result = await observedA;
  if (failA) expect(result.message).toBe("A failed");
  else expect(result).toBeUndefined();
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
});

test.each(["prepare", "send", "confirmation"])("exception during %s leaves a usable registration", async phase => {
  seed(); const before = db.getSession("session-test")!;
  await expect(deliverTurn(db, before, "new input", async () => { if (phase === "send") throw new Error(phase); }, {
    prepare: async () => { if (phase === "prepare") throw new Error(phase); },
    afterSend: async () => { if (phase === "confirmation") throw new Error(phase); },
  })).rejects.toThrow(phase);
  expect(db.getSession("session-test")?.turnInputDigest).toBe(inputDigest(phase === "confirmation" ? "new input" : initial));
  await send(db, "session-test", "tok", "unique retry");
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(false);
});

test("failed A after successful B cannot restore A over B", async () => {
  seed(); const a = db.registerTurn("session-test", db.getSession("session-test")!.version, "A");
  await send(db, "session-test", "tok", "B");
  db.finishTurn(a, false);
  db.close(); db = new StateDB(join(root, "state.db"));
  expect(db.getSession("session-test")?.turnInputDigest).toBe(inputDigest("B"));
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
});

test("an unconfirmed delivery cannot bypass the launch lease or block kill", async () => {
  const row = db.createSession({ id: "session-test", parentId: "host", agentType: "codex", task: "fixture", ownerToken: "tok", projectPath: root, launchPid: process.pid });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => release = r), pending = new Promise<void>(r => started = r);
  const delivery = deliverTurn(db, row, "startup input", async () => { started(); await gate; });
  try {
    await pending;
    const raw = new Database(join(root, "state.db"));
    raw.prepare("UPDATE sessions SET created_at=? WHERE id=?").run(new Date(Date.now() - 181_000).toISOString(), row.id); raw.close();
    await daemon.refreshSessionStatuses(db, [row.id]);
    expect(db.getSession(row.id)?.launchPid).toBeNull();
    expect(db.completeLaunch(row.id, process.pid)).toBe(false);
    expect(Tmux.hasSession).toHaveBeenCalled();
    spyOn(Tmux, "kill").mockResolvedValue();
    await kill(db, row.id, "tok");
    expect(Tmux.kill).toHaveBeenCalledTimes(1);
  } finally { release(); await delivery; }
  expect(db.getSession(row.id)?.status).toBe("dead");
});

for (const hook of [true, false]) {
  test(`${hook ? "hook" : "idle"} nudge can overlap a host task without refusal`, async () => {
    seed();
    if (hook) { prompt(initial, "original"); stop("original"); }
    writeFileSync(join(dir, "summary.md"), "written");
    writeFileSync(join(root, "next.md"), "host follow-up");
    spyOn(Tmux, "capture").mockResolvedValue(hook ? pane : "Reply ended\n❯ \n");
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => release = r), pending = new Promise<void>(r => started = r);
    spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
      if (text === daemon.COMPLETION_NUDGE) { started(); await gate; }
    });
    if (!hook) for (let i = 0; i < 3; i++) await daemon.refreshSessionStatuses(db, ["session-test"]);
    const nudge = daemon.refreshSessionStatuses(db, ["session-test"]);
    try {
      await pending;
      await sendTask(db, "session-test", "tok", join(root, "next.md"));
      expect(readFileSync(join(dir, "task.md"), "utf8")).toContain("host follow-up");
      expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
      expect(Tmux.sendKeys).toHaveBeenCalledTimes(2);
    } finally { release(); await nudge; }
    prompt(daemon.COMPLETION_NUDGE, "old-nudge"); stop("old-nudge", true);
    await daemon.refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("running");
  });
}

test("obsolete persisted delivery token is ignored across reopen, send and refresh", async () => {
  seed();
  const raw = new Database(join(root, "state.db"));
  if (!(raw.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).some(column => column.name === "turn_delivery_token")) {
    raw.exec("ALTER TABLE sessions ADD COLUMN turn_delivery_token TEXT");
  }
  raw.prepare("UPDATE sessions SET turn_delivery_token=? WHERE id=?")
    .run(JSON.stringify({ nonce: "obsolete", pid: process.pid }), "session-test");
  raw.close(); db.close(); db = new StateDB(join(root, "state.db"));
  await send(db, "session-test", "tok", "clean delivery after upgrade");
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(false);
  prompt("clean delivery after upgrade", "upgraded"); stop("upgraded", true);
  await daemon.refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
});

for (const agent of ["claude-code", "codex", "kimi"]) {
  test(`${agent} launch registers before send and allows overlapping follow-up during confirmation`, async () => {
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(defaultWakeup, "prepare").mockResolvedValue();
    spyOn(getDriver(agent), "prepareForTask").mockResolvedValue();
    spyOn(Tmux, "sendKeys").mockImplementation(async (id, text) => {
      expect(db.getSession(id)?.turnInputDigest).toBe(inputDigest(text));
    });
    spyOn(getDriver(agent), "afterTaskSubmitted").mockImplementation(async id => {
      const row = db.getSession(id)!;
      await send(db, id, row.ownerToken, "overlapping follow-up");
      expect(db.getSession(id)?.turnInputDigest).toBe(inputDigest("overlapping follow-up"));
      return true;
    });
    const result = await executeLaunch(planLaunch({ db, agentType: agent, task: "fixture", projectPath: root, parentId: "host" }));
    expect(db.getSession(result.sessionId)?.status).toBe("running");
  });
}
