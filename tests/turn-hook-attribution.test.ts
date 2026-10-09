import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { refreshSessionStatuses } from "../src/daemon";
import * as daemon from "../src/daemon";
import { send, sendTask } from "../src/commands/session-ops";
import { writeTurnHook } from "../src/turn-hooks";

let root: string, dir: string, db: StateDB;
const initial = "Please read and complete the task described in original-task";
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".ahelpa", "attribution-test-"));
  dir = join(root, ".ahelpa", "session-test");
  mkdirSync(dir, { recursive: true });
  db = new StateDB(join(root, "state.db"));
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "capture").mockResolvedValue("Working (1s • esc to interrupt)");
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
});
afterEach(() => { mock.restore(); db.close(); rmSync(root, { recursive: true, force: true }); });
function seed(agent: string) {
  const row = db.createSession({ id: "session-test", parentId: "host", agentType: agent, task: "fixture", ownerToken: "tok", projectPath: root });
  db.beginTurn(row.id, row.version, initial);
}
function notify(input: string, turn: string, thread = "main") {
  writeTurnHook(dir, "codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": thread, "turn-id": turn, "input-messages": [initial, input] }));
}
function prompt(input: string, key: string, session = "native") {
  writeTurnHook(dir, "claude-code", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt_id: key, prompt: input }));
}
function stop(key: string, session = "native", failure = false) {
  writeTurnHook(dir, "claude-code", JSON.stringify({ hook_event_name: failure ? "StopFailure" : "Stop", session_id: session, prompt_id: key, error: "authentication_failed" }));
}
for (const operation of ["send", "task"]) {
  test(`delayed old Codex notify after ${operation} is ignored; matching last input accepted`, async () => {
    seed("codex");
    notify(initial, "seed"); // bind the main thread
    const input = "new task with normalized whitespace";
    if (operation === "send") await send(db, "session-test", "tok", "  " + input + "\r\n");
    else {
      const path = join(root, "next.md");
      writeFileSync(path, input);
      await sendTask(db, "session-test", "tok", path);
    }
    const submitted = (Tmux.sendKeys as unknown as { mock: { calls: string[][] } }).mock.calls[0][1];
    await Bun.sleep(2);
    notify("previous follow-up task", "old");
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("running");
    notify(submitted, "foreign", "foreign-thread");
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("running");
    notify(submitted, "current");
    await refreshSessionStatuses(db, ["session-test"]);
    expect(db.getSession("session-test")?.status).toBe("needs_attention");
    expect(readFileSync(join(dir, "turns.log"), "utf8")).not.toContain(input);
  });
}
test("Claude requires matching input and native session/prompt pair, including StopFailure", async () => {
  seed("claude-code");
  prompt(initial, "old");
  await send(db, "session-test", "tok", "new Claude work");
  prompt("new Claude work", "current");
  prompt("background work", "background");
  stop("old", "native", true);
  stop("background");
  stop("current", "foreign-native");
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
  stop("current", "native", true);
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
  expect(readFileSync(join(dir, "turns.log"), "utf8")).not.toContain("new Claude work");
});
test("Claude Stop without a prompt event stays on the inactivity fallback", async () => {
  seed("claude-code");
  stop("unattributed");
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
});
test("nullable digest migration leaves legacy hook events unattributed", async () => {
  db.createSession({ id: "session-test", parentId: "host", agentType: "codex", task: "fixture", ownerToken: "tok", projectPath: root });
  notify(initial, "legacy");
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
});

test("repeated normalized input cannot attribute delayed old notifications, even after another intervening turn", async () => {
  seed("codex");
  await send(db, "session-test", "tok", "other input");
  await send(db, "session-test", "tok", "  " + initial + "\r\n");
  notify(initial, "delayed-identical");
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
  db.close();
  db = new StateDB(join(root, "state.db"));
  expect(db.getSession("session-test")?.turnInputAmbiguous).toBe(true);
});

test("Claude whole-message paste wrapper normalizes to submitted input while mismatched tags stay unattributed", async () => {
  seed("claude-code");
  prompt('<pasted_content id="7e9e">\n' + initial + '\n</pasted_content id="ffff">', "mismatch");
  stop("mismatch");
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
  prompt('\n\n<pasted_content id="7e9e">\r\n' + initial + '\r\n</pasted_content id="7e9e">\n', "pasted");
  stop("pasted");
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
});
