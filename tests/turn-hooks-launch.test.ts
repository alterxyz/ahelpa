import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { getDriver } from "../src/drivers/registry";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { defaultWakeup } from "../src/wakeup";
import * as daemon from "../src/daemon";

let root: string;
let db: StateDB;
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".ahelpa", "hook-launch-test-"));
  db = new StateDB(join(root, "state.db"));
  spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
  spyOn(defaultWakeup, "prepare").mockResolvedValue();
  spyOn(Tmux, "hasSession").mockResolvedValue(false);
  spyOn(Tmux, "capture").mockResolvedValue("");
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  spyOn(Tmux, "kill").mockResolvedValue();
  for (const agent of ["codex", "claude-code"]) {
    spyOn(getDriver(agent), "prepareForTask").mockResolvedValue();
    spyOn(getDriver(agent), "prepareForResume").mockResolvedValue();
    spyOn(getDriver(agent), "afterTaskSubmitted").mockResolvedValue(true);
  }
});
afterEach(() => {
  for (const row of db.listSessions()) {
    try { rmSync(defaultRuntimeLayout.taskFilePath(row.id), { force: true }); } catch {}
  }
  db.close(); mock.restore(); rmSync(root, { recursive: true, force: true });
});

describe("hook launch orchestration", () => {
  for (const agent of ["claude-code", "codex"]) {
    test.each(["launch", "resume"])(`${agent} %s creates only its new session resources before tmux starts`, async kind => {
      const create = spyOn(Tmux, "create").mockImplementation(async (id, command) => {
        expect(db.getSession(id)?.launchPid).toBe(process.pid);
        expect(existsSync(defaultRuntimeLayout.sessionDeliveryDir(root, id))).toBe(true);
        if (agent === "claude-code") {
          const file = defaultRuntimeLayout.claudeSettingsPath(root, id);
          expect(command).toContain(`--settings '${file}'`);
          expect(JSON.parse(readFileSync(file, "utf8")).hooks.StopFailure).toBeTruthy();
        } else {
          expect(command).toContain("notify=");
          expect(command).toContain(defaultRuntimeLayout.sessionDeliveryDir(root, id));
        }
      });
      if (kind === "launch") {
        await executeLaunch(planLaunch({ db, agentType: agent, task: "fixture", projectPath: root, parentId: "host" }));
      } else {
        db.createSession({ id: "old", parentId: "host", agentType: agent, task: "fixture", ownerToken: "tok", projectPath: root });
        db.updateStatus("old", "dead");
        db.updateResumeId("old", "native-thread");
        const result = await resume({ db, sessionId: "old", ownerToken: "tok" });
        expect(db.getSession(result.sessionId)?.status).toBe("needs_attention");
        expect(existsSync(defaultRuntimeLayout.sessionDeliveryDir(root, "old"))).toBe(false);
      }
      expect(create).toHaveBeenCalledTimes(1);
    });
  }

  test("failure after settings creation reclaims owned files and preserves a conflicting tmp task", async () => {
    const plan = planLaunch({ db, agentType: "claude-code", task: "fixture", projectPath: root, parentId: "host" });
    mkdirSync(defaultRuntimeLayout.tmpDir, { recursive: true });
    spyOn(Tmux, "create").mockImplementation(async () => {
      writeFileSync(plan.fileHandoff.taskFilePath, "foreign task");
    });
    try {
      await expect(executeLaunch(plan)).rejects.toThrow("Refusing to overwrite");
      expect(readFileSync(plan.fileHandoff.taskFilePath, "utf8")).toBe("foreign task");
      expect(existsSync(plan.fileHandoff.sessionDeliveryDir)).toBe(false);
      expect(db.getSession(plan.sessionId)).toBeNull();
    } finally { rmSync(plan.fileHandoff.taskFilePath, { force: true }); }
  });
});
