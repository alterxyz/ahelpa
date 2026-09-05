import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDB } from "../src/state";
import { switchModel } from "../src/commands/session-ops";
import { getDriver } from "../src/drivers/registry";
import { ModelSwitchAppliedError } from "../src/drivers/types";

describe("model choice persistence", () => {
  let db: StateDB;
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ahelpa-model-state-"));
    db = new StateDB(join(directory, "state.db"));
    db.createSession({ id: "model-session", parentId: "p", agentType: "codex",
      task: "t", projectPath: directory, ownerToken: "test-token",
      model: "gpt-5.5", effort: "high" });
  });

  afterEach(() => {
    mock.restore();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("successful switches replace the model and effort used by resume", async () => {
    spyOn(getDriver("codex"), "switchModel").mockResolvedValue("Model changed");
    await switchModel(db, "model-session", "test-token", { model: "gpt-6-astra", effort: "ultra" });
    expect(db.getSession("model-session")).toMatchObject({ model: "gpt-6-astra", effort: "ultra" });
  });

  test("omitting effort stops resume from forcing the previous model's setting", async () => {
    spyOn(getDriver("codex"), "switchModel").mockResolvedValue("Model changed");
    await switchModel(db, "model-session", "test-token", { model: "gpt-6-astra" });
    expect(db.getSession("model-session")).toMatchObject({ model: "gpt-6-astra", effort: null });
  });

  test("failed switches preserve the previous choice", async () => {
    spyOn(getDriver("codex"), "switchModel").mockRejectedValue(new Error("Model unavailable"));
    await expect(switchModel(db, "model-session", "test-token", { model: "missing" })).rejects.toThrow("Model unavailable");
    expect(db.getSession("model-session")).toMatchObject({ model: "gpt-5.5", effort: "high" });
  });

  test("an applied switch remains resumable when restoring defaults fails", async () => {
    spyOn(getDriver("codex"), "switchModel").mockRejectedValue(new ModelSwitchAppliedError("Defaults were not restored"));
    await expect(switchModel(db, "model-session", "test-token", { model: "gpt-6-astra", effort: "ultra" }))
      .rejects.toThrow("Defaults were not restored");
    expect(db.getSession("model-session")).toMatchObject({ model: "gpt-6-astra", effort: "ultra" });
  });
});
