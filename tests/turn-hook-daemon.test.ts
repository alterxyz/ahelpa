import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { COMPLETION_NUDGE, refreshSessionStatuses } from "../src/daemon";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { writeTurnHook } from "../src/turn-hooks";
import { send } from "../src/commands/session-ops";
import * as daemon from "../src/daemon";

const READY = "Response complete\n\n› \n\n  GPT-6.1-Sol · ~/proj\n  ? for shortcuts";
const MENU = "Select Model and Effort\n\n› 1. gpt-6.1-sol\n  Press enter to confirm";
let root: string;
let db: StateDB;
let serial = 0;
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".ahelpa", "hook-daemon-test-"));
  db = new StateDB(join(root, "state.db"));
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "capture").mockResolvedValue(READY);
  spyOn(Tmux, "sendKeys").mockResolvedValue();
});
afterEach(() => { mock.restore(); db.close(); rmSync(root, { recursive: true, force: true }); });
function seed(summary = false, agent = "codex") {
  const id = `${agent}-${++serial}`;
  db.createSession({ id, parentId: "p", agentType: agent, task: "t", ownerToken: "tok", projectPath: root });
  const dir = defaultRuntimeLayout.sessionDeliveryDir(root, id);
  mkdirSync(dir, { recursive: true });
  if (summary) writeFileSync(join(dir, "summary.md"), "written result");
  return { id, dir };
}
function event(dir: string, agent = "codex", failure = false) {
  writeTurnHook(dir, agent, JSON.stringify(agent === "codex"
    ? { type: "agent-turn-complete", "thread-id": "main", "turn-id": "one", "input-messages": ["Please read and complete the task described in fixture"] }
    : { hook_event_name: failure ? "StopFailure" : "Stop", session_id: "native", prompt_id: "prompt", error: "authentication_failed" }));
}

describe("daemon official turn-end timing", () => {
  test.each(["codex", "claude-code"])("%s missing-summary event flags needs_attention on the first poll even with a lingering spinner", async agent => {
    const { id, dir } = seed(false, agent);
    event(dir, agent);
    spyOn(Tmux, "capture").mockResolvedValue(agent === "codex" ? "Working (1s • esc to interrupt)" : "✻ Working…");
    await refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("needs_attention");
    expect(db.getSession(id)?.turnHookOffset).toBeGreaterThan(0);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
  });

  test("summary plus event nudges immediately and persists its cursor across database reopen", async () => {
    const { id, dir } = seed(true);
    event(dir);
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(Tmux.sendKeys).toHaveBeenCalledWith(id, COMPLETION_NUDGE);
    expect(db.getSession(id)).toMatchObject({ status: "running" });
    const offset = db.getSession(id)!.turnHookOffset;
    expect(offset).toBeGreaterThan(0);
    db.close();
    db = new StateDB(join(root, "state.db"));
    await refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    expect(db.getSession(id)?.turnHookOffset).toBe(offset);
    expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  test("Stop before composer readiness remains pending until acceptsInput allows the nudge", async () => {
    const { id, dir } = seed(true, "claude-code");
    event(dir, "claude-code");
    spyOn(Tmux, "capture").mockResolvedValue("✻ Working…");
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
    expect(db.getSession(id)?.turnHookOffset).toBeNull();
    expect(db.getSession(id)?.status).toBe("running");
    spyOn(Tmux, "capture").mockResolvedValue("Response\n\n❯ \n  bypass permissions on");
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(Tmux.sendKeys).toHaveBeenCalledWith(id, COMPLETION_NUDGE);
  });

  test("a hook cannot nudge into a menu and sustained idle still escalates", async () => {
    const { id, dir } = seed(true);
    event(dir);
    spyOn(Tmux, "capture").mockResolvedValue(MENU);
    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
    expect(db.getSession(id)?.status).toBe("needs_attention");
  });

  test("a row-version change during capture prevents hook consumption, nudge and settlement", async () => {
    const { id, dir } = seed(true);
    event(dir);
    spyOn(Tmux, "capture").mockImplementation(async () => { db.updateResumeId(id, "new-version"); return READY; });
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
    expect(db.getSession(id)?.turnHookOffset).toBeNull();
    expect(db.getSession(id)?.status).toBe("running");
  });

  test("StopFailure flags needs_attention immediately and logs the error kind despite summary and ready input", async () => {
    const { id, dir } = seed(true, "claude-code");
    event(dir, "claude-code", true);
    mkdirSync(defaultRuntimeLayout.ahelpaHomeDir(), { recursive: true });
    await refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("needs_attention");
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
    expect(readFileSync(defaultRuntimeLayout.daemonLogPath(), "utf8")).toContain(`${id}: needs attention (turn hook stop_failure: authentication_failed)`);
  });

  test("sentinel wins over a hook and only it can mark success", async () => {
    const { id, dir } = seed();
    event(dir);
    spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:DONE]");
    spyOn(Tmux, "sendKey").mockResolvedValue();
    await refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("draining");
    expect(db.getSession(id)?.nudgedAt).toBeNull();
  });

  test.each(["codex", "kimi"])("%s without hook retains the four-poll inactivity fallback", async agent => {
    const { id } = seed(false, agent);
    for (let i = 0; i < 3; i++) {
      await refreshSessionStatuses(db, [id]);
      expect(db.getSession(id)?.status).toBe("running");
    }
    await refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("needs_attention");
  });

  test("old unconsumed event cannot end a newly submitted host turn", async () => {
    const { id, dir } = seed();
    event(dir);
    await Bun.sleep(2);
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    await send(db, id, "tok", "new work");
    expect(db.getSession(id)?.turnStartedAt).toBeTruthy();
    await refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(Tmux.sendKeys).toHaveBeenCalledWith(id, "new work");
  });

  test("cursor claim is conditional on row version and protects concurrent monitors", () => {
    const { id } = seed();
    const row = db.getSession(id)!;
    expect(db.consumeTurnHook(id, row.version, 123, true)).toBe(true);
    expect(db.consumeTurnHook(id, row.version, 123, true)).toBe(false);
    expect(db.getSession(id)?.turnHookOffset).toBe(123);
  });

  test("nullable migration preserves an old row and consumed offset survives restart", () => {
    const { id } = seed();
    db.close();
    const legacy = new Database(join(root, "state.db"));
    legacy.exec("ALTER TABLE sessions DROP COLUMN turn_hook_offset");
    legacy.exec("ALTER TABLE sessions DROP COLUMN turn_started_at");
    legacy.close();
    db = new StateDB(join(root, "state.db"));
    expect(db.getSession(id)?.turnHookOffset).toBeNull();
    expect(db.getSession(id)?.turnStartedAt).toBeNull();
    expect(db.consumeTurnHook(id, db.getSession(id)!.version, 456)).toBe(true);
    db.close();
    db = new StateDB(join(root, "state.db"));
    expect(db.getSession(id)?.turnHookOffset).toBe(456);
  });
});
