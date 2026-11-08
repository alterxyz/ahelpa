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
// spinner with "esc to cancel" while working, and the resume hint on exit.
const RULE = "─".repeat(40);
const ID = "01234567-89ab-4cde-8012-3456789abcde";
const SCREENS = {
  working: [RULE, "> Run sleep 120", RULE, "⠋ Generating...", RULE, ">", RULE, "esc to cancel"].join("\n"),
  ready: [RULE, "> Run sleep 120", RULE, "Interrupted · What should Antigravity CLI do instead?", RULE, ">", RULE, "? for shortcuts      Gemini 4 Argon · medium"].join("\n"),
  exited: ["Goodbye.", `agy --conversation=${ID}`, "$ "].join("\n"),
  dialog: ["Do you trust the contents of this project?", "> 1. Trust", "  2. Exit"].join("\n"),
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
  // After the CLI exits the pane falls back to bash.
  spyOn(Tmux, "vendorAlive").mockImplementation(async () => screen !== "exited");
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => {
    keys.push(key);
    if (key === "Escape" && screen === "working") screen = "ready";
  });
  spyOn(Tmux, "sendKeys").mockImplementation(async (_id, text) => {
    keys.push(text);
    if (text === "/exit" && screen === "ready") screen = "exited";
  });
});

afterEach(() => {
  mock.restore();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("kill stops a working TUI turn, exits it and keeps the native ID", async () => {
  session("s");
  await kill(db, "s", "s-token");
  expect(keys).toEqual(["Escape", "/exit"]);
  const row = db.getSession("s")!;
  expect(row.status).toBe(SESSION_STATUS.Dead);
  expect(row.agentResumeId).toBe(ID);
  // The archive keeps the work on screen, not the exit screen.
  const archived = new Archive(defaultRuntimeLayout.archiveDir()).get("s")!;
  expect(archived.agentResumeId).toBe(ID);
  expect(archived.lastOutput).toContain("Generating");
});

test("kill exits a settled TUI from its ready composer without a key", async () => {
  session("s");
  db.updateStatus("s", SESSION_STATUS.NeedsAttention);
  screen = "ready";
  await kill(db, "s", "s-token");
  expect(keys).toEqual(["/exit"]);
  expect(db.getSession("s")!.agentResumeId).toBe(ID);
});

test("kill only cancels a dialog on a running turn and never types into it", async () => {
  session("s");
  screen = "dialog";
  await kill(db, "s", "s-token");
  expect(keys).toEqual(["Escape"]);
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Dead);
  expect(db.getSession("s")!.agentResumeId ?? null).toBeNull();
});

test("kill gives up on the exit when the turn does not stop, and still kills", async () => {
  session("s");
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => { keys.push(key); });
  await kill(db, "s", "s-token");
  expect(keys).toEqual(["Escape"]);
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Dead);
}, 15000);

test("kill reads Codex's composer after the interrupt despite history rows", async () => {
  // Codex 0.16x after Escape (2026-11-07): the turn's rows stay above the composer.
  const CODEX = {
    working: ["• Explored", "  └ Read ahelpa-task.md", "• Working (15s • esc to interrupt) · 1 background terminal running", "› Ask Codex to do anything", "  GPT-6-Astra medium · ~/project"].join("\n"),
    ready: ["• Explored", "  └ Read ahelpa-task.md", "■ Conversation interrupted - use /feedback if something went wrong", "› Ask Codex to do anything", "  GPT-6-Astra medium · ~/project"].join("\n"),
    exited: ["To continue this session, run:", `  codex resume ${ID}`, "bash-3.2$"].join("\n"),
  };
  spyOn(Tmux, "capture").mockImplementation(async () => CODEX[screen as "working" | "ready" | "exited"]);
  session("c", "codex");
  await kill(db, "c", "c-token");
  expect(keys).toEqual(["Escape", "/exit"]);
  expect(db.getSession("c")!.agentResumeId).toBe(ID);
});

test("kill exits a settled Codex turn without pressing the interrupt key", async () => {
  // Codex counts history rows as activity; a settled turn's rows are history.
  const settled = ["• Explored", "  └ Read ahelpa-task.md", "• Ran ls", "› Ask Codex to do anything", "  GPT-6-Astra medium · ~/project"].join("\n");
  const exited = ["To continue this session, run:", `  codex resume ${ID}`, "bash-3.2$"].join("\n");
  spyOn(Tmux, "capture").mockImplementation(async () => (keys.includes("/exit") ? exited : settled));
  session("c", "codex");
  db.updateStatus("c", SESSION_STATUS.NeedsAttention);
  await kill(db, "c", "c-token");
  expect(keys).toEqual(["/exit"]);
  expect(db.getSession("c")!.agentResumeId).toBe(ID);
});

test("kill still kills when the interrupt key cannot be sent", async () => {
  session("s");
  spyOn(Tmux, "sendKey").mockRejectedValue(new Error("no server"));
  await kill(db, "s", "s-token");
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Dead);
});

test("kill skips the exit when the native ID is known or arrives at launch", async () => {
  session("known");
  db.updateResumeId("known", ID);
  session("early", "kimi");
  await kill(db, "known", "known-token");
  await kill(db, "early", "early-token");
  expect(keys).toEqual([]);
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

test("kill never types into a permission overlay that the strict check vetoes", async () => {
  // A Claude permission prompt whose tool header scrolled out of the capture.
  const overlay = ["❯", "Do you want to proceed?", "  1. Yes", "  2. No", "Enter to confirm"].join("\n");
  spyOn(Tmux, "capture").mockResolvedValue(overlay);
  session("c", "claude-code");
  await kill(db, "c", "c-token");
  expect(keys).not.toContain("/exit");
  expect(db.getSession("c")!.status).toBe(SESSION_STATUS.Dead);
}, 15000);

test("kill never types into the shell left after the CLI exited", async () => {
  // A stale Codex composer above the bash prompt that the wrapper starts.
  spyOn(Tmux, "capture").mockResolvedValue(["• Ran bun test", "› Ask Codex to do anything", "bash-3.2$"].join("\n"));
  spyOn(Tmux, "vendorAlive").mockResolvedValue(false);
  session("c", "codex");
  await kill(db, "c", "c-token");
  expect(keys).toEqual([]);
  expect(db.getSession("c")!.status).toBe(SESSION_STATUS.Dead);
});

test("kill does not exit while a Codex reply keeps streaming without a spinner", async () => {
  let frame = 0;
  spyOn(Tmux, "capture").mockImplementation(async () =>
    ["• Explored", "  └ Read ahelpa-task.md", `• Streaming line ${frame++}`, "› Ask Codex to do anything", "  GPT-6-Astra medium · ~/project"].join("\n"));
  session("c", "codex");
  await kill(db, "c", "c-token");
  expect(keys).not.toContain("/exit");
  expect(db.getSession("c")!.status).toBe(SESSION_STATUS.Dead);
}, 15000);

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

test("kill does not exit after an interrupt key that left no stop line", async () => {
  // A running Codex turn whose screen reads as work but shows no spinner, and
  // Escape changed nothing: no "Conversation interrupted" line, so no exit.
  const paused = ["• Explored", "  └ Read ahelpa-task.md", "• Ran ls", "› Ask Codex to do anything", "  GPT-6-Astra medium · ~/project"].join("\n");
  spyOn(Tmux, "capture").mockResolvedValue(paused);
  session("c", "codex");
  await kill(db, "c", "c-token");
  expect(keys).toEqual(["Escape"]);
  expect(db.getSession("c")!.status).toBe(SESSION_STATUS.Dead);
}, 15000);

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

test("kill still kills when the lease cannot be taken", async () => {
  session("s");
  writeFileSync(join(root, "not-a-dir"), "");
  spyOn(defaultRuntimeLayout, "interventionLeasePath").mockImplementation((id) => join(root, "not-a-dir", id));
  const killed = spyOn(Tmux, "kill");
  await kill(db, "s", "s-token");
  expect(killed).toHaveBeenCalledTimes(1);
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Dead);
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
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("already being interrupted or killed");
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
  session("k");
  await kill(db, "k", "k-token");
  expect(keys).not.toContain("/exit");
}, 20000);

test("a running turn that shows no work still needs a new stop line before kill exits it", async () => {
  // A prose-only Codex reply: no spinner and no work rows, so Codex reads it as idle.
  const prose = ["› Explain the design", "• Here is the first part of my answer", "› Ask Codex to do anything", "  GPT-6-Astra medium · ~/project"].join("\n");
  spyOn(Tmux, "capture").mockResolvedValue(prose);
  session("c", "codex");
  await kill(db, "c", "c-token");
  expect(keys).toEqual(["Escape"]);
  expect(db.getSession("c")!.status).toBe(SESSION_STATUS.Dead);
}, 15000);
