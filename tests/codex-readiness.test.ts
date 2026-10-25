import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
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

  test("the 0.16x 'Hooks need review' menu is skipped with Escape and reported", async () => {
    const menu = "  Hooks need review\n  5 hooks are new or changed.\n  Hooks can run outside the sandbox after you trust them.\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\n  enter confirm · esc skip";
    const runtime = replay([menu, prompt]);
    const notes = await driver.prepareForTask("replay", runtime);
    expect(runtime.keys).toEqual(["Escape"]);
    expect(runtime.sent).toEqual([]);
    expect(notes).toEqual({ codexHooksSkipped: true });
  });

  test("an answered 'Hooks need review' menu above the composer is scrollback, not escaped again", async () => {
    const runtime = replay([`  Hooks need review\n› 1. Review hooks\n  2. Trust all and continue\n\n${prompt}`]);
    const notes = await driver.prepareForTask("replay", runtime);
    expect(runtime.keys).toEqual([]);
    expect(notes).toBeUndefined();
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

// Real codex-cli 0.163.0 captures of the "Folder access" screen, paths replaced by placeholders.
const folderScreen = (name: string) => readFileSync(new URL(`./fixtures/codex/folder-access-${name}.txt`, import.meta.url), "utf8").trimEnd();
const folder80 = folderScreen("80");
const folder120 = folderScreen("120");
const folderRoot = folderScreen("root");
const folderDaemon = folderScreen("daemon");
const folderRestricted = folderScreen("restricted");
const FOLDER_SCREENS = [["80 columns", folder80], ["120 columns", folder120], ["at the repository root", folderRoot], ["shared daemon wording", folderDaemon]] as const;
const rowTwo = (screen: string) => screen.replace("› 1. Trust and continue", "  1. Trust and continue").replace(/^ {2}2\. (.*)$/m, "› 2. $1");
const PREPARE = ["prepareForTask", "prepareForResume"] as const;

// Every key or text sent advances the screen, like a real menu that answers input.
function sequence(screens: string[]) {
  let state = 0;
  const runtime = replay([]);
  runtime.capture = async () => { runtime.captures++; return screens[Math.min(state, screens.length - 1)]; };
  runtime.sendKey = async (_id, key) => { runtime.keys.push(key); state++; };
  runtime.sendKeys = async (_id, text) => { runtime.sent.push(text); state++; };
  return runtime;
}

describe("codex Folder access screen", () => {
  test.each(PREPARE.flatMap((prepare) => FOLDER_SCREENS.map(([name, screen]) => [prepare, name, screen])))("%s presses Enter once on Trust and continue and reports the root: %s", async (prepare, _name, screen) => {
    const runtime = replay([screen, prompt]);
    expect(await driver[prepare]("replay", runtime)).toEqual({ codexTrust: "<repo root>" });
    expect(runtime.keys).toEqual(["Enter"]);
    expect(runtime.sent).toEqual([]);
    expect(runtime.captures).toBe(2);
  });

  test("a path wrapped by the pane is rejoined in the note", async () => {
    const wrapped = (screen: string, placeholder: string) => screen.replace(placeholder, "/private/var/folders/xx/T/ahelpa-probe-p4XO\n  Y8/repo");
    for (const screen of [wrapped(folder80, "<repo root>"), wrapped(folderRoot, "<repo root>")]) {
      expect(await driver.prepareForTask("replay", replay([screen, prompt]))).toEqual({ codexTrust: "/private/var/folders/xx/T/ahelpa-probe-p4XOY8/repo" });
    }
  });

  test("a lingering screen still gets one Enter", async () => {
    const runtime = replay([folder120, folder120, folder120, prompt]);
    expect(await driver.prepareForTask("replay", runtime)).toEqual({ codexTrust: "<repo root>" });
    expect(runtime.keys).toEqual(["Enter"]);
    expect(runtime.captures).toBe(4);
  });

  const failure = (promise: Promise<unknown>) => promise.then(() => "", (error: Error) => error.message);

  test("an Enter that does not clear the screen is not repeated, and the launch fails naming the trust it left behind", async () => {
    const runtime = replay([folder120]);
    const message = await failure(driver.prepareForTask("replay", runtime));
    expect(message).toContain("did not reach its input prompt");
    expect(message).toContain("Folder access was accepted for <repo root>");
    expect(runtime.keys).toEqual(["Enter"]);
    expect(runtime.sent).toEqual([]);
    expect(runtime.captures).toBe(20);
  });

  test.each(PREPARE.map((prepare) => [prepare] as const))("%s that fails on a later screen after the Enter still names the trust", async (prepare) => {
    const message = await failure(driver[prepare]("replay", sequence([folder120, "Some new screen\n› 1. Continue\n  2. Quit"])));
    expect(message).toContain("did not reach its input prompt");
    expect(message).toContain("Folder access was accepted for <repo root>");
  });

  test("a launch that never pressed Enter does not claim a trust", async () => {
    for (const screen of [rowTwo(folder120), folderRestricted, update]) {
      const message = await failure(driver.prepareForTask("replay", replay([screen])));
      expect(message).toContain("did not reach its input prompt");
      expect(message).not.toContain("Folder access was accepted");
    }
  });

  test.each(FOLDER_SCREENS)("Enter is never sent while row 2 is highlighted: %s", async (_name, folder) => {
    const screen = folder;
    const runtime = replay([rowTwo(screen)]);
    await expect(driver.prepareForResume("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.keys).toEqual([]);
    expect(runtime.sent).toEqual([]);
    expect(runtime.captures).toBe(20);
  });

  test("the legacy Enter nudge cannot answer a live Folder access screen", async () => {
    const runtime = replay([`${rowTwo(folder120)}\n  Press enter to continue`]);
    await expect(driver.prepareForTask("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.keys).toEqual([]);
    expect(runtime.sent).toEqual([]);
  });

  test("the Open restricted screen of an untrusted root is left alone", async () => {
    const runtime = replay([folderRestricted]);
    await expect(driver.prepareForTask("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.keys).toEqual([]);
    expect(runtime.sent).toEqual([]);
  });

  test("a numbered menu that only has the same first row is left alone", async () => {
    const runtime = replay([folder120.replace("Trust this folder?", "Trust the plugin?")]);
    await expect(driver.prepareForTask("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.keys).toEqual([]);
  });

  test("only the latest Folder access screen counts", async () => {
    const runtime = replay([`${folder80}\n${folder120.replace("<repo root>", "<second root>")}`, prompt]);
    expect(await driver.prepareForTask("replay", runtime)).toEqual({ codexTrust: "<second root>" });
    expect(runtime.keys).toEqual(["Enter"]);
  });

  test("a trust screen whose first row is not Trust and continue is left alone", async () => {
    const runtime = replay([folder120.replace("Trust and continue", "Trust and quit")]);
    await expect(driver.prepareForTask("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.keys).toEqual([]);
  });

  test.each([
    ["rows above a ready composer", `${folder120}\n\n${prompt}`],
    ["quoted in a reply", `› Show me the screen\n• It reads:\n  Folder access\n  <dir>\n› 1. Trust and continue\n  2. Quit\n${prompt}`],
  ])("scrollback is never answered: %s", async (_name, screen) => {
    const runtime = replay([screen]);
    expect(await driver.prepareForResume("replay", runtime)).toBeUndefined();
    expect(runtime.keys).toEqual([]);
    expect(runtime.sent).toEqual([]);
  });

  test("a plain prompt reports nothing", async () => {
    expect(await driver.prepareForTask("replay", replay([prompt]))).toBeUndefined();
  });

  test.each([
    ["folder, update", [folder120, update, prompt], ["Enter"], ["2"]],
    ["update, folder", [update, folder120, prompt], ["Enter"], ["2"]],
    ["folder, update with the folder in scrollback", [folder120, `${folder120}\n${update}`, prompt], ["Enter"], ["2"]],
    ["update, folder with the update in scrollback", [update, `${update}\n${folder120}`, prompt], ["Enter"], ["2"]],
    ["hooks, folder", ["SessionStart hooks\n› 1. Review hooks\nPress t to trust all", folder120, prompt], ["Escape", "Enter"], []],
  ] as const)("%s are handled in either order", async (_name, screens, keys, sent) => {
    const runtime = sequence([...screens]);
    const skippedHooks = keys.includes("Escape");
    expect(await driver.prepareForTask("replay", runtime)).toEqual({ codexTrust: "<repo root>", ...(skippedHooks ? { codexHooksSkipped: true } : {}) });
    expect(runtime.keys).toEqual([...keys]);
    expect(runtime.sent).toEqual([...sent]);
  });

  // The numbered "›" row already makes codexHasInputPrompt say no, so this pins that one layer.
  test.each([...FOLDER_SCREENS, ["of an untrusted root", folderRestricted], ["with row 2 highlighted", rowTwo(folder120)]])("the screen is never an input prompt: %s", (_name, screen) => {
    expect(driver.acceptsInput!(screen)).toBe(false);
    expect(driver.acceptsInputAfterTurn!(screen)).toBe(false);
    expect(driver.detectActivity(screen)).toBe("idle");
  });

  // Each variant keeps the screen "live" except for one detail, so Enter would be pressed if that anchor were loosened.
  test.each([
    ["a trust row that is indented", folder120.replace("› 1. Trust and continue", "  › 1. Trust and continue")],
    ["a trust row with a suffix", folder120.replace("1. Trust and continue", "1. Trust and continue (and all parents)")],
    ["two highlighted rows", folder120.replace("  2. Quit", "› 2. Quit")],
    ["a header with a suffix", folder120.replace("\n  Folder access\n", "\n  Folder access granted\n")],
    ["a header inside a longer line", folder120.replace("\n  Folder access\n", "\n  Reopen Folder access\n")],
  ])("Enter is never sent for %s", async (_name, screen) => {
    const runtime = replay([screen]);
    await expect(driver.prepareForTask("replay", runtime)).rejects.toThrow("did not reach its input prompt");
    expect(runtime.keys).toEqual([]);
    expect(runtime.sent).toEqual([]);
  });

  test.each([["80 columns", folder80], ["120 columns", folder120], ["at the repository root", folderRoot]])("a pane that lost its blank lines still reports only the root: %s", async (_name, screen) => {
    const compact = screen.replace(/\n\n/g, "\n");
    expect(await driver.prepareForTask("replay", replay([compact, prompt]))).toEqual({ codexTrust: "<repo root>" });
  });

  test.each([["row 1", folder120], ["row 2", rowTwo(folder120)]])("a hooks prompt answered above a live Folder access screen is not answered again: %s", async (_name, screen) => {
    const runtime = replay([`SessionStart hooks\n› 1. Review hooks\nPress t to trust all\n${screen}`, prompt]);
    await driver.prepareForTask("replay", runtime).catch(() => undefined);
    expect(runtime.keys).not.toContain("Escape");
    expect(runtime.keys).toEqual(screen === folder120 ? ["Enter"] : []);
  });
});
