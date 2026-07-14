import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";
import { Archive } from "../src/archive";
import { Tmux } from "../src/tmux";
import { RuntimeLayout } from "../src/runtime-layout";
import { harvest, renderHarvestResult } from "../src/commands/harvest";
import { runCli } from "../src/command-contract";

const TEST_DB = "/tmp/ahelpa-harvest-test.db";
const TEST_TMP = "/tmp/ahelpa-harvest-test-tmp";
const TEST_HOME = "/tmp/ahelpa-harvest-test-home";
const TEST_PROJECT = "/tmp/ahelpa-harvest-test-project";
const TEST_DIR = "/tmp/ahelpa-harvest-test-out";
const TMUX_SESSION = "ahelpa-test-harvest";
const AT = new Date("2026-07-14T08:30:12.345Z");

function makeSession(db: StateDB, id: string, status: string, label?: string) {
  db.createSession({ id, parentId: "p", agentType: "claude-code", task: "review the parser", ownerToken: "tok", projectPath: TEST_PROJECT, label });
  if (status !== "running") db.updateStatus(id, status as any);
}

describe("harvest", () => {
  let db: StateDB;
  let layout: RuntimeLayout;
  let archive: Archive;

  beforeEach(() => {
    mkdirSync(TEST_TMP, { recursive: true });
    mkdirSync(TEST_PROJECT, { recursive: true });
    db = new StateDB(TEST_DB);
    layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });
    archive = new Archive(layout.archiveDir());
  });

  afterEach(async () => {
    try { await Tmux.kill(TMUX_SESSION); } catch {}
    try { db.close(); } catch {}
    for (const path of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
    for (const dir of [TEST_TMP, TEST_HOME, TEST_PROJECT, TEST_DIR]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archives the live pane, copies the summary, then closes the session", async () => {
    await Tmux.create(TMUX_SESSION, "echo AHELPA_HARVEST_TRANSCRIPT");
    await Bun.sleep(500);
    makeSession(db, TMUX_SESSION, "needs_attention", "Parser review");
    writeFileSync(layout.taskFilePath(TMUX_SESSION), "task body");
    mkdirSync(join(TEST_PROJECT, ".ahelpa", TMUX_SESSION), { recursive: true });
    writeFileSync(join(TEST_PROJECT, ".ahelpa", TMUX_SESSION, "summary.md"), "# what I did");

    const result = await harvest(db, { sessionId: TMUX_SESSION, dir: TEST_DIR, layout, archive, at: AT });

    const [harvested] = result.harvested;
    expect(harvested.source).toBe("pane");
    expect(harvested.transcriptPath).toBe(`${TEST_DIR}/20260714T083012Z-${TMUX_SESSION}-parser-review.txt`);
    const transcript = readFileSync(harvested.transcriptPath, "utf-8");
    expect(transcript).toContain("AHELPA_HARVEST_TRANSCRIPT");
    expect(transcript).toContain("status: needs_attention");
    expect(transcript).toContain("review the parser");
    expect(readFileSync(harvested.summaryPath!, "utf-8")).toBe("# what I did");

    // Closed: tmux shell gone, task file gone, DB row gone.
    expect(await Tmux.hasSession(TMUX_SESSION)).toBe(false);
    expect(existsSync(layout.taskFilePath(TMUX_SESSION))).toBe(false);
    expect(db.getSession(TMUX_SESSION)).toBeNull();
  });

  test("refuses a running session and leaves it untouched", async () => {
    makeSession(db, "live-1", "running");

    await expect(harvest(db, { sessionId: "live-1", dir: TEST_DIR, layout, archive, at: AT }))
      .rejects.toThrow(/is running; harvest only closes finished sessions/);

    expect(db.getSession("live-1")).not.toBeNull();
    expect(existsSync(TEST_DIR)).toBe(false);
  });

  test("falls back to the archived output when the session was already reaped", async () => {
    makeSession(db, "gone-1", "dead");
    archive.save("gone-1", { status: "dead", lastOutput: "last words before the pane died" });

    const result = await harvest(db, { sessionId: "gone-1", dir: TEST_DIR, layout, archive, at: AT });

    const [harvested] = result.harvested;
    expect(harvested.source).toBe("archive");
    expect(readFileSync(harvested.transcriptPath, "utf-8")).toContain("last words before the pane died");
    expect(harvested.summaryPath).toBeUndefined();
    expect(db.getSession("gone-1")).toBeNull();
  });

  test("still closes a session with no pane and no archive", async () => {
    makeSession(db, "bare-1", "error");

    const result = await harvest(db, { sessionId: "bare-1", dir: TEST_DIR, layout, archive, at: AT });

    expect(result.harvested[0].source).toBe("none");
    expect(readFileSync(result.harvested[0].transcriptPath, "utf-8")).toContain("no output available");
    expect(db.getSession("bare-1")).toBeNull();
  });

  test("--idle harvests every finished session and keeps the live ones", async () => {
    makeSession(db, "done-1", "needs_attention");
    makeSession(db, "done-2", "error");
    makeSession(db, "done-3", "dead");
    makeSession(db, "live-2", "running");
    makeSession(db, "draining-1", "draining");

    const result = await harvest(db, { idle: true, dir: TEST_DIR, layout, archive, at: AT });

    expect(result.harvested.map((session) => session.id).sort()).toEqual(["done-1", "done-2", "done-3"]);
    expect(readdirSync(TEST_DIR)).toHaveLength(3);
    expect(db.getSession("live-2")).not.toBeNull();
    expect(db.getSession("draining-1")).not.toBeNull();

    const rendered = renderHarvestResult(result, true);
    expect(rendered).toContain("done-1 needs_attention archived → ");
    expect(rendered).toContain(`harvested 3 session(s) into ${TEST_DIR}`);
  });

  test("--idle reports an empty sweep instead of failing", async () => {
    makeSession(db, "live-3", "running");

    const result = await harvest(db, { idle: true, dir: TEST_DIR, layout, archive, at: AT });

    expect(result.harvested).toEqual([]);
    expect(renderHarvestResult(result, true)).toBe("no finished sessions to harvest");
  });

  test("defaults the harvest directory to one UTC day under the ahelpa home", () => {
    expect(layout.harvestDir(AT)).toBe(`${TEST_HOME}/.ahelpa/harvest/20260714`);
  });

  test("dispatches through the CLI without an owner token", async () => {
    makeSession(db, "cli-done-1", "needs_attention");
    const out: string[] = [];
    const err: string[] = [];

    const code = await runCli(db, ["harvest", "cli-done-1", "--dir", TEST_DIR], {
      print: (text) => out.push(text),
      printError: (text) => err.push(text),
    });

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[0]).toContain("cli-done-1 needs_attention archived → ");
    expect(db.getSession("cli-done-1")).toBeNull();
  });

  test("rejects a CLI call with neither an id nor --idle", async () => {
    const out: string[] = [];
    const err: string[] = [];

    const code = await runCli(db, ["harvest"], {
      print: (text) => out.push(text),
      printError: (text) => err.push(text),
    });

    expect(code).toBe(1);
    expect(err[0]).toContain("Usage: ahelpa harvest <id> | --idle");
  });
});
