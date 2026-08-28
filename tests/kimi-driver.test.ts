import { describe, expect, test } from "bun:test";
import { renderModelsText } from "../src/command-contract";
import { getDriver } from "../src/drivers/registry";
import type { DriverRuntime } from "../src/drivers/types";

function runtimeProbe(outputs: string[] = []): DriverRuntime & {
  captures: Array<{ sessionId: string; lines?: number }>;
  sent: string[];
  keys: string[];
  sleeps: number[];
} {
  const captures: Array<{ sessionId: string; lines?: number }> = [];
  const sent: string[] = [];
  const keys: string[] = [];
  const sleeps: number[] = [];
  let outputIndex = 0;

  return {
    captures,
    sent,
    keys,
    sleeps,
    async sleep(ms) { sleeps.push(ms); },
    async capture(sessionId, lines) {
      captures.push({ sessionId, lines });
      const output = outputs[Math.min(outputIndex, outputs.length - 1)] ?? "";
      outputIndex++;
      return output;
    },
    async sendKeys(_sessionId, text) { sent.push(text); },
    async sendKey(_sessionId, key) { keys.push(key); },
  };
}

describe("Kimi driver", () => {
  test("is registered with its own session prefix", () => {
    const driver = getDriver("kimi");
    expect(driver.name).toBe("kimi");
    expect(driver.sessionPrefix).toBe("kimi");
  });

  test("launches persistent Kimi Code with yolo by default", () => {
    const driver = getDriver("kimi");
    const command = driver.buildLaunchCommand({ cwd: "/tmp/project with spaces/it's ok" });

    expect(command).toContain("cd '/tmp/project with spaces/it'\\''s ok'");
    expect(command).toContain("&& KIMI_CODE_NO_AUTO_UPDATE=1 kimi --yolo");
    expect(command).not.toContain("KIMI_CLI_NO_AUTO_UPDATE");
    expect(command).not.toContain("--prompt");
  });

  test("safe launch and resume restore Kimi Code native approvals", () => {
    const driver = getDriver("kimi");
    const launch = driver.buildLaunchCommand({ cwd: "/tmp/project", safe: true });
    const resume = driver.buildResumeCommand({
      cwd: "/tmp/project",
      resumeId: "session_bce9aed7-8ee0-42ba-8ee8-5326e673db72",
      safe: true,
    });

    expect(launch).toContain("KIMI_CODE_NO_AUTO_UPDATE=1 kimi");
    expect(launch).not.toContain("--yolo");
    expect(resume).toContain(
      "kimi --session 'session_bce9aed7-8ee0-42ba-8ee8-5326e673db72'",
    );
    expect(resume).toContain("KIMI_CODE_NO_AUTO_UPDATE=1 kimi");
    expect(resume).not.toContain("--yolo");
  });

  test("passes a configured model alias and rejects unsupported effort", () => {
    const driver = getDriver("kimi");
    const command = driver.buildLaunchCommand({ cwd: "/tmp/project", model: "review-model" });

    expect(command).toContain("--model 'review-model'");
    expect(() => driver.buildLaunchCommand({ cwd: "/tmp/project", effort: "high" }))
      .toThrow("Kimi does not support --effort");
  });

  test("extracts the session ID from the welcome panel and exit hint", () => {
    const driver = getDriver("kimi");
    const output = [
      "Welcome to Kimi Code!",
      "Directory: /tmp/project",
      "│  Session:   session_bce9aed7-8ee0-42ba-8ee8-5326e673db72                   │",
      "Model: kimi-k3",
    ].join("\n");

    expect(driver.extractResumeToken(output))
      .toBe("session_bce9aed7-8ee0-42ba-8ee8-5326e673db72");
    expect(driver.extractResumeToken(
      "To resume this session: kimi -r session_bce9aed7-8ee0-42ba-8ee8-5326e673db72",
    )).toBe("session_bce9aed7-8ee0-42ba-8ee8-5326e673db72");
    expect(driver.extractResumeToken("Welcome to Kimi Code!\n│  Session:   │")).toBeNull();
  });

  test("accepts the first-run trust prompt and waits for the boxed input", async () => {
    const driver = getDriver("kimi");
    const runtime = runtimeProbe([
      [
        "Trust this folder?",
        "   Trust this folder",
        " ❯ Don't trust",
      ].join("\n"),
      [
        "Welcome to Kimi Code!",
        "│  Session:                                                                  │",
        "│ >                                                                          │",
        "context: 0% (0/977k)",
      ].join("\n"),
    ]);

    await driver.prepareForTask("kimi-test", runtime);

    expect(runtime.captures).toEqual([
      { sessionId: "kimi-test", lines: 60 },
      { sessionId: "kimi-test", lines: 60 },
    ]);
    expect(runtime.keys).toEqual(["Up"]);
    expect(runtime.sent).toEqual([""]);
  });

  test("fails readiness when trust never reaches the input prompt", async () => {
    const driver = getDriver("kimi");
    const runtime = runtimeProbe([
      "Trust this folder?\n   Trust this folder\n ❯ Don't trust",
    ]);

    await expect(driver.prepareForTask("kimi-stuck", runtime))
      .rejects.toThrow("did not reach its input prompt");
    expect(runtime.captures).toHaveLength(30);
    expect(runtime.keys).toEqual(["Up"]);
  });

  test("resume readiness ignores old generation signals before a newer prompt", async () => {
    const driver = getDriver("kimi");
    const runtime = runtimeProbe([
      [
        "✨ Earlier turn",
        "🌗 Retrying (2/3) · APIStatusError · in 120s",
        "● Earlier response",
        "│ >   │",
      ].join("\n"),
    ]);

    await driver.prepareForResume("kimi-resumed", runtime);

    expect(runtime.captures).toHaveLength(1);
  });

  test("resume readiness ignores settled historical tool use before a newer prompt", async () => {
    const driver = getDriver("kimi");
    const runtime = runtimeProbe([
      [
        "✨ Earlier turn",
        "● Using Write (/tmp/result.md)",
        "🌗 · Tip: stay curious",
        "● [AHELPA:DONE]",
        "│ >   │",
      ].join("\n"),
    ]);

    await driver.prepareForResume("kimi-resumed", runtime);

    expect(runtime.captures).toHaveLength(1);
  });

  test("waits until the first message creates a Kimi session", async () => {
    const driver = getDriver("kimi");
    const runtime = runtimeProbe([
      "Welcome to Kimi Code!\n│  Session:   │\n│ >   │",
      "Welcome to Kimi Code!\n│  Session:   session_abc-123   │\n✨ task\n● working",
    ]);

    await driver.afterTaskSubmitted("kimi-test", runtime);

    expect(runtime.captures).toEqual([
      { sessionId: "kimi-test", lines: 80 },
      { sessionId: "kimi-test", lines: 80 },
    ]);
  });

  test("waits for a new resumed turn instead of accepting an old DONE", async () => {
    const driver = getDriver("kimi");
    const oldTurn = [
      "│  Session:   session_abc-123   │",
      "✨ First task",
      "● [AHELPA:DONE]",
      "│ >   │",
    ].join("\n");
    const runtime = runtimeProbe([
      oldTurn,
      oldTurn,
      `${oldTurn}\n✨ Follow-up task\n🌗 working...`,
    ]);

    await driver.afterTaskSubmitted("kimi-test", runtime, { beforeOutput: oldTurn });

    expect(runtime.captures).toHaveLength(3);
  });

  test("accepts an approval answer that resumes generation inside the same turn", async () => {
    const driver = getDriver("kimi");
    const waiting = [
      "│  Session:   session_abc-123   │",
      "✨ Inspect the repository",
      "⠹ working...",
      "▶ Run this command?",
      "1. Approve once",
      "enter confirm",
    ].join("\n");
    const runtime = runtimeProbe([
      waiting,
      `${waiting}\n🌕\ncontext: 2%`,
    ]);

    const submitted = await driver.afterTaskSubmitted(
      "kimi-test",
      runtime,
      { beforeOutput: waiting },
    );

    expect(submitted).toBe(true);
    expect(runtime.captures).toHaveLength(2);
  });

  test("accepts a question answer that resumes generation inside the same turn", async () => {
    const driver = getDriver("kimi");
    const waiting = [
      "│  Session:   session_abc-123   │",
      "✨ Inspect the repository",
      "▶ question",
      "▶ ? Which option?",
      "1. One",
      "esc cancel",
    ].join("\n");
    const runtime = runtimeProbe([
      `${waiting}\n⠏ working...`,
    ]);

    const submitted = await driver.afterTaskSubmitted(
      "kimi-test",
      runtime,
      { beforeOutput: waiting },
    );

    expect(submitted).toBe(true);
  });

  test("accepts an approval answer that completes before generation is sampled", async () => {
    const driver = getDriver("kimi");
    const waiting = [
      "│  Session:   session_abc-123   │",
      "✨ Inspect the repository",
      "▶ Run this command?",
      "1. Approve once",
    ].join("\n");
    const runtime = runtimeProbe([`${waiting}\n● [AHELPA:DONE]\n│ >   │`]);

    const submitted = await driver.afterTaskSubmitted(
      "kimi-test",
      runtime,
      { beforeOutput: waiting },
    );

    expect(submitted).toBe(true);
    expect(runtime.captures).toHaveLength(1);
  });

  test("does not accept an unchanged retained approval and DONE as a new turn", async () => {
    const driver = getDriver("kimi");
    const settled = [
      "│  Session:   session_abc-123   │",
      "✨ Inspect the repository",
      "▶ Run this command?",
      "1. Approve once",
      "● [AHELPA:DONE]",
      "│ >   │",
    ].join("\n");
    const runtime = runtimeProbe([settled]);

    const submitted = await driver.afterTaskSubmitted(
      "kimi-test",
      runtime,
      { beforeOutput: settled },
    );

    expect(submitted).toBe(false);
    expect(runtime.captures).toHaveLength(10);
  });

  test("recognizes a repeated identical turn after the old settled capture slides away", async () => {
    const driver = getDriver("kimi");
    const repeatedTask = "✨ Repeat this exact task";
    const before = [
      "│  Session:   session_abc-123   │",
      repeatedTask,
      "● [AHELPA:DONE]",
      "│ >   │",
    ].join("\n");
    const after = [
      "│  Session:   session_abc-123   │",
      repeatedTask,
      "⠹ working...",
    ].join("\n");
    const runtime = runtimeProbe([after]);

    const submitted = await driver.afterTaskSubmitted(
      "kimi-test",
      runtime,
      { beforeOutput: before },
    );

    expect(submitted).toBe(true);
    expect(driver.detectStatus(after)).toBe("running");
  });

  test("does not accept an unchanged attention panel without newer generation", async () => {
    const driver = getDriver("kimi");
    const waiting = [
      "│  Session:   session_abc-123   │",
      "✨ Inspect the repository",
      "⠹ working...",
      "▶ Run this command?",
      "1. Approve once",
    ].join("\n");
    const runtime = runtimeProbe([waiting]);

    const submitted = await driver.afterTaskSubmitted(
      "kimi-test",
      runtime,
      { beforeOutput: waiting },
    );

    expect(submitted).toBe(false);
    expect(runtime.captures).toHaveLength(10);
  });

  test("detects generation, attention panels, returned-prompt, and booting activity", () => {
    const driver = getDriver("kimi");
    const task = "Please read and complete the task described in /tmp/ahelpa-task.md.";
    const prompt = "│ >                                                                          │";

    expect(driver.detectActivity(`${prompt}\n✨ ${task}\n⠹ thinking...\ncontext: 1%`))
      .toBe("working");
    expect(driver.detectActivity(`${prompt}\n✨ ${task}\n⠏ working... · Tip: stay curious`))
      .toBe("working");
    expect(driver.detectActivity(`${prompt}\n✨ ${task}\n  🌕\ncontext: 0%`))
      .toBe("working");
    expect(driver.detectActivity(
      `${prompt}\n✨ ${task}\n  🌗 Retrying (2/3) · APIStatusError · in 120s`,
    ))
      .toBe("working");
    expect(driver.detectActivity(
      `${prompt}\n✨ ${task}\nRetrying (2/3) · APIStatusError · in 120s`,
    ))
      .toBe("working");
    expect(driver.detectActivity(
      `${prompt}\n✨ ${task}\n● [AHELPA:DONE]\n${prompt}\ncontext: 4%`,
    )).toBe("idle");
    for (const title of [
      "▶ Run this command?",
      "▶ Write this file?",
      "▶ Apply these edits?",
      "▶ Stop this task?",
      "▶ Ready to build with this plan?",
      "▶ Approve mcp_tool?",
    ]) {
      expect(driver.detectActivity(`${task}\n${title}\n1. Allow\nenter confirm`))
        .toBe("idle");
    }
    expect(driver.detectActivity(
      `${task}\n▶ Run this command?\n1. Allow\n⠏ working...`,
    )).toBe("working");
    expect(driver.detectActivity(
      `${task}\n▶ Run this command?\n1. Allow\n⠏ working...\n${prompt}`,
    )).toBe("idle");
    expect(driver.detectActivity([
      `✨ ${task}`,
      "● Read src/cli.ts",
      "● Using Write (/tmp/result.md)",
      "🌗 · Tip: stay curious",
      prompt,
    ].join("\n"))).toBe("working");
    expect(driver.detectActivity([
      `✨ ${task}`,
      "● Using Write (/tmp/result.md)",
      "🌗 · Tip: stay curious",
      "● [AHELPA:DONE]",
      prompt,
    ].join("\n"))).toBe("idle");
    expect(driver.detectActivity("▶ question\n ▶ ? Which option?\n1. One\nesc cancel"))
      .toBe("idle");
    expect(driver.detectActivity(
      "▶ question\n ▶ ? Which option?\n1. One\nesc cancel\n🌕",
    )).toBe("working");
    expect(driver.detectActivity("Review your answer before submit"))
      .toBe("idle");
    expect(driver.detectActivity("Ready to submit your answers?"))
      .toBe("idle");
    expect(driver.detectActivity(`${prompt}\ncontext: 42%`)).toBe("idle");
    expect(driver.detectActivity("Trust this folder?\n❯ Don't trust")).toBe("booting");
    expect(driver.detectActivity("Welcome to Kimi Code!\n│  Session:   │")).toBe("booting");
  });

  test("detects Kimi Code bullet sentinels", () => {
    const driver = getDriver("kimi");

    expect(driver.detectStatus("● [AHELPA:DONE]")).toBe("idle");
    expect(driver.detectStatus("● [AHELPA:NEED_HELP]")).toBe("error");
  });

  test("ignores a completed sentinel from an earlier resumed turn", () => {
    const driver = getDriver("kimi");
    const resumed = [
      "✨ First turn",
      "● [AHELPA:DONE]",
      "│ >   │",
      "✨ Second turn",
      "⠹ thinking...",
    ].join("\n");

    expect(driver.detectStatus(resumed)).toBe("running");
    expect(driver.detectStatus(`${resumed}\n● [AHELPA:DONE]`)).toBe("idle");
  });

  test("ignores a historical NEED_HELP after intervention resumes the same turn", () => {
    const driver = getDriver("kimi");
    const resumed = [
      "✨ First turn",
      "● [AHELPA:NEED_HELP]",
      "⠹ working...",
    ].join("\n");

    expect(driver.detectStatus(resumed)).toBe("running");
    expect(driver.detectActivity(resumed)).toBe("working");
  });

  test("exits gracefully and reports unsupported runtime model switching", async () => {
    const driver = getDriver("kimi");
    const runtime = runtimeProbe();

    await driver.gracefulExit("kimi-test", runtime);
    expect(runtime.sent).toEqual(["/exit"]);
    await expect(driver.switchModel("kimi-test", runtime, { model: "review-model" }))
      .rejects.toThrow("Kimi runtime model switching is not supported");
  });

  test("advertises dynamic model aliases without inventing a static catalog", () => {
    const text = renderModelsText("kimi");

    expect(text).toContain("kimi");
    expect(text).toContain("configured Kimi Code model alias");
    expect(text).toContain("--effort is not supported");
  });
});
