import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { daemonLoop, startDaemon } from "../src/daemon";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import type { StateDB } from "../src/state";

let root: string;
let logPath: string;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "daemon-loop-errors-"));
  logPath = join(root, "daemon.log");
  spyOn(defaultRuntimeLayout, "daemonLogPath").mockReturnValue(logPath);
  spyOn(defaultRuntimeLayout, "daemonWakePath").mockReturnValue(join(root, "daemon.wake"));
  spyOn(Bun, "sleep").mockResolvedValue();
});

afterEach(() => {
  mock.restore();
  rmSync(root, { recursive: true, force: true });
});

describe("daemonLoop outer error handling", () => {
  test("a failing poll is logged and the loop keeps going", async () => {
    const calls: Array<() => unknown[]> = [
      () => { throw new Error("poll-failed-once-7f3a"); },
      () => [],
    ];
    const db = { listActiveSessions: () => calls.shift()!() } as unknown as StateDB;

    await daemonLoop(db);

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("daemon loop failed");
    expect(log).toContain("poll-failed-once-7f3a");
  });

  test("ten consecutive failures make the loop exit with a log", async () => {
    const db = { listActiveSessions: () => { throw new Error("poll-failed-forever-b2c9"); } } as unknown as StateDB;

    const failure: unknown = await daemonLoop(db).then(() => null, (error) => error);
    expect(failure).toBeInstanceOf(Error);

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("exiting after 10 consecutive loop failures");
    expect(log).toContain("poll-failed-forever-b2c9");
  });
});

describe("startDaemon spawn failure", () => {
  test("is logged and observed as a stopped daemon", () => {
    const pidPath = join(root, "daemon.pid");
    spyOn(defaultRuntimeLayout, "daemonPidPath").mockReturnValue(pidPath);
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error("spawn-exploded-e41d");
    });
    try {
      startDaemon();
    } finally {
      spawn.mockRestore();
    }
    expect(readFileSync(logPath, "utf8")).toContain("daemon start failed");
    expect(readFileSync(logPath, "utf8")).toContain("spawn-exploded-e41d");
    expect(existsSync(pidPath)).toBe(false);
  });
});
