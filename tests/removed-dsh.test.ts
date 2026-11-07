import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Archive } from "../src/archive";
import { runCli } from "../src/command-contract";
import { clean } from "../src/commands/session-ops";
import * as daemon from "../src/daemon";
import { defaultRuntimeLayout, RuntimeLayout } from "../src/runtime-layout";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";

let root: string;
let db: StateDB;
let layout: RuntimeLayout;
const removedMessage = "dsh was removed on 2026-11-06";

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-removed-dsh-"));
  layout = new RuntimeLayout({ homeDir: root, tmpDir: root, ahelpaDir: join(root, "runtime") });
  db = new StateDB(":memory:");
  spyOn(defaultRuntimeLayout, "ahelpaHomeDir").mockReturnValue(join(root, "runtime"));
  spyOn(defaultRuntimeLayout, "needHelpLedgerPath").mockReturnValue(join(root, "need-help.jsonl"));
  spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(join(root, "archive"));
  spyOn(defaultRuntimeLayout, "daemonLogPath").mockReturnValue(join(root, "daemon.log"));
  spyOn(defaultRuntimeLayout, "fifoPath").mockImplementation(id => layout.fifoPath(id));
  spyOn(defaultRuntimeLayout, "taskFilePath").mockImplementation(id => layout.taskFilePath(id));
  spyOn(daemon, "isDaemonRunning").mockReturnValue(false);
});
afterEach(() => {
  mock.restore();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function session(harness = "dsh") {
  const id = `${harness}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  db.createSession({ id, agentType: harness, parentId: "owner", ownerToken: "tok", task: "old task", projectPath: root });
  return id;
}
async function cli(args: string[]) {
  const output: string[] = [], errors: string[] = [];
  const exitCode = await runCli(db, args, { print: text => output.push(text), printError: text => errors.push(text) });
  return { exitCode, output: output.join("\n"), errors: errors.join("\n") };
}

test.each(["status", "check"])("%s refreshes retired DSH safely and continues monitoring another harness", async command => {
  const retired = session();
  const active = session("codex");
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(row => row.id)));
  const captures = spyOn(Tmux, "capture").mockImplementation(async id => id === retired ? "old DSH output" : "[AHELPA:NEED_HELP]");

  const result = await cli([command]);

  expect(result.exitCode).toBe(0);
  expect(result.errors).toBe("");
  expect(result.output).toContain(retired);
  expect(result.output).toContain(removedMessage);
  expect(db.getSession(retired)?.status).toBe("needs_attention");
  expect(db.getSession(active)?.status).toBe("error");
  expect(new Archive(join(root, "archive")).get(retired)).toMatchObject({
    status: "needs_attention", reason: removedMessage, lastOutput: "old DSH output",
  });
  await daemon.refreshSessionStatuses(db);
  expect(captures.mock.calls.filter(args => args[0] === retired)).toHaveLength(1);
  expect(existsSync(join(root, "daemon.log"))).toBe(false);
});

test("daemon refresh still reclaims a retired draining terminal without resolving a driver", async () => {
  const id = session();
  db.updateStatus(id, "draining");
  const since = Date.parse(db.getSession(id)!.updatedAt);
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(row => row.id)));
  const capture = spyOn(Tmux, "capture").mockResolvedValue("old DSH output");
  const kill = spyOn(Tmux, "kill").mockResolvedValue();

  await daemon.refreshSessionStatuses(db, [id], since + 16_000);

  expect(kill).toHaveBeenCalledWith(id);
  expect(capture).not.toHaveBeenCalled();
  expect(db.getSession(id)?.status).toBe("idle");
  expect(readFileSync(join(root, "daemon.log"), "utf8")).not.toContain("resume token capture failed");
});

test("retired DSH logs, kill, and clean remain usable without its driver", async () => {
  const id = session();
  let alive = true;
  spyOn(Tmux, "hasSession").mockImplementation(async () => alive);
  spyOn(Tmux, "capture").mockResolvedValue("retained DSH log");
  const kill = spyOn(Tmux, "kill").mockImplementation(async () => { alive = false; });
  expect(await cli(["logs", id, "--token", "tok"])).toEqual({ exitCode: 0, output: "retained DSH log", errors: "" });

  expect((await cli(["kill", id, "--token", "tok"])).exitCode).toBe(0);

  expect(kill).toHaveBeenCalledWith(id);
  expect(alive).toBe(false);
  expect(db.getSession(id)?.status).toBe("dead");
  expect((await cli(["logs", id, "--token", "tok"])).output).toBe("retained DSH log");
  expect((await clean(db, layout)).removed).toBe(1);
  expect(db.getSession(id)).toBeNull();
});

test("missing retired DSH terminal settles dead and can be cleaned", async () => {
  const id = session();
  spyOn(Tmux, "hasSession").mockResolvedValue(false);
  spyOn(Tmux, "liveSessionNames").mockResolvedValue(new Set());
  await daemon.refreshSessionStatuses(db);
  expect(db.getSession(id)?.status).toBe("dead");
  expect((await cli(["status"])).exitCode).toBe(0);
  expect((await cli(["check"])).exitCode).toBe(0);
  expect((await clean(db, layout)).removed).toBe(1);
});

test.each(["running", "idle", "dead"] as const)("retired DSH in %s refuses send, task, resume, and model before side effects", async status => {
  const id = session();
  db.updateStatus(id, status);
  db.updateResumeId(id, "old-native-session");
  const before = db.getSession(id);
  const send = spyOn(Tmux, "sendKeys").mockResolvedValue();
  const create = spyOn(Tmux, "create").mockResolvedValue();
  const capture = spyOn(Tmux, "capture").mockResolvedValue("");
  const missingTask = join(root, "missing-task.md");
  for (const args of [
    ["send", id, "new work", "--token", "tok"],
    ["task", id, "--file", missingTask, "--token", "tok"],
    ["resume", id, "--token", "tok"],
    ["model", id, "--to", "any-model", "--token", "tok"],
  ]) {
    const result = await cli(args);
    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain(removedMessage);
    expect(result.output).toBe("");
  }
  expect(send).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  expect(db.getSession(id)).toEqual(before);
  expect(db.listSessions()).toHaveLength(1);
  expect(existsSync(join(root, ".ahelpa"))).toBe(false);
});
