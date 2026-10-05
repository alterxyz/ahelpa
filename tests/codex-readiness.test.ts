import { describe, expect, test } from "bun:test";
import { codexDriver as driver } from "../src/drivers/codex";
import type { DriverRuntime } from "../src/drivers/types";

const update = [
  "Update available · 0.160.0 → 0.160.1",
  "› 1. Update now (runs remote installer)",
  "  2. Skip",
  "  3. Skip until next version",
  "enter continue · esc skip",
].join("\n");
const oldUpdate = [
  "Update available! 0.128.0 -> 0.140.0",
  "› 1. Update now",
  "  2. Skip",
  "Press enter to continue",
].join("\n");
const trust = [
  "Do you trust the contents of this directory?",
  "› 1. Yes, continue",
  "  2. No, quit",
  "Press enter to continue",
].join("\n");
const prompt = "› Implement {feature}";

function replay(outputs: string[], onSend?: (text: string) => void): DriverRuntime & {
  sent: string[]; keys: string[]; captures: number;
} {
  return {
    sent: [], keys: [], captures: 0,
    async capture() { return outputs[Math.min(this.captures++, outputs.length - 1)] ?? ""; },
    async sleep() {},
    async sendKeys(_id, text) { this.sent.push(text); onSend?.(text); },
    async sendKey(_id, key) { this.keys.push(key); },
  };
}

describe("codex readiness against live menus and history", () => {
  test("a live numbered picker blocks readiness despite an earlier empty composer", async () => {
    const runtime = replay(["›\nSelect Model and Effort\n› 1. gpt-6.1-sol\n  2. gpt-6-astra"]);
    await expect(driver.prepareForTask("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.sent).toEqual([]);
  });

  test("a lingering update menu blocks readiness despite an earlier empty composer", async () => {
    const runtime = replay([`›\n${update}`]);
    await expect(driver.prepareForTask("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.sent).toEqual(["2"]);
  });

  test("resume must not submit 2 when update text is historical and the composer is ready", async () => {
    const runtime = replay([[
      "› Explain the Codex update options",
      "• The header says Update available · 0.160.0 → 0.160.1",
      "  1. Update now",
      "  2. Skip",
      "  3. Skip until next version",
      prompt,
    ].join("\n")]);
    await driver.prepareForResume("replay", runtime);
    expect(runtime.sent).toEqual([]);
    expect(runtime.captures).toBe(1);
  });

  test("update then directory trust can both be handled before readiness", async () => {
    let state = 0;
    const runtime = replay([], (text) => {
      if (state === 0 && text === "2") state = 1;
      else if (state === 1 && text === "") state = 2;
    });
    runtime.capture = async () => { runtime.captures++; return [update, trust, prompt][state]; };
    await driver.prepareForTask("replay", runtime);
    expect(runtime.sent).toEqual(["2", ""]);
  });

  test("directory trust then update can both be handled before readiness", async () => {
    let state = 0;
    const runtime = replay([], (text) => {
      if (state === 0 && text === "") state = 1;
      else if (state === 1 && text === "2") state = 2;
    });
    runtime.capture = async () => { runtime.captures++; return [trust, update, prompt][state]; };
    await driver.prepareForTask("replay", runtime);
    expect(runtime.sent).toEqual(["", "2"]);
  });

  // Startup composers are empty; a numbered draft is indistinguishable from a menu, so it fails safe (timeout, nothing typed).
  test.each([
    "› 1. fix the bug\n  gpt-6.1-sol high",
    "› 1. fix the bug\n  2. add a regression test\n  gpt-6.1-sol high",
  ])("a numbered draft is treated as a menu and fails safe", async (screen) => {
    const runtime = replay([screen]);
    await expect(driver.prepareForResume("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.sent).toEqual([]);
  });

  test.each(["prepareForTask", "prepareForResume"] as const)("%s rejects a picker with its last item selected", async (prepare) => {
    const runtime = replay(["Select Model and Effort\n  1. gpt-6.1-sol\n› 2. gpt-6-astra\nenter to select · esc to close"]);
    await expect(driver[prepare]("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.sent).toEqual([]);
  });

  test.each([
    "Select Model and Effort\n› 1. gpt-6.1-sol\n     (current model with\n      a long description)\n  2. gpt-6-astra",
    "Select Model and Effort\n  1. gpt-6.1-sol\n› 2. gpt-6-astra\n     (long description\n      wraps here)",
  ])("a wrapped selected row stays a menu", async (screen) => {
    const runtime = replay([screen]);
    await expect(driver.prepareForTask("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.sent).toEqual([]);
  });

  test("update then trust progresses while the update rows remain in scrollback", async () => {
    let state = 0;
    const runtime = replay([], (text) => {
      if (state === 0 && text === "2") state = 1;
      else if (state === 1 && text === "") state = 2;
    });
    runtime.capture = async () => {
      runtime.captures++;
      return [update, `${update}\n${trust}`, `${update}\n${trust}\n${prompt}`][state];
    };
    await driver.prepareForTask("replay", runtime);
    expect(runtime.sent).toEqual(["2", ""]);
  });

  test("historical update rows never trigger Skip", async () => {
    const runtime = replay(["› Explain the update menu\n• Update available · 0.160.0 → 0.160.1\n  1. Update now\n  2. Skip\n› 1. fix the bug"]);
    await expect(driver.prepareForResume("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.sent).toEqual([]);
  });

  test("a wrapped update menu, including a wrapped Skip label, still gets Skip", async () => {
    const wrapped = [
      "Update available ·", "0.160.0 → 0.160.1", "› 1. Update now (runs", "     sh -c 'curl -fsSL",
      "     https://chatgpt.com/", "     codex/install.sh |", "     sh')", "  2.", "     Skip",
      "  3. Skip until next", "     version", "enter continue · esc skip",
    ].join("\n");
    const runtime = replay([wrapped, wrapped, prompt]);
    await driver.prepareForTask("replay", runtime);
    expect(runtime.sent).toEqual(["2"]);
    expect(runtime.captures).toBe(3);
  });

  test.each(["1", "2", "3"])("a live update menu with item %s selected stays blocked after one Skip", async (selected) => {
    const menu = [
      "Update available · 0.160.0 → 0.160.1",
      `${selected === "1" ? "›" : " "} 1. Update now`,
      `${selected === "2" ? "›" : " "} 2. Skip`,
      `${selected === "3" ? "›" : " "} 3. Skip until next version`,
      "enter continue · esc skip",
    ].join("\n");
    const runtime = replay([menu]);
    await expect(driver.prepareForResume("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.sent).toEqual(["2"]);
  });

  test("a historical numbered user turn does not hide a later empty composer", async () => {
    const runtime = replay(["› 1. fix the bug\n• Ran tests\n• Completed it\n›"]);
    await driver.prepareForResume("replay", runtime);
    expect(runtime.sent).toEqual([]);
  });

  test("a lingering legacy update screen does not provoke Enter after Skip", async () => {
    const runtime = replay([oldUpdate, oldUpdate, oldUpdate, prompt]);
    await driver.prepareForTask("replay", runtime);
    expect(runtime.sent).toEqual(["2"]);
    expect(runtime.captures).toBe(4);
  });

  test("directory trust alone is handled with a selected numbered menu row", async () => {
    const runtime = replay([trust, prompt]);
    await driver.prepareForTask("replay", runtime);
    expect(runtime.sent).toEqual([""]);
  });

  test("hooks trust and its review screen can each be escaped", async () => {
    const runtime = replay([
      "SessionStart hooks\n› 1. Review hooks\nPress t to trust all",
      "[ ] Hook 1\nPress space or enter to toggle",
      update,
      prompt,
    ]);
    await driver.prepareForTask("replay", runtime);
    expect(runtime.keys).toEqual(["Escape", "Escape"]);
    expect(runtime.sent).toEqual(["2"]);
  });

  test("afterTaskSubmitted retains numbered user turns as evidence", async () => {
    const runtime = replay(["› 1. fix the bug\nWorking (1s)"]);
    expect(await driver.afterTaskSubmitted("replay", runtime, { beforeOutput: prompt })).toBe(true);
    expect(runtime.sent).toEqual([]);
  });

  test("switchModel still parses the selected numbered rows without readiness filtering", async () => {
    const runtime = replay([
      "Select Model and Effort\n› 1. gpt-6.1-sol (current)\n  2. gpt-6-astra",
      "Select Reasoning Level\n› 1. Low\n  2. High",
      "Model changed to gpt-6-astra high",
    ]);
    expect(await driver.switchModel("replay", runtime, { model: "gpt-6-astra", effort: "high", persist: true }))
      .toBe("Model changed to gpt-6-astra high");
    expect(runtime.sent).toEqual(["/model"]);
    expect(runtime.keys).toEqual(["2", "2"]);
  });
});
