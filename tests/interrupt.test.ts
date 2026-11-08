import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Archive } from "../src/archive";
import { interrupt, kill } from "../src/commands/session-ops";
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
  db = new StateDB(":memory:");
  screen = "working";
  keys = [];
  spyOn(defaultWakeup, "notify").mockResolvedValue();
  spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
  spyOn(Tmux, "capture").mockImplementation(async () => SCREENS[screen]);
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "kill").mockResolvedValue();
  // After the CLI exits the pane falls back to bash.
  spyOn(Tmux, "paneRunsChild").mockImplementation(async () => screen !== "exited");
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

test("kill exits a TUI that already waits at its composer", async () => {
  session("s");
  screen = "ready";
  await kill(db, "s", "s-token");
  expect(keys).toEqual(["/exit"]);
  expect(db.getSession("s")!.agentResumeId).toBe(ID);
});

test("kill sends nothing to a dialog", async () => {
  session("s");
  screen = "dialog";
  await kill(db, "s", "s-token");
  expect(keys).toEqual([]);
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

test("kill exits a settled Codex turn whose history rows read as work", async () => {
  // Codex counts history rows as activity; Escape on its idle composer only dismisses UI.
  const settled = ["• Explored", "  └ Read ahelpa-task.md", "• Ran ls", "› Ask Codex to do anything", "  GPT-6-Astra medium · ~/project"].join("\n");
  const exited = ["To continue this session, run:", `  codex resume ${ID}`, "bash-3.2$"].join("\n");
  spyOn(Tmux, "capture").mockImplementation(async () => (keys.includes("/exit") ? exited : settled));
  session("c", "codex");
  db.updateStatus("c", SESSION_STATUS.NeedsAttention);
  await kill(db, "c", "c-token");
  expect(keys).toEqual(["Escape", "/exit"]);
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
  spyOn(Tmux, "paneRunsChild").mockResolvedValue(false);
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

test("interrupt claims the turn before pressing the key", async () => {
  session("s");
  let statusAtKey: string | undefined;
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => {
    statusAtKey = db.getSession("s")!.status;
    keys.push(key);
    screen = "ready";
  });
  await interrupt(db, "s", "s-token");
  expect(statusAtKey).toBe(SESSION_STATUS.NeedsAttention);
});

test("interrupt reports failure and hands the turn back when the turn does not stop", async () => {
  session("s");
  const notify = spyOn(defaultWakeup, "notify");
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => { keys.push(key); });
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("did not visibly stop");
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Running);
  expect(notify).not.toHaveBeenCalled();
}, 15000);

test("interrupt refuses a pane whose CLI already exited", async () => {
  session("s");
  spyOn(Tmux, "paneRunsChild").mockResolvedValue(false);
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("no running agy");
  expect(keys).toEqual([]);
  expect(db.getSession("s")!.status).toBe(SESSION_STATUS.Running);
});

test("interrupt does not publish over a row that changed while it waited", async () => {
  session("s");
  spyOn(Tmux, "sendKey").mockImplementation(async (_id, key) => {
    keys.push(key);
    screen = "ready";
    db.updateResumeId("s", ID); // any concurrent write bumps the version
  });
  await expect(interrupt(db, "s", "s-token")).rejects.toThrow("changed");
  expect(new Archive(defaultRuntimeLayout.archiveDir()).get("s") ?? null).toBeNull();
});
