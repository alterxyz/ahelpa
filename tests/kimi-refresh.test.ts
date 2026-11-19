import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { refreshSessionStatuses } from "../src/daemon";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";

let TEST_DB: string;
let scratch: string;

describe("Kimi daemon activity", () => {
  let db: StateDB;

  beforeEach(() => {
    spyOn(Tmux, "liveSessionNames").mockImplementation(async () => new Set(db.listSessions().map(session => session.id)));
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-kimi-refresh-"));
    TEST_DB = join(scratch, "state.db");
  });

  afterEach(() => {
    mock.restore();
    try { db.close(); } catch {}
    rmSync(scratch, { recursive: true, force: true });
  });

  test("keeps a Kimi session running while its submitted task is active", async () => {
    db = new StateDB(TEST_DB);
    db.createSession({
      id: "kimi-working",
      parentId: "p",
      agentType: "kimi",
      task: "t",
      ownerToken: "tok",
      projectPath: "/tmp",
    });
    spyOn(Tmux, "hasSession").mockResolvedValue(true);
    spyOn(Tmux, "capture").mockResolvedValue(
      `│ >   │\n🌕\ncontext: 0%`,
    );

    for (let i = 0; i < 5; i++) {
      await refreshSessionStatuses(db, ["kimi-working"]);
    }

    expect(db.getSession("kimi-working")?.status).toBe("running");
  });

});
