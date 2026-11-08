import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const gateScript = resolve(import.meta.dir, "../scripts/closure-gate.sh");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runFixture(scenario: string, agent = "codex", integration = false, role = "", gateKimi = "", gatePi = "", piModel = "", piEffort = "", gateAgy = "", gateVibe = "", gateDeepseek = "") {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-closure-test-"));
  fixtureRoots.push(root);
  const binDir = join(root, "bin");
  const evidenceDir = join(root, "evidence");
  mkdirSync(binDir);
  mkdirSync(evidenceDir);
  const cliPath = join(binDir, "fake-ahelpa");
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, "tests", "fixtures", "closure"), { recursive: true });
  writeFileSync(cliPath, `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
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
    const role = roleIndex === -1 ? (args[0] === "claude" ? "advisor" : ["codex", "deepseek-pi", "gemini", "mistral", "deepseek"].includes(args[0]) ? "worker" : null)
      : args[roleIndex + 1];
    const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : args[0] === "claude" ? (role === "advisor" ? "claude-opus-5-5" : "claude-sonnet-5-5")
      : args[0] === "codex" ? "gpt-6-astra" : args[0] === "gemini" ? "gemini-4-argon" : args[0] === "mistral" ? "mistral-large-4-0-3" : args[0] === "deepseek" ? "deepseek-v4-1-flash-1017" : args[0] === "deepseek-pi" ? "cc-switch-deep-seek/deepseek-flash" : null;
    const effort = args.includes("--effort") ? args[args.indexOf("--effort") + 1] : args[0] === "claude" && role === "advisor" ? "xhigh" : args[0] === "kimi" ? null : ["codex", "gemini"].includes(args[0]) ? "medium" : "high";
    const id = args[0] + (role ? "-" + role : "") + "-fixture";
    const project = args[args.indexOf("--project") + 1];
    const task = args[args.indexOf("--task") + 1];
    const marker = task.match(/Remember this context marker for our next turn: ([a-f0-9-]+)\./)?.[1];
    const completionMarker = task.match(/Write exactly ([^ ]+) followed by a newline/)?.[1];
    sessions[id] = { id, agent: args[0], harness: ["mistral", "deepseek"].includes(args[0]) ? "vibe" : args[0] === "deepseek-pi" ? "pi" : args[0] === "claude" ? "claude-code" : args[0] === "gemini" ? "agy" : args[0], project, task, marker, role, model, effort, status: scenario === "reaped" ? "idle" : "draining",
      agentResumeId: scenario === "missing-native-id" ? null : ["deepseek-pi", "gemini", "mistral", "deepseek"].includes(args[0]) ? "01234567-89ab-4cde-8012-3456789abcde" : "session_fixture" };
    save();
    if (args[0] === "deepseek-pi") {
      const encoded = "--" + resolve(project).replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
      const directory = join(process.env.PI_CODING_AGENT_DIR, "sessions", encoded);
      mkdirSync(directory, { recursive: true });
      let lockPath = join(directory, ".ahelpa-" + sessions[id].agentResumeId + ".lock");
      const header = JSON.stringify({ type: "session", id: scenario === "pi-history-wrong-id" ? "wrong" : sessions[id].agentResumeId }) + "\\n";
      writeFileSync(join(directory, "time_" + sessions[id].agentResumeId + ".jsonl"), scenario === "pi-history-malformed" ? "not JSON\\n" : header);
      if (scenario === "pi-history-ambiguous") writeFileSync(join(directory, "other_" + sessions[id].agentResumeId + ".jsonl"), header);
      if (scenario === "pi-lock-remains" || scenario === "pi-lock-wrong-directory") writeFileSync(lockPath, "");
      if (scenario === "pi-lock-wrong-directory") {
        writeFileSync(join(root, "real-lock-path"), lockPath);
        lockPath = join(root, "wrong-directory", ".ahelpa-" + sessions[id].agentResumeId + ".lock");
        // A matching transcript must not make a foreign directory acceptable.
        mkdirSync(join(root, "wrong-directory"), { recursive: true });
        writeFileSync(join(root, "wrong-directory", "time_" + sessions[id].agentResumeId + ".jsonl"), header);
      }
      mkdirSync(join(project, ".ahelpa", id), { recursive: true });
      writeFileSync(join(project, ".ahelpa", id, "pi-process.json"), JSON.stringify({ lockPath, bridgePid: 91001, childPid: 91002 }));
    }
    if (["mistral", "deepseek"].includes(args[0])) {
      mkdirSync(join(project, ".ahelpa", id), { recursive: true });
      writeFileSync(join(project, ".ahelpa", id, sessions[id].harness + "-process.json"), JSON.stringify({ bridgePid: 93001, childPid: 93002 }));
    }
    // A linked worktree keeps its results in the main checkout and a link in the project.
    const delivery = scenario === "linked-results" ? join(root, "main", ".ahelpa", id) : join(project, ".ahelpa", id);
    mkdirSync(delivery, { recursive: true });
    if (scenario === "linked-results") {
      mkdirSync(join(project, ".ahelpa"), { recursive: true });
      symlinkSync(delivery, join(project, ".ahelpa", id));
    }
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
    if (session.midturn) console.log("[AHELPA_VIBE_STATE:running]");
    console.log(scenario === "account-error" ? "Your account does not have access to Claude Code" : "partial gate-codex output");
    break;
  }
  case "check": {
    if (scenario === "malformed-check") { console.log("not JSON"); break; }
    // agy reports its conversation ID only on exit, a few checks after completion.
    const checks = existsSync(join(root, "checks")) ? Number(readFileSync(join(root, "checks"), "utf8")) + 1 : 1;
    writeFileSync(join(root, "checks"), String(checks));
    console.log(JSON.stringify(Object.values(sessions).map((entry) => ({
      id: entry.id, agentType: entry.harness, agentResumeId: scenario === "late-native-id" && checks < 4 ? null : entry.agentResumeId,
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
    const id = session.agent + (sessionId === session.agent + "-resumed-fixture" ? "-midturn-fixture" : "-resumed-fixture");
    sessions[id] = { ...session, id, status: scenario === "resume-not-ready" ? "running" : "needs_attention",
      agentResumeId: scenario === "pi-resume-id-drift" ? "ffffffff-ffff-4fff-8fff-ffffffffffff" : session.agentResumeId };
    save();
    if (session.harness === "pi") {
      const directory = join(session.project, ".ahelpa", id);
      mkdirSync(directory, { recursive: true });
      const encoded = "--" + resolve(session.project).replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
      const lockPath = join(...(scenario === "pi-lock-wrong-directory" ? [root, "wrong-directory"] : [process.env.PI_CODING_AGENT_DIR, "sessions", encoded]), ".ahelpa-" + sessions[id].agentResumeId + ".lock");
      writeFileSync(join(directory, "pi-process.json"), JSON.stringify({ lockPath, bridgePid: 91001, childPid: 91002 }));
    }
    if (session.harness === "vibe") {
      mkdirSync(join(session.project, ".ahelpa", id), { recursive: true });
      writeFileSync(join(session.project, ".ahelpa", id, session.harness + "-process.json"), JSON.stringify({ bridgePid: 93001, childPid: 93002 }));
    }
    console.log(JSON.stringify({ sessionId: id, ownerToken: "fixture-token" }));
    break;
  }
  case "task": {
    if (scenario === "resumed-task-failure") process.exit(2);
    const taskFile = args[args.indexOf("--file") + 1];
    session.task = readFileSync(taskFile, "utf8");
    session.midturn = ["vibe", "agy"].includes(session.harness) && session.task.includes("sleep 120");
    if (session.harness === "vibe") {
      session.childPid = session.midturn ? 93005 : 93004;
      writeFileSync(join(session.project, ".ahelpa", sessionId, "vibe-process.json"), JSON.stringify({ bridgePid: 93001, childPid: session.childPid }));
    }
    session.status = session.midturn ? "running" : "draining";
    save();
    const delivery = join(session.project, ".ahelpa", sessionId);
    mkdirSync(delivery, { recursive: true });
    if (!session.midturn && scenario !== "stale-first-turn") {
      writeFileSync(join(delivery, "summary.md"), "gate-" + session.agent + "-resumed:" +
        (scenario === "resumed-extra-space" ? " " : "") +
        (scenario === "context-loss" ? "wrong" : session.marker) + "\\n");
    }
    break;
  }
  default: process.exit(3);
}
`, { mode: 0o755 });
  writeFileSync(join(binDir, "ps"), `#!/usr/bin/env bun
import { readFileSync } from "fs";
const scenario = process.env.CLOSURE_TEST_SCENARIO;
const sessions = Object.values(JSON.parse(readFileSync(process.env.CLOSURE_TEST_ROOT + "/state.json", "utf8")));
if (process.argv.includes("command=")) {
  if (scenario === "pi-self-match") console.log("bun -e --mode rpc 01234567-89ab-4cde-8012-3456789abcde");
  // Pi hides its RPC argv behind its native process title.
  if (scenario === "pi-child-alive") console.log("pi");
} else if (sessions.some(session => session.harness === "agy" && session.status !== "dead")) {
  // agy's TUI runs in the pane: the pane shell, agy, and mid-turn its tool.
  const live = sessions.find(session => session.harness === "agy" && session.status !== "dead");
  console.log(scenario === "agy-tui-gone" ? "93001 1 bash" : "93001 1 bash\\n93002 93001 agy");
  if (live.midturn) console.log("93006 93002 sleep");
} else if (sessions.some(session => session.harness === "vibe" && session.status !== "dead")) {
  const live = sessions.find(session => session.harness === "vibe" && session.status !== "dead");
  if (scenario === "vibe-bridge-gone") process.exit(0);
  console.log(scenario === "vibe-child-gone" && !live.midturn ? "93001 1" : "93001 1\\n" + (live.childPid ?? 93002) + " 93001");
  if (live.midturn) console.log("93006 93005 sleep");
} else if (["vibe-tool-alive", "agy-tool-alive"].includes(scenario) && sessions.some(session => session.midturn)) {
  console.log("93006 1 sleep");
} else if (["agy-child-alive", "vibe-child-alive"].includes(scenario)) {
  console.log("93002 1");
} else if (sessions.some(session => session.harness === "pi" && session.status !== "dead")) {
  console.log("91001 1\\n91002 91001\\n91003 91002");
} else if (scenario === "pi-child-alive") {
  console.log("91002 1");
} else if (scenario === "pi-grandchild-alive") {
  console.log("91003 1");
}
`, { mode: 0o755 });
  writeFileSync(join(binDir, "tmux"), `#!/usr/bin/env bash
if [ "$1" = "list-panes" ]; then case "$3" in gemini-*|mistral-*|deepseek-worker-*|deepseek-resumed-*|deepseek-midturn-*) echo 93001 ;; *) echo 91001 ;; esac; exit 0; fi
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
      AHELPA_GATE_KIMI: gateKimi,
      AHELPA_GATE_PI: gatePi,
      AHELPA_GATE_PI_MODEL: piModel,
      AHELPA_GATE_PI_EFFORT: piEffort,
      AHELPA_GATE_AGY: gateAgy,
      AHELPA_GATE_VIBE: gateVibe,
      AHELPA_GATE_DEEPSEEK: gateDeepseek,
      PI_CODING_AGENT_DIR: join(root, "pi-agent"),
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
  return { exitCode, stdout, stderr, calls, root, evidenceDir: integration ? join(calls[0].home, "..") : evidenceDir };
}

describe("closure gate", () => {
  test.each(["pi-lock-wrong-directory", "pi-history-ambiguous", "pi-history-wrong-id", "pi-history-malformed"])("Pi snapshot rejects %s", async scenario => {
    const result = await runFixture(scenario, "deepseek-pi");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Cannot snapshot Pi process tree and lock before kill");
    if (scenario === "pi-lock-wrong-directory") {
      expect(existsSync(readFileSync(join(result.root, "real-lock-path"), "utf8"))).toBe(true);
    }
  }, 20000);
  test("Pi reclamation ignores the checker command line matching its UUID", async () => {
    expect((await runFixture("pi-self-match", "deepseek-pi")).exitCode).toBe(0);
  }, 20000);
  test.each(["pi-child-alive", "pi-grandchild-alive"])("Pi reclamation detects %s by recorded PID despite hidden argv", async scenario => {
    const result = await runFixture(scenario, "deepseek-pi");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Pi child or session lock remains after kill");
    expect(readFileSync(join(result.evidenceDir, "pids-deepseek-pi-worker.txt"), "utf8")).toBe("91001\n91002\n91003\n");
  }, 20000);

  test("Pi gate accepts standard defaults and verifies resume continuity", async () => {
    const result = await runFixture("success", "deepseek-pi");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pass > deepseek-pi resume readiness, new turn, and context continuity");
    expect(result.calls.filter(call => call.command === "kill")).toHaveLength(2);
    expect(result.calls.find(call => call.command === "launch")?.args).not.toContain("--model");
    expect(result.calls.find(call => call.command === "launch")?.args).not.toContain("--effort");
  });
  test.each(["launch-role-drift", "launch-model-drift", "launch-effort-drift", "launch-model-missing", "launch-effort-missing", "check-model-drift", "check-effort-drift"])("Pi gate rejects %s", async (scenario) => {
    const result = await runFixture(scenario, "deepseek-pi");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("expected role/model/effort");
  });
  test("Pi gate accepts explicit overrides of the standard model and effort", async () => {
    const result = await runFixture("success", "deepseek-pi", false, "", "", "", "test/model", "low");
    expect(result.exitCode).toBe(0);
    expect(result.calls.find(call => call.command === "launch")?.args.slice(-4))
      .toEqual(["--model", "test/model", "--effort", "low"]);
  });
  test("Pi live gate is opt-in", async () => {
    const result = await runFixture("success", "codex", true, "", "", "1");
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter(call => call.command === "launch").map(call => call.args[0]))
      .toEqual(["claude", "claude", "codex", "deepseek-pi"]);
  });
  test.each([
    ["missing-native-id", "Pi did not retain a native session UUID"],
    ["context-loss", "missing or incorrect summary"],
    ["pi-child-alive", "Pi child or session lock remains after kill"],
    ["pi-lock-remains", "Pi child or session lock remains after kill"],
    ["pi-resume-id-drift", "Pi resume changed the native session UUID"],
  ])("Pi gate rejects %s", async (scenario, message) => {
    const result = await runFixture(scenario, "deepseek-pi");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
  }, 20000);

  test.each(["success", "late-native-id"])("gemini gate checks the Argon default, native resume, context continuity and mid-turn reclamation (%s)", async scenario => {
    const result = await runFixture(scenario, "gemini");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pass > gemini resume readiness, new turn, and context continuity");
    expect(result.stdout).toContain("pass > gemini mid-turn kill reclaims agy and its tool");
    expect(result.calls.filter(call => ["launch", "wait", "resume", "task", "kill"].includes(call.command)).map(call => call.command))
      .toEqual(["launch", "wait", "kill", "resume", "task", "wait", "kill", "resume", "task", "kill"]);
    expect(result.calls.find(call => call.command === "launch")?.args).not.toContain("--model");
    expect(readFileSync(join(result.evidenceDir, "pids-gemini-worker.txt"), "utf8")).toBe("93001\n93002\n");
    expect(readFileSync(join(result.evidenceDir, "pids-gemini-resumed.txt"), "utf8")).toBe("93001\n93002\n");
    expect(readFileSync(join(result.evidenceDir, "pids-gemini-midturn.txt"), "utf8")).toBe("93001\n93002\n93006\n");
  }, 20000);
  test.each([
    ["agy-child-alive", "gemini agy process tree remains after kill"],
    ["agy-tool-alive", "gemini agy process tree remains after kill"],
    ["agy-tui-gone", "Cannot snapshot gemini agy process tree of a live helper"],
    ["missing-native-id", "gemini did not retain a native session UUID"],
    ["pi-resume-id-drift", "gemini resume changed the native session UUID"],
    ["check-effort-drift", "expected role/model/effort"],
    ["context-loss", "missing or incorrect summary"],
  ])("gemini gate rejects %s", async (scenario, message) => {
    const result = await runFixture(scenario, "gemini");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
  }, 40000);
  test("gemini live gate is opt-in", async () => {
    const skipped = await runFixture("success", "codex", true);
    expect(skipped.stdout).toContain("skip > gemini (set AHELPA_GATE_AGY=1 to include)");
    const result = await runFixture("success", "codex", true, "", "", "", "", "", "1");
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter(call => call.command === "launch").map(call => call.args[0]))
      .toEqual(["claude", "claude", "codex", "gemini"]);
  }, 30000);

  test.each(["mistral", "deepseek"])("%s gate completes normally, recalls context on resume, then resumes again for mid-turn kill", async agent => {
    const result = await runFixture("success", agent);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`pass > ${agent} resume readiness, new turn, and context continuity`);
    expect(result.calls.filter(call => ["launch", "wait", "resume", "task", "send", "kill"].includes(call.command)).map(call => call.command))
      .toEqual(["launch", "wait", "kill", "resume", "task", "wait", "kill", "resume", "task", "kill"]);
    expect(result.calls.find(call => call.command === "launch")?.args.join(" ")).not.toContain("NEED_HELP");
    expect(readFileSync(join(result.evidenceDir, `${agent}-resume-task.md`), "utf8")).not.toContain("NEED_HELP");
    expect(readFileSync(join(result.evidenceDir, `${agent}-midturn-task.md`), "utf8")).toContain("sleep 120");
    expect(JSON.parse(readFileSync(join(result.evidenceDir, `wait-${agent}-worker.json`), "utf8")).status).toBe("idle");
    expect(JSON.parse(readFileSync(join(result.evidenceDir, `wait-${agent}-resumed.json`), "utf8")).status).toBe("idle");
    expect(result.calls.find(call => call.command === "launch")?.args).not.toContain("--model");
    expect(readFileSync(join(result.evidenceDir, `result-${agent}-worker`, "summary.md"), "utf8")).toBe(`gate-${agent}-worker\n`);
    expect(readFileSync(join(result.evidenceDir, `result-${agent}-resumed`, "summary.md"), "utf8")).toMatch(new RegExp(`^gate-${agent}-resumed:[a-f0-9-]+\\n$`));
    expect(readFileSync(join(result.evidenceDir, `pids-${agent}-resumed.txt`), "utf8")).toBe("93001\n93002\n93004\n");
    expect(readFileSync(join(result.evidenceDir, `pids-${agent}-midturn.txt`), "utf8")).toBe("93001\n93002\n93004\n93005\n93006\n");
  }, 20000);
  test.each([
    ["vibe-child-alive", "mistral bridge or child remains after kill"],
    ["vibe-bridge-gone", "Cannot snapshot mistral bridge and child of a live helper"],
    ["vibe-tool-alive", "mistral bridge or child remains after kill"],
    ["missing-native-id", "mistral did not retain a native session UUID"],
    ["pi-resume-id-drift", "mistral resume changed the native session UUID"],
    ["context-loss", "missing or incorrect summary"],
  ])("Vibe gate rejects %s", async (scenario, message) => {
    const result = await runFixture(scenario, "mistral");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
  }, 20000);
  test("Vibe snapshots tolerate an already-exited child on ordinary turns", async () => {
    const result = await runFixture("vibe-child-gone", "mistral");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(result.evidenceDir, "pids-mistral-midturn.txt"), "utf8")).toBe("93001\n93005\n93006\n");
  }, 20000);
  test("Vibe live gate is opt-in", async () => {
    const skipped = await runFixture("success", "codex", true);
    expect(skipped.stdout).toContain("skip > mistral (set AHELPA_GATE_VIBE=1 to include)");
    const result = await runFixture("success", "codex", true, "", "", "", "", "", "", "1");
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter(call => call.command === "launch").map(call => call.args[0]))
      .toEqual(["claude", "claude", "codex", "mistral"]);
  }, 30000);

  test("DeepSeek live gate is opt-in and uses the Vibe scenario", async () => {
    const skipped = await runFixture("success", "codex", true);
    expect(skipped.stdout).toContain("skip > deepseek (set AHELPA_GATE_DEEPSEEK=1 to include)");
    const result = await runFixture("success", "codex", true, "", "", "", "", "", "", "", "1");
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter(call => call.command === "launch").map(call => call.args[0]))
      .toEqual(["claude", "claude", "codex", "deepseek"]);
    expect(result.calls.filter(call => call.command === "resume")).toHaveLength(2);
  }, 30000);

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

  test("a linked worktree's results are kept as evidence and removed from the main checkout, not only the link", async () => {
    const result = await runFixture("linked-results");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(result.evidenceDir, "result-codex-worker", "summary.md"), "utf8")).toBe("gate-codex-worker\n");
    const launch = result.calls.find((call) => call.command === "launch")!;
    const project = launch.args[launch.args.indexOf("--project") + 1];
    expect(existsSync(join(result.root, "main", ".ahelpa", "codex-worker-fixture"))).toBe(false);
    expect(lstatSync(join(project, ".ahelpa", "codex-worker-fixture"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("exercises Claude worker explicitly with independent evidence", async () => {
    const result = await runFixture("success", "claude", false, "worker");
    expect(result.exitCode).toBe(0);
    const launch = result.calls.find((call) => call.command === "launch")!;
    expect(launch.args.slice(-2)).toEqual(["--role", "worker"]);
    expect(result.stdout).toContain("pass > claude-worker");
    expect(readFileSync(join(result.evidenceDir, "result-claude-worker", "summary.md"), "utf8"))
      .toBe("gate-claude-worker\n");
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

  test("skips the live Kimi run unless AHELPA_GATE_KIMI=1", async () => {
    const result = await runFixture("success", "codex", true);
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter((call) => call.command === "launch").map((call) => call.args[0]))
      .toEqual(["claude", "claude", "codex"]);
    expect(result.stdout).toContain("skip > kimi");
    expect(result.stdout).toContain("skip > deepseek-pi");
  });

  test("checks three role profiles and Kimi with private runtime roots and distinct evidence", async () => {
    const result = await runFixture("success", "codex", true, "", "1");
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter((call) => call.command === "launch").map((call) => call.args[0]))
      .toEqual(["claude", "claude", "codex", "kimi"]);
    const launches = result.calls.filter((call) => call.command === "launch");
    expect(launches[0].args).not.toContain("--role");
    expect(launches[1].args.slice(-2)).toEqual(["--role", "worker"]);
    expect(launches[2].args).not.toContain("--role");
    for (const [label, role, model, effort] of [
      ["claude-advisor", "advisor", "claude-opus-5-5", "xhigh"],
      ["claude-worker", "worker", "claude-sonnet-5-5", "high"],
      ["codex-worker", "worker", "gpt-6-astra", "medium"],
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
