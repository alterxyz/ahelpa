import { describe, expect, test } from "bun:test";
import { codexDriver } from "../src/drivers/codex";
import type { DriverRuntime } from "../src/drivers/types";

function runtimeFor(outputs: string[]): DriverRuntime & { keys: string[]; sent: string[] } {
  let index = 0;
  const keys: string[] = [];
  const sent: string[] = [];
  return {
    keys,
    sent,
    async sleep() {},
    async capture() { return outputs[Math.min(index++, outputs.length - 1)] ?? ""; },
    async sendKeys(_id, text) { sent.push(text); },
    async sendKey(_id, key) { keys.push(key); },
  };
}

const modelMenu = "Select Model and Effort\n1. gpt-6-astra-mini\n2. gpt-6-astra";

describe("Codex reasoning menu selection", () => {
  test("graceful exit submits the command that exposes the resume token", async () => {
    const runtime = runtimeFor([]);
    await codexDriver.gracefulExit("test", runtime);
    expect(runtime.sent).toEqual(["/exit"]);
    expect(runtime.keys).toEqual([]);
  });

  test.each([
    ["high", "High", "1"],
    ["max", "Maximum", "5"],
    ["ultra", "Ultra", "6"],
    ["extra-high", "Extra high", "7"],
  ])("selects %s using the displayed key", async (effort, label, key) => {
    const confirmation = `Model changed to gpt-6-astra ${effort}`;
    const runtime = runtimeFor([
      modelMenu,
      `Select Reasoning Level for gpt-6-astra\n8. Low\n${key}. ${label}\n9. Medium`,
      confirmation,
    ]);
    const result = await codexDriver.switchModel("test", runtime, {
      model: "gpt-6-astra", effort, persist: true,
    });
    expect(result).toBe(confirmation);
    expect(runtime.keys).toEqual(["2", key]);
  });

  test("uses the marked default rather than assuming medium is option two", async () => {
    const runtime = runtimeFor([
      modelMenu,
      "Select Reasoning Level for gpt-6-astra\n1. High\n5. Low (default)\n2. Medium",
      "Model changed to gpt-6-astra low",
    ]);
    await codexDriver.switchModel("test", runtime, { model: "gpt-6-astra", effort: "default", persist: true });
    expect(runtime.keys).toEqual(["2", "5"]);
  });

  test("leaves the selected reasoning level in place when effort is omitted", async () => {
    const runtime = runtimeFor([
      modelMenu,
      "Select Reasoning Level for gpt-6-astra\n❯ 5. Max (current)",
      "Model changed to gpt-6-astra max",
    ]);
    await codexDriver.switchModel("test", runtime, { model: "gpt-6-astra", persist: true });
    expect(runtime.keys).toEqual(["2", "Enter"]);
  });

  test.each([
    ["ultra", "1. Low\n2. Medium", "not available"],
    ["ultra", "6. Ultra (disabled)", "disabled"],
    ["unexpected", "1. Low\n2. Medium", "not available"],
  ])("exits the reasoning menu if %s cannot be selected", async (effort, rows, message) => {
    const runtime = runtimeFor([modelMenu, `Select Reasoning Level for gpt-6-astra\n${rows}`]);
    await expect(codexDriver.switchModel("test", runtime, {
      model: "gpt-6-astra", effort, persist: true,
    })).rejects.toThrow(message);
    expect(runtime.keys).toEqual(["2", "Escape"]);
  });

  test("exits the model menu when only a different suffixed model exists", async () => {
    const runtime = runtimeFor(["Select Model and Effort\n1. gpt-6-astra-mini"]);
    await expect(codexDriver.switchModel("test", runtime, {
      model: "gpt-6-astra", persist: true,
    })).rejects.toThrow("not available");
    expect(runtime.keys).toEqual(["Escape"]);
  });

  test("preserves the selection error when closing the menu also fails", async () => {
    const runtime = runtimeFor(["Select Model and Effort\n1. gpt-5.5"]);
    runtime.sendKey = async () => { throw new Error("tmux session closed"); };
    await expect(codexDriver.switchModel("test", runtime, {
      model: "gpt-6-astra", persist: true,
    })).rejects.toThrow("not available");
  });

  test("ignores old confirmations while waiting for reasoning and returns the latest target confirmation", async () => {
    const previous = "Model changed to gpt-5.5 high";
    const reasoning = "Select Reasoning Level for gpt-6-astra\n1. Low\n6. Ultra";
    const confirmation = "Model changed to gpt-6-astra ultra";
    const runtime = runtimeFor([
      `${previous}\n${modelMenu}`,
      previous,
      `${previous}\n${reasoning}`,
      `${previous}\n${modelMenu}\n${reasoning}\n${confirmation}`,
    ]);

    expect(await codexDriver.switchModel("test", runtime, {
      model: "gpt-6-astra", effort: "ultra", persist: true,
    })).toBe(confirmation);
    expect(runtime.keys).toEqual(["2", "6"]);
  });

  test("requires a new confirmation even when scrollback already confirms the target model", async () => {
    const confirmation = "Model changed to gpt-6-astra ultra";
    const reasoning = "Select Reasoning Level for gpt-6-astra\n6. Ultra";
    const runtime = runtimeFor([
      `${confirmation}\n${modelMenu}`,
      confirmation,
      `${confirmation}\n${reasoning}`,
      `${confirmation}\n${reasoning}`,
      `${confirmation}\n${reasoning}\n${confirmation}`,
    ]);

    expect(await codexDriver.switchModel("test", runtime, {
      model: "gpt-6-astra", effort: "ultra", persist: true,
    })).toBe(confirmation);
    expect(runtime.keys).toEqual(["2", "6"]);
  });

  test("times out and closes the picker if only an old target confirmation remains", async () => {
    const previous = "Model changed to gpt-6-astra high";
    const runtime = runtimeFor([`${previous}\n${modelMenu}`, previous]);

    await expect(codexDriver.switchModel("test", runtime, {
      model: "gpt-6-astra", effort: "ultra", persist: true,
    })).rejects.toThrow("Timed out waiting for Codex reasoning menu");
    expect(runtime.keys).toEqual(["2", "Escape"]);
  });

  test("requires the complete target slug in the final confirmation", async () => {
    const runtime = runtimeFor([
      modelMenu,
      "Select Reasoning Level for gpt-6-astra\n6. Ultra",
      "Model changed to gpt-6-astra-mini ultra",
    ]);

    await expect(codexDriver.switchModel("test", runtime, {
      model: "gpt-6-astra", effort: "ultra", persist: true,
    })).rejects.toThrow("Timed out waiting for Codex model switch confirmation");
    expect(runtime.keys).toEqual(["2", "6", "Escape"]);
  });

  test("selects rows from the latest picker rather than numbered rows in old menus", async () => {
    const runtime = runtimeFor([
      `Select Model and Effort\n8. gpt-6-astra\nModel changed to gpt-5.5 high\n${modelMenu}`,
      "Select Reasoning Level for gpt-5.5\n9. High\nSelect Reasoning Level for gpt-6-astra\n3. High",
      "Model changed to gpt-6-astra high",
    ]);

    await codexDriver.switchModel("test", runtime, {
      model: "gpt-6-astra", effort: "high", persist: true,
    });
    expect(runtime.keys).toEqual(["2", "3"]);
  });

  test("reports the supported efforts for each new Codex family", () => {
    const models = new Map(codexDriver.modelCatalog.models.map((model) => [model.name, model]));
    for (const model of ["gpt-6-astra", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      expect(models.get(model)?.efforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    }
    expect(models.get("gpt-5.6-luna")?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models.get("gpt-5.5")?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });
});
