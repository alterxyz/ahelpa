import { afterEach, beforeEach, describe, expect, spyOn, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Wakeup } from "../src/wakeup";
import { RuntimeLayout } from "../src/runtime-layout";
import { StateDB } from "../src/state";
import { wait } from "../src/commands/wait";
import * as daemon from "../src/daemon";

let TEST_TMP: string;
let TEST_DB: string;
let scratch: string;

describe("wakeup protocol", () => {
  let wakeup: Wakeup;

  beforeEach(() => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-wakeup-"));
    TEST_TMP = join(scratch, "tmp");
    TEST_DB = join(scratch, "state.db");
    mkdirSync(TEST_TMP, { recursive: true });
    wakeup = new Wakeup(new RuntimeLayout({ tmpDir: TEST_TMP }));
  });

  afterEach(() => {
    mock.restore();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("notify wakes a blocked awaitWakeup with the event payload", async () => {
    await wakeup.prepare("s1");

    const pending = wakeup.awaitWakeup("s1", 5000);
    await Bun.sleep(100);
    await wakeup.notify("s1", "idle");

    expect(await pending).toEqual({ sessionId: "s1", status: "idle" });
  });

  test("notify without a listener drops the event without blocking", async () => {
    await wakeup.prepare("s1");

    const start = Date.now();
    await wakeup.notify("s1", "idle");
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("notify after cleanup is a no-op", async () => {
    await wakeup.prepare("s1");
    wakeup.cleanup("s1");

    await wakeup.notify("s1", "idle");
    expect(await wakeup.awaitWakeup("s1", 50)).toBeNull();
  });

  test("awaitWakeup times out to null", async () => {
    await wakeup.prepare("s1");
    expect(await wakeup.awaitWakeup("s1", 100)).toBeNull();
  });

  test("a daemon notify wakes a blocked wait before any polling interval", async () => {
    const db = new StateDB(TEST_DB);
    db.createSession({
      id: "wake-session",
      parentId: "cli-root",
      agentType: "claude-code",
      task: "t",
      ownerToken: "tok",
      projectPath: "/tmp",
    });
    await wakeup.prepare("wake-session");
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);

    const waiting = wait(db, ["wake-session"], false, 30000, wakeup);
    await Bun.sleep(300);

    db.updateStatus("wake-session", "idle");
    const notified = Date.now();
    await wakeup.notify("wake-session", "idle");

    const result = await waiting;
    const latency = Date.now() - notified;

    expect(result).toEqual({
      sessionId: "wake-session",
      status: "idle",
      evidence: expect.objectContaining({ summaryBytes: 0 }),
    });
    // Well under the 5s slice fallback: proves the pipe woke us, not polling.
    expect(latency).toBeLessThan(1500);

    db.close();
  });
});
