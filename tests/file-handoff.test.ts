import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { RuntimeLayout } from "../src/runtime-layout";
import {
  buildTaskInstruction,
  isTaskInstructionEcho,
  planFileHandoff,
  prepareFileHandoff,
} from "../src/file-handoff";
import { SENTINEL } from "../src/drivers/sentinels";

const TEST_TMP = "/tmp/ahelpa-file-handoff-test-tmp";
const TEST_HOME = "/tmp/ahelpa-file-handoff-test-home";
const TEST_PROJECT = "/tmp/ahelpa-file-handoff-test-project";

describe("file handoff", () => {
  afterEach(() => {
    rmSync(TEST_TMP, { recursive: true, force: true });
    rmSync(TEST_HOME, { recursive: true, force: true });
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  test("plans task and result paths from project plus session", () => {
    const layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });

    const plan = planFileHandoff(TEST_PROJECT, "codex-abc123", layout);

    expect(plan.taskFilePath).toBe(`${TEST_TMP}/ahelpa-task-codex-abc123.md`);
    expect(plan.projectDeliveryDir).toBe(`${TEST_PROJECT}/.ahelpa`);
    expect(plan.sessionDeliveryDir).toBe(`${TEST_PROJECT}/.ahelpa/codex-abc123`);
    expect(plan.summaryPath).toBe(`${TEST_PROJECT}/.ahelpa/codex-abc123/summary.md`);
    expect(plan.artifactsDir).toBe(`${TEST_PROJECT}/.ahelpa/codex-abc123/artifacts`);
  });

  test("prepares task file and result artifact directory", () => {
    const layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });
    const plan = planFileHandoff(TEST_PROJECT, "claude-abc123", layout);

    prepareFileHandoff(plan, "do the work");

    expect(readFileSync(plan.taskFilePath, "utf-8")).toBe("do the work");
    expect(existsSync(plan.sessionDeliveryDir)).toBe(true);
    expect(existsSync(plan.artifactsDir)).toBe(true);
  });

  test("instruction teaches task file, result directory, artifacts, and sentinels", () => {
    const instruction = buildTaskInstruction({
      taskFilePath: "/tmp/ahelpa/ahelpa-task-abc.md",
      sessionDeliveryDir: "/project/.ahelpa/abc",
      summaryPath: "/project/.ahelpa/abc/summary.md",
      artifactsDir: "/project/.ahelpa/abc/artifacts",
    });

    expect(instruction).toContain("/tmp/ahelpa/ahelpa-task-abc.md");
    expect(instruction).toContain("/project/.ahelpa/abc");
    expect(instruction).toContain("/project/.ahelpa/abc/summary.md");
    expect(instruction).toContain("/project/.ahelpa/abc/artifacts");
    expect(instruction).toContain(SENTINEL.Done);
    expect(instruction).toContain(SENTINEL.NeedHelp);
  });

  test("instruction echo detection matches the handoff instruction prefix", () => {
    const plan = planFileHandoff(TEST_PROJECT, "codex-echo", new RuntimeLayout({ tmpDir: TEST_TMP }));

    expect(isTaskInstructionEcho(plan.taskInstruction)).toBe(true);
    expect(isTaskInstructionEcho("Working (3s)")).toBe(false);
  });
});
