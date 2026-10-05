import { describe, expect, test } from "bun:test";
import { getDriver } from "../src/drivers/registry";
import { SENTINEL } from "../src/drivers/sentinels";

const driverCases = [
  { name: "claude-code", turn: "❯", bullet: "⏺", working: "✢ Working…" },
  { name: "codex", turn: "›", bullet: "•", working: "Working (1s)" },
  { name: "kimi", turn: "✨", bullet: "●", working: "⠹ thinking..." },
];

describe.each(driverCases)("$name outcomes", ({ name, turn, bullet, working }) => {
  test("current tagged help carries normalized tags", () => {
    const driver = getDriver(name);
    const output = `${turn} Current task\n${working}\n${bullet} [AHELPA:NEED_HELP: REVIEW, input,REVIEW,custom_tag]`;

    expect(driver.detectOutcome(output)).toEqual({ status: "error", needHelpTags: ["review", "input", "custom_tag"] });
    expect(driver.detectStatus(output)).toBe("error");
  });

  test("older help does not leak into a newer working turn", () => {
    const driver = getDriver(name);
    const output = `${turn} First task\n${bullet} [AHELPA:NEED_HELP:review]\n${turn} Follow-up task\n${working}`;

    expect(driver.detectOutcome(output)).toEqual({ status: "running", needHelpTags: null });
    expect(driver.detectStatus(output)).toBe("running");
  });

  test("current DONE clears older help tags", () => {
    const driver = getDriver(name);
    const output = `${turn} First task\n${bullet} [AHELPA:NEED_HELP:review]\n${turn} Follow-up task\n${bullet} ${SENTINEL.Done}`;

    expect(driver.detectOutcome(output)).toEqual({ status: "idle", needHelpTags: null });
    expect(driver.detectStatus(output)).toBe("idle");
  });

  test.each([
    { signal: SENTINEL.NeedHelp, status: "error", needHelpTags: [] },
    { signal: "[AHELPA:NEED_HELP:!!!]", status: "error", needHelpTags: [] },
    { signal: SENTINEL.Done, status: "idle", needHelpTags: null },
    { signal: "[AHELPA:DONE:review]", status: "running", needHelpTags: null },
    { signal: "Still working", status: "running", needHelpTags: null },
  ])("detectStatus agrees with the $signal outcome", ({ signal, status, needHelpTags }) => {
    const driver = getDriver(name);
    const output = `${turn} Current task\n${bullet} ${signal}`;

    expect(driver.detectOutcome(output)).toEqual({
      status,
      needHelpTags: needHelpTags === null ? null : [...needHelpTags],
    });
    expect(driver.detectStatus(output)).toBe(status);
  });
});

describe.each(driverCases.slice(0, 2))("$name shared winner rules", ({ name, turn, bullet }) => {
  test("HELP wins over later DONE with the last HELP tags", () => {
    const driver = getDriver(name);
    const output = [
      `${turn} Current task`,
      `${bullet} [AHELPA:NEED_HELP:review]`,
      `${bullet} [AHELPA:NEED_HELP:input]`,
      `${bullet} ${SENTINEL.Done}`,
    ].join("\n");

    expect(driver.detectOutcome(output)).toEqual({ status: "error", needHelpTags: ["input"] });
    expect(driver.detectStatus(output)).toBe("error");
  });
});

describe("driver-specific outcome winners", () => {
  const unsupported = "ERROR: The 'bad-model' model is not supported when using Codex with a ChatGPT account.";

  test.each([true, false])("Codex same-turn HELP outranks unsupported-model text: %j", (errorFirst) => {
    const signal = "[AHELPA:NEED_HELP:review]";
    const output = ["› Please read and complete the task described in /tmp/current.md.", ...(errorFirst ? [unsupported, signal] : [signal, unsupported])].join("\n");
    expect(getDriver("codex").detectOutcome(output)).toEqual({ status: "error", needHelpTags: ["review"] });
  });

  test.each([true, false])("Codex same-turn DONE outranks unsupported-model text: %j", (errorFirst) => {
    const signal = "[AHELPA:DONE]";
    const output = ["› Please read and complete the task described in /tmp/current.md.", ...(errorFirst ? [unsupported, signal] : [signal, unsupported])].join("\n");
    expect(getDriver("codex").detectOutcome(output)).toEqual({ status: "idle", needHelpTags: null });
  });

  test.each([
    { payload: "working...", tags: [] },
    { payload: "thinking...", tags: [] },
    { payload: "Retrying (1/3)", tags: [] },
    { payload: "review,thinking...", tags: ["review"] },
    { payload: "input,Retrying (2/3)", tags: ["input"] },
    { payload: "REVIEW, WORKING...", tags: ["review"] },
  ])("Kimi HELP still wins for malformed payload $payload", ({ payload, tags }) => {
    const driver = getDriver("kimi");
    const capture = `✨ Current task\n● [AHELPA:NEED_HELP:${payload}]\n│ > │`;
    expect(driver.detectOutcome(capture)).toEqual({ status: "error", needHelpTags: [...tags] });
    expect(driver.detectActivity(capture)).toBe("idle");
  });
  test("Codex unsupported-model error does not inherit older help tags", () => {
    const driver = getDriver("codex");
    const output = [
      "› First task",
      "• [AHELPA:NEED_HELP:review]",
      "› Please read and complete the task described in /tmp/ahelpa/task.md.",
      "■ {\"type\":\"error\",\"status\":400,\"error\":",
      "{\"message\":\"The 'gpt-5.6' model is not supported",
      "when using Codex with a ChatGPT account.\"}}",
      "› Explain this codebase",
    ].join("\n");

    expect(driver.detectOutcome(output)).toEqual({ status: "error", needHelpTags: null });
    expect(driver.detectStatus(output)).toBe("error");
  });

  test.each(["⠹ working...", "⠹ thinking...", "Retrying (1/3)", "● Using Write (/tmp/result.md)"])(
    "Kimi newer generation %j retires same-turn help tags",
    (generation) => {
      const driver = getDriver("kimi");
      const output = `✨ Current task\n● [AHELPA:NEED_HELP:review]\n${generation}`;

      expect(driver.detectOutcome(output)).toEqual({ status: "running", needHelpTags: null });
      expect(driver.detectStatus(output)).toBe("running");
    },
  );

  test("Kimi latest DONE wins over earlier help in the same turn", () => {
    const driver = getDriver("kimi");
    const output = "✨ Current task\n● [AHELPA:NEED_HELP:review]\n● [AHELPA:DONE]";

    expect(driver.detectOutcome(output)).toEqual({ status: "idle", needHelpTags: null });
    expect(driver.detectStatus(output)).toBe("idle");
  });

  test("Kimi uses fresh help tags after generation resumes", () => {
    const driver = getDriver("kimi");
    const output = "✨ Current task\n● [AHELPA:NEED_HELP:review]\n⠹ working...\n● [AHELPA:NEED_HELP:input]";

    expect(driver.detectOutcome(output)).toEqual({ status: "error", needHelpTags: ["input"] });
    expect(driver.detectStatus(output)).toBe("error");
  });
});
