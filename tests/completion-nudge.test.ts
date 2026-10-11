import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { COMPLETION_NUDGE, refreshSessionStatuses } from "../src/daemon";
import { getDriver } from "../src/drivers/registry";
import { scanSentinels } from "../src/drivers/sentinels";

const TEST_DB = "/tmp/ahelpa-nudge-test.db";
const PROJECT = "/tmp/ahelpa-nudge-test-project";
// Codex at rest after a turn: composer visible, no turn evidence after it.
const READY_PANE = "I wrote the summary to .ahelpa/codex-quiet/summary.md.\n\n› \n\n  GPT-6.1-Sol xhigh · ~/proj\n  ? for shortcuts";
// Idle to detectActivity, but the thing on screen is a numbered menu.
const MENU_PANE = "Select Model and Effort\n\n› 1. gpt-6.1-sol\n  2. gpt-6-astra\n\n  Press enter to confirm";

function seed(db: StateDB, id: string, summary = true) {
  db.createSession({ id, parentId: "p", agentType: "codex", task: "t", ownerToken: "tok", projectPath: PROJECT });
  if (summary) {
    mkdirSync(`${PROJECT}/.ahelpa/${id}`, { recursive: true });
    writeFileSync(`${PROJECT}/.ahelpa/${id}/summary.md`, "# done but silent\n");
  }
}

describe("completion nudge", () => {
  let db: StateDB;

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
    rmSync(PROJECT, { recursive: true, force: true });
  });

  test("the nudge text never contains a sentinel", () => {
    expect(scanSentinels(COMPLETION_NUDGE)).toEqual([]);
    expect(COMPLETION_NUDGE).not.toContain("[AHELPA:");
  });

  test("asks once for the signal when summary.md exists and the composer is ready, then flags needs_attention", async () => {
    db = new StateDB(TEST_DB);
    seed(db, "codex-quiet");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(READY_PANE);
    const sendKeys = spyOn(Tmux, "sendKeys").mockResolvedValue();

    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, ["codex-quiet"]);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("codex-quiet", COMPLETION_NUDGE);
    expect(db.getSession("codex-quiet")?.status).toBe("running");
    expect(db.getSession("codex-quiet")?.nudgedAt).toBeTruthy();

    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, ["codex-quiet"]);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(db.getSession("codex-quiet")?.status).toBe("needs_attention");
  });

  test("the nudge marker survives a new monitoring process", async () => {
    db = new StateDB(TEST_DB);
    seed(db, "codex-restart");
    db.markNudged("codex-restart");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(READY_PANE);
    const sendKeys = spyOn(Tmux, "sendKeys").mockResolvedValue();

    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, ["codex-restart"]);

    expect(sendKeys).not.toHaveBeenCalled();
    expect(db.getSession("codex-restart")?.status).toBe("needs_attention");
  });

  test("never types into a menu even when summary.md exists", async () => {
    db = new StateDB(TEST_DB);
    seed(db, "codex-menu");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(MENU_PANE);
    const sendKeys = spyOn(Tmux, "sendKeys").mockResolvedValue();

    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, ["codex-menu"]);

    expect(sendKeys).not.toHaveBeenCalled();
    expect(db.getSession("codex-menu")?.status).toBe("needs_attention");
  });

  test("never confirms a Claude permission dialog whose tool header scrolled out of the capture", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "claude-perm", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: PROJECT });
    mkdirSync(`${PROJECT}/.ahelpa/claude-perm`, { recursive: true });
    writeFileSync(`${PROJECT}/.ahelpa/claude-perm/summary.md`, "# written\n");
    const dialog = [
      "────────────────", " Edit file", " .ahelpa/claude-perm/summary.md",
      ...Array.from({ length: 22 }, (_, i) => `  ${String(i + 3).padStart(3)} + - finding ${i}`),
      " Do you want to make this edit to summary.md?",
      " ❯ 1. Yes", "   2. Yes, allow all edits during this session (shift+tab)", "   3. No, and tell Claude what to do differently (esc)",
    ].join("\n");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(dialog);
    const sendKeys = spyOn(Tmux, "sendKeys").mockResolvedValue();

    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, ["claude-perm"]);

    expect(sendKeys).not.toHaveBeenCalled();
    expect(db.getSession("claude-perm")?.status).toBe("needs_attention");
  });

  // The focused review's six synthetic completion oracles. No tool header or
  // submitted user turn remains in view; reply text must not suppress nudging.
  const completedClaudePanes = [
    ...["  Working...", "  Testing…", "  Loading...", "* Fixed the bug…", "· Removed the stale branch…"].map((line) => ({
      name: `reply:${line}`,
      screen: `The command printed:\n\n\`\`\`text\n${line}\n\`\`\`\n\n────────────────\n❯ \n────────────────\n  0% ctx`,
    })),
    { name: "tool-output-continuation", screen: "     Loading...\n     build complete\n\n────────────────\n❯ \n────────────────\n  0% ctx" },
  ];
  test.each(completedClaudePanes)("Claude $name allows completion nudge after a finished reply", async ({ screen }) => {
    db = new StateDB(TEST_DB);
    const id = "claude-completed";
    db.createSession({ id, parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: PROJECT });
    mkdirSync(`${PROJECT}/.ahelpa/${id}`, { recursive: true });
    writeFileSync(`${PROJECT}/.ahelpa/${id}/summary.md`, "# complete\n");
    const driver = getDriver("claude-code");
    expect(driver.detectActivity(screen)).toBe("idle");
    expect(driver.acceptsInput?.(screen)).toBe(true);
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(screen);
    const sendKeys = spyOn(Tmux, "sendKeys").mockResolvedValue();
    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, [id]);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith(id, COMPLETION_NUDGE);
    expect(db.getSession(id)?.nudgedAt).toBeTruthy();
  });

  test("does not nudge from a stale capture after the row changed underneath", async () => {
    db = new StateDB(TEST_DB);
    seed(db, "codex-race");
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    let captures = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      // The host sends a new turn while the fourth capture is in flight.
      if (++captures === 4) db.updateResumeId("codex-race", "bump-version");
      return READY_PANE;
    });
    const sendKeys = spyOn(Tmux, "sendKeys").mockResolvedValue();

    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, ["codex-race"]);

    expect(sendKeys).not.toHaveBeenCalled();
  });

  test("does not nudge a silent helper that wrote nothing", async () => {
    db = new StateDB(TEST_DB);
    seed(db, "codex-empty", false);
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(READY_PANE);
    const sendKeys = spyOn(Tmux, "sendKeys").mockResolvedValue();

    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, ["codex-empty"]);

    expect(sendKeys).not.toHaveBeenCalled();
    expect(db.getSession("codex-empty")?.status).toBe("needs_attention");
  });
});
