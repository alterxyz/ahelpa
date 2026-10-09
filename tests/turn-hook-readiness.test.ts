import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getDriver } from "../src/drivers/registry";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { COMPLETION_NUDGE, refreshSessionStatuses } from "../src/daemon";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { writeTurnHook } from "../src/turn-hooks";

const pane = readFileSync(join(import.meta.dir, "fixtures/turn-hooks/claude-completed.txt"), "utf8");
const codexPane = readFileSync(join(import.meta.dir, "fixtures/turn-hooks/codex-completed.txt"), "utf8");
const trust = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/claude-trust.json"), "utf8"));
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
  "interrupt hint anywhere": "esc to interrupt\n" + pane,
  "no composer": pane.replace(/^❯.*\n/mu, ""),
};

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
  test("Codex's saved pane includes an /exit draft and remains refused by existing readiness", () => {
    expect(codexPane).toContain("› /exit");
    expect(getDriver("codex").acceptsInput!(codexPane)).toBe(false);
    expect(getDriver("codex").acceptsInput!("Reply finished\n\n› Improve documentation in @filename\n  gpt-6.1-sol · ~/project")).toBe(true);
  });
});

let root: string;
let db: StateDB;
let count = 0;
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".ahelpa", "hook-ready-test-"));
  db = new StateDB(join(root, "state.db"));
  spyOn(Tmux, "hasSession").mockResolvedValue(true);
  spyOn(Tmux, "capture").mockResolvedValue(pane);
  spyOn(Tmux, "sendKeys").mockResolvedValue();
});
afterEach(() => { mock.restore(); db.close(); rmSync(root, { recursive: true, force: true }); });
function seed(hook = true) {
  const id = `claude-ready-${++count}`;
  db.createSession({ id, parentId: "host", agentType: "claude-code", task: "test", ownerToken: "tok", projectPath: root });
  const dir = defaultRuntimeLayout.sessionDeliveryDir(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.md"), "Result written");
  if (hook) writeTurnHook(dir, "claude-code", JSON.stringify({ hook_event_name: "Stop", session_id: "native", prompt_id: "prompt" }));
  return id;
}

describe("daemon uses hook readiness only for current accepted events", () => {
  test("real finished Claude pane nudges on the first hook refresh", async () => {
    const id = seed();
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(Tmux.sendKeys).toHaveBeenCalledWith(id, COMPLETION_NUDGE);
    expect(db.getSession(id)?.nudgedAt).toBeTruthy();
    expect(db.getSession(id)?.turnHookOffset).toBeGreaterThan(0);
  });
  test("the same pane without a hook never uses the new readiness path", async () => {
    const id = seed(false);
    for (let i = 0; i < 4; i++) await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
  });
  for (const [name, output] of Object.entries(blocked)) {
    test(`hook cannot nudge ${name}`, async () => {
      const id = seed();
      spyOn(Tmux, "capture").mockResolvedValue(output);
      await refreshSessionStatuses(db, [id]);
      expect(Tmux.sendKeys).not.toHaveBeenCalled();
      expect(db.getSession(id)?.nudgedAt).toBeNull();
    });
  }
  test("a hook from before the new host turn cannot authorize relaxed readiness", async () => {
    const id = seed();
    await Bun.sleep(2);
    db.beginTurn(id, db.getSession(id)!.version);
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
  });
  test("row-version change during capture still prevents the hook-aware nudge", async () => {
    const id = seed();
    spyOn(Tmux, "capture").mockImplementation(async () => { db.updateResumeId(id, "new-version"); return pane; });
    await refreshSessionStatuses(db, [id]);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
    expect(db.getSession(id)?.turnHookOffset).toBeNull();
  });
});
