import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { waitForNextPoll } from "../src/daemon";
import { FIFO } from "../src/fifo";
import { defaultRuntimeLayout } from "../src/runtime-layout";
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
  const waiting = waitForNextPoll(wake, 3000);
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
  expect(await waitForNextPoll(undefined, 300)).toBe(false);
  expect(await waitForNextPoll(join(root, "missing.wake"), 300)).toBe(false);
  expect(Date.now() - started).toBeGreaterThanOrEqual(580);
});
