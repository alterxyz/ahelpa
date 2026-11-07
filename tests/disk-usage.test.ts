import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { collectDiskUsage, DISK_CATEGORIES, formatDiskUsage, parseDiskExclusions } from "../src/disk-usage";
import { RuntimeLayout } from "../src/runtime-layout";
import { COMMAND_CONTRACTS, runCli } from "../src/command-contract";
import * as diskUsage from "../src/disk-usage";

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-du-"));
  fixtures.push(path);
  const layout = new RuntimeLayout({ homeDir: join(path, "home"), tmpDir: join(path, "tmp") });
  const cwd = join(path, "project");
  const collect = (extra: Parameters<typeof collectDiskUsage>[0] = {}) => collectDiskUsage({ layout, cwd, env: {}, ...extra });
  return { path, layout, cwd, collect };
}
function file(path: string, bytes: string | number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof bytes === "string" ? bytes : Buffer.alloc(bytes, 65));
}
function database(path: string, rows: { id?: string; project_path: string; delivery_root?: string; target_result_dirs?: string }[]) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("CREATE TABLE sessions (id TEXT, project_path TEXT, delivery_root TEXT, target_result_dirs TEXT)");
  for (const row of rows) db.query("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(row.id ?? "test", row.project_path, row.delivery_root ?? null, row.target_result_dirs ?? null);
  db.close();
}
function total(path: string): { logical: number; allocated: number } {
  const stat = lstatSync(path);
  let logical = stat.isFile() ? stat.size : 0;
  let allocated = stat.blocks * 512;
  if (stat.isDirectory()) for (const name of readdirSync(path)) {
    const child = total(join(path, name)); logical += child.logical; allocated += child.allocated;
  }
  return { logical, allocated };
}

test("empty runtime remains absent, including through stateless JSON CLI", async () => {
  const f = fixture();
  const report = f.collect();
  expect(report.totals.logicalBytes).toBe(0);
  expect(report.totals.allocatedBytes).toBe(0);
  expect(report.complete).toBe(true);
  expect(existsSync(f.layout.homeDir)).toBe(false);
  expect(existsSync(f.layout.tmpDir)).toBe(false);
  expect(COMMAND_CONTRACTS.find(command => command.name === "du")?.stateless).toBe(true);
  const out: string[] = [];
  const collect = spyOn(diskUsage, "collectDiskUsage").mockReturnValue(report);
  try {
    const code = await runCli(undefined, ["du", "--json"], { print: text => out.push(text), printError: text => out.push(text) });
    expect(code).toBe(0);
    expect(JSON.parse(out[0]).totals.allocatedBytes).toBe(0);
  } finally { collect.mockRestore(); }
});

test("classifies by position, preserves catch-alls, and accounts every block", () => {
  const f = fixture();
  const home = f.layout.ahelpaDir;
  const delivery = join(f.cwd, ".ahelpa", "helper");
  file(join(home, "daemon.log.1"), 17);
  file(join(home, "archive/id/message.json"), 23);
  file(join(home, "unknown/nested.dat"), 29);
  file(join(home, "bin/ahelpa"), 31);
  file(join(home, "bin/ahelpa.pre-old"), 37);
  file(join(home, "backups/copy"), 41);
  file(join(delivery, "summary.md"), 43);
  file(join(delivery, "artifacts/summary.md"), 47);
  file(join(delivery, "task.md"), 53);
  file(join(delivery, "turns.log"), 59);
  file(join(delivery, "pi-process.json"), 61);
  file(join(f.cwd, ".ahelpa/jobs/job/mail.jsonl"), 67);
  const report = f.collect();
  const size = (id: string) => report.categories.find(category => category.id === id)!.logicalBytes;
  expect(size("delivery.summary")).toBe(43);
  expect(size("delivery.artifacts")).toBe(47);
  expect(size("delivery.mail")).toBe(67);
  expect(size("delivery.bridge")).toBe(61);
  expect(size("runtime.other")).toBe(29);
  expect(size("install.bin")).toBe(31);
  expect(size("install.backups")).toBe(78);
  const expected = [total(home), total(join(f.cwd, ".ahelpa"))];
  expect(report.totals.logicalBytes).toBe(expected.reduce((sum, value) => sum + value.logical, 0));
  expect(report.totals.allocatedBytes).toBe(expected.reduce((sum, value) => sum + value.allocated, 0));
  expect(report.categories.reduce((sum, category) => sum + category.allocatedBytes, 0)).toBe(report.totals.allocatedBytes);
});

test("sparse files use blocks, not logical bytes", () => {
  const f = fixture();
  const path = join(f.layout.tmpDir, "scratch/id/sparse");
  file(path, 0); truncateSync(path, 16 * 1024 * 1024);
  const report = f.collect();
  expect(report.totals.logicalBytes).toBe(16 * 1024 * 1024);
  expect(report.totals.allocatedBytes).toBe(total(f.layout.tmpDir).allocated);
  expect(report.totals.allocatedBytes).toBeLessThan(report.totals.logicalBytes);
});

test("deduplicates hardlinks across roots and reports externally linked bytes", () => {
  const f = fixture();
  const path = join(f.layout.ahelpaDir, "original");
  file(path, 8192);
  mkdirSync(f.layout.tmpDir, { recursive: true });
  linkSync(path, join(f.layout.tmpDir, "alias"));
  linkSync(path, join(f.path, "outside"));
  const report = f.collect();
  expect(report.totals.logicalBytes).toBe(8192);
  expect(report.categories.reduce((sum, category) => sum + category.linkedElsewhereBytes, 0)).toBe(lstatSync(path).blocks * 512);
  expect(f.collect({ exclude: "tmp" }).totals.logicalBytes).toBe(8192);
});

test("does not follow internal links, cycles or discovered symlink roots", () => {
  const f = fixture();
  file(join(f.path, "outside/big"), 65536);
  mkdirSync(f.layout.tmpDir, { recursive: true });
  mkdirSync(f.cwd, { recursive: true });
  symlinkSync(join(f.path, "outside"), join(f.cwd, ".ahelpa"));
  symlinkSync(join(f.path, "outside"), join(f.layout.tmpDir, "link"));
  symlinkSync(f.layout.tmpDir, join(f.layout.tmpDir, "cycle"));
  const report = f.collect();
  expect(report.totals.logicalBytes).toBe(0);
  expect(report.totals.symlinks).toBe(2);
  expect(report.notCounted).toContainEqual({ kind: "symlink", path: join(f.cwd, ".ahelpa"), target: join(f.path, "outside") });
});

test("nested roots own their contents and exclusions do not fall into other", () => {
  const f = fixture();
  const layout = new RuntimeLayout({ homeDir: f.layout.homeDir, tmpDir: join(f.layout.ahelpaDir, "tmp") });
  file(join(layout.tmpDir, "scratch/id/large"), 101);
  file(join(layout.tmpDir, "ahelpa-task-id.md"), 103);
  const full = f.collect({ layout });
  expect(full.totals.logicalBytes).toBe(204);
  expect(full.categories.find(category => category.id === "tmp.scratch")?.logicalBytes).toBe(101);
  const filtered = f.collect({ layout, exclude: "tmp.scratch" });
  expect(filtered.totals.logicalBytes).toBe(103);
  expect(filtered.categories.some(category => category.id === "tmp.scratch")).toBe(false);
  expect(f.collect({ layout, exclude: "tmp" }).totals.logicalBytes).toBe(0);
});

test("discovers db, delivery root, retained target directories and ledger projects without updating the db", () => {
  const f = fixture();
  const paths = ["recorded", "main", "history", "ledger"].map(name => join(f.path, name));
  for (const path of paths) file(join(path, ".ahelpa/id/summary.md"), 11);
  database(f.layout.stateDbPath(), [{ project_path: paths[0], delivery_root: paths[1], target_result_dirs: JSON.stringify([join(paths[2], ".ahelpa/old")]) }]);
  file(f.layout.needHelpLedgerPath(), JSON.stringify({ projectPath: paths[3] }) + "\ninterrupted");
  const before = lstatSync(f.layout.stateDbPath());
  const report = f.collect();
  const after = lstatSync(f.layout.stateDbPath());
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.size).toBe(before.size);
  expect(report.categories.find(category => category.id === "delivery.summary")?.logicalBytes).toBe(44);
  expect(report.discovery.projects.find(project => project.path === paths[2])?.sources).toContain("db-history");
});

test("scan adds orphan projects while skipping dependency and hidden trees", () => {
  const f = fixture();
  const scan = join(f.path, "projects");
  file(join(scan, "orphan/.ahelpa/id/summary.md"), 71);
  file(join(scan, "node_modules/ignored/.ahelpa/id/summary.md"), 83);
  file(join(scan, ".hidden/ignored/.ahelpa/id/summary.md"), 89);
  expect(f.collect().totals.logicalBytes).toBe(0);
  const report = f.collect({ scan });
  expect(report.totals.logicalBytes).toBe(71);
  expect(report.discovery.projects.some(project => project.sources.includes("scan"))).toBe(true);
});

test("OS temp discovery is limited to the ahelpa namespace and respects exclusions", () => {
  const f = fixture();
  const temp = join(f.path, "os-temp");
  file(join(temp, "ahelpa-closure-gate.example/evidence"), 127);
  file(join(temp, "unrelated/private"), 100000);
  const report = f.collect({ tempDirs: [temp, temp] });
  expect(report.totals.logicalBytes).toBe(127);
  expect(report.categories.find(category => category.id === "tmp.legacy")?.logicalBytes).toBe(127);
  expect(f.collect({ tempDirs: [temp], exclude: "tmp.legacy" }).totals.logicalBytes).toBe(0);
});

test("an unavailable explicit scan root cannot report a complete inventory", () => {
  const f = fixture();
  const missing = f.collect({ scan: join(f.path, "missing") });
  expect(missing.complete).toBe(false);
  expect(missing.errors[0].code).toBe("SCAN_NOT_FOUND");
  const path = join(f.path, "file");
  file(path, 0);
  expect(f.collect({ scan: path }).errors[0].code).toBe("SCAN_NOT_DIRECTORY");
});

test("worktree branch metadata proves ownership, checkout delivery remains separate", () => {
  const f = fixture();
  const main = f.cwd;
  const tree = join(f.path, "project-worktrees/helper");
  const meta = join(main, ".git/worktrees/nonmatching-name");
  file(join(main, ".git/HEAD"), "ref: refs/heads/main\n");
  file(join(meta, "HEAD"), "ref: refs/heads/ahelpa/helper\n");
  file(join(meta, "gitdir"), join(tree, ".git") + "\n");
  file(join(meta, "commondir"), "../..\n");
  file(join(tree, ".git"), "gitdir: " + meta + "\n");
  file(join(tree, "payload"), 97);
  file(join(tree, ".ahelpa/helper/claude-settings.json"), 101);
  file(join(f.path, "project-worktrees/host/payload"), 100000);
  const report = f.collect();
  expect(report.discovery.worktrees).toContain(tree);
  expect(report.categories.find(category => category.id === "delivery.bridge")?.logicalBytes).toBe(101);
  expect(report.categories.find(category => category.id === "worktree.checkouts")!.logicalBytes).toBe(97 + lstatSync(join(tree, ".git")).size);
  expect(report.notCounted).toContainEqual({ kind: "unattributed-worktree", path: join(f.path, "project-worktrees/host") });
});

test("old schemas work; corrupt databases produce a lower-bound report", () => {
  const f = fixture();
  file(join(f.path, "recorded/.ahelpa/id/summary.md"), 107);
  mkdirSync(f.layout.ahelpaDir, { recursive: true });
  const db = new Database(f.layout.stateDbPath());
  db.exec("CREATE TABLE sessions (project_path TEXT)");
  db.query("INSERT INTO sessions VALUES (?)").run(join(f.path, "recorded")); db.close();
  expect(f.collect().categories.find(category => category.id === "delivery.summary")?.logicalBytes).toBe(107);
  file(f.layout.stateDbPath(), "corrupt");
  const report = f.collect();
  expect(report.complete).toBe(false);
  expect(report.errorCount).toBeGreaterThan(0);
  expect(formatDiskUsage(report)).toContain("INCOMPLETE");
  expect(formatDiskUsage(report)).toContain("≥");
});

test("database worktree ownership survives path aliases, detached HEAD and resume rows", () => {
  const f = fixture();
  const tree = join(f.path, "project-worktrees/helper");
  const meta = join(f.cwd, ".git/worktrees/helper");
  file(join(f.cwd, ".git/HEAD"), "ref: refs/heads/main\n");
  file(join(meta, "HEAD"), "detached\n");
  file(join(meta, "commondir"), "../..\n");
  file(join(tree, ".git"), "gitdir: " + meta + "\n");
  file(join(tree, "payload"), 131);
  const alias = join(f.path, "alias");
  symlinkSync(f.path, alias);
  const project_path = join(alias, "project-worktrees/helper");
  database(f.layout.stateDbPath(), [{ id: "helper", project_path }, { id: "resumed", project_path }]);
  const report = f.collect();
  expect(report.discovery.worktrees).toContain(tree);
  expect(report.categories.find(category => category.id === "worktree.checkouts")?.logicalBytes).toBe(131 + lstatSync(join(tree, ".git")).size);
});

test.skipIf(process.getuid?.() === 0)("unreadable subtrees are partial; excluded scratch is never entered", () => {
  const f = fixture();
  const denied = join(f.layout.tmpDir, "scratch/id/denied");
  file(join(denied, "hidden"), 109);
  file(join(f.layout.tmpDir, "other"), 113);
  chmodSync(denied, 0);
  try {
    const report = f.collect();
    expect(report.complete).toBe(false);
    expect(report.categories.find(category => category.id === "tmp.scratch")?.partial).toBe(true);
    expect(report.errors.some(error => error.code === "EACCES")).toBe(true);
    const filtered = f.collect({ exclude: "tmp.scratch" });
    expect(filtered.complete).toBe(true);
    expect(filtered.totals.logicalBytes).toBe(113);
  } finally { chmodSync(denied, 0o700); }
});

test("unknown exclusion IDs fail before scanning", async () => {
  expect(() => parseDiskExclusions("tmp.scratch,typo")).toThrow("Unknown disk usage category");
  const errors: string[] = [];
  expect(await runCli(undefined, ["du", "--exclude", "typo"], { print: () => {}, printError: text => errors.push(text) })).toBe(1);
  expect(errors[0]).toContain("Unknown disk usage category");
});

test("vibe runtime sessions attribute bridge and per-turn input files", () => {
  const f = fixture();
  const delivery = join(f.layout.ahelpaDir, "vibe-0123456789ab");
  for (const name of ["vibe-terminal.mjs", "vibe-process.json", "ahelpa-helper.toml"]) file(join(delivery, name), 7);
  file(join(delivery, "vibe-prompt-11111111-2222-3333-4444-555555555555.txt"), 11);
  file(join(delivery, "summary.md"), 13);
  const report = f.collect({ exclude: "runtime.other" });
  expect(report.categories.find(category => category.id === "delivery.bridge")?.logicalBytes).toBe(21);
  expect(report.categories.find(category => category.id === "delivery.inputs")?.logicalBytes).toBe(11);
  expect(report.categories.find(category => category.id === "delivery.summary")?.logicalBytes).toBe(13);
});
