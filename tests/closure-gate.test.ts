import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const gateScript = resolve(import.meta.dir, "../scripts/closure-gate.sh");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runFixture(scenario: string, agent = "codex", integration = false, role = "") {
  const root = mkdtempSync(join(tmpdir(), "ahelpa-closure-test-"));
  fixtureRoots.push(root);
  const binDir = join(root, "bin");
  const evidenceDir = join(root, "evidence");
  mkdirSync(binDir);
  mkdirSync(evidenceDir);
  const cliPath = join(binDir, "fake-ahelpa");
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, "tests", "fixtures", "closure"), { recursive: true });
  writeFileSync(cliPath, `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
const root = process.env.CLOSURE_TEST_ROOT;
const scenario = process.env.CLOSURE_TEST_SCENARIO;
const [command, ...args] = process.argv.slice(2);
appendFileSync(join(root, "calls.jsonl"), JSON.stringify({
  command, args, home: process.env.AHELPA_HOME, runtime: process.env.AHELPA_TMP_DIR,
}) + "\\n");
const statePath = join(root, "state.json");
const sessions = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(sessions));
const sessionId = args[0];
const session = sessions[sessionId];
switch (command) {
  case "help": console.log("fixture help"); break;
  case "version": console.log("ahelpa fixture"); break;
  case "daemon": break;
  case "launch": {
    const roleIndex = args.indexOf("--role");
    const role = roleIndex === -1 ? (args[0] === "claude-code" ? "advisor" : args[0] === "codex" ? "worker" : null)
      : args[roleIndex + 1];
    const model = args[0] === "claude-code" ? (role === "advisor" ? "claude-opus-5-5" : "claude-sonnet-5-5")
      : args[0] === "codex" ? "gpt-6.1-sol" : null;
    const effort = args[0] === "claude-code" && role === "advisor" ? "xhigh" : args[0] === "kimi" ? null : "high";
    const id = args[0] + (role ? "-" + role : "") + "-fixture";
    const project = args[args.indexOf("--project") + 1];
    const task = args[args.indexOf("--task") + 1];
    const marker = task.match(/Remember this context marker for our next turn: ([a-f0-9-]+)\./)?.[1];
    const completionMarker = task.match(/Write exactly ([^ ]+) followed by a newline/)?.[1];
    sessions[id] = { id, project, task, marker, role, model, effort, status: scenario === "reaped" ? "idle" : "draining",
      agentResumeId: scenario === "missing-native-id" ? null : "session_fixture" };
    save();
    const delivery = join(project, ".ahelpa", id);
    mkdirSync(delivery, { recursive: true });
    if (scenario !== "marker-echo") {
      writeFileSync(join(delivery, "summary.md"), scenario === "wrong-summary" ? "wrong\\n" : completionMarker + "\\n");
    }
    const result = { sessionId: id, ownerToken: "fixture-token", role, model, effort };
    for (const field of ["role", "model", "effort"]) {
      if (scenario === "launch-" + field + "-drift") result[field] = "incorrect";
      if (scenario === "launch-" + field + "-missing") delete result[field];
    }
    console.log(JSON.stringify(result));
    break;
  }
  case "wait": {
    if (scenario === "wait-failure") process.exit(2);
    const status = scenario === "timeout" ? "still_running" : scenario === "account-error" ? "error"
      : scenario === "resumed-timeout" && sessionId.includes("resumed") ? "still_running" : "idle";
    console.log(JSON.stringify({ sessionId, status }));
    break;
  }
  case "logs": {
    if (scenario === "logs-unavailable") process.exit(1);
    console.log(session.task);
    console.log(scenario === "account-error" ? "Your account does not have access to Claude Code" : "partial gate-codex output");
    break;
  }
  case "check": {
    if (scenario === "malformed-check") { console.log("not JSON"); break; }
    console.log(JSON.stringify(Object.values(sessions).map((entry) => ({
      id: entry.id, agentResumeId: entry.agentResumeId,
      role: scenario === "check-role-drift" ? "incorrect" : entry.role,
      model: scenario === "check-model-drift" ? "incorrect" : entry.model,
      effort: scenario === "check-effort-drift" ? "incorrect" : entry.effort,
      status: scenario === "check-running" || (scenario === "stale-after-kill" && entry.status === "dead")
        ? "running" : entry.status,
    }))));
    break;
  }
  case "kill": {
    if (scenario === "kill-failure") process.exit(1);
    session.status = "dead";
    save();
    break;
  }
  case "resume": {
    const id = "kimi-resumed-fixture";
    sessions[id] = { ...session, id, status: scenario === "resume-not-ready" ? "running" : "needs_attention" };
    save();
    console.log(JSON.stringify({ sessionId: id, ownerToken: "fixture-token" }));
    break;
  }
  case "task": {
    if (scenario === "resumed-task-failure") process.exit(2);
    const taskFile = args[args.indexOf("--file") + 1];
    session.task = readFileSync(taskFile, "utf8");
    session.status = "draining";
    save();
    const delivery = join(session.project, ".ahelpa", sessionId);
    mkdirSync(delivery, { recursive: true });
    if (scenario !== "stale-first-turn") {
      writeFileSync(join(delivery, "summary.md"), "gate-kimi-resumed:" +
        (scenario === "resumed-extra-space" ? " " : "") +
        (scenario === "context-loss" ? "wrong" : session.marker) + "\\n");
    }
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
    'source "$1"; GATE_DIR="$2"; PROJECT_ROOT="$3"; if [ "$4" = yes ]; then run_integration_gate; else run_gate "$5" "$6"; fi',
    "closure-fixture", gateScript, evidenceDir, projectRoot, integration ? "yes" : "no", agent, role,
  ], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      CLOSURE_TEST_ROOT: root,
      CLOSURE_TEST_SCENARIO: scenario,
      AHELPA_GATE_CLI: cliPath,
      AHELPA_HOME: "/unused-inherited-ahelpa-state",
      AHELPA_TMP_DIR: "/unused-inherited-ahelpa-runtime",
      TMPDIR: root,
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
    .trim().split("\n").map((line): { command: string; args: string[]; home: string; runtime: string } => JSON.parse(line));
  return { exitCode, stdout, stderr, calls, evidenceDir: integration ? join(calls[0].home, "..") : evidenceDir };
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
      .toEqual(["codex-worker-fixture", "--token", "fixture-token"]);
  });

  test("exercises Claude worker explicitly with independent evidence", async () => {
    const result = await runFixture("success", "claude-code", false, "worker");
    expect(result.exitCode).toBe(0);
    const launch = result.calls.find((call) => call.command === "launch")!;
    expect(launch.args.slice(-2)).toEqual(["--role", "worker"]);
    expect(result.stdout).toContain("pass > claude-code-worker");
    expect(readFileSync(join(result.evidenceDir, "result-claude-code-worker", "summary.md"), "utf8"))
      .toBe("gate-claude-code-worker\n");
  });

  test.each([
    "launch-role-drift", "launch-model-drift", "launch-effort-drift",
    "launch-role-missing", "launch-model-missing", "launch-effort-missing",
    "check-role-drift", "check-model-drift", "check-effort-drift",
  ])("rejects %s and still reclaims the helper", async (scenario) => {
    const result = await runFixture(scenario);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("expected role/model/effort");
    expect(result.stdout).not.toContain("pass >");
    expect(result.calls.at(-1)?.command).toBe("kill");
    expect(result.calls.at(-1)?.args[0]).toBe("codex-worker-fixture");
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

  test("verifies Kimi resume readiness, a new task, and exact retained context", async () => {
    const result = await runFixture("success", "kimi");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pass > kimi resume readiness, new turn, and context continuity");
    expect(result.calls.map((call) => call.command)).toEqual([
      "launch", "wait", "logs", "check", "kill", "check",
      "resume", "check", "task", "wait", "logs", "check", "kill", "check",
    ]);
    expect(result.calls.find((call) => call.command === "task")?.args[0]).toBe("kimi-resumed-fixture");
    expect(result.stdout + result.stderr).not.toContain("fixture-token");
  });

  test.each([
    ["missing-native-id", "Kimi did not retain a native session resume ID"],
    ["resume-not-ready", "Kimi resume did not reach needs_attention"],
    ["resumed-timeout", "wait did not observe successful completion"],
    ["context-loss", "missing or incorrect summary"],
    ["resumed-extra-space", "missing or incorrect summary"],
    ["stale-first-turn", "missing or incorrect summary"],
  ])("rejects Kimi %s and cleans the current helper", async (scenario, message) => {
    const result = await runFixture(scenario, "kimi");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.calls.at(-1)?.command).toBe("kill");
    expect(result.stdout).not.toContain("pass > kimi");
  });

  test("cleans the resumed helper if submitting its task fails", async () => {
    const result = await runFixture("resumed-task-failure", "kimi");
    expect(result.exitCode).not.toBe(0);
    expect(result.calls.at(-1)?.command).toBe("kill");
    expect(result.calls.at(-1)?.args[0]).toBe("kimi-resumed-fixture");
  });

  test("checks three role profiles and Kimi with private runtime roots and distinct evidence", async () => {
    const result = await runFixture("success", "codex", true);
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter((call) => call.command === "launch").map((call) => call.args[0]))
      .toEqual(["claude-code", "claude-code", "codex", "kimi"]);
    const launches = result.calls.filter((call) => call.command === "launch");
    expect(launches[0].args).not.toContain("--role");
    expect(launches[1].args.slice(-2)).toEqual(["--role", "worker"]);
    expect(launches[2].args).not.toContain("--role");
    for (const [label, role, model, effort] of [
      ["claude-code-advisor", "advisor", "claude-opus-5-5", "xhigh"],
      ["claude-code-worker", "worker", "claude-sonnet-5-5", "high"],
      ["codex-worker", "worker", "gpt-6.1-sol", "high"],
    ]) {
      expect(readFileSync(join(result.evidenceDir, `result-${label}`, "summary.md"), "utf8"))
        .toBe(`gate-${label}\n`);
      const sessions = JSON.parse(readFileSync(join(result.evidenceDir, `check-${label}.json`), "utf8"));
      expect(sessions.find((session: { id: string }) => session.id === `${label}-fixture`))
        .toMatchObject({ role, model, effort });
    }
    const homes = new Set(result.calls.map((call) => call.home));
    expect(homes.size).toBe(1);
    expect([...homes][0]).toContain("ahelpa-closure-gate.");
    expect([...homes][0]).not.toBe("/unused-inherited-ahelpa-state");
    for (const call of result.calls) {
      expect(call.runtime).toBe(join(call.home, "..", "runtime"));
    }
    expect(result.calls.at(-1)?.command).toBe("daemon");
    expect(result.calls.at(-1)?.args).toEqual(["stop"]);
    expect(result.stdout + result.stderr).not.toContain("fixture-token");
  });

  test("stops only the isolated daemon after an integration failure", async () => {
    const result = await runFixture("account-error", "codex", true);
    expect(result.exitCode).not.toBe(0);
    expect(result.calls.at(-2)?.command).toBe("kill");
    expect(result.calls.at(-1)?.command).toBe("daemon");
    expect(result.calls.at(-1)?.home).toContain("ahelpa-closure-gate.");
    expect(result.calls.at(-1)?.home).not.toBe("/unused-inherited-ahelpa-state");
  });
});
