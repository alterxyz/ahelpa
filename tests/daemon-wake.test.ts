import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { daemonLoop, refreshSessionStatuses, waitForWake } from "../src/daemon";
import { FIFO } from "../src/fifo";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { writeTurnHook } from "../src/turn-hooks";

let root: string;
let wake: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "daemon-wake-"));
  wake = join(root, "daemon.wake");
  spyOn(defaultRuntimeLayout, "daemonWakePath").mockReturnValue(wake);
});
afterEach(() => { mock.restore(); rmSync(root, { recursive: true, force: true }); });

test("a turn-end hook cuts the daemon's wait short", async () => {
  await FIFO.create(wake);
  const started = Date.now();
  const waiting = waitForWake(wake, 3000);
  await Bun.sleep(100);
  // The Codex notify payload, as the hook receives it at turn end.
  const dir = join(root, ".ahelpa", "codex-fixture");
  mkdirSync(dir, { recursive: true });
  writeTurnHook(dir, "codex", readFileSync(join(import.meta.dir, "fixtures/turn-hooks/codex-complete.json"), "utf8"));
  expect(existsSync(join(dir, "turns.log"))).toBe(true);
  expect(await waiting).toBe(true);
  expect(Date.now() - started).toBeLessThan(1500);
});

test("a prompt event does not wake the daemon", () => {
  const write = spyOn(FIFO, "tryWrite");
  const dir = join(root, ".ahelpa", "claude-fixture");
  mkdirSync(dir, { recursive: true });
  writeTurnHook(dir, "claude-code", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", prompt: "hello" }));
  expect(existsSync(join(dir, "turns.log"))).toBe(true);
  expect(write).not.toHaveBeenCalled();
  writeTurnHook(dir, "claude-code", JSON.stringify({ hook_event_name: "Stop", session_id: "s1", prompt_id: "p1" }));
  expect(write).toHaveBeenCalledTimes(1);
});

test("without the pipe the wait is the plain poll", async () => {
  const started = Date.now();
  expect(await waitForWake(undefined, 300)).toBe(false);
  expect(await waitForWake(join(root, "missing.wake"), 300)).toBe(false);
  expect(Date.now() - started).toBeGreaterThanOrEqual(580);
});

test("the wake path is used only as a pipe: never a regular file, never through a link", async () => {
  writeFileSync(wake, "IMPORTANT FILE CONTENT");
  expect(await FIFO.tryWrite(wake, "turn")).toBe(false);
  const target = join(root, "target");
  writeFileSync(target, "ORIGINAL");
  const link = join(root, "link.wake");
  symlinkSync(target, link);
  expect(await FIFO.tryWrite(link, "turn")).toBe(false);
  expect(readFileSync(wake, "utf8")).toBe("IMPORTANT FILE CONTENT");
  expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
  // A file is not a wake on every read, and the daemon still starts on a plain poll.
  const started = Date.now();
  expect(await waitForWake(wake, 300)).toBe(false);
  expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  await daemonLoop(new StateDB(":memory:"));
});

test("a wake refresh settles a sentinel but never spends another helper's patience", async () => {
  const db = new StateDB(":memory:");
  const TASK = "Please read and complete the task described in /tmp/ahelpa-task-kimi.md.";
  for (const id of ["kimi-quiet", "kimi-done"]) {
    db.createSession({ id, parentId: "p", agentType: "kimi", task: "t", ownerToken: "tok", projectPath: "/tmp" });
  }
  spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(session => session.id)));
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  spyOn(Tmux, "sendKey").mockResolvedValue();
  spyOn(Tmux, "capture").mockImplementation(async (id) => id === "kimi-done"
    ? `${TASK}\n[AHELPA:DONE]\n│ >   │\ncontext: 0%`
    // Quiet with no signal: four polls of this reach the no-sentinel fallback.
    : `${TASK}\n▶ Run this command?\n1. Approve once\n2. Approve for this session\n↵ confirm`);
  await refreshSessionStatuses(db, ["kimi-quiet"]);
  for (let wakes = 0; wakes < 6; wakes++) await refreshSessionStatuses(db, undefined, Date.now(), true);
  // DONE settles at once; the daemon then starts the graceful exit.
  expect(["idle", "draining"]).toContain(db.getSession("kimi-done")!.status);
  expect(db.getSession("kimi-quiet")?.status).toBe("running");
  for (let polls = 0; polls < 3; polls++) await refreshSessionStatuses(db, ["kimi-quiet"]);
  expect(db.getSession("kimi-quiet")?.status).toBe("needs_attention");
  db.close();
});

test("a host waiting on a wake path that is not a pipe keeps its pace and does not throw", async () => {
  // A link to a pipe, and a regular file: neither is read, and the read waits out its budget.
  await FIFO.create(wake);
  const link = join(root, "link.pipe");
  symlinkSync(wake, link);
  const file = join(root, "file.pipe");
  writeFileSync(file, "");
  for (const path of [link, file]) {
    const started = Date.now();
    expect(await FIFO.read(path, 200)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  }
});
