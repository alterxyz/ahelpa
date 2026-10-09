import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { runCli } from "../src/command-contract";
import { Tmux } from "../src/tmux";
import * as daemon from "../src/daemon";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { defaultWakeup } from "../src/wakeup";
import { writeTurnHook } from "../src/turn-hooks";

let root: string;
let db: StateDB;
let caller: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".ahelpa", "mail-stack-test-"));
  db = new StateDB(join(root, "state.db"));
  caller = process.env.AHELPA_PARENT_ID;
  process.env.AHELPA_PARENT_ID = "mail-stack-sender";
  spyOn(daemon, "isDaemonRunning").mockReturnValue(false);
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "capture").mockResolvedValue("✻ Working… (1s)");
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  for (const id of ["mail-stack-sender", "mail-stack-recipient"]) {
    db.createSession({ id, parentId: "host", agentType: "claude-code", task: "fixture",
      ownerToken: "tok", projectPath: root, jobId: "mail-stack-job", mailBudget: 8 });
  }
});

afterEach(() => {
  for (const row of db.listSessions()) defaultWakeup.cleanup(row.id);
  db.close();
  mock.restore();
  if (caller === undefined) delete process.env.AHELPA_PARENT_ID;
  else process.env.AHELPA_PARENT_ID = caller;
  rmSync(root, { recursive: true, force: true });
});

async function sendMail() {
  const errors: string[] = [];
  const exitCode = await runCli(db, ["mail", "mail-stack-recipient", "--text", "Please check this edge case"], {
    print: () => {}, printError: text => errors.push(text),
  });
  return { exitCode, errors };
}

test("mail inline refresh attributes StopFailure before deciding recipient eligibility", async () => {
  const id = "mail-stack-recipient";
  const input = "Inspect the parser edge case";
  db.beginTurn(id, db.getSession(id)!.version, input);
  const dir = defaultRuntimeLayout.sessionDeliveryDir(root, id);
  mkdirSync(dir, { recursive: true });
  writeTurnHook(dir, "claude-code", JSON.stringify({ hook_event_name: "UserPromptSubmit",
    session_id: "mail-native", prompt_id: "mail-turn", prompt: input }));
  writeTurnHook(dir, "claude-code", JSON.stringify({ hook_event_name: "StopFailure",
    session_id: "mail-native", prompt_id: "mail-turn", error: "authentication_failed" }));

  const result = await sendMail();
  expect(result.exitCode).toBe(1);
  expect(result.errors.join("\n")).toContain("needs_attention");
  expect(db.getSession(id)?.status).toBe("needs_attention");
  expect(db.getSession(id)?.turnHookOffset).toBeGreaterThan(0);
  expect(db.peerMailCounts("mail-stack-sender").sent).toBe(0);
  expect(db.listPeerMail(id)).toEqual([]);
  expect(Tmux.sendKeys).not.toHaveBeenCalled();
});

test("mail inline refresh preserves a live startup lease and refuses delivery", async () => {
  const id = "mail-stack-launching";
  db.createSession({ id, parentId: "host", agentType: "claude-code", task: "starting",
    ownerToken: "tok", projectPath: root, jobId: "mail-stack-job", launchPid: process.pid });
  const errors: string[] = [];
  const exitCode = await runCli(db, ["mail", id, "--text", "Please check this edge case"], {
    print: () => {}, printError: text => errors.push(text),
  });
  expect(exitCode).toBe(1);
  expect(errors.join("\n")).toContain("still launching");
  expect(db.getSession(id)).toMatchObject({ status: "running", launchPid: process.pid });
  expect(Tmux.capture).not.toHaveBeenCalledWith(id, expect.anything());
  expect(db.peerMailCounts("mail-stack-sender").sent).toBe(0);
  expect(db.listPeerMail(id)).toEqual([]);
  expect(Tmux.sendKeys).not.toHaveBeenCalled();
});
