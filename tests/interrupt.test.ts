import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Archive } from "../src/archive";
import { interrupt, kill } from "../src/commands/session-ops";
import { refreshSessionStatuses } from "../src/daemon";
import { interventionLeaseActive, releaseInterventionLease, takeInterventionLease } from "../src/intervention-lease";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { SESSION_STATUS } from "../src/session-lifecycle";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { defaultWakeup } from "../src/wakeup";

// agy's TUI as captured on 2026-11-07: a rule-framed composer, a Braille
// spinner with "esc to cancel" while working, and its own stop line.
const RULE = "─".repeat(40);
const ID = "01234567-89ab-4cde-8012-3456789abcde";
const SCREENS = {
  working: [RULE, "> Run sleep 120", RULE, "⠋ Generating...", RULE, ">", RULE, "esc to cancel"].join("\n"),
  ready: [RULE, "> Run sleep 120", RULE, "Interrupted · What should Antigravity CLI do instead?", RULE, ">", RULE, "? for shortcuts      Gemini 4 Argon · medium"].join("\n"),
};
type Screen = keyof typeof SCREENS;

let db: StateDB;
let root: string;
let screen: Screen;
let keys: string[];

function session(id: string, agentType = "agy") {
  db.createSession({ id, parentId: "host", agentType, task: "fixture", ownerToken: `${id}-token`, projectPath: root });
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "interrupt-"));
  spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(join(root, "archive"));
  spyOn(defaultRuntimeLayout, "interventionLeasePath").mockImplementation((id) => join(root, "interventions", id));
  db = new StateDB(":memory:");
  screen = "working";
  keys = [];
  spyOn(defaultWakeup, "notify").mockResolvedValue();
  spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
  spyOn(Tmux, "capture").mockImplementation(async () => SCREENS[screen]);
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "kill").mockResolvedValue();
  spyOn(Tmux, "vendorAlive").mockResolvedValue(true);
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => {
    keys.push(key);
    if (key === "Escape" && screen === "working") screen = "ready";
  });
  spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => { keys.push(text); });
});

afterEach(() => {
  mock.restore();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("kill presses no key and waits for nothing: it ends the terminal", async () => {
  // A helper is its ahelpa ID; a native ID it never printed is not worth delaying the kill.
  session("s");
  const killed = spyOn(Tmux, "kill");
  await kill(db, "s", "s-token");
  expect(keys).toEqual([]);
  expect(killed).toHaveBeenCalledTimes(1);
  const row = db.getSession("s")!;
  expect(row.status).toBe(SESSION_STATUS.Dead);
  expect(row.agentResumeId ?? null).toBeNull();
});

test("interrupt stops the turn and leaves the session waiting for send", async () => {
  session("s");
  const result = await interrupt(db, "s", "s-token");
  expect(result).toContain("interrupted s");
  expect(keys).toEqual(["Escape"]);
  const row = db.getSession("s")!;
  expect(row.status).toBe(SESSION_STATUS.NeedsAttention);
  const archived = new Archive(defaultRuntimeLayout.archiveDir()).get("s")!;
  expect(archived.reason).toBe("interrupted by host");
  expect(archived.lastOutput).toContain("Interrupted");
});

test("interrupt refuses a helper without a verified key", async () => {
  session("k", "kimi");
  await expect(interrupt(db, "k", "k-token")).rejects.toThrow("no verified interrupt key");
  expect(keys).toEqual([]);
});

test("interrupt refuses a settled session", async () => {
  session("s");
  db.updateStatus("s", SESSION_STATUS.Idle);
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("only a running or flagged turn");
  expect(keys).toEqual([]);
});

test("interrupt holds a lease, not a status, while the turn stops", async () => {
  session("s");
  const seen: Array<{ status: string; lease: boolean }> = [];
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => {
    seen.push({ status: db.getSession("s")!.status, lease: interventionLeaseActive("s") });
    keys.push(key);
    screen = "ready";
  });
  await interrupt(db, "s", "s-token");
  // A waiter sees running until the stop is confirmed, and the daemon is held off.
  expect(seen).toEqual([{ status: SESSION_STATUS.Running, lease: true }]);
  expect(interventionLeaseActive("s")).toBe(false);
});

test("interrupt leaves the turn running and releases the lease when it does not stop", async () => {
  session("s");
  const notify = spyOn(defaultWakeup, "notify");
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => { keys.push(key); });
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("did not show that its turn stopped");
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Running);
  expect(notify).not.toHaveBeenCalled();
  expect(interventionLeaseActive("s")).toBe(false);
}, 15000);

test("interrupt needs the TUI's own stop line, not just a quiet ready screen", async () => {
  // Escape had no effect on a reply that paused between chunks: same screen, no "Interrupted" line.
  session("s");
  spyOn(Tmux, "capture").mockResolvedValue([RULE, "> Run sleep 120", RULE, "partial reply …", RULE, ">", RULE, "? for shortcuts      Gemini 4 Argon · medium"].join("\n"));
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("did not show that its turn stopped");
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Running);
}, 15000);

test("interrupt publishes across a metadata write but not across a new turn", async () => {
  session("s");
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => {
    keys.push(key);
    screen = "ready";
    db.updateResumeId("s", ID); // metadata: version moves, same turn
  });
  await interrupt(db, "s", "s-token");
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.NeedsAttention);

  session("t");
  screen = "working";
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => {
    keys.push(key);
    screen = "ready";
    db.updateStatus("t", SESSION_STATUS.Idle); // a settlement won meanwhile
  });
  await expect(interrupt(db, "t", "t-token")).rejects.toThrow("changed to idle");
  expect(db.getSession("t")!.status).toBe(SESSION_STATUS.Idle);
});

test("interrupt keeps the turn running when publishing the archive fails", async () => {
  session("s");
  spyOn(Archive.prototype, "save").mockImplementation(() => { throw new Error("disk full"); });
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("disk full");
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Running);
  expect(interventionLeaseActive("s")).toBe(false);
});

test("the daemon leaves a leased session alone", async () => {
  session("s");
  screen = "ready"; // idle with no signal: normally the idle fallback, then needs_attention
  spyOn(Tmux, "liveSessionNames").mockResolvedValue(new Set(["s"]));
  takeInterventionLease("s");
  for (let poll = 0; poll < 6; poll++) await refreshSessionStatuses(db, ["s"]);
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Running);
  expect(keys).toEqual([]);
});

test("interrupt refuses a pane whose CLI already exited", async () => {
  session("s");
  spyOn(Tmux, "vendorAlive").mockResolvedValue(false);
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("no running agy");
  expect(keys).toEqual([]);
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Running);
});

test("an intervention moves the row version so an in-flight refresh cannot use it", async () => {
  session("s");
  const before = db.getSession("s")!.version;
  let atKey = before;
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => {
    atKey = db.getSession("s")!.version;
    keys.push(key);
    screen = "ready";
  });
  await interrupt(db, "s", "s-token");
  expect(atKey).toBeGreaterThan(before);
});

test("one intervention at a time, and only its holder releases the lease", async () => {
  session("s");
  const first = takeInterventionLease("s")!;
  expect(takeInterventionLease("s")).toBeNull();
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("already being interrupted");
  releaseInterventionLease({ sessionId: "s", token: "someone-else" });
  expect(interventionLeaseActive("s")).toBe(true);
  releaseInterventionLease(first);
  expect(interventionLeaseActive("s")).toBe(false);
  expect(keys).toEqual([]);
});

test("the lease holds through a slow tmux call, however long", async () => {
  session("s");
  let now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now);
  const active: boolean[] = [];
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => {
    keys.push(key);
    now += 20_001; // one tmux call outlasts any fixed renewal period
    active.push(interventionLeaseActive("s", now));
    screen = "ready";
  });
  spyOn(Tmux, "capture").mockImplementation(async () => {
    now += 10_000;
    active.push(interventionLeaseActive("s", now));
    return SCREENS[screen];
  });
  await interrupt(db, "s", "s-token");
  expect(active.length).toBeGreaterThan(2);
  expect(active.every(Boolean)).toBe(true);
});

test("a lease ends with its holder process and can then be taken", async () => {
  session("s");
  // A holder that died: a PID that cannot exist.
  mkdirSync(join(root, "interventions"), { recursive: true });
  writeFileSync(join(root, "interventions", "s"), `${Date.now()} dead-token 2147483646`);
  expect(interventionLeaseActive("s")).toBe(false);
  const lease = takeInterventionLease("s");
  expect(lease).not.toBeNull();
  expect(interventionLeaseActive("s")).toBe(true);
  releaseInterventionLease(lease!);
});

test("an older stop line on screen does not prove that a newer turn stopped", async () => {
  // A previous interrupt's line is still visible above a new running turn; Escape had no effect.
  const screenWithOldStop = [RULE, "> First task", RULE, "Interrupted · What should Antigravity CLI do instead?", RULE, "> Second task", RULE, "partial reply", RULE, ">", RULE, "? for shortcuts      Gemini 4 Argon · medium"].join("\n");
  spyOn(Tmux, "capture").mockResolvedValue(screenWithOldStop);
  session("s");
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("did not show that its turn stopped");
}, 15000);
