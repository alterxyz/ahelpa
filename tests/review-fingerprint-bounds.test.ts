import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { $ } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { computeTargetFingerprint, collectEvidence } from "../src/evidence";
import { executeLaunch, planLaunch } from "../src/commands/launch";
import { wait } from "../src/commands/wait";
import { StateDB } from "../src/state";
import { Tmux } from "../src/tmux";
import { FIFO } from "../src/fifo";
import * as daemon from "../src/daemon";

let root: string, project: string, db: StateDB;
const realGit = Bun.which("git")!;
const originalPath = process.env.PATH;
const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

beforeEach(async () => {
  root = mkdtempSync(join(import.meta.dir, "../.ahelpa/fingerprint-bounds-"));
  project = join(root, "repo");
  process.env.GIT_CEILING_DIRECTORIES = root;
  db = new StateDB(join(root, "state.db"));
  spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
  spyOn(Tmux, "create").mockResolvedValue();
  spyOn(Tmux, "sendKeys").mockResolvedValue();
  spyOn(FIFO, "create").mockResolvedValue();
  await initRepo(project, "base\n");
});

afterEach(() => {
  mock.restore();
  db.close();
  process.env.PATH = originalPath;
  if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
  rmSync(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]) {
  return (await $`${realGit} -C ${cwd} ${args}`.quiet()).text().trim();
}
async function initRepo(cwd: string, content: string) {
  mkdirSync(cwd, { recursive: true });
  await git(cwd, "init", "-q");
  writeFileSync(join(cwd, "code.ts"), content);
  await git(cwd, "add", ".");
  await git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
}
function shim(body: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const path = join(bin, "git");
  writeFileSync(path, `#!/bin/sh\n${body}\nexec ${quote(realGit)} "$@"\n`);
  chmodSync(path, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
}
async function launchReviewer() {
  const plan = planLaunch({ db, agentType: "codex", role: "reviewer", task: "review independently", projectPath: project, parentId: "host" });
  spyOn(plan.driver, "prepareForTask").mockResolvedValue();
  spyOn(plan.driver, "afterTaskSubmitted").mockResolvedValue(true);
  await executeLaunch(plan);
  db.updateStatus(plan.sessionId, "idle");
  return plan;
}
async function addModule() {
  const child = join(root, "child");
  await initRepo(child, "child\n");
  await git(project, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "vendor");
  await git(project, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "module");
}

// Sibling repo exists too: trim() would silently compute a valid wrong baseline.
test("trailing-space repository binds the actual target and detects edits", async () => {
  project = join(root, "repo ");
  await initRepo(project, "actual target\n");
  const head = await git(project, "rev-parse", "HEAD");
  const reviewer = await launchReviewer();
  expect(db.getSession(reviewer.sessionId)?.targetFingerprint?.head).toBe(head);
  writeFileSync(join(project, "code.ts"), "target changed\n");
  const result = await wait(db, [reviewer.sessionId], false, 2000);
  expect(result).toMatchObject({ evidence: { targetChanged: true } });
});

test("a physical root outside the project yields no fingerprint, never unchanged", async () => {
  const other = join(root, "other");
  await initRepo(other, "other\n");
  const baseline = await computeTargetFingerprint(project);
  shim(`case "$*" in *"rev-parse --show-toplevel"*) printf '%s\\n' ${quote(other)}; exit 0 ;; esac`);
  expect(await computeTargetFingerprint(project)).toBeNull();
  const evidence = await collectEvidence({ id: "review", projectPath: project, role: "reviewer", targetFingerprint: baseline });
  expect(evidence.targetChanged).toBeUndefined();
  expect(evidence.currentFingerprint).toBeUndefined();
  expect(evidence.targetFingerprintIncomplete).toContain("unavailable");
});

test("wait bounds slow fingerprint git and kills its child process", async () => {
  const reviewer = await launchReviewer();
  const pidFile = join(root, "child.pid");
  shim(`case "$*" in *"rev-parse --show-toplevel"*) sleep 4 & echo $! > ${quote(pidFile)}; wait ;; esac`);
  const start = performance.now();
  const result = await wait(db, [reviewer.sessionId], false, 2000);
  expect(performance.now() - start).toBeLessThan(2800);
  expect(result).toMatchObject({ evidence: { targetFingerprintIncomplete: expect.stringContaining("deadline") } });
  if (!Array.isArray(result)) expect(result.evidence?.targetChanged).toBeUndefined();
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await Bun.sleep(30);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("fingerprint after acceptance uses only the remaining wait deadline", async () => {
  const reviewer = await launchReviewer();
  // Add a check to the stored session without creating another launch target.
  const session = db.getSession(reviewer.sessionId)!;
  db.createSession({ ...session, id: "checked-review", ownerToken: "token", resumedFrom: session.resumedFrom ?? undefined, checkCmd: "sleep 0.15" });
  db.updateStatus("checked-review", "idle");
  shim('case "$*" in *"rev-parse --show-toplevel"*) sleep 3 ;; esac');
  // Leave room for the real acceptance process to start on a busy machine.
  const start = performance.now();
  const result = await wait(db, ["checked-review"], false, 1000);
  expect(performance.now() - start).toBeLessThan(1700);
  expect(result).toMatchObject({ evidence: { check: { exitCode: 0 }, targetFingerprintIncomplete: expect.stringContaining("deadline") } });
  if (!Array.isArray(result)) expect(result.evidence?.targetChanged).toBeUndefined();
});

test("symlinked ancestor submodule terminates incomplete and reviewer still launches", async () => {
  await addModule();
  await git(project, "config", "submodule.vendor.ignore", "all");
  rmSync(join(project, "vendor"), { recursive: true, force: true });
  symlinkSync(project, join(project, "vendor"), "dir");
  const counter = join(root, "counter");
  // Bound the old implementation too so the failing regression can finish.
  shim(`case "$*" in *"rev-parse --show-toplevel"*) n=0; if [ -f ${quote(counter)} ]; then n=$(cat ${quote(counter)}); fi; n=$((n+1)); echo "$n" > ${quote(counter)}; if [ "$n" -gt 6 ]; then exit 88; fi ;; esac`);
  const reviewer = await launchReviewer();
  const baseline = db.getSession(reviewer.sessionId)!.targetFingerprint;
  expect(baseline?.incomplete).toContain("already visited");
  expect(Number(readFileSync(counter, "utf8"))).toBe(2);
  expect(Tmux.create).toHaveBeenCalled();
  expect(readFileSync(reviewer.fileHandoff.taskCopyPath, "utf8")).toContain("already visited");
  const result = await wait(db, [reviewer.sessionId], false, 2000);
  expect(result).toMatchObject({ evidence: { targetFingerprintIncomplete: expect.stringContaining("already visited") } });
  if (!Array.isArray(result)) expect(result.evidence?.targetChanged).toBeUndefined();
});

test("submodule node cap marks an incomplete target and evidence omits comparison", async () => {
  await addModule();
  const baseline = await computeTargetFingerprint(project, [], { maxRepositories: 1 });
  expect(baseline?.incomplete).toContain("node cap");
  const evidence = await collectEvidence({ id: "review", projectPath: project, role: "reviewer", targetFingerprint: baseline });
  expect(evidence.targetChanged).toBeUndefined();
  expect(evidence.targetFingerprintIncomplete).toContain("node cap");
});

test("expired launch fingerprint deadline is explicitly incomplete", async () => {
  const baseline = await computeTargetFingerprint(project, [], { deadline: Date.now() - 1 });
  expect(baseline?.incomplete).toContain("deadline");
  const evidence = await collectEvidence({ id: "review", projectPath: project, role: "reviewer", targetFingerprint: baseline });
  expect(evidence.targetChanged).toBeUndefined();
  expect(evidence.targetFingerprintIncomplete).toContain("deadline");
});
