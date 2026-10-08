import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { getDriver } from "../src/drivers/registry";

// Panes modeled on each CLI's real layout. The daemon's completion nudge ends
// with Enter, so "idle" must never be mistaken for "the composer has focus".
const trust = JSON.parse(readFileSync(new URL("./fixtures/claude-trust.json", import.meta.url), "utf-8"));
const diffRows = (n: number) => Array.from({ length: n }, (_, i) => `  ${String(i + 3).padStart(3)} + - finding ${i}`);
const longReply = Array.from({ length: 24 }, (_, i) => `  - P2 finding ${i}: src/foo.ts:${i + 10} returns early`);

const MUST_REFUSE: Record<string, Record<string, string>> = {
  codex: {
    "model menu": "  Select Model and Effort\n\n› 1. gpt-6.1-sol (current)\n  2. gpt-6-astra\n\n  Press enter to select reasoning effort, or esc to dismiss.",
    "command approval": [
      "› Please read and complete the task described in /tmp/ahelpa/ahelpa-task-codex-x.md.",
      "", "• I'll clean the build output first.", "",
      "  Would you like to run the following command?", "", "  $ rm -rf build", "",
      "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again for this command (a)", "  3. No, and tell Codex what to do differently (esc)",
      "", "  Press enter to confirm or esc to cancel",
    ].join("\n"),
  },
  "claude-code": {
    "workspace trust": trust["wide-with-source-padding"],
    "Bash permission with tool bullet visible": [
      "❯ Please read and complete the task described in /tmp/ahelpa/ahelpa-task-claude-x.md.", "",
      "⏺ Bash(rm -rf build)", "", "────────────────", " Bash command", "", "   rm -rf build", "",
      " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for rm commands", "   3. No, and tell Claude what to do differently (esc)",
    ].join("\n"),
    // Safe-mode helper editing its own summary: the preview pushed the ⏺ header
    // out of the capture, so only the indented, numbered cursor remains to tell.
    "Edit permission with the tool header scrolled out": [
      "────────────────", " Edit file", " .ahelpa/claude-x/summary.md", "╌╌╌╌╌╌╌╌",
      ...diffRows(22),
      "╌╌╌╌╌╌╌╌", " Do you want to make this edit to summary.md?",
      " ❯ 1. Yes", "   2. Yes, allow all edits during this session (shift+tab)", "   3. No, and tell Claude what to do differently (esc)",
    ].join("\n"),
    "Edit permission with a 55-line preview in a 54-line capture": [
      "❯ Please read and complete the task described in /tmp/ahelpa/ahelpa-task-claude-x.md.",
      "⏺ Update(.ahelpa/claude-x/summary.md)", "────────────────", " Edit file", " .ahelpa/claude-x/summary.md",
      ...diffRows(55),
      " Do you want to make this edit to summary.md?",
      " ❯ 1. Yes", "   2. Yes, allow all edits during this session (shift+tab)", "   3. No, and tell Claude what to do differently (esc)",
    ].join("\n").split("\n").slice(-54).join("\n"),
    "only the echoed user turn is visible, no composer": "❯ Please read and complete the task described in /tmp/ahelpa/ahelpa-task-claude-x.md.\n",
    "composer holding a draft": "  - finding 1\n\n────────────────\n❯ fix the second finding too\n────────────────\n  ⏵⏵ bypass permissions on",
    "AskUserQuestion menu": [
      "⏺ Which approach should I take?", "",
      " ❯ 1. Keep the current schema", "   2. Migrate to the new one", "   3. Other",
      "", "  Enter to select · Esc to cancel",
    ].join("\n"),
  },
  kimi: {
    "command approval": [
      "✨ Please read and complete the task described in /tmp/ahelpa-task-kimi.md.",
      "● I'll clean the build output.", "▶ Run this command?", "1. Approve once", "2. Approve for this session", "↵ confirm",
      "╭──────────────────────────────────╮", "│ >                                │", "╰──────────────────────────────────╯",
    ].join("\n"),
    "folder trust": "Trust this folder?\n› Trust\n  Don't trust\n│ > │",
  },
};

const READY: Record<string, Record<string, string>> = {
  codex: {
    "placeholder composer after a long reply": [
      ...longReply, "", "─ Worked for 4m 12s ─────────────", "", "› Improve documentation in @filename", "",
      "  gpt-6.1-sol xhigh · 62% context left · ~/proj",
    ].join("\n"),
  },
  "claude-code": {
    "composer after a long reply with ⏺ scrolled out": [
      ...longReply, "", "────────────────", "❯ ", "────────────────", "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n"),
  },
  kimi: {
    "empty composer after a reply": [
      "✨ Please read and complete the task described in /tmp/ahelpa-task-kimi.md.",
      "● Used Write (.ahelpa/kimi-x/summary.md) · 12 lines", "● Summary written to .ahelpa/kimi-x/summary.md.",
      "╭──────────────────────────────────╮", "│ >                                │", "╰──────────────────────────────────╯",
      "yolo  kimi-k3 thinking: high",
    ].join("\n"),
  },
};

describe("acceptsInput", () => {
  test("claude-code: a visible ⏺ in the current turn still reads as working, so the nudge path is never reached", () => {
    const pane = [
      "❯ Please read and complete the task described in /tmp/ahelpa/ahelpa-task-claude-x.md.", "",
      "⏺ Summary written to .ahelpa/claude-x/summary.md.", "", "────────────────", "❯ ", "────────────────",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(getDriver("claude-code").detectActivity(pane)).toBe("working");
  });

  for (const [agent, panes] of Object.entries(MUST_REFUSE)) {
    for (const [name, pane] of Object.entries(panes)) {
      test(`${agent} refuses: ${name}`, () => {
        expect(getDriver(agent).acceptsInput!(pane)).toBe(false);
      });
    }
  }
  for (const [agent, panes] of Object.entries(READY)) {
    for (const [name, pane] of Object.entries(panes)) {
      test(`${agent} accepts: ${name}`, () => {
        expect(getDriver(agent).acceptsInput!(pane)).toBe(true);
      });
    }
  }
});
