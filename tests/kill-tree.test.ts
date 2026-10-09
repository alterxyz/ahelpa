import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as sessionOps from "../src/commands/session-ops";
import { resume } from "../src/commands/launch";
import { runCli } from "../src/command-contract";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { defaultWakeup } from "../src/wakeup";
import type { SessionStatus } from "../src/session-lifecycle";

const { kill, send, sendTask, logs, capture, MAX_TREE_KILL_PASSES } = sessionOps;

describe("kill --tree", () => {
  let db: StateDB;
  let stopped: string[];

  function session(id: string, parentId = "host", status: SessionStatus = "running") {
    db.createSession({ id, parentId, agentType: "codex", task: "test", ownerToken: `${id}-token`, projectPath: import.meta.dir });
    if (status !== "running") db.updateStatus(id, status);
  }

  beforeEach(() => {
    db = new StateDB(":memory:");
    stopped = [];
    spyOn(Tmux, "kill").mockImplementation(async (id) => { stopped.push(id); });
    spyOn(defaultWakeup, "cleanup").mockImplementation(() => {});
  });

  afterEach(() => {
    mock.restore();
    db.close();
  });

  test("CLI kills three levels leaves first, returns JSON, and leaves sibling trees alone", async () => {
    session("root");
    session("child", "root");
    session("grandchild", "child");
    session("sibling");
    session("sibling-child", "sibling");
    const out: string[] = [];
    const err: string[] = [];
    expect(await runCli(db, ["kill", "root", "--token", "root-token", "--tree"], {
      print: (s) => out.push(s), printError: (s) => err.push(s),
    })).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out[0])).toEqual({ killed: ["grandchild", "child", "root"], missed: [] });
    expect(stopped).toEqual(["grandchild", "child", "root"]);
    for (const id of stopped) {
      expect(db.getSession(id)?.status).toBe("dead");
      expect(defaultWakeup.cleanup).toHaveBeenCalledWith(id);
    }
    expect(db.getSession("sibling")?.status).toBe("running");
    expect(db.getSession("sibling-child")?.status).toBe("running");
  });

  test("a nested target sweeps only its subtree, not its ancestor or siblings", async () => {
    session("ancestor");
    session("root", "ancestor");
    session("child", "root");
    session("sibling", "ancestor");
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: [] });
    expect(stopped).toEqual(["child", "root"]);
    expect(db.getSession("ancestor")?.status).toBe("running");
    expect(db.getSession("sibling")?.status).toBe("running");
  });

  test("re-enumeration catches a late spawn below a parent killed in the previous pass", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "root") session("late", "child");
    });
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root", "late"], missed: [] });
    expect(stopped).toEqual(["child", "root", "late"]);
    expect(db.getSession("late")?.status).toBe("dead");
  });

  test("four passes bound continual late spawns and report the final unseen descendant", async () => {
    expect(MAX_TREE_KILL_PASSES).toBe(4);
    session("root");
    session("late-0", "root");
    let next = 1;
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id !== "root") session(`late-${next++}`, "root");
    });
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({
      killed: ["late-0", "root", "late-1", "late-2", "late-3"], missed: ["late-4"],
    });
    expect(next).toBe(5);
    expect(db.getSession("late-4")?.status).toBe("running");
  });

  test("wrong root token stops nothing, including the root", async () => {
    session("root");
    session("child", "root");
    await expect(Promise.resolve().then(() => kill(db, "root", "wrong", { tree: true }))).rejects.toThrow("Invalid token");
    expect(stopped).toEqual([]);
    expect(defaultWakeup.cleanup).not.toHaveBeenCalled();
    expect(db.getSession("root")?.status).toBe("running");
    expect(db.getSession("child")?.status).toBe("running");
  });

  test("plain kill still stops exactly one session and prints its existing text", async () => {
    session("root");
    session("child", "root");
    const out: string[] = [];
    expect(await runCli(db, ["kill", "root", "--token", "root-token"], {
      print: (s) => out.push(s), printError: () => {},
    })).toBe(0);
    expect(out).toEqual(["killed"]);
    expect(stopped).toEqual(["root"]);
    expect(db.getSession("child")?.status).toBe("running");
  });

  test("a dead root still sweeps active descendants through settled intermediate parents", async () => {
    session("root", "host", "dead");
    session("idle", "root", "idle");
    session("dead", "root", "dead");
    session("error", "root", "error");
    session("child", "idle");
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child"], missed: [] });
    expect(stopped).toEqual(["child"]);
    expect(db.getSession("idle")?.status).toBe("idle");
  });

  test.each(["draining", "needs_attention"] as const)("%s descendants are active and get stopped", async (status) => {
    session("root");
    session("child", "root", status);
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: [] });
    expect(stopped).toEqual(["child", "root"]);
  });

  test("failed descendant kills are missed, without blocking other descendants or retrying forever", async () => {
    session("root");
    session("child", "root");
    session("grandchild", "child");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "grandchild") throw new Error("kill failed");
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: ["grandchild"] });
    expect(stopped).toEqual(["grandchild", "child", "root"]);
    expect(db.getSession("grandchild")?.status).toBe("running");
    expect(defaultWakeup.cleanup).not.toHaveBeenCalledWith("grandchild");
  });

  test("an already vanished descendant is stopped even if tmux kill throws", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "child") throw new Error("cannot find session");
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(false);
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["child", "root"], missed: [] });
    expect(db.getSession("child")?.status).toBe("dead");
  });

  test("an unobservable descendant after a tmux failure is missed", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "child") throw new Error("kill failed");
    });
    spyOn(Tmux, "hasSession").mockRejectedValue(new Error("tmux unavailable"));
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["root"], missed: ["child"] });
    expect(db.getSession("child")?.status).toBe("running");
  });

  test("root failures still reject after attempting descendants", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "root") throw new Error("root kill failed");
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    await expect(kill(db, "root", "root-token", { tree: true })).rejects.toThrow("root kill failed");
    expect(stopped).toEqual(["child", "root"]);
    expect(db.getSession("root")?.status).toBe("running");
    expect(db.getSession("child")?.status).toBe("dead");
  });

  test("a descendant settling before its turn is skipped", async () => {
    session("root");
    session("child", "root");
    session("grandchild", "child");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "grandchild") db.updateStatus("child", "idle");
    });
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["grandchild", "root"], missed: [] });
    expect(stopped).toEqual(["grandchild", "root"]);
    expect(db.getSession("child")?.status).toBe("idle");
  });

  test("a failed descendant that subsequently settles is not missed", async () => {
    session("root");
    session("child", "root");
    spyOn(Tmux, "kill").mockImplementation(async (id) => {
      stopped.push(id);
      if (id === "child") throw new Error("kill failed");
      db.updateStatus("child", "idle");
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    expect(await kill(db, "root", "root-token", { tree: true })).toEqual({ killed: ["root"], missed: [] });
  });

  test("explicit descendant kill invalidates a concurrent settle's row version", async () => {
    session("root");
    session("child", "root");
    const observed = db.getSession("child")!;
    await kill(db, "root", "root-token", { tree: true });
    expect(db.compareAndSetStatus("child", observed.status, "idle", observed.version)).toBe(false);
    expect(db.getSession("child")?.status).toBe("dead");
  });

  test.each(["send", "task", "logs", "capture", "resume"])("root token cannot %s a grandchild", async (op) => {
    session("root");
    session("child", "root");
    session("grandchild", "child");
    const operation = async () => {
      switch (op) {
        case "send": return send(db, "grandchild", "root-token", "hello");
        case "task": return sendTask(db, "grandchild", "root-token", "/missing-task.md");
        case "logs": return logs(db, "grandchild", "root-token");
        case "capture": return capture(db, "grandchild", "root-token");
        default: return resume({ db, sessionId: "grandchild", ownerToken: "root-token" });
      }
    };
    await expect(operation()).rejects.toThrow("Invalid token");
    expect(stopped).toEqual([]);
    expect(db.getSession("grandchild")?.status).toBe("running");
  });
});
