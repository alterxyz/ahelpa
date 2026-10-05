import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Archive } from "../src/archive";
import { refreshSessionStatuses } from "../src/daemon";
import { getDriver } from "../src/drivers/registry";
import { RuntimeLayout, defaultRuntimeLayout } from "../src/runtime-layout";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { defaultWakeup } from "../src/wakeup";

describe("need-help ledger refresh", () => {
  let root: string;
  let layout: RuntimeLayout;
  let db: StateDB;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ahelpa-ledger-"));
    layout = new RuntimeLayout({ ahelpaDir: join(root, "state"), tmpDir: join(root, "runtime") });
    spyOn(defaultRuntimeLayout, "ahelpaHomeDir").mockReturnValue(layout.ahelpaHomeDir());
    spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(layout.archiveDir());
    spyOn(defaultRuntimeLayout, "needHelpLedgerPath").mockReturnValue(layout.needHelpLedgerPath());
    spyOn(defaultRuntimeLayout, "daemonLogPath").mockReturnValue(layout.daemonLogPath());
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(defaultWakeup, "notify").mockResolvedValue();
    spyOn(defaultWakeup, "cleanup").mockReturnValue();
    db = new StateDB(join(root, "state.db"));
  });

  afterEach(() => {
    mock.restore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function createSession(agentType = "codex", id = "ledger-session") {
    return db.createSession({
      id, agentType, parentId: "host", task: "private task must not be indexed",
      ownerToken: "private token must not be indexed", projectPath: join(root, "project"),
      role: "worker", model: "model", effort: "high", safe: true,
    });
  }

  function ledgerLines() {
    return existsSync(layout.needHelpLedgerPath())
      ? readFileSync(layout.needHelpLedgerPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
  }

  for (const agentType of ["codex", "claude-code", "kimi"]) {
    test(`${agentType}: records current tags once with complete metadata`, async () => {
      createSession(agentType);
      spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:NEED_HELP: Review,INPUT,review]");
      const detect = spyOn(getDriver(agentType), "detectOutcome");

      await refreshSessionStatuses(db);
      await refreshSessionStatuses(db);

      expect(db.getSession("ledger-session")?.status).toBe("error");
      expect(detect).toHaveBeenCalledTimes(1);
      expect(ledgerLines()).toHaveLength(1);
      const event = ledgerLines()[0];
      expect(event).toEqual({
        ts: expect.any(String), sessionId: "ledger-session", parentId: "host", agentType,
        role: "worker", model: "model", effort: "high", safe: true,
        projectPath: join(root, "project"), tags: ["review", "input"],
        summaryPath: join(root, "project", ".ahelpa", "ledger-session", "summary.md"),
      });
      expect(new Date(event.ts).toISOString()).toBe(event.ts);
      expect(defaultWakeup.notify).toHaveBeenCalledWith("ledger-session", "error");
      expect(defaultWakeup.cleanup).toHaveBeenCalledWith("ledger-session");
    });
  }

  test("ledger metadata reflects a completed model switch during capture", async () => {
    createSession();
    db.updateModel("ledger-session", "before-switch", "low");
    spyOn(Tmux, "capture").mockImplementation(async () => {
      db.updateModel("ledger-session", "after-switch", "high");
      return "› Current task\n[AHELPA:NEED_HELP:input]";
    });

    await refreshSessionStatuses(db);

    expect(db.getSession("ledger-session")).toMatchObject({ status: "error", model: "after-switch", effort: "high" });
    expect(ledgerLines()).toHaveLength(1);
    expect(ledgerLines()[0]).toMatchObject({ model: "after-switch", effort: "high", tags: ["input"] });
  });

  test("a model switch while settle awaits the wakeup does not relabel the event", async () => {
    createSession();
    db.updateModel("ledger-session", "before-switch", "low");
    spyOn(Tmux, "capture").mockResolvedValue("› Current task\n[AHELPA:NEED_HELP:review]");
    spyOn(defaultWakeup, "notify").mockImplementation(async () => {
      db.updateModel("ledger-session", "post-notify-switch", "high");
    });

    await refreshSessionStatuses(db);

    expect(ledgerLines()).toHaveLength(1);
    expect(ledgerLines()[0]).toMatchObject({ model: "before-switch", effort: "low", tags: ["review"] });
  });

  test("untagged help normalizes legacy empty metadata and preserves false safe", async () => {
    db.createSession({ id: "legacy", agentType: "codex", parentId: "host", task: "t", ownerToken: "tok", projectPath: root, model: "", effort: "" });
    const legacyDatabase = new Database(join(root, "state.db"));
    legacyDatabase.run("UPDATE sessions SET role = '' WHERE id = ?", ["legacy"]);
    legacyDatabase.close();
    spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:NEED_HELP]");

    await refreshSessionStatuses(db);

    expect(ledgerLines()[0]).toMatchObject({ tags: [], role: null, model: null, effort: null, safe: false });
  });

  test("full capture supplies tags even outside the archive tail", async () => {
    createSession();
    const output = "[AHELPA:NEED_HELP:review]\n" + "capture tail ".repeat(100);
    spyOn(Tmux, "capture").mockResolvedValue(output);
    const save = spyOn(Archive.prototype, "save");

    await refreshSessionStatuses(db);

    expect(ledgerLines()[0].tags).toEqual(["review"]);
    expect(save).toHaveBeenCalledWith("ledger-session", { status: "error", lastOutput: output.slice(-500) });
  });

  test("rearmed session records tags from each new event", async () => {
    createSession();
    const capture = spyOn(Tmux, "capture").mockResolvedValue("› first\n[AHELPA:NEED_HELP:review]");
    await refreshSessionStatuses(db);
    expect(db.compareAndSetStatus("ledger-session", "error", "running")).toBe(true);
    capture.mockResolvedValue("› first\n[AHELPA:NEED_HELP:review]\n› second\n[AHELPA:NEED_HELP:input]");

    await refreshSessionStatuses(db);

    expect(ledgerLines().map((event) => event.tags)).toEqual([["review"], ["input"]]);
  });

  test("same-turn competing refreshes append only for the CAS winner", async () => {
    createSession();
    let releaseCapture!: (output: string) => void;
    let captureStarted!: () => void;
    const started = new Promise<void>((resolve) => { captureStarted = resolve; });
    const delayed = new Promise<string>((resolve) => { releaseCapture = resolve; });
    let captures = 0;
    spyOn(Tmux, "capture").mockImplementation(async () => {
      if (++captures === 1) {
        captureStarted();
        return delayed;
      }
      return "[AHELPA:NEED_HELP:input]";
    });
    const first = refreshSessionStatuses(db);
    await started;
    await refreshSessionStatuses(db);
    releaseCapture("[AHELPA:NEED_HELP:review]");
    await first;

    expect(ledgerLines().map((event) => event.tags)).toEqual([["input"]]);
    expect(defaultWakeup.notify).toHaveBeenCalledTimes(1);
  });

  test("a kill winning during capture produces no help record", async () => {
    createSession();
    spyOn(Tmux, "capture").mockImplementation(async () => {
      db.updateStatus("ledger-session", "dead");
      return "[AHELPA:NEED_HELP:review]";
    });

    await refreshSessionStatuses(db);

    expect(db.getSession("ledger-session")?.status).toBe("dead");
    expect(ledgerLines()).toEqual([]);
    expect(defaultWakeup.notify).not.toHaveBeenCalled();
  });

  test("append failure is logged without breaking settlement, archive or notification", async () => {
    createSession();
    mkdirSync(layout.needHelpLedgerPath(), { recursive: true });
    spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:NEED_HELP:review]");
    const save = spyOn(Archive.prototype, "save");

    await refreshSessionStatuses(db);

    expect(db.getSession("ledger-session")?.status).toBe("error");
    expect(save).toHaveBeenCalledTimes(1);
    expect(defaultWakeup.notify).toHaveBeenCalledWith("ledger-session", "error");
    expect(defaultWakeup.cleanup).toHaveBeenCalledWith("ledger-session");
    expect(readFileSync(layout.daemonLogPath(), "utf8")).toContain("need-help ledger append failed");
  });

  test("archive failure rolls back settlement and writes no ledger line", async () => {
    createSession();
    spyOn(Tmux, "capture").mockResolvedValue("[AHELPA:NEED_HELP:review]");
    spyOn(Archive.prototype, "save").mockImplementation(() => { throw new Error("archive failure"); });

    await refreshSessionStatuses(db);

    expect(db.getSession("ledger-session")?.status).toBe("running");
    expect(ledgerLines()).toEqual([]);
    expect(defaultWakeup.notify).not.toHaveBeenCalled();
  });

  test("idle, needs_attention, dead and unsupported-model errors are not indexed", async () => {
    for (const id of ["done", "attention", "gone", "unsupported"]) createSession("codex", id);
    spyOn(Tmux, "hasSession").mockImplementation(async (id) => id !== "gone");
    spyOn(Tmux, "capture").mockImplementation(async (id) => {
      if (id === "done") return "[AHELPA:DONE]";
      if (id === "unsupported") return [
        "› old", "[AHELPA:NEED_HELP:review]",
        "› Please read and complete the task described in task.md.",
        "ERROR: The 'bad-model' model is not supported when using Codex with a ChatGPT account.",
      ].join("\n");
      return "idle prompt";
    });
    spyOn(Tmux, "sendKey").mockResolvedValue();
    spyOn(Tmux, "sendKeys").mockResolvedValue();

    for (let poll = 0; poll < 4; poll++) await refreshSessionStatuses(db);

    expect(db.getSession("done")?.status).toBe("draining");
    expect(db.getSession("attention")?.status).toBe("needs_attention");
    expect(db.getSession("gone")?.status).toBe("dead");
    expect(db.getSession("unsupported")?.status).toBe("error");
    expect(ledgerLines()).toEqual([]);
  });
});
