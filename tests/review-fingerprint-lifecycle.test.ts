import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { computeTargetFingerprint } from "../src/evidence";

let root: string;
const originalPath = process.env.PATH;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

beforeEach(() => {
  mkdirSync(join(import.meta.dir, "../.ahelpa"), { recursive: true });
  root = mkdtempSync(join(import.meta.dir, "../.ahelpa/fingerprint-lifecycle-"));
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});

function shim(body: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const path = join(bin, "git");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return `${bin}:${originalPath}`;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function kill(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  // On the regressed implementation the shim/escaped child owns a group.
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

test("fingerprint git dies with the caller's SIGTERM process group", async () => {
  const pidFile = join(root, "git.pid");
  const path = shim(`echo $$ > ${quote(pidFile)}\nexec sleep 30`);
  const runner = join(root, "caller.ts");
  writeFileSync(runner, `import { computeTargetFingerprint } from ${JSON.stringify(join(import.meta.dir, "../src/evidence.ts"))};\nawait computeTargetFingerprint(${JSON.stringify(root)});\n`);
  // Only the test caller is detached, so signalling it cannot kill bun test.
  const caller = Bun.spawn([process.execPath, runner], {
    detached: true, stdout: "ignore", stderr: "pipe", stdin: "ignore",
    env: { ...process.env, PATH: path },
  });
  let gitPid: number | undefined;
  try {
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    gitPid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(gitPid)).toBe(true);
    process.kill(-caller.pid, "SIGTERM");
    await caller.exited;
    await until(() => !alive(gitPid!), 1000);
  } finally {
    kill(caller.pid);
    if (gitPid !== undefined) kill(gitPid);
    else if (existsSync(pidFile)) kill(Number(readFileSync(pidFile, "utf8")));
    await caller.exited;
  }
}, 10000);

test("escaped descendant holding stdout cannot prolong fingerprint deadline", async () => {
  const pidFile = join(root, "escaped.pid");
  const childCode = `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(5000);`;
  const spawner = join(root, "spawn-escaped.ts");
  writeFileSync(spawner, `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(childCode)}], { detached: true, stdout: "inherit", stderr: "ignore", stdin: "ignore" }); child.unref();\n`);
  process.env.PATH = shim(`exec ${quote(process.execPath)} ${quote(spawner)}`);
  let fingerprint: Awaited<ReturnType<typeof computeTargetFingerprint>>;
  try {
    const start = Date.now();
    fingerprint = await computeTargetFingerprint(root, [], { deadline: start + 800 });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(existsSync(pidFile)).toBe(true);
    // The writer is still alive, proving EOF did not release the read.
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(true);
    expect(fingerprint?.incomplete).toContain("deadline");
  } finally {
    if (existsSync(pidFile)) kill(Number(readFileSync(pidFile, "utf8")));
  }
}, 10000);
