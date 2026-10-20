import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
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
// Shape of a real archived end-of-turn Codex pane (sentinel row removed).
const CODEX_FINISHED = [
  "• Ran python3 .ahelpa/codex-x/artifacts/validate.py", "  └ PASS; 19 checks", "    + 1 line (⌃t to expand)", "",
  "• Explored", "  └ Read summary.md", "",
  "• Done. Summary in .ahelpa/codex-x/summary.md.", "", "",
  "  Worked for 18m 59s • 05:33", "", "",
  "› Ask Codex to do anything", "",
  "  GPT-6.1-Sol high · ~/proj · Complete the ahelpa task", "  ? for shortcuts",
].join("\n");
let root: string;
let db: StateDB;
let serial = 0;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "hook-daemon-test-"));
  db = new StateDB(join(root, "state.db"));
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "capture").mockResolvedValue(READY);
  spyOn(Tmux, "sendKeys").mockResolvedValue();
});
afterEach(() => { mock.restore(); db.close(); rmSync(root, { recursive: true, force: true }); });
function seed(summary = false, agent = "codex") {
  const id = `${agent}-${++serial}`;
  const row = db.createSession({ id, parentId: "p", agentType: agent, task: "t", ownerToken: "tok", projectPath: root });
  db.beginTurn(id, row.version, "Please read and complete the task described in fixture");
  const dir = defaultRuntimeLayout.sessionDeliveryDir(root, id);
  mkdirSync(dir, { recursive: true });
  if (summary) writeFileSync(join(dir, "summary.md"), "written result");
  return { id, dir };
}
// verified: bind the Codex thread as resume does, so the event is threadVerified.
// Otherwise "main" is not a UUIDv7, its rollout cannot be read, and the event is fail-open.
function event(dir: string, agent = "codex", failure = false, verified = false) {
  if (agent === "claude-code") writeTurnHook(dir, agent, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native", prompt_id: "prompt", prompt: "Please read and complete the task described in fixture" }));
  writeTurnHook(dir, agent, JSON.stringify(agent === "codex"
    ? { type: "agent-turn-complete", "thread-id": "main", "turn-id": "one", "input-messages": ["Please read and complete the task described in fixture"] }
    : { hook_event_name: failure ? "StopFailure" : "Stop", session_id: "native", prompt_id: "prompt", error: "authentication_failed" }),
    verified ? "main" : undefined);
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

  // Codex keeps a finished turn's work rows on screen. Reading them as live work
  // left a helper with a summary and a turn-end event `running` forever.
  test("codex: a verified turn end ignores finished work rows and nudges", async () => {
    const { id, dir } = seed(true);
    event(dir, "codex", false, true);
    spyOn(Tmux, "capture").mockResolvedValue(CODEX_FINISHED);
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).toHaveBeenCalledWith(id, COMPLETION_NUDGE);
  });

  test("codex: a finished reply quoting the question view's words still gets the nudge", async () => {
    const { id, dir } = seed(true);
    event(dir, "codex", false, true);
    spyOn(Tmux, "capture").mockResolvedValue(CODEX_FINISHED.replace("• Done.", "• The view shows:\n  Question 1/1\n  enter to submit answer | esc to interrupt\n\n• Done."));
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).toHaveBeenCalledWith(id, COMPLETION_NUDGE);
  });

  // A fail-open event may be a sub-agent's while the main thread streams with
  // its spinner hidden, which looks exactly like CODEX_FINISHED.
  test("codex: an unverified turn end keeps reading work rows as work", async () => {
    const { id, dir } = seed(true);
    event(dir);
    spyOn(Tmux, "capture").mockResolvedValue(CODEX_FINISHED);
    for (let i = 0; i < 5; i++) await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
    expect(db.getSession(id)).toMatchObject({ status: "running", turnHookOffset: null });
  });

  // Older Codex draws this divider before it streams the answer, with the spinner hidden.
  test("codex: without a turn-end event a reply streaming below a Worked-for divider stays running", async () => {
    const { id } = seed(true);
    let chunks = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => [
      "› Please read and complete the task described in fixture", "",
      "• Ran bun test", "  └ 12 pass", "", "─ Worked for 1m 05s ─────────", "",
      `• Still streaming the review;${" more".repeat(++chunks)}`, "",
      "› Ask Codex to do anything",
    ].join("\n"));
    for (let i = 0; i < 6; i++) await refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
  });

  // Codex can hide the interrupt hint and keep the spinner (set_interrupt_hint_visible).
  test.each(["• Working (12s • esc to interrupt)", "• Working (12s)"])("codex: a live spinner (%s) after a verified event keeps it pending", async spinner => {
    const { id, dir } = seed(true);
    event(dir, "codex", false, true);
    spyOn(Tmux, "capture").mockResolvedValue(`• Ran bun test\n  └ 12 pass\n\n${spinner}\n\n› Ask Codex to do anything\n\n  ? for shortcuts`);
    for (let i = 0; i < 5; i++) await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
    expect(db.getSession(id)).toMatchObject({ status: "running", turnHookOffset: null });
  });

  test.each([
    ["a menu", MENU],
    // Upstream request_user_input freeform snapshot (codex-rs v0.154.0): "›" here takes the answer.
    ["the free-form question view", "Question 1/1 (1 unanswered)\nShare details.\n› Type your answer (optional)\nenter to submit answer | esc to interrupt"],
  ])("codex: %s below finished work rows never gets the nudge and escalates after a verified event", async (_name, view) => {
    const { id, dir } = seed(true);
    event(dir, "codex", false, true);
    spyOn(Tmux, "capture").mockResolvedValue(`  └ earlier output\n\n• Ran bun test\n  └ 12 pass\n\n${view}`);
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
    legacy.exec("ALTER TABLE sessions DROP COLUMN turn_input_digest");
    legacy.exec("ALTER TABLE sessions DROP COLUMN turn_input_history");
    legacy.close();
    db = new StateDB(join(root, "state.db"));
    expect(db.getSession(id)?.turnHookOffset).toBeNull();
    expect(db.getSession(id)?.turnStartedAt).toBeNull();
    expect(db.getSession(id)?.turnInputDigest).toBeNull();
    expect(db.consumeTurnHook(id, db.getSession(id)!.version, 456)).toBe(true);
    db.close();
    db = new StateDB(join(root, "state.db"));
    expect(db.getSession(id)?.turnHookOffset).toBe(456);
  });
});
