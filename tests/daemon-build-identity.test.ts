import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildIdentity, daemonBuildWarning, runningDaemonBuild, startDaemon, stopDaemon } from "../src/daemon";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { StateDB } from "../src/state";
import { status } from "../src/commands/session-ops";
import { runCli } from "../src/command-contract";
import { VERSION } from "../src/version";

// The pid file holds this process's pid: alive for process.kill(pid, 0), and
// no code path here ever delivers a real signal to it.
const ALIVE_PID = String(process.pid);

let root: string;
let pidPath: string;
let buildPath: string;
let db: StateDB;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "daemon-build-identity-"));
  pidPath = join(root, "daemon.pid");
  buildPath = join(root, "daemon.build");
  db = new StateDB(join(root, "state.db"));
  spyOn(defaultRuntimeLayout, "daemonPidPath").mockReturnValue(pidPath);
  spyOn(defaultRuntimeLayout, "daemonBuildPath").mockReturnValue(buildPath);
});

afterEach(() => {
  mock.restore();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("buildIdentity", () => {
  test("changes when the program file's mtime changes", () => {
    const program = join(root, "program");
    writeFileSync(program, "#!/bin/sh\n");
    // A moduleDir without cli.ts: the program is the execPath itself.
    const moduleDir = join(root, "module");
    mkdirSync(moduleDir);
    utimesSync(program, new Date(1_000_000), new Date(1_000_000));
    const first = buildIdentity(program, moduleDir);
    expect(first).toContain(VERSION);
    expect(first).toContain(program);
    utimesSync(program, new Date(2_000_000), new Date(2_000_000));
    const second = buildIdentity(program, moduleDir);
    expect(second).toContain(program);
    expect(second).not.toBe(first);
  });

  test("a symlink to the program is the same build as the program", () => {
    const program = join(root, "program");
    writeFileSync(program, "#!/bin/sh\n");
    const link = join(root, "link");
    symlinkSync(program, link);
    const moduleDir = join(root, "module");
    mkdirSync(moduleDir);
    expect(buildIdentity(link, moduleDir)).toBe(buildIdentity(program, moduleDir));
  });
});

describe("daemonBuildWarning", () => {
  test("is undefined when the recorded build matches the current one", () => {
    writeFileSync(pidPath, ALIVE_PID);
    writeFileSync(buildPath, "current-build");
    expect(daemonBuildWarning("current-build")).toBeUndefined();
  });

  test("names both identities when they differ", () => {
    writeFileSync(pidPath, ALIVE_PID);
    writeFileSync(buildPath, "recorded-build");
    const warning = daemonBuildWarning("current-build");
    expect(warning).toContain("recorded-build");
    expect(warning).toContain("current-build");
  });

  test("says unknown when no build was recorded", () => {
    writeFileSync(pidPath, ALIVE_PID);
    const warning = daemonBuildWarning("current-build");
    expect(warning).toContain("unknown");
  });

  test("is undefined when no daemon is running", () => {
    // pid file absent; a recorded build alone warns nobody.
    writeFileSync(buildPath, "recorded-build");
    expect(daemonBuildWarning("current-build")).toBeUndefined();
  });
});

describe("the daemon build in command output", () => {
  test("status's first line names the recorded build of a running daemon", () => {
    writeFileSync(buildPath, "recorded-build");
    expect(runningDaemonBuild()).toBe("recorded-build");
    expect(status(db, true).split("\n")[0]).toBe("ahelpa daemon: running (build recorded-build)");
  });

  test("runCli status prints the warning to stderr, the status to stdout", async () => {
    writeFileSync(pidPath, ALIVE_PID);
    writeFileSync(buildPath, "recorded-build");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(db, ["status"], {
      print: (text) => out.push(text),
      printError: (text) => err.push(text),
    });
    expect(code).toBe(0);
    expect(out[0]).toContain("ahelpa daemon: running");
    expect(out[0]).not.toContain("warning:");
    expect(err.join("\n")).toContain("warning: the running daemon is build recorded-build");
  });
});

describe("the build file's lifecycle", () => {
  test("startDaemon records its build identity next to the pid", () => {
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => ({
      exitCode: 0,
      stdout: Buffer.from("4242\n"),
      stderr: Buffer.from(""),
    }) as ReturnType<typeof Bun.spawnSync>);
    try {
      startDaemon();
    } finally {
      spawn.mockRestore();
    }
    expect(readFileSync(pidPath, "utf8")).toBe("4242");
    expect(readFileSync(buildPath, "utf8")).toBe(buildIdentity());
  });

  test("stopDaemon removes the build file together with the pid file", () => {
    // "not-a-pid" parses to NaN, so nothing is ever signalled.
    writeFileSync(pidPath, "not-a-pid");
    writeFileSync(buildPath, "recorded-build");
    stopDaemon();
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(buildPath)).toBe(false);
  });
});
