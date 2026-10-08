import { describe, expect, test } from "bun:test";
import { getDriver } from "../src/drivers/registry";
import { parseHelperRole, resolveLaunchProfile } from "../src/launch-profiles";

describe("helper role parsing", () => {
  test("preserves supported roles and an unspecified choice", () => {
    expect(parseHelperRole()).toBeUndefined();
    expect(parseHelperRole("worker")).toBe("worker");
    expect(parseHelperRole("advisor")).toBe("advisor");
    expect(parseHelperRole("reviewer")).toBe("reviewer");
  });

  test.each(["", "strategist", "Worker", " worker "])("rejects an unknown role: %s", (role) => {
    expect(() => parseHelperRole(role)).toThrow("Unknown helper role");
  });
});

describe("launch profiles", () => {
  test("Codex defaults to a GPT-6.1 Sol worker at high effort", () => {
    expect(resolveLaunchProfile(getDriver("codex"), {})).toEqual({
      role: "worker", model: "gpt-6.1-sol", effort: "high",
    });
  });

  test("Claude defaults to an Opus 5.5 advisor at xhigh effort", () => {
    expect(resolveLaunchProfile(getDriver("claude-code"), {})).toEqual({
      role: "advisor", model: "claude-opus-5-5", effort: "xhigh",
    });
  });

  test("Claude workers use Sonnet 5.5 at high effort", () => {
    expect(resolveLaunchProfile(getDriver("claude-code"), { role: "worker" })).toEqual({
      role: "worker", model: "claude-sonnet-5-5", effort: "high",
    });
  });

  test("an explicit advisor role uses the same Claude profile as the default", () => {
    expect(resolveLaunchProfile(getDriver("claude-code"), { role: "advisor" }))
      .toEqual(resolveLaunchProfile(getDriver("claude-code"), {}));
  });

  test("an explicit model overrides only the profile model", () => {
    expect(resolveLaunchProfile(getDriver("claude-code"), { model: "custom-model" })).toEqual({
      role: "advisor", model: "custom-model", effort: "xhigh",
    });
  });

  test("an explicit effort overrides only the selected worker effort", () => {
    expect(resolveLaunchProfile(getDriver("claude-code"), { role: "worker", effort: "low" })).toEqual({
      role: "worker", model: "claude-sonnet-5-5", effort: "low",
    });
  });

  test("explicit model and effort take precedence over the Codex preset", () => {
    expect(resolveLaunchProfile(getDriver("codex"), { model: "gpt-5.5", effort: "xhigh" })).toEqual({
      role: "worker", model: "gpt-5.5", effort: "xhigh",
    });
  });

  test("reviewers get the strongest preset of each driver", () => {
    expect(resolveLaunchProfile(getDriver("claude-code"), { role: "reviewer" })).toEqual({
      role: "reviewer", model: "claude-opus-5-5", effort: "xhigh",
    });
    expect(resolveLaunchProfile(getDriver("codex"), { role: "reviewer" })).toEqual({
      role: "reviewer", model: "gpt-6.1-sol", effort: "xhigh",
    });
  });

  test("Codex rejects advisor even when model and effort are explicit", () => {
    expect(() => resolveLaunchProfile(getDriver("codex"), {
      role: "advisor", model: "gpt-6.1-sol", effort: "high",
    })).toThrow('codex does not support role "advisor"');
  });

  test("Kimi keeps the native CLI defaults without a role", () => {
    const resolved = resolveLaunchProfile(getDriver("kimi"), {});
    expect(resolved.role).toBeUndefined();
    expect(resolved.model).toBeUndefined();
    expect(resolved.effort).toBeUndefined();
  });

  test("Kimi preserves explicit options for its driver to handle", () => {
    expect(resolveLaunchProfile(getDriver("kimi"), { model: "configured-model", effort: "high" })).toEqual({
      model: "configured-model", effort: "high",
    });
  });

  test.each(["worker", "advisor"])("Kimi rejects the %s role", (role) => {
    expect(() => resolveLaunchProfile(getDriver("kimi"), { role }))
      .toThrow("kimi does not support helper roles");
  });

  test("a role typo is rejected instead of silently selecting the driver default", () => {
    expect(() => resolveLaunchProfile(getDriver("claude-code"), { role: "adviser" }))
      .toThrow("Unknown helper role");
  });

  test.each(["codex", "claude-code"])("native %s resume still leaves unspecified model and effort unchanged", (agent) => {
    const command = getDriver(agent).buildResumeCommand({ cwd: "/tmp/project", resumeId: "old-session" });
    expect(command).not.toContain("--model");
    expect(command).not.toContain("--effort");
    expect(command).not.toContain("model_reasoning_effort");
  });

  test("the model catalog reports native defaults separately from launch presets", () => {
    const codex = getDriver("codex");
    const claude = getDriver("claude-code");
    expect(codex.modelCatalog.models.find((model) => model.name === "gpt-6.1-sol"))
      .toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" });
    for (const name of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(claude.modelCatalog.models.find((model) => model.name === name))
        .toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" });
    }
    expect(resolveLaunchProfile(codex, {}).effort).toBe("high");
    expect(resolveLaunchProfile(claude, {}).effort).toBe("xhigh");
  });
});
