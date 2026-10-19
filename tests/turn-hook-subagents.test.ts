import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { COMPLETION_NUDGE, refreshSessionStatuses } from "../src/daemon";
import { readTurnEvents, turnHookCommand, writeTurnHook } from "../src/turn-hooks";

const input = "Please read and complete the task described in synthetic-task";
const main = "01a1440e-2994-7843-9a53-6f872804dac4";
const child = "01a1440e-a757-7f83-a65a-daa510ccf783";
let root: string, dir: string, db: StateDB;
let previousHome: string | undefined;
const timezoneState = () => ({
  env: process.env.TZ,
  offsets: [new Date("2026-01-15T12:00:00Z").getTimezoneOffset(), new Date("2026-07-15T12:00:00Z").getTimezoneOffset()],
});
let timezoneBefore: ReturnType<typeof timezoneState>;

beforeEach(() => {
  timezoneBefore = timezoneState();
  root = mkdtempSync(join(realpathSync(tmpdir()), "subagent-hooks-"));
  previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex-home");
  mkdirSync(process.env.CODEX_HOME);
  dir = join(root, ".ahelpa", "session-test");
  mkdirSync(dir, { recursive: true });
  db = new StateDB(join(root, "state.db"));
  const row = db.createSession({ id: "session-test", parentId: "host", agentType: "codex", task: "fixture", ownerToken: "tok", projectPath: root });
  db.beginTurn(row.id, row.version, input);
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "capture").mockResolvedValue("Working (1s • esc to interrupt)");
  spyOn(Tmux, "sendKeys").mockResolvedValue();
});

afterEach(() => {
  mock.restore();
  db.close();
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
  // Per-test sentinel: no dependency on another test file's execution order.
  expect(timezoneState()).toEqual(timezoneBefore);
});

function rollout(thread: string, source: unknown, delay = 0): string {
  const date = new Date(parseInt(thread.replaceAll("-", "").slice(0, 12), 16) + delay * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const path = join(process.env.CODEX_HOME!, "sessions", ...day.split("-"), `rollout-${day}T${time}-${thread}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: thread, source } }) + "\nsynthetic non-metadata content\n");
  return path;
}

function payload(thread: string, turn = "one", messages = [input]) {
  return JSON.stringify({ type: "agent-turn-complete", "thread-id": thread, "turn-id": turn, "input-messages": messages });
}

const subagent = { subagent: { thread_spawn: { parent_thread_id: main, depth: 1 } } };
const log = () => existsSync(join(dir, "turns.log")) ? readFileSync(join(dir, "turns.log"), "utf8") : "";

test("subagent completes first with matching input: no binding or settlement; main completion still settles", async () => {
  rollout(child, subagent);
  rollout(main, "cli");
  writeTurnHook(dir, "codex", payload(child));
  expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
  writeTurnHook(dir, "codex", payload(main));
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
  expect(log().trim().split("\n")).toHaveLength(1);
  expect(readTurnEvents(join(dir, "turns.log")).event?.threadId).toBe(main);
  expect(log()).not.toContain(child);
});

test("main completes first: later subagent cannot change its binding or settlement", async () => {
  rollout(main, "cli");
  rollout(child, subagent);
  writeTurnHook(dir, "codex", payload(main));
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
  const before = log();
  writeTurnHook(dir, "codex", payload(child));
  expect(log()).toBe(before);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
});

test.each(["missing", "missing-source", "malformed", "wrong-id", "oversized", "symlink", "late"])("unavailable metadata (%s) preserves first-event binding and settlement", async kind => {
  if (kind !== "missing") {
    const path = rollout(child, kind === "missing-source" ? undefined : subagent, kind === "late" ? 5 : 0);
    if (kind === "malformed") writeFileSync(path, "not json\n");
    if (kind === "wrong-id") writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: main, source: subagent } }) + "\n");
    if (kind === "oversized") writeFileSync(path, " ".repeat(64 * 1024) + JSON.stringify({ type: "session_meta", payload: { id: child, source: subagent } }) + "\n");
    if (kind === "symlink") {
      const target = join(root, "metadata");
      writeFileSync(target, readFileSync(path));
      rmSync(path);
      symlinkSync(target, path);
    }
  }
  writeTurnHook(dir, "codex", payload(child));
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
  writeTurnHook(dir, "codex", payload(main));
  expect(readTurnEvents(join(dir, "turns.log")).event?.threadId).toBe(child);
  expect(log().trim().split("\n")).toHaveLength(1);
});

test("bounded lookup includes a rollout created four seconds after the UUID", () => {
  rollout(child, subagent, 4);
  writeTurnHook(dir, "codex", payload(child));
  expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
});

test("native resume rejects an earlier child and binds the explicit thread without rollout metadata", async () => {
  writeTurnHook(dir, "codex", payload(child), main);
  expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
  const command = Bun.spawn([...turnHookCommand(dir, "codex", main), payload(main, "resumed", ["ordinary follow-up"])], { stdout: "pipe", stderr: "pipe" });
  expect(await command.exited).toBe(0);
  expect(await new Response(command.stdout).text()).toBe("");
  expect(await new Response(command.stderr).text()).toBe("");
  expect(readTurnEvents(join(dir, "turns.log")).event).toMatchObject({ threadId: main, turnId: "resumed" });
});

test("symlinked CODEX_HOME root still identifies a child through its real rollout path", async () => {
  const actualHome = process.env.CODEX_HOME!;
  const alias = join(root, "codex-home-alias");
  symlinkSync(actualHome, alias);
  process.env.CODEX_HOME = alias;
  rollout(child, subagent);
  writeTurnHook(dir, "codex", payload(child));
  expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
});

test("relative CODEX_HOME resolves against the same cwd for rollout and notify", async () => {
  const actualHome = process.env.CODEX_HOME!;
  process.env.CODEX_HOME = relative(process.cwd(), actualHome);
  expect(process.env.CODEX_HOME.startsWith("/")).toBe(false);
  rollout(child, subagent);
  writeTurnHook(dir, "codex", payload(child));
  expect(readTurnEvents(join(dir, "turns.log")).event).toBeNull();
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
});

const timeBoundaries = [
  { name: "local midnight", instant: "2026-01-14T23:59:58-08:00", day: "2026-01-15", time: "00-00-02" },
  { name: "month rollover", instant: "2026-04-30T23:59:58-07:00", day: "2026-05-01", time: "00-00-02" },
  { name: "year rollover", instant: "2026-12-31T23:59:58-08:00", day: "2027-01-01", time: "00-00-02" },
  { name: "spring DST gap", instant: "2026-03-08T01:59:58-08:00", day: "2026-03-08", time: "03-00-02" },
  { name: "fall DST fold", instant: "2026-11-01T01:59:58-07:00", day: "2026-11-01", time: "01-00-02" },
];

test.each(timeBoundaries)("four-second probe crosses $name", ({ instant, day, time }) => {
  const timestamp = Date.parse(instant).toString(16).padStart(12, "0");
  const thread = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-000000000001`;
  // Independent LA wall-clock oracle; never change the parent process's TZ.
  const path = join(process.env.CODEX_HOME!, "sessions", ...day.split("-"), `rollout-${day}T${time}-${thread}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: thread, source: subagent } }) + "\n");
  const script = `import { isKnownCodexSubagent } from ${JSON.stringify(join(import.meta.dir, "../src/drivers/codex-rollout.ts"))};
    console.log(isKnownCodexSubagent(${JSON.stringify(thread)}));`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, TZ: "America/Los_Angeles", CODEX_HOME: process.env.CODEX_HOME! },
    stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  expect({ exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() })
    .toEqual({ exit: 0, stdout: "true\n", stderr: "" });
});

test.each(["cli", "exec"])("main source %s preserves immediate summary completion nudge", async source => {
  rollout(main, source);
  writeFileSync(join(dir, "summary.md"), "Synthetic completed result\n");
  spyOn(Tmux, "capture").mockResolvedValue("Response complete\n\n› \n\n  GPT-6.1-Sol · ~/proj\n  ? for shortcuts");
  writeTurnHook(dir, "codex", payload(main));
  expect(readTurnEvents(join(dir, "turns.log")).event).toMatchObject({ threadId: main, event: "turn_complete" });
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("running");
  expect(db.getSession("session-test")?.nudgedAt).toBeTruthy();
  expect(db.getSession("session-test")?.turnHookOffset).toBeGreaterThan(0);
  expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
  expect(Tmux.sendKeys).toHaveBeenCalledWith("session-test", COMPLETION_NUDGE);
  await refreshSessionStatuses(db, ["session-test"]);
  expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
});

test("explicit resumeThread accepts its matching thread even when rollout source is subagent", async () => {
  rollout(main, subagent);
  writeTurnHook(dir, "codex", payload(main, "resumed"), main);
  expect(readTurnEvents(join(dir, "turns.log")).event).toMatchObject({ threadId: main, turnId: "resumed" });
  await refreshSessionStatuses(db, ["session-test"]);
  expect(db.getSession("session-test")?.status).toBe("needs_attention");
});
