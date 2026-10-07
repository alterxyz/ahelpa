import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB } from "../src/state";

describe("cross-process row versions", () => {
  let root: string;
  let dbPath: string;
  let db: StateDB;

  beforeEach(() => {
    root = mkdtempSync(join(process.cwd(), ".ahelpa-version-test-"));
    dbPath = join(root, "state.db");
    db = new StateDB(dbPath);
    db.createSession({ id: "shared", parentId: "host", agentType: "codex", task: "fixture", ownerToken: "tok", projectPath: root });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function raceWriters(phase: "update" | "cas", expectedVersion: number) {
    const count = 4;
    const gatePath = join(root, `${phase}-gate`);
    const children = Array.from({ length: count }, (_, index) => Bun.spawn([process.execPath, "-e", `
      import { Database } from "bun:sqlite";
      import { existsSync, writeFileSync } from "fs";
      import { StateDB } from ${JSON.stringify(join(import.meta.dir, "../src/state.ts"))};
      const db = new StateDB(${JSON.stringify(dbPath)});
      const prepare = Database.prototype.prepare;
      Database.prototype.prepare = function(sql) {
        if (sql.startsWith("UPDATE sessions SET status =")) {
          // Stop immediately before UPDATE, after any erroneous JS-side read/increment.
          writeFileSync(${JSON.stringify(join(root, `${phase}-ready-${index}`))}, "ready");
          const started = performance.now();
          while (!existsSync(${JSON.stringify(gatePath)})) {
            if (performance.now() - started > 10000) throw new Error("Writer barrier timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          }
        }
        return prepare.call(this, sql);
      };
      try {
        let result;
        // Hold the write lock through reading our version, so a later writer
        // cannot hide an intermediate version from the assertion.
        db.transaction(() => {
          const changed = ${phase === "update"
            ? '(db.updateStatus("shared", "running"), true)'
            : `db.compareAndSetStatus("shared", "running", "running", ${expectedVersion})`};
          result = { changed, version: db.getSession("shared").version };
        });
        console.log(JSON.stringify(result));
      } finally {
        db.close();
      }
    `], { stdout: "pipe", stderr: "pipe" }));
    const outcomes = children.map(async (child) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    });

    try {
      const started = performance.now();
      while (!children.every((_, index) => existsSync(join(root, `${phase}-ready-${index}`)))) {
        if (performance.now() - started > 8000) throw new Error("Writers did not reach UPDATE barrier");
        await Bun.sleep(2);
      }
      writeFileSync(gatePath, "go");
      const results = await Promise.all(outcomes);
      expect(results.map(({ exitCode, stderr }) => ({ exitCode, stderr })))
        .toEqual(Array.from({ length: count }, () => ({ exitCode: 0, stderr: "" })));
      return results.map(({ stdout }) => JSON.parse(stdout) as { changed: boolean; version: number });
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.allSettled(outcomes);
    }
  }

  test("barrier-released concurrent UPDATEs yield distinct versions and exactly one version CAS winner", async () => {
    const originalVersion = db.getSession("shared")!.version;
    const writes = await raceWriters("update", originalVersion);
    expect(writes.every(({ changed }) => changed)).toBe(true);
    expect(writes.map(({ version }) => version).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4].map((offset) => originalVersion + offset));
    const observedVersion = db.getSession("shared")!.version;
    expect(observedVersion).toBe(originalVersion + writes.length);

    // The status remains running even after a win, so only the version
    // predicate can reject the other writers with the same observed row.
    const attempts = await raceWriters("cas", observedVersion);
    expect(attempts.filter(({ changed }) => changed)).toHaveLength(1);
    expect(attempts.map(({ version }) => version)).toEqual(Array(4).fill(observedVersion + 1));
    expect(db.getSession("shared")?.version).toBe(observedVersion + 1);
  }, 20000);
});
