import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { codexDriver } from "../src/drivers/codex";
import { StateDB } from "../src/state";
import { Archive } from "../src/archive";
import { Tmux } from "../src/tmux";
import * as daemon from "../src/daemon";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { defaultWakeup } from "../src/wakeup";
import { wait } from "../src/commands/wait";
import { check, status } from "../src/commands/session-ops";
import { runCli } from "../src/command-contract";

const pane = readFileSync(new URL("./fixtures/codex/model-capacity.txt", import.meta.url), "utf8");
const pane0154 = readFileSync(new URL("./fixtures/codex/model-capacity-0.154.txt", import.meta.url), "utf8");
const errorLine = "■ Selected model is at capacity. Please try a different model.";
const expected = { status: "needs_attention", needHelpTags: null, reason: "model_capacity" } as const;

describe("Codex terminal model errors", () => {
  test("earlier tool/spinner evidence does not hide capacity followed by an idle composer", () => {
    expect(codexDriver.detectOutcome(pane)).toEqual(expected);
    expect(codexDriver.detectStatus(pane)).toBe("needs_attention");
  });

  test.each(["  ", "\t"])("indented assistant quote is not a capacity stop: %j", indent => {
    expect(codexDriver.detectStatus(pane.replace(errorLine, `• The reported symptom is:\n${indent}${errorLine}`))).toBe("running");
  });

  test("indented echoed send text and a first-line quote are not model stops", () => {
    for (const error of [errorLine, "■ Usage limit reached", "⚠ Selected model is at capacity. Please try a different model."]) {
      expect(codexDriver.detectStatus(`› Explain this error, then keep working:\n  ${error}\n\n› Ask Codex to do anything`)).toBe("running");
      expect(codexDriver.detectStatus(`  ${error}\n\n› Ask Codex to do anything`)).toBe("running");
    }
  });

  test("the error phrase must immediately follow the glyph", () => {
    for (const error of ["■ Quoted: Selected model is at capacity.", "■ Example: Usage limit reached", "⚠ Retrying: Selected model is at capacity."]) {
      expect(codexDriver.detectStatus(pane.replace(errorLine, error))).toBe("running");
    }
  });

  test("Codex 0.154 column-zero capacity warning is a model stop", () => {
    expect(codexDriver.detectOutcome(pane0154)).toEqual(expected);
    expect(codexDriver.detectStatus(pane0154.replace("⚠ Selected", "  ⚠ Selected"))).toBe("running");
    expect(codexDriver.detectStatus(pane0154.replace("⚠ Selected", "Working (1s)\n⚠ Selected")
      .replace("› Ask", "Working (2s)\n› Ask"))).toBe("running");
  });

  test("warning usage limits and retrying streams are not classified as terminal stops", () => {
    for (const error of ["⚠ Usage limit reached", "⚠ You've hit your usage limit.", "⚠ stream disconnected before completion; retrying"]) {
      expect(codexDriver.detectStatus(pane.replace(errorLine, error))).toBe("running");
    }
  });

  test.each(["›", "› ", "› Explain this codebase", "› Ask Codex to do anything"])("composer shape %j and CRLF", composer => {
    const output = pane.replace("› Ask Codex to do anything", composer).replaceAll("\n", "\r\n");
    expect(codexDriver.detectOutcome(output)).toEqual(expected);
  });

  test.each(["Working (1s)", "esc to interrupt", "• Ran bun test", "• Explored"])(
    "work after the error means recovery: %s", work => {
      const recovered = pane.replace(errorLine, `${errorLine}\n\n${work}`);
      expect(codexDriver.detectOutcome(recovered)).toEqual({ status: "running", needHelpTags: null });
    },
  );

  test.each(["[AHELPA:DONE]", "[AHELPA:NEED_HELP:input]"])("sentinel still wins: %s", sentinel => {
    const output = pane.replace(errorLine, `${errorLine}\n${sentinel}`);
    expect(codexDriver.detectOutcome(output)).toEqual(sentinel.includes("DONE")
      ? { status: "idle", needHelpTags: null }
      : { status: "error", needHelpTags: ["input"] });
  });

  test("normal DONE remains idle", () => {
    expect(codexDriver.detectOutcome(pane.replace(errorLine, "[AHELPA:DONE]")))
      .toEqual({ status: "idle", needHelpTags: null });
  });

  test("requires a composer after the error", () => {
    expect(codexDriver.detectStatus(pane.slice(0, pane.indexOf("› Ask")))).toBe("running");
    expect(codexDriver.detectStatus(pane.replace("› Ask Codex to do anything", "› 1. Retry"))).toBe("running");
  });

  test("detects a scrolled-out task and an empty composer", () => {
    expect(codexDriver.detectOutcome(`${errorLine}\n\n› \n`)).toEqual(expected);
  });

  test.each(["Usage limit reached", "You've hit your usage limit. Try again later."])("explicit usage limit: %s", message => {
    expect(codexDriver.detectOutcome(pane.replace(errorLine, `■ ${message}`)))
      .toEqual({ status: "needs_attention", needHelpTags: null, reason: "usage_limit" });
  });

  test("leaves ambiguous stream errors and unrecognized error lines to existing monitoring", () => {
    for (const message of ["stream disconnected before completion; retrying", "Something failed"]) {
      expect(codexDriver.detectStatus(pane.replace(errorLine, `■ ${message}`))).toBe("running");
    }
  });

  test("does not reuse an old capacity stop in a new turn", () => {
    const previous = pane.slice(0, pane.indexOf("› Ask"));
    for (const current of ["› New task\nWorking (1s)", "› New task\n\n› Ask Codex to do anything"]) {
      expect(codexDriver.detectStatus(`${previous}${current}`)).toBe("running");
    }
  });

  test("the last error wins after a recovered attempt fails again", () => {
    const output = pane.replace(errorLine, `${errorLine}\nWorking (2s)\n${errorLine}`);
    expect(codexDriver.detectOutcome(output)).toEqual(expected);
  });
});

describe("capacity settlement and reporting", () => {
  let root: string;
  let db: StateDB;
  let id: string;
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-capacity-"));
    id = `codex-capacity-${root.split("/").at(-1)}`;
    db = new StateDB(join(root, "state.db"));
    db.createSession({ id, parentId: "fixture-parent", agentType: "codex", task: "synthetic task",
      ownerToken: "synthetic-private-token", projectPath: root });
    spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(join(root, "archive"));
    spyOn(daemon, "isDaemonRunning").mockReturnValue(false);
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(pane);
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    spyOn(defaultWakeup, "notify").mockResolvedValue();
    spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
  });
  afterEach(() => { mock.restore(); db.close(); rmSync(root, { recursive: true, force: true }); });

  test("inline wait confirms on two polls, archives the reason and wakes waiters without retrying", async () => {
    const dir = defaultRuntimeLayout.sessionDeliveryDir(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.md"), "partial result");
    expect(await wait(db, [id], false, 0)).toMatchObject({ status: "still_running" });
    expect(db.getSession(id)?.status).toBe("running");
    expect(defaultWakeup.notify).not.toHaveBeenCalled();
    const result = await wait(db, [id], false, 0);
    expect(result).toMatchObject({ sessionId: id, status: "needs_attention", reason: "model_capacity" });
    expect(db.getSession(id)?.status).toBe("needs_attention");
    expect(new Archive(defaultRuntimeLayout.archiveDir()).get(id)).toMatchObject({ status: "needs_attention", reason: "model_capacity" });
    expect(defaultWakeup.notify).toHaveBeenCalledWith(id, "needs_attention");
    expect(defaultWakeup.cleanup).toHaveBeenCalledWith(id);
    expect(Tmux.sendKeys).not.toHaveBeenCalled();
    expect(check(db)[0]).toMatchObject({ status: "needs_attention", reason: "model_capacity" });
    expect(status(db, false)).toContain("model_capacity");
    expect(JSON.stringify([result, check(db), status(db, false)])).not.toContain("synthetic-private-token");

    db.close();
    db = new StateDB(join(root, "state.db"));
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    expect(await wait(db, [id], false, 0)).toMatchObject({ reason: "model_capacity" });
  });

  test.each([false, true])("CLI wait reports reason with exit 1 (all=%s)", async all => {
    const out: string[] = [];
    const err: string[] = [];
    await daemon.refreshSessionStatuses(db, [id]);
    const code = await runCli(db, ["wait", id, ...(all ? ["--all"] : []), "--timeout", "0"],
      { print: value => out.push(value), printError: value => err.push(value) });
    expect(code).toBe(1);
    const result = JSON.parse(out[0]);
    expect(all ? result[0] : result).toMatchObject({ sessionId: id, status: "needs_attention", reason: "model_capacity" });
    expect(err).toEqual([]);
  });

  test("a draft/new-task frame gets one poll to become a fresh turn; stable errors need two polls", async () => {
    const oldTurn = pane.slice(0, pane.indexOf("› Ask"));
    const transition = `${oldTurn}› New task\n`;
    const capture = spyOn(Tmux, "capture").mockResolvedValue(transition);
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    expect(defaultWakeup.notify).not.toHaveBeenCalled();
    capture.mockResolvedValue(`${transition}\n› Ask Codex to do anything`);
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    capture.mockResolvedValue(pane);
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("needs_attention");
  });

  test("confirmation cannot cross session versions or a recovered frame", async () => {
    await daemon.refreshSessionStatuses(db, [id]);
    const row = db.getSession(id)!;
    expect(db.beginTurn(id, row.version, "continue")).not.toBeNull();
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    const capture = spyOn(Tmux, "capture").mockResolvedValue(pane.replace(errorLine, `${errorLine}\nWorking (2s)`));
    await daemon.refreshSessionStatuses(db, [id]);
    capture.mockResolvedValue(pane);
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("needs_attention");
  });

  test("Codex 0.154 warning settles after two polls despite old work evidence", async () => {
    spyOn(Tmux, "capture").mockResolvedValue(pane0154);
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    await daemon.refreshSessionStatuses(db, [id]);
    expect(check(db)[0]).toMatchObject({ status: "needs_attention", reason: "model_capacity" });
  });

  test.each([false, true])("deleted rows discard pending confirmation before same-ID recreation (dead first=%s)", async deadFirst => {
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    if (deadFirst) {
      db.updateStatus(id, "dead");
      await daemon.refreshSessionStatuses(db, [id]);
    }
    db.deleteSession(id);
    // Each variant must clear on its own: observing dead, or observing absence.
    if (!deadFirst) await daemon.refreshSessionStatuses(db, [id]);
    db.createSession({ id, parentId: "fixture-parent", agentType: "codex", task: "synthetic task",
      ownerToken: "synthetic-private-token", projectPath: root });
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("needs_attention");
  });

  test("targeted pruning leaves another running session's pending confirmation intact", async () => {
    const second = `${id}-second`;
    db.createSession({ id: second, parentId: "fixture-parent", agentType: "codex", task: "synthetic task",
      ownerToken: "synthetic-private-token", projectPath: root });
    await daemon.refreshSessionStatuses(db, [id, second]);
    expect(db.getSession(second)?.status).toBe("running");
    db.deleteSession(id);
    await daemon.refreshSessionStatuses(db, [id]);
    await daemon.refreshSessionStatuses(db, [second]);
    expect(db.getSession(second)?.status).toBe("needs_attention");
  });

  test.each([false, true])("wait exit compatibility for legacy and model reasons (all=%s)", async all => {
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    const archive = new Archive(defaultRuntimeLayout.archiveDir());
    for (const reason of [undefined, "turn ended without signal", "turn hook stop_failure: unknown", "model_capacity", "usage_limit"]) {
      db.updateStatus(id, "needs_attention");
      archive.save(id, { status: "needs_attention", reason });
      const out: string[] = [];
      const code = await runCli(db, ["wait", id, ...(all ? ["--all"] : []), "--timeout", "0"],
        { print: value => out.push(value), printError: () => {} });
      expect(code).toBe(reason === "model_capacity" || reason === "usage_limit" ? 1 : 0);
      const result = JSON.parse(out[0]);
      expect(all ? result[0] : result).toMatchObject({ status: "needs_attention" });
    }
    db.updateStatus(id, "error");
    archive.save(id, { status: "error", reason: "model_capacity" });
    expect(await runCli(db, ["wait", id, ...(all ? ["--all"] : []), "--timeout", "0"],
      { print: () => {}, printError: () => {} })).toBe(0);
  });

  test("post-error work stays running through repeated refreshes", async () => {
    spyOn(Tmux, "capture").mockResolvedValue(pane.replace(errorLine, `${errorLine}\nWorking (2s)`));
    for (let poll = 0; poll < 5; poll++) await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("running");
    expect(defaultWakeup.notify).not.toHaveBeenCalled();
  });

  test("missing, damaged, or older-turn archives do not leak reasons or break reporting", async () => {
    db.updateStatus(id, "needs_attention");
    const archive = new Archive(defaultRuntimeLayout.archiveDir());
    expect(check(db)[0]).not.toHaveProperty("reason");
    archive.save(id, { status: "needs_attention", reason: "old reason" });
    const path = join(defaultRuntimeLayout.archiveDir(), id, "message.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...saved, archivedAt: "2000-01-01T00:00:00.000Z" }));
    expect(check(db)[0]).not.toHaveProperty("reason");
    expect(status(db, true)).not.toContain("old reason");
    writeFileSync(path, "{");
    expect(await wait(db, [id], false, 0)).not.toHaveProperty("reason");
    expect(check(db)[0]).not.toHaveProperty("reason");
  });

  test("rearming hides the archived reason and a later success does not retain it", async () => {
    await daemon.refreshSessionStatuses(db, [id]);
    await daemon.refreshSessionStatuses(db, [id]);
    expect(db.getSession(id)?.status).toBe("needs_attention");
    db.updateStatus(id, "running");
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
    expect(check(db)[0]).not.toHaveProperty("reason");
    expect(status(db, true)).not.toContain("model_capacity");
    expect(await wait(db, [id], false, 0)).not.toHaveProperty("reason");
    spyOn(Tmux, "capture").mockResolvedValue(pane.replace(errorLine, "[AHELPA:DONE]"));
    await daemon.refreshSessionStatuses(db, [id]);
    const out: string[] = [];
    expect(await runCli(db, ["wait", id, "--timeout", "0"], { print: v => out.push(v), printError: () => {} })).toBe(0);
    expect(JSON.parse(out[0])).toMatchObject({ status: "idle" });
    expect(JSON.parse(out[0])).not.toHaveProperty("reason");
  });
});
