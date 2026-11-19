import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { restoreCodexConfig, snapshotCodexConfig } from "../src/drivers/codex-config";
import { codexDriver } from "../src/drivers/codex";
import type { DriverRuntime } from "../src/drivers/types";
import { ModelSwitchAppliedError } from "../src/drivers/types";

let home: string;
let configPath: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ahelpa-codex-config-"));
  configPath = join(home, "config.toml");
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("Codex config restoration", () => {
  test("restores the original bytes when only root model settings changed", () => {
    const original = [
      "# Preserve formatting and nested settings",
      '"model" = "gpt-5.5"',
      'model_reasoning_effort = "high"',
      'note = """multi-line',
      'setting"""',
      "[features]",
      "items = [{ enabled = true }, { enabled = false }]",
      "[profiles.review]",
      'model = "gpt-5.4-mini"',
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const snapshot = snapshotCodexConfig();
    writeFileSync(configPath, original.replace('"gpt-5.5"', '"gpt-6-astra"').replace('"high"', '"ultra"'));

    restoreCodexConfig(snapshot);

    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test("compares TOML structure without depending on key order", () => {
    const original = 'model = "old"\n[features]\na = true\nb = false\n';
    writeFileSync(configPath, original);
    const snapshot = snapshotCodexConfig();
    writeFileSync(configPath, 'model = "new"\n[features]\nb = false\na = true\n');
    restoreCodexConfig(snapshot);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test.each([
    'model = "new"\nsetting = 2\n[profile]\nmodel = "nested"\n',
    'model = "new"\nsetting = 1\n[profile]\nmodel = "changed"\n',
  ])("preserves concurrent changes outside root model fields", (current) => {
    writeFileSync(configPath, 'model = "old"\nsetting = 1\n[profile]\nmodel = "nested"\n');
    const snapshot = snapshotCodexConfig();
    writeFileSync(configPath, current);

    expect(() => restoreCodexConfig(snapshot)).toThrow("non-model settings changed");
    expect(readFileSync(configPath, "utf-8")).toBe(current);
  });

  test("preserves an invalid current file without exposing parser details", () => {
    writeFileSync(configPath, 'model = "old"\n');
    const snapshot = snapshotCodexConfig();
    const current = 'model = "private-value-without-closing-quote';
    writeFileSync(configPath, current);
    expect(() => restoreCodexConfig(snapshot)).toThrow("invalid TOML");
    try { restoreCodexConfig(snapshot); } catch (error) {
      expect(String(error)).not.toContain("private-value");
    }
    expect(readFileSync(configPath, "utf-8")).toBe(current);
  });

  test("refuses to snapshot invalid TOML", () => {
    writeFileSync(configPath, 'model = "unterminated');
    expect(() => snapshotCodexConfig()).toThrow("invalid TOML");
  });

  test("preserves unknown model structures", () => {
    writeFileSync(configPath, 'model = "old"\n');
    const snapshot = snapshotCodexConfig();
    const current = '[model]\nname = "new"\n';
    writeFileSync(configPath, current);
    expect(() => restoreCodexConfig(snapshot)).toThrow("unrecognized model settings");
    expect(readFileSync(configPath, "utf-8")).toBe(current);
  });

  test("records an absent config and removes only a model-only replacement", () => {
    const snapshot = snapshotCodexConfig();
    expect(snapshot.content).toBeNull();
    writeFileSync(configPath, 'model = "gpt-6-astra"\nmodel_reasoning_effort = "ultra"\n');
    restoreCodexConfig(snapshot);
    expect(existsSync(configPath)).toBe(false);
  });

  test("preserves a newly created config containing unrelated settings", () => {
    const snapshot = snapshotCodexConfig();
    const current = 'model = "new"\nnew_setting = true\n';
    writeFileSync(configPath, current);
    expect(() => restoreCodexConfig(snapshot)).toThrow("non-model settings changed");
    expect(readFileSync(configPath, "utf-8")).toBe(current);
  });

  test("does not recreate a config removed during the switch", () => {
    writeFileSync(configPath, 'model = "old"\n');
    const snapshot = snapshotCodexConfig();
    unlinkSync(configPath);
    expect(() => restoreCodexConfig(snapshot)).toThrow("config was removed");
    expect(existsSync(configPath)).toBe(false);
  });

  test("leaves an absent config absent if the switch never writes it", () => {
    restoreCodexConfig(snapshotCodexConfig());
    expect(existsSync(configPath)).toBe(false);
  });
});

function switchingRuntime(change: () => void, effortRows = "3. High"): DriverRuntime & { sent: string[]; keys: string[] } {
  const outputs = [
    "Select Model and Effort\n1. gpt-5.5\n2. gpt-6-astra",
    `Select Reasoning Level for gpt-6-astra\n${effortRows}`,
    "Model changed to gpt-6-astra high",
  ];
  let index = 0;
  const sent: string[] = [];
  const keys: string[] = [];
  return {
    sent,
    keys,
    async sleep() {},
    async capture() { return outputs[Math.min(index++, outputs.length - 1)]; },
    async sendKeys(_id, text) { sent.push(text); },
    async sendKey(_id, key) {
      keys.push(key);
      if (key === "2") change();
    },
  };
}

describe("Codex model switch config protection", () => {
  const original = 'model = "gpt-5.5"\nsetting = 1\n';

  test("restores defaults after a confirmed model switch", async () => {
    writeFileSync(configPath, original);
    const runtime = switchingRuntime(() => writeFileSync(configPath, original.replace("gpt-5.5", "gpt-6-astra")));
    const result = await codexDriver.switchModel("test", runtime, { model: "gpt-6-astra", effort: "high" });
    expect(result).toContain("Model changed to gpt-6-astra");
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test("restores defaults when reasoning selection fails", async () => {
    writeFileSync(configPath, original);
    const runtime = switchingRuntime(() => writeFileSync(configPath, original.replace("gpt-5.5", "gpt-6-astra")));
    await expect(codexDriver.switchModel("test", runtime, { model: "gpt-6-astra", effort: "ultra" })).rejects.toThrow("not available");
    expect(runtime.keys).toEqual(["2", "Escape"]);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test("reports a confirmed switch separately from a refused config restoration", async () => {
    writeFileSync(configPath, original);
    const current = 'model = "gpt-6-astra"\nsetting = 2\n';
    const runtime = switchingRuntime(() => writeFileSync(configPath, current));
    const switching = codexDriver.switchModel("test", runtime, { model: "gpt-6-astra", effort: "high" });
    await expect(switching)
      .rejects.toThrow("Model changed to gpt-6-astra, but Cannot safely restore Codex defaults");
    await expect(switching).rejects.toBeInstanceOf(ModelSwitchAppliedError);
    expect(readFileSync(configPath, "utf-8")).toBe(current);
  });

  test("retains both errors when selection and config restoration fail", async () => {
    writeFileSync(configPath, original);
    const current = 'model = "gpt-6-astra"\nsetting = 2\n';
    const runtime = switchingRuntime(() => writeFileSync(configPath, current));
    try {
      await codexDriver.switchModel("test", runtime, { model: "gpt-6-astra", effort: "ultra" });
      throw new Error("Expected switch failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(String(error)).toContain("not available");
      expect(String(error)).toContain("non-model settings changed");
    }
    expect(readFileSync(configPath, "utf-8")).toBe(current);
  });

  test("refuses an invalid original config before opening the menu", async () => {
    writeFileSync(configPath, 'model = "unterminated');
    const runtime = switchingRuntime(() => {});
    await expect(codexDriver.switchModel("test", runtime, { model: "gpt-6-astra" })).rejects.toThrow("invalid TOML");
    expect(runtime.sent).toEqual([]);
  });

  test("persist bypasses snapshot and restoration", async () => {
    writeFileSync(configPath, 'model = "unterminated');
    const current = 'model = "gpt-6-astra"\n';
    const runtime = switchingRuntime(() => writeFileSync(configPath, current));
    await codexDriver.switchModel("test", runtime, { model: "gpt-6-astra", effort: "high", persist: true });
    expect(readFileSync(configPath, "utf-8")).toBe(current);
  });
});

describe("codex model switch menus", () => {
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
});
