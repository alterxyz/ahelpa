import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { getDriver } from "../src/drivers/registry";

// Panes modeled on each CLI's real layout. The daemon's completion nudge ends
// with Enter, so "idle" must never be mistaken for "the composer has focus".
const trust = JSON.parse(readFileSync(new URL("./fixtures/claude-trust.json", import.meta.url), "utf-8"));
const diffRows = (n: number) => Array.from({ length: n }, (_, i) => `  ${String(i + 3).padStart(3)} + - finding ${i}`);
const folder = (name: string) => readFileSync(new URL(`./fixtures/codex/folder-access-${name}.txt`, import.meta.url), "utf8").trimEnd();
const longReply = Array.from({ length: 24 }, (_, i) => `  - P2 finding ${i}: src/foo.ts:${i + 10} returns early`);

const MUST_REFUSE: Record<string, Record<string, string>> = {
  codex: {
    "Folder access (80 columns)": folder("80"),
    "Folder access (120 columns)": folder("120"),
    "Folder access with row 2 highlighted": folder("120").replace("› 1. Trust and continue", "  1. Trust and continue").replace("  2. Quit", "› 2. Quit"),
    "Folder access of an untrusted root": folder("restricted"),
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
    "folder trust": "  Trust this folder?\n   ❯ Trust and continue\n     Exit\n│ > │",
  },
};

const READY: Record<string, Record<string, string>> = {
  codex: {
    "composer below an answered Folder access screen": `${folder("120")}\n\n› Improve documentation in @filename\n\n  gpt-6.1-sol xhigh · 62% context left · ~/proj`,
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

  test("codex: finished work rows block acceptsInput but not acceptsInputAfterTurn; a spinner or menu blocks both", () => {
    const codex = getDriver("codex");
    const finished = "  └ earlier output\n\n• Ran bun test\n  └ 12 pass\n\n• Done.\n\n  Worked for 3m 02s • 05:33\n\n› Ask Codex to do anything\n\n  ? for shortcuts";
    expect(codex.acceptsInput!(finished)).toBe(false);
    expect(codex.acceptsInputAfterTurn!(finished)).toBe(true);
    expect(codex.workingAfterTurn!(finished)).toBe(false);
    for (const spinner of ["• Working (12s • esc to interrupt)", "• Working (12s)"]) {
      const live = finished.replace("  Worked for 3m 02s • 05:33", spinner);
      expect(codex.acceptsInputAfterTurn!(live)).toBe(false);
      expect(codex.workingAfterTurn!(live)).toBe(true);
    }
    for (const pane of Object.values(MUST_REFUSE.codex)) expect(codex.acceptsInputAfterTurn!(pane)).toBe(false);
    // Upstream request_user_input freeform snapshot (codex-rs v0.154.0): typing there answers the question.
    const question = "Question 1/1 (1 unanswered)\nShare details.\n› Type your answer (optional)\nenter to submit answer | esc to interrupt";
    expect(codex.acceptsInput!(question)).toBe(false);
    expect(codex.acceptsInputAfterTurn!(`${finished.split("› Ask")[0]}${question}`)).toBe(false);
    // A finished reply that only quotes those words leaves the composer ready.
    for (const quoted of ["esc to interrupt", "enter to submit answer", "Question 1/1"]) {
      const pane = finished.replace("• Done.", `• Review complete. The UI text discussed above is:\n  ${quoted}\n\n• Finished review.`);
      expect(codex.acceptsInputAfterTurn!(pane)).toBe(true);
    }
    // Older Codex draws "Worked for" before streaming the answer: not a turn end.
    expect(codex.detectActivity(finished.replace("  Worked for 3m 02s • 05:33", "─ Worked for 3m 02s ─────────"))).toBe("working");
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

describe("hook-aware driver readiness (accepted Stop)", () => {
  const pane = readFileSync(join(import.meta.dir, "fixtures/turn-hooks/claude-completed.txt"), "utf8");
  const codexPane = readFileSync(join(import.meta.dir, "fixtures/turn-hooks/codex-completed.txt"), "utf8");
  const claude = getDriver("claude-code");
  const blocked: Record<string, string> = {
    "numbered permission cursor": "⏺ Bash(command)\n Do you want to proceed?\n ❯ 1. Yes\n   2. No",
    "column-zero permission cursor": "Do you want to proceed?\n❯ 1. Yes\n  2. No",
    "question menu": "⏺ Which approach?\n ❯ 1. First\n   2. Second\n Enter to select · Esc to cancel",
    "workspace trust": trust["wide-with-source-padding"],
    "draft composer": pane.replace(/^❯.*$/mu, "❯ continue editing"),
    "indented empty cursor": pane.replace(/^❯.*$/mu, " ❯ "),
    "live spinner after reply": pane.replace("✻ Crunched for 7s · done 12:26 AM", "✻ Imagining… (5s · ↓ 197 tokens)"),
    "dot spinner frame": pane.replace("✻ Crunched for 7s · done 12:26 AM", "· Imagining… (5s · ↓ 197 tokens)"),
    "spinner without ellipsis or timer": pane.replace("✻ Crunched for 7s · done 12:26 AM", "✻ Imagining"),
    "spinner without ellipsis with timer": pane.replace("✻ Crunched for 7s · done 12:26 AM", "✻ Imagining (5s · ↓ 197 tokens)"),
    "timerless spinner": pane.replace("✻ Crunched for 7s · done 12:26 AM", "✻ Imagining…"),
    "spinner above newer tool bullet": pane.replace("✻ Crunched for 7s · done 12:26 AM", "✻ Imagining… (5s · ↓ 197 tokens)\n⏺ Bash(still-running)"),
    "ASCII spinner with timer": pane.replace("✻ Crunched for 7s · done 12:26 AM", "✻ Imagining... (5s · ↓ 197 tokens)"),
    "iconless Unicode spinner": pane.replace("✻ Crunched for 7s · done 12:26 AM", "Imagining…"),
    "iconless ASCII spinner": pane.replace("✻ Crunched for 7s · done 12:26 AM", "Imagining..."),
    "iconless Unicode spinner with timer": pane.replace("✻ Crunched for 7s · done 12:26 AM", "Imagining… (5s · ↓ 197 tokens)"),
    "iconless ASCII spinner with timer": pane.replace("✻ Crunched for 7s · done 12:26 AM", "Imagining... (5s · ↓ 197 tokens)"),
    "cursorless permission overlay": pane + "\nDo you want to proceed?\n  1. Yes\n  2. No\nEnter to confirm",
    "cursorless selection footer": pane + "\nEnter to select",
    "cursorless cancellation footer": pane + "\nEsc to cancel",
    "cursorless permission prompt": pane + "\nPermission required for this command",
    "cursorless allow prompt": pane + "\nAllow this command?",
    "cursorless numbered menu": pane + "\n  1. Yes\n  2. No",
    "wrapped interrupt hint": "ESC\n to interrupt\n" + pane,
    "interrupt hint anywhere": "esc to interrupt\n" + pane,
    "no composer": pane.replace(/^❯.*\n/mu, ""),
  };
  for (const icon of "✢✽✶✻✳✺✹✸✷✵·") {
    blocked[`timerless ${icon} spinner frame`] = pane.replace("✻ Crunched for 7s · done 12:26 AM", `${icon} Imagining…`);
  }

  describe("hook-aware driver readiness", () => {
    test("real Claude finished pane becomes ready only with accepted turn-end evidence", () => {
      expect(claude.acceptsInput!(pane)).toBe(false);
      expect(claude.acceptsInputAfterTurn?.(pane)).toBe(true);
    });
    for (const [name, output] of Object.entries(blocked)) {
      test(`accepted Stop still refuses ${name}`, () => {
        expect(claude.acceptsInputAfterTurn?.(output)).toBe(false);
      });
    }
    test("completed spinner line is harmless while an older cursor cannot hide a live menu", () => {
      expect(claude.acceptsInputAfterTurn?.("❯ previous task\n" + pane)).toBe(true);
      expect(claude.acceptsInputAfterTurn?.(pane + "\n Do you want to proceed?\n ❯ 1. Yes\n  2. No")).toBe(false);
    });
    test("historical bullets with ellipses do not veto an otherwise finished pane", () => {
      expect(claude.acceptsInputAfterTurn?.(pane.replace("⏺ ok", "⏺ Earlier reply…\n⏺ Earlier tool..."))).toBe(true);
    });
    test("dialog footers above the current empty composer remain historical", () => {
      expect(claude.acceptsInputAfterTurn?.("Enter to confirm · Esc to cancel\n" + pane)).toBe(true);
    });
    test("Codex's saved pane includes an /exit draft and remains refused by existing readiness", () => {
      expect(codexPane).toContain("› /exit");
      expect(getDriver("codex").acceptsInput!(codexPane)).toBe(false);
      expect(getDriver("codex").acceptsInput!("Reply finished\n\n› Improve documentation in @filename\n  gpt-6.1-sol · ~/project")).toBe(true);
    });
  });
});
