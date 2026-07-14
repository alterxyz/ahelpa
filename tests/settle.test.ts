import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { Archive } from "../src/archive";
import { Wakeup } from "../src/wakeup";
import { RuntimeLayout } from "../src/runtime-layout";
import { settle } from "../src/settle";
import { Tmux } from "../src/tmux";
import { SESSION_STATUS } from "../src/session-lifecycle";

const TEST_DB = "/tmp/ahelpa-settle-test.db";
const TEST_ARCHIVE = "/tmp/ahelpa-settle-test-archive";
const TEST_TMP = "/tmp/ahelpa-settle-test-tmp";
const TEST_HOME = "/tmp/ahelpa-settle-test-home";
const TEST_PROJECT = "/tmp/ahelpa-settle-test-project";
const NOTIFY_TARGET = "ahelpa-test-settle-notify";
const GLOBAL_TARGET = "ahelpa-test-settle-global";
const SESSION_TARGET = "ahelpa-test-settle-session";

function cleanup() {
  for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    try { if (existsSync(path)) unlinkSync(path); } catch {}
  }
  for (const dir of [TEST_ARCHIVE, TEST_TMP, TEST_HOME, TEST_PROJECT]) {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForFile(path: string, text: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    if (existsSync(path)) {
      const body = readFileSync(path, "utf-8");
      if (body.includes(text)) return body;
    }
    await Bun.sleep(150);
  }
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

async function createLineRecorder(target: string, outputPath: string): Promise<void> {
  await Tmux.create(target, `while IFS= read -r line; do printf '%s\\n' "$line" >> ${outputPath}; done`);
  await Bun.sleep(300);
}

describe("settle", () => {
  let db: StateDB;

  afterEach(async () => {
    for (const target of [NOTIFY_TARGET, GLOBAL_TARGET, SESSION_TARGET]) {
      try { await Tmux.kill(target); } catch {}
    }
    try { db.close(); } catch {}
    cleanup();
  });

  test("atomically updates DB and writes archive", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    db = new StateDB(TEST_DB);
    const archive = new Archive(TEST_ARCHIVE);
    const layout = new RuntimeLayout({ homeDir: "/tmp", tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);

    db.createSession({ id: "s1", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });

    await settle(db, archive, wakeup, "s1", "idle", { status: "idle", lastOutput: "done" });

    expect(db.getSession("s1")?.status).toBe("idle");
    const archived = archive.get("s1");
    expect(archived?.status).toBe("idle");
    expect(archived?.lastOutput).toBe("done");
  });

  test("rolls back DB on archive failure", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    db = new StateDB(TEST_DB);
    const badArchive = {
      save() { throw new Error("disk full"); },
      get() { return null; },
    } as unknown as Archive;
    const layout = new RuntimeLayout({ homeDir: "/tmp", tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);

    db.createSession({ id: "s2", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });

    await expect(settle(db, badArchive, wakeup, "s2", "idle", { status: "idle" })).rejects.toThrow("disk full");

    expect(db.getSession("s2")?.status).toBe("running");
  });

  test("StateDB.transaction rolls back on throw", () => {
    db = new StateDB(TEST_DB);
    db.createSession({ id: "tx1", parentId: "p", agentType: "claude-code", task: "t", ownerToken: "tok", projectPath: "/tmp" });

    expect(() => {
      db.transaction(() => {
        db.updateStatus("tx1", "idle");
        throw new Error("boom");
      });
    }).toThrow("boom");

    expect(db.getSession("tx1")?.status).toBe("running");
  });

  test("notifies a configured tmux target on terminal status", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    mkdirSync(join(TEST_HOME, ".ahelpa"), { recursive: true });
    db = new StateDB(TEST_DB);
    const archive = new Archive(TEST_ARCHIVE);
    const layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);
    const notifyPath = join(TEST_HOME, "notify-target.txt");
    writeFileSync(layout.configPath(), JSON.stringify({ notify: { tmux: NOTIFY_TARGET } }));
    await createLineRecorder(NOTIFY_TARGET, notifyPath);

    db.createSession({
      id: "notify-1",
      parentId: "p",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: TEST_PROJECT,
      label: "chief label",
    });

    await settle(db, archive, wakeup, "notify-1", SESSION_STATUS.NeedsAttention, {
      status: SESSION_STATUS.NeedsAttention,
      lastOutput: "stuck",
    }, { layout });

    const expected = `【ahelpa:chief label】needs_attention. summary: ${TEST_PROJECT}/.ahelpa/notify-1/summary.md`;
    const output = await waitForFile(notifyPath, expected);
    expect(output).toContain(expected);
  });

  test("does not notify for draining status", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    db = new StateDB(TEST_DB);
    const archive = new Archive(TEST_ARCHIVE);
    const layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);
    await Tmux.create(NOTIFY_TARGET, "bash");
    await Bun.sleep(300);

    db.createSession({
      id: "drain-1",
      parentId: "p",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: TEST_PROJECT,
      notifyTmux: NOTIFY_TARGET,
    });

    await settle(db, archive, wakeup, "drain-1", SESSION_STATUS.Draining, {
      status: SESSION_STATUS.Draining,
      lastOutput: "draining",
    }, { layout });
    await Bun.sleep(400);

    const output = await Tmux.capture(NOTIFY_TARGET, 40);
    expect(output).not.toContain("ahelpa:drain-1");
  });

  test("skips a missing tmux target without breaking settlement", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    db = new StateDB(TEST_DB);
    const archive = new Archive(TEST_ARCHIVE);
    const layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);
    db.createSession({
      id: "missing-target-1",
      parentId: "p",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: TEST_PROJECT,
      notifyTmux: "ahelpa-test-settle-missing",
    });

    await settle(db, archive, wakeup, "missing-target-1", SESSION_STATUS.Dead, {
      status: SESSION_STATUS.Dead,
      reason: "gone",
    }, { layout });

    expect(db.getSession("missing-target-1")?.status).toBe(SESSION_STATUS.Dead);
    expect(archive.get("missing-target-1")?.status).toBe(SESSION_STATUS.Dead);
  });

  test("per-session tmux target overrides global config", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    mkdirSync(join(TEST_HOME, ".ahelpa"), { recursive: true });
    db = new StateDB(TEST_DB);
    const archive = new Archive(TEST_ARCHIVE);
    const layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);
    const globalPath = join(TEST_HOME, "global-target.txt");
    const sessionPath = join(TEST_HOME, "session-target.txt");
    writeFileSync(layout.configPath(), JSON.stringify({ notify: { tmux: GLOBAL_TARGET } }));
    await createLineRecorder(GLOBAL_TARGET, globalPath);
    await createLineRecorder(SESSION_TARGET, sessionPath);
    db.createSession({
      id: "override-1",
      parentId: "p",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: TEST_PROJECT,
      notifyTmux: SESSION_TARGET,
    });

    await settle(db, archive, wakeup, "override-1", SESSION_STATUS.Error, {
      status: SESSION_STATUS.Error,
      lastOutput: "bad",
    }, { layout });

    const expected = `【ahelpa:override-1】error. summary: ${TEST_PROJECT}/.ahelpa/override-1/summary.md`;
    expect(await waitForFile(sessionPath, expected)).toContain(expected);
    await Bun.sleep(400);
    expect(existsSync(globalPath) ? readFileSync(globalPath, "utf-8") : "").not.toContain("ahelpa:override-1");
  });

  test("runs command hook with env and logs nonzero failures without breaking settlement", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    mkdirSync(join(TEST_HOME, ".ahelpa"), { recursive: true });
    db = new StateDB(TEST_DB);
    const archive = new Archive(TEST_ARCHIVE);
    const layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);
    const hookPath = join(TEST_HOME, "hook.txt");
    writeFileSync(
      layout.configPath(),
      JSON.stringify({
        notify: {
          command: `printf "$AHELPA_SESSION_ID|$AHELPA_STATUS|$AHELPA_LABEL|$AHELPA_PROJECT" > ${hookPath}; exit 7`,
        },
      }),
    );
    db.createSession({
      id: "cmd-fail-1",
      parentId: "p",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: TEST_PROJECT,
      label: "cmd label",
    });

    await settle(db, archive, wakeup, "cmd-fail-1", SESSION_STATUS.Error, {
      status: SESSION_STATUS.Error,
      lastOutput: "bad",
    }, { layout });

    expect(db.getSession("cmd-fail-1")?.status).toBe(SESSION_STATUS.Error);
    expect(await waitForFile(hookPath, "cmd-fail-1|error|cmd label|")).toBe(`cmd-fail-1|error|cmd label|${TEST_PROJECT}`);
    expect(await waitForFile(layout.daemonLogPath(), "command exited 7 for cmd-fail-1")).toContain("command exited 7 for cmd-fail-1");
  });

  test("does not notify the same session status twice", async () => {
    mkdirSync(TEST_TMP, { recursive: true });
    mkdirSync(TEST_HOME, { recursive: true });
    db = new StateDB(TEST_DB);
    const archive = new Archive(TEST_ARCHIVE);
    const layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });
    const wakeup = new Wakeup(layout);
    const notifyPath = join(TEST_HOME, "notify-lines.txt");
    await createLineRecorder(NOTIFY_TARGET, notifyPath);
    db.createSession({
      id: "once-1",
      parentId: "p",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: TEST_PROJECT,
      notifyTmux: NOTIFY_TARGET,
    });

    await settle(db, archive, wakeup, "once-1", SESSION_STATUS.Dead, { status: SESSION_STATUS.Dead }, { layout });
    await settle(db, archive, wakeup, "once-1", SESSION_STATUS.Dead, { status: SESSION_STATUS.Dead }, { layout });

    const body = await waitForFile(notifyPath, "【ahelpa:once-1】dead.");
    expect(body.split("\n").filter((line) => line.includes("ahelpa:once-1"))).toHaveLength(1);
  });
});
