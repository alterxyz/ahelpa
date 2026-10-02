import { describe, expect, test } from "bun:test";
import { claudeCodeDriver } from "../src/drivers/claude-code";
import type { DriverRuntime } from "../src/drivers/types";

function runtimeFor(outputs: string[]): DriverRuntime & { sent: string[]; keys: string[]; captures: number } {
  const sent: string[] = [];
  const keys: string[] = [];
  return {
    sent,
    keys,
    captures: 0,
    async sleep() {},
    async capture() {
      return outputs[Math.min(this.captures++, outputs.length - 1)] ?? "";
    },
    async sendKeys(_id, text) { sent.push(text); },
    async sendKey(_id, key) { keys.push(key); },
  };
}

const menu = "Select model\n❯ 1. Opus\n  2. Sonnet 4.6 (1M context)";
const confirmation = "Set model to Sonnet 4.6 for this session only";

describe("Claude session model switching", () => {
  test("moves between choices even when descriptions wrap or have blank separators", async () => {
    const runtime = runtimeFor([
      "Select model\n❯ 1. Opus\n    A long description\n    that wraps onto another line\n\n  2. Sonnet 4.6",
      confirmation,
    ]);

    expect(await claudeCodeDriver.switchModel("test", runtime, { model: "sonnet" })).toBe(confirmation);
    expect(runtime.keys).toEqual(["Down", "s"]);
  });

  test("navigates upwards using choice positions rather than displayed line numbers", async () => {
    const runtime = runtimeFor([
      "1. Sonnet 4.6\n   More detail\n\n2. Opus\n   More detail\n❯ 3. Fable\nSelect model",
      confirmation,
    ]);

    await claudeCodeDriver.switchModel("test", runtime, { model: "sonnet" });
    expect(runtime.keys).toEqual(["Up", "Up", "s"]);
  });

  test("accepts a versioned confirmation for a menu alias", async () => {
    const runtime = runtimeFor(["Select model\n❯ 1. Opus\n2. Sonnet", confirmation]);

    expect(await claudeCodeDriver.switchModel("test", runtime, { model: "sonnet" })).toBe(confirmation);
  });

  test("accepts Default when Claude confirms the resolved model with the default marker", async () => {
    const defaultConfirmation = "Set model to Opus 4.6 (default) for this session only";
    const runtime = runtimeFor([
      "Select model\n1. Default\n❯ 2. Sonnet 4.6",
      defaultConfirmation,
    ]);

    expect(await claudeCodeDriver.switchModel("test", runtime, { model: "default" }))
      .toBe(defaultConfirmation);
    expect(runtime.keys).toEqual(["Up", "s"]);
  });

  test("requires a fresh Default confirmation rather than one retained in history", async () => {
    const defaultConfirmation = "Set model to Opus 4.6 (default) for this session only";
    const defaultMenu = "Select model\n1. Default\n❯ 2. Sonnet 4.6";
    const runtime = runtimeFor([
      `${defaultConfirmation}\n${defaultMenu}`,
      defaultConfirmation,
      `${defaultConfirmation}\n${defaultMenu}\n${defaultConfirmation}`,
    ]);

    expect(await claudeCodeDriver.switchModel("test", runtime, { model: "default" }))
      .toBe(defaultConfirmation);
    expect(runtime.captures).toBe(3);
  });

  test("does not accept a Default selection without an explicit default marker", async () => {
    const runtime = runtimeFor([
      "Select model\n1. Default\n❯ 2. Sonnet 4.6",
      "Set model to Opus 4.6 for this session only",
    ]);

    await expect(claudeCodeDriver.switchModel("test", runtime, { model: "default" }))
      .rejects.toThrow("Timed out waiting for Claude session-only model switch");
    expect(runtime.keys).toEqual(["Up", "s", "Escape"]);
  });

  test("ignores a wrong model and returns the latest fresh target confirmation", async () => {
    const previous = "Set model to Opus for this session only";
    const runtime = runtimeFor([
      `${previous}\n${menu}`,
      previous,
      `${previous}\n${confirmation}`,
    ]);

    expect(await claudeCodeDriver.switchModel("test", runtime, { model: "sonnet" })).toBe(confirmation);
    expect(runtime.captures).toBe(3);
  });

  test("requires a new confirmation even when the target already appears in history", async () => {
    const runtime = runtimeFor([
      `${confirmation}\n${menu}`,
      confirmation,
      `${confirmation}\n${menu}\n${confirmation}`,
    ]);

    expect(await claudeCodeDriver.switchModel("test", runtime, { model: "sonnet" })).toBe(confirmation);
    expect(runtime.captures).toBe(3);
  });

  test.each([
    ["wrong model", "Set model to Opus for this session only"],
    ["wrong version", "Set model to Sonnet 4.7 for this session only"],
    ["model suffix", "Set model to Sonnet 4.6-mini for this session only"],
    ["persistent change", "Set model to Sonnet 4.6"],
    ["default instead of the concrete model", "Set model to Sonnet 4.6 (default) for this session only"],
  ])("does not report success for a %s", async (_description, result) => {
    const runtime = runtimeFor([menu, result]);

    await expect(claudeCodeDriver.switchModel("test", runtime, { model: "sonnet" }))
      .rejects.toThrow("Timed out waiting for Claude session-only model switch");
    expect(runtime.keys).toEqual(["Down", "s", "Escape"]);
  });

  test("times out and closes the menu when only an old target confirmation remains", async () => {
    const runtime = runtimeFor([`${confirmation}\n${menu}`, confirmation]);

    await expect(claudeCodeDriver.switchModel("test", runtime, { model: "sonnet" }))
      .rejects.toThrow("Timed out waiting for Claude session-only model switch");
    expect(runtime.keys).toEqual(["Down", "s", "Escape"]);
  });

  test.each([
    ["missing", menu, "not available"],
    ["sonnet", "Select model\n❯ 1. Opus\n2. Sonnet (disabled)", "disabled"],
    ["sonnet", "Select model\n❯ 1. Opus\n2. Sonnet 4.6\n3. Sonnet 4.7", "matches multiple"],
  ])("closes the menu when %s cannot be selected", async (model, output, error) => {
    const runtime = runtimeFor([output]);

    await expect(claudeCodeDriver.switchModel("test", runtime, { model })).rejects.toThrow(error);
    expect(runtime.keys).toEqual(["Escape"]);
  });

  test("preserves the selection error when closing the picker also fails", async () => {
    const runtime = runtimeFor([menu]);
    runtime.sendKey = async () => { throw new Error("terminal closed"); };

    await expect(claudeCodeDriver.switchModel("test", runtime, { model: "missing" }))
      .rejects.toThrow("not available");
  });

  test.each([
    [{ model: "sonnet", effort: "max" }, "--effort"],
    [{ model: "sonnet", persist: true }, "--persist"],
  ])("rejects unsupported options before interacting with the terminal", async (options, flag) => {
    const runtime = runtimeFor([]);

    await expect(claudeCodeDriver.switchModel("test", runtime, options)).rejects.toThrow(flag);
    expect(runtime.sent).toEqual([]);
    expect(runtime.keys).toEqual([]);
    expect(runtime.captures).toBe(0);
  });
});
