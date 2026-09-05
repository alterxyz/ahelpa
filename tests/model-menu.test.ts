import { describe, expect, test } from "bun:test";
import { findModelChoice, parseModelMenuChoices } from "../src/drivers/model-menu";

describe("model menu selection", () => {
  test("does not confuse a model with a suffixed variant listed first", () => {
    const menu = "1. gpt-5.4-mini\n2. gpt-5.4 (current)";
    expect(findModelChoice(menu, "gpt-5.4").number).toBe("2");
    expect(() => findModelChoice("1. gpt-5.4-mini", "gpt-5.4")).toThrow("not available");
  });

  test("prefers the exact Claude alias over a versioned display label", () => {
    const menu = "1. Opus 4.6\n2. Opus";
    expect(findModelChoice(menu, "opus").number).toBe("2");
  });

  test("accepts Claude display labels and Codex current markers", () => {
    expect(findModelChoice("❯ 3. Sonnet 4.6 (1M context) ✔", "SONNET").number).toBe("3");
    expect(findModelChoice("› 2. gpt-6-astra (current)", "gpt-6-astra").selected).toBe(true);
  });

  test("does not match a name that appears only in another model description", () => {
    expect(() => findModelChoice("1. Default (currently Sonnet)", "sonnet")).toThrow("not available");
  });

  test("requires a specific name when multiple display labels match", () => {
    const menu = "1. Opus 4.6\n2. Opus 4.7";
    expect(() => findModelChoice(menu, "opus")).toThrow("matches multiple");
    expect(findModelChoice(menu, "Opus 4.7").number).toBe("2");
  });

  test("rejects a disabled exact model without falling back to another model", () => {
    const menu = "1. gpt-6-astra  disabled\n2. gpt-6-astra-mini";
    expect(() => findModelChoice(menu, "gpt-6-astra")).toThrow("disabled");
  });

  test("only parses numbered menu rows, preserving the actual selection key", () => {
    const choices = parseModelMenuChoices("Details for release 2. example\n  > 7. Ultra  Slowest reasoning");
    expect(choices).toEqual([{
      number: "7", label: "Ultra", lineIndex: 1, selected: true, disabled: false,
    }]);
  });
});
