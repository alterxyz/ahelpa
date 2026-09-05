import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const gateScript = resolve(import.meta.dir, "../scripts/closure-gate.sh");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runFixture(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "ahelpa-closure-test-"));
  fixtureRoots.push(root);
  const binDir = join(root, "bin");
  const evidenceDir = join(root, "evidence");
  mkdirSync(binDir);
  mkdirSync(evidenceDir);
  const cliPath = join(binDir, "fake-ahelpa");
  writeFileSync(cliPath, `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
const root = process.env.CLOSURE_TEST_ROOT;
const scenario = process.env.CLOSURE_TEST_SCENARIO;
const [command, ...args] = process.argv.slice(2);
appendFileSync(join(root, "calls.jsonl"), JSON.stringify({ command, args }) + "\\n");
const sessionId = "codex-fixture";
const infoPath = join(root, "launch.json");
const killedPath = join(root, "killed");
switch (command) {
  case "launch": {
    const project = args[args.indexOf("--project") + 1];
    const task = args[args.indexOf("--task") + 1];
    writeFileSync(infoPath, JSON.stringify({ project, task }));
    const delivery = join(project, ".ahelpa", sessionId);
    mkdirSync(delivery, { recursive: true });
    if (scenario !== "marker-echo") {
      writeFileSync(join(delivery, "summary.md"), scenario === "wrong-summary" ? "wrong\\n" : "gate-codex\\n");
    }
    console.log(JSON.stringify({ sessionId, ownerToken: "fixture-token" }));
    break;
  }
  case "wait": {
    if (scenario === "wait-failure") process.exit(2);
    const status = scenario === "timeout" ? "still_running" : scenario === "account-error" ? "error" : "idle";
    console.log(JSON.stringify({ sessionId, status }));
    break;
  }
  case "logs": {
    if (scenario === "logs-unavailable") process.exit(1);
    const { task } = JSON.parse(readFileSync(infoPath, "utf8"));
    console.log(task);
    console.log(scenario === "account-error" ? "Your account does not have access to Claude Code" : "partial gate-codex output");
    break;
  }
  case "check": {
    if (scenario === "malformed-check") { console.log("not JSON"); break; }
    const killed = existsSync(killedPath);
    const status = scenario === "check-running" || (scenario === "stale-after-kill" && killed)
      ? "running" : killed ? "dead" : scenario === "reaped" ? "idle" : "draining";
    console.log(JSON.stringify([{ id: sessionId, status }]));
    break;
  }
  case "kill": {
    if (scenario === "kill-failure") process.exit(1);
    writeFileSync(killedPath, "killed");
    break;
  }
  default: process.exit(3);
}
`, { mode: 0o755 });
  writeFileSync(join(binDir, "tmux"), `#!/usr/bin/env bash
if [ "$CLOSURE_TEST_SCENARIO" = "tmux-alive" ]; then exit 0; fi
exit 1
`, { mode: 0o755 });

  const proc = Bun.spawn([
    "bash", "-c",
    'source "$1"; CLI="$2"; GATE_DIR="$3"; run_gate codex',
    "closure-fixture", gateScript, cliPath, evidenceDir,
  ], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      CLOSURE_TEST_ROOT: root,
      CLOSURE_TEST_SCENARIO: scenario,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const calls = readFileSync(join(root, "calls.jsonl"), "utf8")
    .trim().split("\n").map((line): { command: string; args: string[] } => JSON.parse(line));
  return { exitCode, stdout, stderr, calls };
}

describe("closure gate", () => {
  test("requires file delivery and checks completion and reclamation", async () => {
    const result = await runFixture("success");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pass > codex");
    expect(result.stdout).not.toContain("fixture-token");
    expect(result.calls.map((call) => call.command)).toEqual([
      "launch", "wait", "logs", "check", "kill", "check",
    ]);
    expect(result.calls[0].args.join(" ")).toContain("summary.md");
    expect(result.calls.find((call) => call.command === "kill")?.args)
      .toEqual(["codex-fixture", "--token", "fixture-token"]);
  });

  test.each(["reaped", "logs-unavailable"])("accepts completed file delivery when %s", async (scenario) => {
    expect((await runFixture(scenario)).exitCode).toBe(0);
  });

  test.each([
    ["timeout", "wait did not observe successful completion"],
    ["account-error", "wait did not observe successful completion"],
    ["marker-echo", "missing or incorrect summary"],
    ["wrong-summary", "missing or incorrect summary"],
    ["wait-failure", "wait failed"],
    ["check-running", "check did not observe completed"],
    ["malformed-check", "check did not observe completed"],
  ])("rejects %s and still cleans its helper", async (scenario, message) => {
    const result = await runFixture(scenario);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain("pass >");
    expect(result.calls.at(-1)?.command).toBe("kill");
  });

  test.each([
    ["kill-failure", "kill failed"],
    ["tmux-alive", "kill left tmux session"],
    ["stale-after-kill", "check still reports an active"],
  ])("rejects failed reclamation: %s", async (scenario, message) => {
    const result = await runFixture(scenario);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain("pass >");
  });
});
