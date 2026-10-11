import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { Archive } from "../src/archive";
import { kill, logs } from "../src/commands/session-ops";
import { defaultRuntimeLayout } from "../src/runtime-layout";
import { settle } from "../src/settle";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { defaultWakeup } from "../src/wakeup";

let db: StateDB;
let archive: Archive;
let root: string;
let alive: Set<string>;

function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  const fixtures = join(import.meta.dir, "..", ".ahelpa");
  mkdirSync(fixtures, { recursive: true });
  root = mkdtempSync(join(fixtures, "kill-archive-races-"));
  spyOn(defaultRuntimeLayout, "archiveDir").mockReturnValue(join(root, "archive"));
  db = new StateDB(":memory:");
  archive = new Archive(defaultRuntimeLayout.archiveDir());
  for (const [id, parentId] of [["root", "host"], ["child", "root"]]) {
    db.createSession({ id, parentId, agentType: "codex", task: "fixture", ownerToken: `${id}-token`, projectPath: root });
  }
  alive = new Set(["root", "child"]);
  spyOn(defaultWakeup, "notify").mockResolvedValue();
  spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
  spyOn(Tmux, "hasSession").mockImplementation(async (id) => alive.has(id));
  spyOn(Tmux, "capture").mockImplementation(async (id) => `kill snapshot ${id}`);
  spyOn(Tmux, "kill").mockImplementation(async (id) => { alive.delete(id); });
});

afterEach(() => {
  mock.restore();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

for (const status of ["idle", "error", "needs_attention", "draining"] as const) {
  test(`tree skips a child that settles to ${status} during kill capture`, async () => {
    const entered = gate<void>();
    const captured = gate<string>();
    const initial = db.getSession("child")!;
    spyOn(Tmux, "capture").mockImplementation(async (id) => {
      if (id === "child") { entered.release(); return captured.promise; }
      return "root output";
    });
    const pending = kill(db, "root", "root-token", { tree: true });
    await entered.promise;
    let result;
    try {
      expect(await settle(db, archive, defaultWakeup, "child", status,
        { status, lastOutput: "successful final output [AHELPA:DONE]" }, "running", initial.version)).toBe(true);
    } finally {
      captured.release("old output before completion");
      result = await pending;
    }
    expect(result).toEqual({ killed: ["root"], missed: status === "needs_attention" || status === "draining" ? ["child"] : [] });
    expect(Tmux.kill).not.toHaveBeenCalledWith("child");
    expect(alive.has("child")).toBe(true);
    expect(db.getSession("child")?.status).toBe(status);
    expect(archive.get("child")).toMatchObject({ status, lastOutput: "successful final output [AHELPA:DONE]" });
    alive.delete("child");
    expect(await logs(db, "child", "child-token")).toBe("successful final output [AHELPA:DONE]");
  });
}

test("plain kill preserves the settlement that wins during capture", async () => {
  const entered = gate<void>();
  const captured = gate<string>();
  const initial = db.getSession("root")!;
  spyOn(Tmux, "capture").mockImplementation(async () => { entered.release(); return captured.promise; });
  const pending = kill(db, "root", "root-token");
  await entered.promise;
  try {
    expect(await settle(db, archive, defaultWakeup, "root", "idle",
      { status: "idle", lastOutput: "DONE output" }, "running", initial.version)).toBe(true);
  } finally {
    captured.release("old pane output");
    await pending;
  }
  expect(alive.has("root")).toBe(false);
  expect(db.getSession("root")?.status).toBe("idle");
  expect(archive.get("root")).toMatchObject({ status: "idle", lastOutput: "DONE output" });
  expect(await logs(db, "root", "root-token")).toBe("DONE output");
});

test("settle wins during tmux kill without a premature dead snapshot", async () => {
  const entered = gate<void>();
  const releaseKill = gate<void>();
  const initial = db.getSession("root")!;
  spyOn(Tmux, "kill").mockImplementation(async (id) => {
    entered.release();
    await releaseKill.promise;
    alive.delete(id);
  });
  const pending = kill(db, "root", "root-token");
  await entered.promise;
  try {
    expect(archive.get("root")).toBeNull();
    expect(db.getSession("root")).toEqual(initial);
    expect(await settle(db, archive, defaultWakeup, "root", "idle",
      { status: "idle", lastOutput: "settled DONE output" }, "running", initial.version)).toBe(true);
  } finally {
    releaseKill.release();
    await pending;
  }
  expect(db.getSession("root")?.status).toBe("idle");
  expect(archive.get("root")).toMatchObject({ status: "idle", lastOutput: "settled DONE output" });
  expect(await logs(db, "root", "root-token")).toBe("settled DONE output");
});

test("kill commits after termination and rejects a delayed settle", async () => {
  const initial = db.getSession("root")!;
  spyOn(Tmux, "kill").mockImplementation(async (id) => {
    expect(archive.get(id)).toBeNull();
    expect(db.getSession(id)).toEqual(initial);
    alive.delete(id);
  });
  await kill(db, "root", "root-token");
  expect(await settle(db, archive, defaultWakeup, "root", "idle",
    { status: "idle", lastOutput: "stale daemon DONE output" }, "running", initial.version)).toBe(false);
  expect(db.getSession("root")?.status).toBe("dead");
  expect(archive.get("root")).toMatchObject({ status: "dead", lastOutput: "kill snapshot root" });
});

for (const status of ["running", "idle"] as const) {
  test(`failed kill of ${status} session leaves its row and archive untouched`, async () => {
    if (status === "idle") {
      db.updateStatus("root", status);
      archive.save("root", { status, lastOutput: "successful settled output" });
    }
    const initial = db.getSession("root");
    const previousArchive = archive.get("root");
    spyOn(Tmux, "kill").mockRejectedValue(new Error("permission denied"));
    await expect(kill(db, "root", "root-token")).rejects.toThrow("permission denied");
    expect(db.getSession("root")).toEqual(initial);
    expect(archive.get("root")).toEqual(previousArchive);
    expect(defaultWakeup.cleanup).not.toHaveBeenCalled();
  });
}

for (const status of ["idle", "draining", "error", "needs_attention", "dead"] as const) {
  test(`explicit kill of ${status} with a live terminal keeps the existing DONE archive`, async () => {
    db.updateStatus("root", status);
    archive.save("root", { status: "idle", lastOutput: "successful settled output [AHELPA:DONE]" });
    const previousArchive = archive.get("root");
    spyOn(Tmux, "capture").mockResolvedValue("shell prompt after /exit");
    await kill(db, "root", "root-token");
    expect(alive.has("root")).toBe(false);
    expect(db.getSession("root")?.status).toBe("dead");
    expect(archive.get("root")).toEqual(previousArchive);
    expect(await logs(db, "root", "root-token")).toBe("successful settled output [AHELPA:DONE]");
  });
}
