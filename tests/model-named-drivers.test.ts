import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HELPER_NAMES, getDriver, getHarnessDriver, getHelperName, listDrivers, renderNameDirectory } from "../src/drivers/registry";
import { resolveLaunchProfile } from "../src/launch-profiles";
import { renderHelpText, renderModelsText } from "../src/command-contract";
import { executeLaunch, planLaunch, resume } from "../src/commands/launch";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { defaultWakeup } from "../src/wakeup";
import * as daemon from "../src/daemon";

const names = ["claude", "codex", "gemini", "kimi", "mistral", "deepseek", "deepseek-pi"];
const spellings = [
  ["claude", "claude", "claude-code"], ["claude-code", "claude", "claude-code"],
  ["codex", "codex", "codex"], ["gpt", "codex", "codex"],
  ["gemini", "gemini", "agy"], ["agy", "gemini", "agy"], ["antigravity", "gemini", "agy"],
  ["kimi", "kimi", "kimi"], ["mistral", "mistral", "vibe"], ["vibe", "mistral", "vibe"],
  ["deepseek", "deepseek", "vibe"], ["deepseek-vibe", "deepseek", "vibe"],
  ["deepseek-pi", "deepseek-pi", "pi"], ["pi", "deepseek-pi", "pi"],
] as const;

test("public names, nicknames and internal IDs resolve while first-layer listings expose only public names", () => {
  expect(listDrivers()).toEqual(names);
  for (const [input, name, harness] of spellings) {
    expect(getDriver(input)).toBe(getDriver(name));
    expect(getDriver(input).name).toBe(name);
    expect(getHelperName(input).harnessId).toBe(harness);
    expect(getHarnessDriver(harness)).toBeDefined();
  }
  const help = renderHelpText();
  expect(help).toContain("launch <name>");
  for (const name of names) expect(help).toContain(`  ${name}: `);
  for (const nickname of ["claude-code", "gpt", "agy", "antigravity", "vibe", "deepseek-vibe", "pi", "dsh"]) {
    expect(help).not.toContain(`  ${nickname}: `);
  }
  expect(help).not.toContain("cc-switch-deep-seek");
});

test("unknown names and models share full second-layer disclosure with host-controlled fallback", () => {
  const directory = renderNameDirectory();
  expect(renderModelsText()).toBe(`Available models\n\n${directory}`);
  expect(() => getDriver("missing")).toThrow(`Unknown helper name: "missing".\n\n${directory}`);
  for (const entry of HELPER_NAMES) {
    expect(directory).toContain(`Harness: ${entry.harnessName} (ID: ${entry.harnessId})`);
    expect(directory).toContain(`Route: ${entry.route}`);
    expect(directory).toContain(`Prerequisites: ${entry.prerequisites}`);
    expect(directory).toContain(`Aliases: ${entry.aliases.join(", ") || "none"}`);
  }
  expect(directory).toContain("model unavailable (the Mistral subscription may not include it)");
  expect(directory).toContain("authentication fails: host may choose deepseek-pi");
  expect(directory).toContain("No automatic fallback");
  expect(directory).toContain("CC-Switch");
  expect(directory).toContain("cc-switch-deep-seek/deepseek-flash; effort: high");
  expect(directory).toEndWith("Use ahelpa models <name> for model options.");
  expect(renderModelsText("gpt")).toBe(renderModelsText("codex"));
  expect(renderModelsText("agy")).toBe(renderModelsText("gemini"));
});

test.each([
  ["mistral", "mistral-large-4-0-3", "high"],
  ["deepseek", "deepseek-v4-1-flash-1017", "high"],
  ["deepseek-pi", "cc-switch-deep-seek/deepseek-flash", "high"],
  ["pi", "cc-switch-deep-seek/deepseek-flash", "high"],
] as const)("%s uses the agreed profiles", (name, model, effort) => {
  const driver = getDriver(name);
  for (const role of ["worker", "reviewer"] as const) {
    expect(resolveLaunchProfile(driver, { role })).toEqual({ role, model, effort });
  }
  expect(resolveLaunchProfile(driver, {})).toEqual({ role: "worker", model, effort });
  // Both are read from their TUI screens: Pi's signal ends the transcript above its
  // editor; Vibe's latest turn shows DONE above the composer.
  const output = ["deepseek-pi", "pi"].includes(name)
    ? ` [AHELPA:DONE]\n\n${"─".repeat(80)}\n\n${"─".repeat(80)}\n~/project\n0.0%/1.0M`
    : "> task\n───\n  [AHELPA:DONE]\n─── Mistral Large 4[high] · ahelpa helper ─\n>\n";
  expect(driver.detectStatus(output)).toBe("idle");
  expect(driver.detectOutcome(output).status).toBe("idle");
});

test("public catalogs separate models while accepting other Vibe aliases", () => {
  expect(getDriver("mistral").modelCatalog.models.map(model => model.name))
    .toEqual(["mistral-large-4-0-3", "mistral-medium-3.5"]);
  expect(getDriver("deepseek").modelCatalog.models).toEqual([
    { name: "deepseek-v4-1-flash-1017", efforts: ["low", "high", "max"], defaultEffort: "high" },
  ]);
  for (const model of ["glm-5-3", "zai-glm-5-3-flash", "deepseek-v4-1-flash-1017"]) {
    expect(getDriver("mistral").buildLaunchCommand({ cwd: "/tmp", model })).toContain(`active_model = "${model}"`);
  }
});

describe("name and harness persistence", () => {
  let root: string;
  let db: StateDB;
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-names-"));
    db = new StateDB(":memory:");
    spyOn(defaultRuntimeLayout, "taskFilePath").mockImplementation(id => join(root, `task-${id}.md`));
    spyOn(defaultRuntimeLayout, "scratchDir").mockImplementation(id => join(root, "scratch", id));
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    spyOn(defaultWakeup, "prepare").mockResolvedValue();
    spyOn(Tmux, "create").mockResolvedValue();
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    spyOn(Tmux, "capture").mockResolvedValue("");
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(Tmux, "kill").mockResolvedValue();
    for (const { driver } of HELPER_NAMES) {
      spyOn(driver, "prepareForTask").mockResolvedValue();
      spyOn(driver, "prepareForResume").mockResolvedValue();
      spyOn(driver, "afterTaskSubmitted").mockResolvedValue(true);
    }
  });
  afterEach(() => { db.close(); mock.restore(); rmSync(root, { recursive: true, force: true }); });

  test.each(spellings)("launch %s stores the harness ID and uses canonical %s prefix", async (input, name, harness) => {
    const plan = planLaunch({ db, agentType: input, task: "fixture", projectPath: root, parentId: "host" });
    const result = await executeLaunch(plan);
    const row = db.getSession(result.sessionId)!;
    expect(result.sessionId).toMatch(new RegExp(`^${name}-[a-f0-9]{12}$`));
    expect(row.agentType).toBe(harness);
    if (name === "deepseek-pi") {
      expect(row.model).toBe("cc-switch-deep-seek/deepseek-flash");
      expect(row.effort).toBe("high");
    }
    if (name === "deepseek") expect(row.model).toBe("deepseek-v4-1-flash-1017");
    if (name === "mistral") expect(row.model).toBe("mistral-large-4-0-3");
  });

  test.each([
    ["claude", "claude-code"], ["codex", "codex"], ["gemini", "agy"], ["agy", "agy"],
    ["kimi", "kimi"], ["mistral", "vibe"], ["deepseek", "vibe"], ["vibe", "vibe"],
    ["deepseek-pi", "pi"], ["pi", "pi"],
  ])("resume keeps the %s prefix and recorded settings via harness %s", async (prefix, harness) => {
    const oldId = `${prefix}-0123456789ab`;
    const model = harness === "pi" ? "previous-provider/previous-model" : "previous-model";
    db.createSession({ id: oldId, parentId: "host", agentType: harness, task: "old", ownerToken: "token", projectPath: root,
      model, effort: harness === "kimi" ? undefined : "high" });
    db.updateStatus(oldId, "dead");
    db.updateResumeId(oldId, "11111111-1234-1234-1234-123456789abc");
    const result = await resume({ db, sessionId: oldId, ownerToken: "token" });
    const row = db.getSession(result.sessionId)!;
    expect(result.sessionId).toMatch(new RegExp(`^${prefix}-[a-f0-9]{12}$`));
    expect(row.agentType).toBe(harness);
    expect(row.model).toBe(model);
    expect(row.effort).toBe(harness === "kimi" ? null : "high");
    expect(Tmux.create).toHaveBeenCalledTimes(1);
    expect((Tmux.create as ReturnType<typeof spyOn>).mock.calls[0]?.[1]).toContain(model);
  });

  test("resume resolves the stored harness without consulting the public deepseek pointer", async () => {
    const oldId = "deepseek-0123456789ab";
    db.createSession({ id: oldId, parentId: "host", agentType: "vibe", task: "old", ownerToken: "token", projectPath: root,
      model: "deepseek-v4-1-flash-1017", effort: "low" });
    db.updateStatus(oldId, "dead"); db.updateResumeId(oldId, "11111111-1234-1234-1234-123456789abc");
    const publicResume = spyOn(getDriver("deepseek"), "buildResumeCommand").mockImplementation(() => { throw new Error("public pointer changed"); });
    const result = await resume({ db, sessionId: oldId, ownerToken: "token" });
    expect(publicResume).not.toHaveBeenCalled();
    expect(db.getSession(result.sessionId)).toMatchObject({ agentType: "vibe", model: "deepseek-v4-1-flash-1017", effort: "low" });
  });
});
