import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { StateDB, type CreateSessionInput } from "../src/state";
import { runCli, renderHelpText } from "../src/command-contract";
import { planLaunch } from "../src/commands/launch";
import { buildTaskFileContent } from "../src/file-handoff";
import { check, status, sendTask } from "../src/commands/session-ops";
import { wait } from "../src/commands/wait";
import * as daemon from "../src/daemon";
import { Tmux } from "../src/tmux";

describe("bounded peer mail", () => {
  let root: string;
  let db: StateDB;
  let originalParent: string | undefined;
  let originalBudget: string | undefined;
  function session(id: string, extra: Partial<CreateSessionInput> = {}) {
    const projectPath = join(root, id);
    mkdirSync(projectPath, { recursive: true });
    return db.createSession({ id, parentId: "host", agentType: "codex", task: "task", ownerToken: "tok",
      projectPath, role: "worker", jobId: "job", ...extra });
  }
  async function cli(args: string[], caller?: string) {
    if (caller === undefined) delete process.env.AHELPA_PARENT_ID;
    else process.env.AHELPA_PARENT_ID = caller;
    const out: string[] = [], err: string[] = [];
    const code = await runCli(db, args, { print: (s) => out.push(s), printError: (s) => err.push(s) });
    return { code, out, err };
  }
  beforeEach(() => {
    mkdirSync(join(import.meta.dir, "../.ahelpa"), { recursive: true });
    root = mkdtempSync(join(import.meta.dir, "../.ahelpa/mail-test-"));
    db = new StateDB(join(root, "state.db"));
    originalParent = process.env.AHELPA_PARENT_ID;
    originalBudget = process.env.AHELPA_MAIL_BUDGET;
    delete process.env.AHELPA_MAIL_BUDGET;
    spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
  });
  afterEach(() => {
    mock.restore();
    if (originalParent === undefined) delete process.env.AHELPA_PARENT_ID;
    else process.env.AHELPA_PARENT_ID = originalParent;
    if (originalBudget === undefined) delete process.env.AHELPA_MAIL_BUDGET;
    else process.env.AHELPA_MAIL_BUDGET = originalBudget;
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("two helpers exchange file and text messages across worktrees, with ledger, read marking and wait evidence", async () => {
    const a = session("a"), b = session("b"), untouched = session("untouched");
    const message = "接口说明：保留 UTF-8\n";
    const input = join(root, "message.md");
    writeFileSync(input, message);
    expect((await cli(["mail", "b", "--file", input], "a")).code).toBe(0);
    const inbox = join(b.projectPath, ".ahelpa/b/inbox");
    expect(readdirSync(inbox)).toEqual(["1-from-a.md"]);
    expect(readFileSync(join(inbox, "1-from-a.md"), "utf8")).toBe(message);
    expect(existsSync(join(a.projectPath, ".ahelpa/b"))).toBe(false);
    const ledger = JSON.parse(readFileSync(join(a.projectPath, ".ahelpa/jobs/job/mail.jsonl"), "utf8"));
    expect(ledger).toMatchObject({ from: "a", to: "b", seq: 1, bytes: Buffer.byteLength(message) });
    expect(Number.isNaN(Date.parse(ledger.ts))).toBe(false);
    let listed = JSON.parse((await cli(["inbox"], "b")).out[0]);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ from: "a", to: "b", seq: 1, readAt: null });
    expect((await cli(["inbox", "--read", "1"], "b")).out[0]).toBe("> 接口说明：保留 UTF-8");
    listed = JSON.parse((await cli(["inbox"], "b")).out[0]);
    expect(listed[0].readAt).toBeString();
    expect((await cli(["inbox", "--read", "1"], "b")).out[0]).toBe("> 接口说明：保留 UTF-8");
    expect((await cli(["mail", "a", "--text", "noted"], "b")).code).toBe(0);
    expect(readFileSync(join(a.projectPath, ".ahelpa/a/inbox/1-from-b.md"), "utf8")).toBe("noted");
    db.updateStatus("a", "idle"); db.updateStatus("b", "idle"); db.updateStatus(untouched.id, "idle");
    const results = await wait(db, ["a", "b", "untouched"], true, 5000);
    expect(Array.isArray(results)).toBe(true);
    if (!Array.isArray(results)) throw new Error("Expected array");
    expect(results[0].evidence?.peerMail).toEqual({ sent: 1, received: 1 });
    expect(results[1].evidence?.peerMail).toEqual({ sent: 1, received: 1 });
    expect(results[2].evidence?.peerMail).toBeUndefined();
  });

  test("host, unknown caller, no-job, out-of-job, self and reviewer mail are refused without delivery", async () => {
    session("a"); const b = session("b"); session("outside", { jobId: "elsewhere" });
    session("nojob", { jobId: null }); const reviewer = session("review", { role: "reviewer" });
    for (const caller of [undefined, "missing"]) {
      const result = await cli(["mail", "b", "--text", "x"], caller);
      expect(result.code).toBe(1); expect(result.err.join("")).toContain("host");
      expect((await cli(["inbox"], caller)).code).toBe(1);
    }
    for (const [from, to, error] of [["nojob", "b", "job"], ["a", "outside", "job"],
      ["a", "review", "reviewer"], ["review", "a", "reviewer"], ["a", "a", "self"], ["a", "missing", "not found"]]) {
      const result = await cli(["mail", to, "--text", "x"], from);
      expect(result.code).toBe(1); expect(result.err.join("")).toContain(error);
    }
    expect((await cli(["mail", "--peers", "--text", "x"], "nojob")).code).toBe(1);
    expect((await cli(["inbox"], "review")).code).toBe(1);
    expect(existsSync(join(b.projectPath, ".ahelpa/b/inbox"))).toBe(false);
    expect(existsSync(join(reviewer.projectPath, ".ahelpa/review/inbox"))).toBe(false);
  });

  test.each(["idle", "draining", "needs_attention", "error", "dead"] as const)("refuses sender and recipient in %s", async (state) => {
    session("a"); session("b"); db.updateStatus("a", state);
    const fromResult = await cli(["mail", "b", "--text", "x"], "a");
    expect(fromResult.code).toBe(1); expect(fromResult.err.join("")).toContain("running session");
    db.updateStatus("a", "running"); db.updateStatus("b", state);
    const toResult = await cli(["mail", "b", "--text", "x"], "a");
    expect(toResult.code).toBe(1); expect(toResult.err.join("")).toContain("running session");
  });

  test("broadcast excludes sender, reviewers, finished and other-job sessions and charges each recipient", async () => {
    const a = session("a", { mailBudget: 3 }); session("b"); session("c"); session("review", { role: "reviewer" });
    session("outside", { jobId: "elsewhere" }); session("done"); db.updateStatus("done", "idle");
    const result = await cli(["mail", "--peers", "--text", "question"], "a");
    expect(result.code).toBe(0);
    const ledger = readFileSync(join(a.projectPath, ".ahelpa/jobs/job/mail.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(ledger.map((m) => m.to).sort()).toEqual(["b", "c"]);
    expect((await cli(["mail", "--peers", "--text", "too many"], "a")).code).toBe(1);
    expect((await cli(["mail", "b", "--text", "last"], "a")).code).toBe(0);
    expect((await cli(["mail", "c", "--text", "over"], "a")).code).toBe(1);
    db.updateStatus("b", "idle"); db.updateStatus("c", "idle");
    expect((await cli(["mail", "--peers", "--text", "empty"], "a")).code).toBe(1);
  });

  test("the ninth message is refused even after reopening SQLite and switching cwd", async () => {
    const a = session("a"), b = session("b");
    for (let i = 1; i <= 8; i++) expect((await cli(["mail", "b", "--text", `m${i}`], "a")).code).toBe(0);
    db.close(); db = new StateDB(join(root, "state.db"));
    const cwd = process.cwd();
    try {
      process.chdir(b.projectPath);
      const result = await cli(["mail", "b", "--text", "m9"], "a");
      expect(result.code).toBe(1); expect(result.err.join("")).toContain("budget");
    } finally { process.chdir(cwd); }
    expect(readFileSync(join(a.projectPath, ".ahelpa/jobs/job/mail.jsonl"), "utf8").trim().split("\n")).toHaveLength(8);
    expect(readdirSync(join(b.projectPath, ".ahelpa/b/inbox"))).toHaveLength(8);
  });

  test.each(["", "0", "-1", "garbage"])("invalid budget %s uses the same fallback as nesting limits", async (budget) => {
    session("a"); session("b"); process.env.AHELPA_MAIL_BUDGET = budget;
    for (let i = 0; i < 8; i++) expect((await cli(["mail", "b", "--text", "x"], "a")).code).toBe(0);
    expect((await cli(["mail", "b", "--text", "x"], "a")).code).toBe(1);
  });

  test("recipient sequence increases across senders and read state survives reopen", async () => {
    session("a"); const b = session("b"); session("c");
    expect((await cli(["mail", "b", "--text", "one"], "a")).code).toBe(0);
    expect((await cli(["mail", "b", "--text", "two"], "c")).code).toBe(0);
    expect((await cli(["inbox", "--read", "2"], "b")).code).toBe(0);
    db.close(); db = new StateDB(join(root, "state.db"));
    expect(JSON.parse((await cli(["inbox"], "b")).out[0])[1].readAt).toBeString();
    expect(readdirSync(join(b.projectPath, ".ahelpa/b/inbox")).sort()).toEqual(["1-from-a.md", "2-from-c.md"]);
    for (const value of ["0", "-1", "1.5", "999"]) expect((await cli(["inbox", "--read", value], "b")).code).toBe(1);
  });

  test("failed file delivery does not consume budget, sequence or ledger entries", async () => {
    const a = session("a", { mailBudget: 1 }), b = session("b");
    const obstruction = join(b.projectPath, ".ahelpa"); writeFileSync(obstruction, "blocked");
    expect((await cli(["mail", "b", "--text", "fails"], "a")).code).toBe(1);
    rmSync(obstruction);
    expect((await cli(["mail", "b", "--text", "works"], "a")).code).toBe(0);
    expect(readdirSync(join(b.projectPath, ".ahelpa/b/inbox"))).toEqual(["1-from-a.md"]);
    expect(readFileSync(join(a.projectPath, ".ahelpa/jobs/job/mail.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a later broadcast failure rolls back earlier recipient files and metadata", async () => {
    session("a"); const b = session("b"), c = session("c");
    writeFileSync(join(c.projectPath, ".ahelpa"), "blocked");
    expect((await cli(["mail", "--peers", "--text", "batch"], "a")).code).toBe(1);
    expect(db.peerMailCounts("a")).toEqual({ sent: 0, received: 0 });
    expect(db.listPeerMail("b")).toEqual([]);
    expect(readdirSync(join(b.projectPath, ".ahelpa/b/inbox"))).toEqual([]);
    rmSync(join(c.projectPath, ".ahelpa"));
    expect((await cli(["mail", "--peers", "--text", "retry"], "a")).code).toBe(0);
    expect(readdirSync(join(b.projectPath, ".ahelpa/b/inbox"))).toEqual(["1-from-a.md"]);
  });

  test("a ledger append failure rolls back delivered files, preserving prior ledger bytes", async () => {
    const a = session("a"), b = session("b");
    expect((await cli(["mail", "b", "--text", "first"], "a")).code).toBe(0);
    const ledger = join(a.projectPath, ".ahelpa/jobs/job/mail.jsonl");
    const original = readFileSync(ledger, "utf8");
    // Fail only the ledger append after files were delivered, including a
    // partial append to verify that rollback truncates only this batch.
    const fs = await import("fs");
    const append = fs.appendFileSync;
    spyOn(fs, "appendFileSync").mockImplementation((path, data) => {
      append(path, data.toString().slice(0, 8));
      throw new Error("synthetic append failure");
    });
    const result = await cli(["mail", "b", "--text", "second"], "a");
    expect(result.code).toBe(1); expect(result.err.join("")).toContain("synthetic append failure");
    expect(readFileSync(ledger, "utf8")).toBe(original);
    expect(db.peerMailCounts("a").sent).toBe(1);
    expect(readdirSync(join(b.projectPath, ".ahelpa/b/inbox"))).toEqual(["1-from-a.md"]);
  });

  test("parallel processes enforce the sender budget and unique per-recipient sequences", async () => {
    session("a"); const b = session("b"); session("c");
    const modulePath = join(import.meta.dir, "../src/command-contract.ts");
    const statePath = join(import.meta.dir, "../src/state.ts");
    const daemonPath = join(import.meta.dir, "../src/daemon.ts");
    const callers = [...Array<string>(12).fill("a"), ...Array<string>(4).fill("c")];
    const children = callers.map((caller, index) => Bun.spawn([process.execPath, "-e", `
      import { existsSync, writeFileSync } from "fs";
      import { StateDB } from ${JSON.stringify(statePath)};
      import { runCli } from ${JSON.stringify(modulePath)};
      import { spyOn } from "bun:test";
      import * as daemon from ${JSON.stringify(daemonPath)};
      spyOn(daemon, "isDaemonRunning").mockReturnValue(true);
      writeFileSync(${JSON.stringify(join(root, `ready-${index}`))}, "ready");
      const deadline = Date.now() + 10000;
      while (!existsSync(${JSON.stringify(join(root, "start"))})) {
        if (Date.now() >= deadline) throw new Error("Mail barrier timed out");
        await Bun.sleep(5);
      }
      const db = new StateDB(${JSON.stringify(join(root, "state.db"))});
      try { process.exitCode = await runCli(db, ["mail", "b", "--text", "concurrent"], {
        print: () => {}, printError: (s) => console.error(s),
      }); } finally { db.close(); }
    `], { env: { ...process.env, AHELPA_PARENT_ID: caller, AHELPA_MAIL_BUDGET: "8" }, stdout: "pipe", stderr: "pipe" }));
    const outcomes = children.map(async (child) => {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    });
    try {
      const deadline = Date.now() + 10000;
      while (!children.every((_, index) => existsSync(join(root, `ready-${index}`)))) {
        if (Date.now() >= deadline) throw new Error("Mail workers did not become ready");
        await Bun.sleep(5);
      }
      writeFileSync(join(root, "start"), "start");
      const results = await Promise.all(outcomes);
      expect(results.filter((r) => r.code === 0)).toHaveLength(12);
      expect(results.filter((r) => r.code !== 0).every((r) => r.code === 1 && r.err.includes("budget"))).toBe(true);
      expect(db.peerMailCounts("a").sent).toBe(8);
      expect(db.peerMailCounts("c").sent).toBe(4);
      expect(db.listPeerMail("b").map((m) => m.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(readdirSync(join(b.projectPath, ".ahelpa/b/inbox"))).toHaveLength(12);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(outcomes);
    }
  }, 20000);

  test("receipt counts, read state and sequence remain available after the sender record is cleaned", async () => {
    session("a"); session("b"); session("c");
    expect((await cli(["mail", "b", "--text", "one"], "a")).code).toBe(0);
    db.deleteSession("a");
    expect((await cli(["inbox", "--read", "1"], "b")).out[0]).toBe("> one");
    expect((await cli(["mail", "b", "--text", "two"], "c")).code).toBe(0);
    expect(db.listPeerMail("b").map((m) => m.seq)).toEqual([1, 2]);
    expect(db.peerMailCounts("b").received).toBe(2);
  });

  test("changing stored project paths or deleting a ledger cannot reset the SQLite send budget", async () => {
    const a = session("a", { mailBudget: 1 }); session("b"); session("c");
    expect((await cli(["mail", "b", "--text", "one"], "a")).code).toBe(0);
    rmSync(join(a.projectPath, ".ahelpa/jobs/job/mail.jsonl"));
    const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
    const raw = new Database(join(root, "state.db"));
    raw.prepare("UPDATE sessions SET project_path = ? WHERE id = ?").run(elsewhere, "a"); raw.close();
    const result = await cli(["mail", "c", "--text", "two"], "a");
    expect(result.code).toBe(1); expect(result.err.join("")).toContain("budget");
    expect(db.peerMailCounts("a").sent).toBe(1);
    expect(existsSync(join(elsewhere, ".ahelpa"))).toBe(false);
  });

  test("orphan files are preserved and skipped; non-regular ledgers are refused", async () => {
    const a = session("a"), b = session("b");
    const inboxPath = join(b.projectPath, ".ahelpa/b/inbox"); mkdirSync(inboxPath, { recursive: true });
    const orphan = join(inboxPath, "1-from-a.md"); writeFileSync(orphan, "uncertain");
    let result = await cli(["mail", "b", "--text", "replacement"], "a");
    expect(result.code).toBe(0);
    expect(db.listPeerMail("b")[0].seq).toBe(2);
    expect(readFileSync(orphan, "utf8")).toBe("uncertain");
    const ledger = join(a.projectPath, ".ahelpa/jobs/job/mail.jsonl"); rmSync(ledger); mkdirSync(ledger);
    result = await cli(["mail", "b", "--text", "body"], "a");
    expect(result.code).toBe(1); expect(result.err.join("")).toContain("regular file");
    expect(db.peerMailCounts("a").sent).toBe(1);
    expect(readdirSync(inboxPath).sort()).toEqual(["1-from-a.md", "2-from-a.md"]);
  });

  test("relative legacy projects are refused and a failed inbox read does not mark the message", async () => {
    session("a"); const b = session("b"); session("relative", { projectPath: "relative" });
    for (const [from, to] of [["relative", "b"], ["a", "relative"]]) {
      const result = await cli(["mail", to, "--text", "body"], from);
      expect(result.code).toBe(1); expect(result.err.join("")).toContain("absolute project path");
    }
    expect((await cli(["mail", "b", "--text", "body"], "a")).code).toBe(0);
    rmSync(join(b.projectPath, ".ahelpa/b/inbox/1-from-a.md"));
    expect((await cli(["inbox", "--read", "1"], "b")).code).toBe(1);
    expect(db.listPeerMail("b")[0].readAt).toBeNull();
  });

  test("mail retains the existing filename-safe job convention", async () => {
    const jobId = "job.with-dots_1";
    const a = session("a", { jobId }); session("b", { jobId });
    expect((await cli(["mail", "b", "--text", "body"], "a")).code).toBe(0);
    expect(existsSync(join(a.projectPath, ".ahelpa/jobs/job.with-dots_1/mail.jsonl"))).toBe(true);
    const plan = planLaunch({ db, agentType: "codex", parentId: "a", projectPath: root, task: "work" });
    expect(buildTaskFileContent(plan.fileHandoff, "work", plan.handoffContext)).toContain("ahelpa check --job job.with-dots_1");
  });

  test("budget configuration stays out of every driver's launch and resume environment", async () => {
    delete process.env.AHELPA_PARENT_ID; process.env.AHELPA_MAIL_BUDGET = "3";
    for (const agentType of ["codex", "claude-code", "kimi"]) {
      const plan = planLaunch({ db, agentType, parentId: "host", projectPath: root, task: "work" });
      expect(plan.launchCmd).not.toContain("AHELPA_MAIL_BUDGET=");
      const old = session(`old-${agentType}`, { agentType });
      db.updateStatus(old.id, "idle"); db.updateResumeId(old.id, "resume-token");
      const create = spyOn(Tmux, "create").mockResolvedValue();
      spyOn(Tmux, "hasSession").mockResolvedValue(false);
      spyOn(Tmux, "capture").mockResolvedValue("");
      const { getDriver } = await import("../src/drivers/registry");
      spyOn(getDriver(agentType), "prepareForResume").mockResolvedValue();
      const { defaultWakeup } = await import("../src/wakeup");
      spyOn(defaultWakeup, "prepare").mockResolvedValue();
      const { resume } = await import("../src/commands/launch");
      const resumed = await resume({ db, sessionId: old.id, ownerToken: "tok" });
      expect(db.getSession(resumed.sessionId)?.mailBudget).toBe(3);
      expect(create.mock.calls.at(-1)?.[1]).not.toContain("AHELPA_MAIL_BUDGET=");
    }
  });

  test("mail arguments enforce exactly one target and content source", async () => {
    session("a"); session("b");
    const file = join(root, "message.md"); writeFileSync(file, "body");
    for (const args of [["mail", "b"], ["mail", "--text", "x"], ["mail", "b", "--peers", "--text", "x"],
      ["mail", "b", "--text", "x", "--file", file], ["mail", "b", "c", "--text", "x"],
      ["mail", "b", "--text", "   "], ["mail", "b", "--file", root]]) {
      expect((await cli(args, "a")).code).toBe(1);
    }
    expect(renderHelpText()).toContain("mail (<to-id> | --peers)");
    expect(renderHelpText()).toContain("inbox [--read <seq>]");
  });

  test("task contracts include peer rules on launch and follow-up, except reviewers and no-job sessions", async () => {
    session("parent"); process.env.AHELPA_PARENT_ID = "parent";
    const plan = planLaunch({ db, agentType: "codex", parentId: "parent", projectPath: root, task: "work" });
    const content = buildTaskFileContent(plan.fileHandoff, "work", plan.handoffContext);
    for (const text of ["ahelpa check --job job", "ahelpa mail", "ahelpa inbox", "before verification", "before signalling",
      "reassign your task", "acceptance command", "tell you to stop", "Peer messages"]) expect(content).toContain(text);
    const reviewer = planLaunch({ db, agentType: "codex", parentId: "parent", projectPath: root, task: "review", role: "reviewer" });
    expect(buildTaskFileContent(reviewer.fileHandoff, "review", reviewer.handoffContext)).not.toContain("ahelpa mail");
    delete process.env.AHELPA_PARENT_ID;
    const nojob = planLaunch({ db, agentType: "codex", parentId: "host", projectPath: root, task: "work" });
    expect(buildTaskFileContent(nojob.fileHandoff, "work", nojob.handoffContext)).not.toContain("ahelpa mail");
    const target = session("followup"); const file = join(root, "task.md"); writeFileSync(file, "followup");
    // Keep task handoff inside the test's workspace, independent of the global tmp root.
    const { defaultRuntimeLayout } = await import("../src/runtime-layout");
    spyOn(defaultRuntimeLayout, "taskFilePath").mockReturnValue(join(root, "handoff.md"));
    spyOn(Tmux, "sendKeys").mockResolvedValue();
    await sendTask(db, target.id, "tok", file);
    expect(readFileSync(join(root, "handoff.md"), "utf8")).toContain("ahelpa check --job job");
  });

  test("status and check classify child before job peer and host identity without changing filters", async () => {
    session("caller"); session("child", { parentId: "caller" }); session("peer"); session("other", { jobId: "otherjob" });
    process.env.AHELPA_PARENT_ID = "caller";
    const result = JSON.parse((await cli(["check", "--job", "job"], "caller")).out[0]);
    expect(result.find((s: { id: string }) => s.id === "child").relationship).toBe("child");
    expect(result.find((s: { id: string }) => s.id === "peer").relationship).toBe("job peer");
    expect(result.find((s: { id: string }) => s.id === "caller").relationship).toBe("other");
    expect(check(db).find((s) => s.id === "other")?.relationship).toBe("other");
    const output = status(db, true);
    expect(output).toContain("RELATIONSHIP");
    expect(output.split("\n").find((s) => s.startsWith("child "))).toContain("child");
    expect(output.split("\n").find((s) => s.startsWith("peer "))).toContain("job peer");
    expect(output.split("\n").find((s) => s.startsWith("other "))).toContain("other");
    process.env.AHELPA_PARENT_ID = "host";
    expect(check(db).every((s) => s.relationship === "child")).toBe(false);
    expect(check(db).find((s) => s.id === "caller")?.relationship).toBe("child");
    expect(check(db).find((s) => s.id === "child")?.relationship).toBe("other");
    expect(check(db, "caller").map((s) => s.id)).toEqual(["child"]);
  });

  test("pre-mail schema migrates and retains existing sessions", async () => {
    session("a"); session("b"); db.close();
    const raw = new Database(join(root, "state.db"));
    const columns = raw.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (columns.some((c) => c.name === "mail_sent")) raw.exec("ALTER TABLE sessions DROP COLUMN mail_sent");
    raw.exec("DROP TABLE IF EXISTS peer_mail"); raw.close();
    db = new StateDB(join(root, "state.db"));
    expect(db.listSessions()).toHaveLength(2);
    expect((await cli(["mail", "b", "--text", "migrated"], "a")).code).toBe(0);
  });

  test("host fallback identity grants child labels but never job-peer status even when it matches a stored session", async () => {
    session("host-thread"); session("child", { parentId: "host-thread" }); session("peer");
    const priorClaude = process.env.CLAUDE_CODE_SESSION_ID;
    const priorCodex = process.env.CODEX_THREAD_ID;
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      process.env.CODEX_THREAD_ID = "host-thread";
      const result = JSON.parse((await cli(["check"], undefined)).out[0]);
      expect(result.find((s: { id: string }) => s.id === "child").relationship).toBe("child");
      expect(result.find((s: { id: string }) => s.id === "peer").relationship).toBe("other");
      const output = (await cli(["status"], undefined)).out[0];
      expect(output).not.toContain("job peer");
    } finally {
      if (priorClaude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = priorClaude;
      if (priorCodex === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = priorCodex;
    }
  });
});
