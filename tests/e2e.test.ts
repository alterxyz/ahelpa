// End to end without a model: the compiled CLI, a real daemon and a real tmux
// server drive `tests/fixtures/fake-kimi.ts` in place of the Kimi Code TUI.
// Everything lives under one scratch root: a private tmux socket (a `tmux`
// wrapper on PATH adds `-S`, as tests/tmux-env.test.ts does), a private HOME,
// AHELPA_HOME and AHELPA_TMP_DIR. The real Claude/Codex/Kimi TUIs are covered
// only by `bun run closure:gate`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { shellEscape } from "../src/shell";

const REPO = join(import.meta.dir, "..");
const REAL_TMUX = Bun.which("tmux") ?? (() => { throw new Error("tmux is required for the end-to-end tests"); })();
// Only these host variables reach the CLI, the daemon and the helper's `bash -lc`. Anything
// else could be run or read there: BASH_ENV and exported bash functions start host code, GIT_*
// redirects git, and host identity, a nested TMUX or the caller's AHELPA_* roots break isolation.
const KEEP_ENV = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"];

let root: string;
let bin: string;
let socket: string;
let cli: string;
let home: string;
let env: Record<string, string>;
const ahelpaHome = () => join(root, "ahelpa");

const helperEnv = (host: Record<string, string | undefined>): Record<string, string> => ({
  ...Object.fromEntries(KEEP_ENV.filter(name => host[name] !== undefined).map(name => [name, host[name]!])),
  PATH: `${bin}:${host.PATH}`,
  HOME: home,
  AHELPA_HOME: ahelpaHome(),
  AHELPA_TMP_DIR: join(root, "run"),
});

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-e2e-"));
  bin = join(root, "bin");
  socket = join(root, "tmux.sock");
  home = join(root, "home");
  cli = join(bin, "ahelpa");
  for (const dir of [bin, home]) mkdirSync(dir);

  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nexec ${shellEscape(REAL_TMUX)} -f /dev/null -S ${shellEscape(socket)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "kimi"), `#!/bin/sh\nexec ${shellEscape(process.execPath)} ${shellEscape(join(import.meta.dir, "fixtures", "fake-kimi.ts"))} "$@"\n`, { mode: 0o755 });
  // tmux starts the helper with `bash -lc`; a login shell may rebuild PATH (macOS
  // path_helper, Debian /etc/profile), so put the fake `kimi` back in front.
  writeFileSync(join(home, ".bash_profile"), `export PATH=${shellEscape(bin)}:"$PATH"\n`);

  env = helperEnv(process.env);
  // The release binary, built from this checkout (about 0.2 s): the daemon then
  // re-invokes the binary itself, a path `bun src/cli.ts` never takes.
  const build = Bun.spawnSync([process.execPath, "build", join(REPO, "src", "cli.ts"), "--compile", `--outfile=${cli}`],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`compile failed: ${build.stderr.toString()}`);
}, 60_000);

afterAll(() => {
  // Concurrent launches may each have started a daemon; the binary path is unique to this run.
  for (const line of Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n")) {
    if (line.includes(`${cli} __daemon`)) try { process.kill(Number(line.trim().split(/\s+/)[0]), "SIGTERM"); } catch {}
  }
  Bun.spawnSync([REAL_TMUX, "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  rmSync(root, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<string> {
  const proc = Bun.spawn([cli, ...args], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`ahelpa ${args.join(" ")} exited ${code}\n${err}${out}`);
  return out;
}

// One project per scenario: helpers sharing a project would raise writerConflict warnings.
function newProject(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
}

interface Launched { sessionId: string; ownerToken: string; tmuxSession: string; projectPath: string }
const launch = async (project: string, task: string, ...extra: string[]) =>
  JSON.parse(await run("launch", "kimi", "--task", task, "--project", project, ...extra)) as Launched;

interface Waited { sessionId: string; status: string; reason?: string; evidence?: { summaryBytes: number; check?: { exitCode: number | null } } }
const wait = async (id: string) => JSON.parse(await run("wait", id, "--timeout", "40")) as Waited;

interface Row { id: string; status: string; agentResumeId: string | null; resumedFrom: string | null }
async function row(id: string): Promise<Row> {
  const found = (JSON.parse(await run("check")) as Row[]).find(entry => entry.id === id);
  if (!found) throw new Error(`check does not list ${id}`);
  return found;
}
// wait reports draining (graceful exit in progress) as idle; check shows the raw state.
const settled = (status: string) => status === "draining" ? "idle" : status;

const tmux = (...args: string[]) => Bun.spawnSync([REAL_TMUX, "-S", socket, ...args], { stdout: "pipe", stderr: "pipe" });
const hasSession = (id: string) => tmux("has-session", "-t", id).exitCode === 0;
const summary = (project: string, id: string) => readFileSync(join(project, ".ahelpa", id, "summary.md"), "utf8");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// pid -> command for a process and everything under it, as `closure:gate` snapshots a pane.
function processTree(rootPid: number): Map<number, string> {
  const children = new Map<number, Array<[number, string]>>();
  for (const line of Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,comm="]).stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) children.set(Number(match[2]), [...children.get(Number(match[2])) ?? [], [Number(match[1]), basename(match[3])]]);
  }
  const found = new Map<number, string>([[rootPid, "pane"]]);
  for (const pid of found.keys()) for (const [child, name] of children.get(pid) ?? []) found.set(child, name);
  return found;
}

test("host shell startup files never reach the helper's shell", () => {
  const marker = join(root, "host-startup-ran");
  const script = join(root, "host-startup.sh");
  writeFileSync(script, `touch ${shellEscape(marker)}\n`);
  const polluted = { ...process.env, BASH_ENV: script, ENV: script };
  // Control: with the host environment bash runs the script.
  Bun.spawnSync(["bash", "-c", "true"], { env: polluted });
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  // tmux starts every helper with `bash -lc`.
  Bun.spawnSync(["bash", "-lc", "true"], { env: helperEnv(polluted), cwd: root });
  expect(existsSync(marker)).toBe(false);
});

test.concurrent("launch, wait, check, kill, resume, a second task, kill", async () => {
  const project = newProject("chain");
  const marker = crypto.randomUUID();
  const first = await launch(project, `[fake:remember=${marker}] first round`, "--check", 'grep -rq "fake-agent summary" .ahelpa');
  const id = first.sessionId;
  expect(id).toMatch(/^kimi-[0-9a-f]{12}$/);
  expect(first.ownerToken).toMatch(/^[0-9a-f]{32}$/);
  expect([first.tmuxSession, first.projectPath]).toEqual([id, project]);
  // The helper is in the private tmux server and nowhere else.
  expect(hasSession(id)).toBe(true);
  expect(Bun.spawnSync([REAL_TMUX, "list-sessions", "-F", "#{session_name}"], { stdout: "pipe", stderr: "pipe" }).stdout.toString()).not.toContain(id);
  expect(alive(Number(readFileSync(join(ahelpaHome(), "daemon.pid"), "utf8")))).toBe(true);

  const done = await wait(id);
  expect(done.status).toBe("idle");
  expect(done.evidence?.summaryBytes).toBeGreaterThan(0);
  expect(done.evidence?.check?.exitCode).toBe(0);
  expect(summary(project, id)).toContain("task: first round");
  expect(await run("capture", id, "--token", first.ownerToken)).toContain("[AHELPA:DONE]");

  const after = await row(id);
  expect(settled(after.status)).toBe(done.status);
  expect(after.agentResumeId).toMatch(/^session_[0-9a-f-]{36}$/);

  expect(await run("kill", id, "--token", first.ownerToken)).toContain("killed");
  expect(hasSession(id)).toBe(false);
  expect((await row(id)).status).toBe("dead");

  const resumed = JSON.parse(await run("resume", id, "--token", first.ownerToken)) as { sessionId: string; ownerToken: string; resumedFrom: string };
  expect(resumed.resumedFrom).toBe(id);
  expect(resumed.sessionId).not.toBe(id);
  const reopened = await row(resumed.sessionId);
  expect([reopened.status, reopened.resumedFrom, reopened.agentResumeId]).toEqual(["needs_attention", id, after.agentResumeId]);

  const followUp = join(root, "follow-up.md");
  writeFileSync(followUp, "[fake:recall] second round\n");
  expect(await run("task", resumed.sessionId, "--file", followUp, "--token", resumed.ownerToken)).toContain("task sent");
  const second = await wait(resumed.sessionId);
  expect(second.status).toBe("idle");
  expect(summary(project, resumed.sessionId)).toContain(`recalled=${marker}`);

  await run("kill", resumed.sessionId, "--token", resumed.ownerToken);
  expect(hasSession(resumed.sessionId)).toBe(false);
}, 90_000);

test.concurrent("NEED_HELP stops the helper; send answers it and the helper finishes", async () => {
  const project = newProject("need-help");
  const helper = await launch(project, "[fake:need-help] choose a colour");
  const id = helper.sessionId;
  const blocked = await wait(id);
  expect(blocked.status).toBe("error");
  expect((await row(id)).status).toBe("error");
  const ledger = readFileSync(join(ahelpaHome(), "need-help.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(ledger.find(entry => entry.sessionId === id)).toMatchObject({ tags: ["input"], agentType: "kimi" });

  // The fake keeps working until the release file exists, so `running` below cannot race the daemon.
  const release = join(root, "need-help-release");
  expect(await run("send", id, `use blue [fake:release=${release}]`, "--token", helper.ownerToken)).toContain("sent");
  expect((await row(id)).status).toBe("running");
  writeFileSync(release, "");
  const finished = await wait(id);
  expect(finished.status).toBe("idle");
  expect(summary(project, id)).toContain("answer: use blue");

  await run("kill", id, "--token", helper.ownerToken);
  expect(hasSession(id)).toBe(false);
}, 90_000);

test.concurrent("kill mid-turn leaves no tmux session and no process of its tree", async () => {
  const helper = await launch(newProject("kill-tree"), "[fake:spawn][fake:hold] run a long tool");
  const id = helper.sessionId;
  expect((await row(id)).status).toBe("running");

  const panePid = Number(tmux("display-message", "-p", "-t", id, "#{pane_pid}").stdout.toString().trim());
  const tree = processTree(panePid);
  expect([...tree.values()]).toContain("sleep");
  expect(tree.size).toBeGreaterThanOrEqual(3);

  await run("kill", id, "--token", helper.ownerToken);
  expect(hasSession(id)).toBe(false);
  expect((await row(id)).status).toBe("dead");
  for (let attempt = 0; attempt < 30 && [...tree.keys()].some(alive); attempt++) await Bun.sleep(100);
  expect([...tree].filter(([pid]) => alive(pid))).toEqual([]);
}, 90_000);
