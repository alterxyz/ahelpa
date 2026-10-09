import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import * as daemon from "../src/daemon";
import { executeLaunch, planLaunch } from "../src/commands/launch";
import { send, sendTask } from "../src/commands/session-ops";
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

test("overlapping send A/B rearm is refused across DB connections; later B registers and ignores delayed A", async () => {
  seed("codex");
  writeTurnHook(dir, "codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "main", "turn-id": "bind", "input-messages": [initial] }));
  db.updateStatus("session-test", "needs_attention");
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const pending = new Promise<void>(resolve => started = resolve);
  spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => { if (text === "new A") { started(); await gate; } });
  spyOn(getDriver("codex"), "afterTaskSubmitted").mockResolvedValue(true);
  const other = new StateDB(join(root, "state.db"));
  const a = send(db, "session-test", "tok", "new A");
  try {
    await pending;
    await expect(send(other, "session-test", "tok", "new B")).rejects.toThrow("delivery already pending");
    expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
  } finally { release(); await a; other.close(); }
  await send(db, "session-test", "tok", "new B");
  await Bun.sleep(3);
  writeTurnHook(dir, "codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "main", "turn-id": "delayed-A", "input-messages": [initial, "new A"] }));
  expect(db.getSession("session-test")?.turnInputDigest).toBe(inputDigest("new B"));
  await daemon.refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
});


test.each(["monitor", "send"])("a crashed delivery owner releases its lock via %s and uses conservative inactivity fallback", async recovery => {
  seed();
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { StateDB } from "./src/state";
    const db = new StateDB(process.argv[1]);
    db.reserveTurnDelivery("session-test", db.getSession("session-test").version, "abandoned input");
    db.close();
  `, join(root, "state.db")], { cwd: process.cwd() });
  expect(child.exitCode).toBe(0);
  expect(db.getSession("session-test")?.turnDeliveryPending).toBe(true);
  if (recovery === "monitor") await daemon.refreshSessionStatuses(db, ["session-test"]);
  else await expect(send(db, "session-test", "tok", "retry me")).rejects.toThrow("abandoned delivery released");
  expect(db.getSession("session-test")?.turnDeliveryPending).toBe(false);
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
  expect(db.getSession("session-test")?.status).toBe("running");
  await send(db, "session-test", "tok", "next unique input");
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(false);
});


for (const agent of ["claude-code", "codex", "kimi"]) {
  test(`${agent} launch registers its submitted input and keeps the delivery lock through confirmation`, async () => {
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "kill").mockResolvedValue();
    spyOn(defaultWakeup, "prepare").mockResolvedValue();
    spyOn(getDriver(agent), "prepareForTask").mockResolvedValue();
    spyOn(Tmux, "sendKeys").mockImplementation(async (id, text) => {
      expect(db.getSession(id)?.turnInputDigest).toBe(inputDigest(text));
      expect(db.getSession(id)?.turnDeliveryPending).toBe(true);
    });
    spyOn(getDriver(agent), "afterTaskSubmitted").mockImplementation(async id => {
      const row = db.getSession(id)!;
      await expect(send(db, id, row.ownerToken, "overlapping follow-up")).rejects.toThrow("delivery already pending");
      return true;
    });
    const result = await executeLaunch(planLaunch({ db, agentType: agent, task: "fixture", projectPath: root, parentId: "host" }));
    expect(db.getSession(result.sessionId)?.turnDeliveryPending).toBe(false);
  });
}
