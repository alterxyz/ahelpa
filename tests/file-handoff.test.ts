import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { RuntimeLayout } from "../src/runtime-layout";
import {
  buildTaskInstruction,
  isTaskInstructionEcho,
  planFileHandoff,
  prepareFileHandoff,
} from "../src/file-handoff";
import { SENTINEL, scanSentinels } from "../src/drivers/sentinels";

const TEST_TMP = "/tmp/ahelpa-file-handoff-test-tmp";
const TEST_HOME = "/tmp/ahelpa-file-handoff-test-home";
const TEST_PROJECT = "/tmp/ahelpa-file-handoff-test-project";

const instructionPaths = {
  taskFilePath: "/tmp/ahelpa/ahelpa-task-abc.md",
  sessionDeliveryDir: "/project/.ahelpa/abc",
  summaryPath: "/project/.ahelpa/abc/summary.md",
  artifactsDir: "/project/.ahelpa/abc/artifacts",
};

function readPreparedTask(task: string = "do the work") {
  const plan = planFileHandoff(TEST_PROJECT, "claude-abc123", new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP }));
  prepareFileHandoff(plan, task);
  return { plan, content: readFileSync(plan.taskFilePath, "utf-8") };
}

function wordWrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function characterWrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < text.length; offset += width) {
    lines.push(text.slice(offset, offset + width));
  }
  return lines;
}

describe("file handoff", () => {
  afterEach(() => {
    rmSync(TEST_TMP, { recursive: true, force: true });
    rmSync(TEST_HOME, { recursive: true, force: true });
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  test("plans task and result paths from project plus session", () => {
    const layout = new RuntimeLayout({ homeDir: TEST_HOME, tmpDir: TEST_TMP });

    const plan = planFileHandoff(TEST_PROJECT, "codex-abc123", layout);

    expect(plan.taskFilePath).toBe(`${TEST_TMP}/ahelpa-task-codex-abc123.md`);
    expect(plan.projectDeliveryDir).toBe(`${TEST_PROJECT}/.ahelpa`);
    expect(plan.sessionDeliveryDir).toBe(`${TEST_PROJECT}/.ahelpa/codex-abc123`);
    expect(plan.summaryPath).toBe(`${TEST_PROJECT}/.ahelpa/codex-abc123/summary.md`);
    expect(plan.artifactsDir).toBe(`${TEST_PROJECT}/.ahelpa/codex-abc123/artifacts`);
  });

  test("prepares task file and result artifact directory", () => {
    const task = "  do the work\r\nKeep literal [AHELPA:NEED_HELP:custom].\n\n";
    const { plan, content } = readPreparedTask(task);

    expect(content.slice(0, task.length)).toBe(task);
    expect(content.slice(task.length)).toStartWith("\n\n---\n\n## ahelpa signals\n\n");
    expect(existsSync(plan.sessionDeliveryDir)).toBe(true);
    expect(existsSync(plan.artifactsDir)).toBe(true);
    prepareFileHandoff(plan, task);
    expect(readFileSync(plan.taskFilePath, "utf-8")).toBe(content);
  });

  test("instruction teaches task file, result directory, artifacts, and sentinels", () => {
    const instruction = buildTaskInstruction(instructionPaths);

    expect(instruction).toContain("/tmp/ahelpa/ahelpa-task-abc.md");
    expect(instruction).toContain("/project/.ahelpa/abc");
    expect(instruction).toContain("/project/.ahelpa/abc/summary.md");
    expect(instruction).toContain("/project/.ahelpa/abc/artifacts");
    expect(instruction).toContain(SENTINEL.Done);
    expect(instruction).toContain(SENTINEL.NeedHelp);
  });

  test("typed instruction stays within HEAD wording plus 60 characters for fixed paths", () => {
    const headInstruction = [
      `Please read and complete the task described in ${instructionPaths.taskFilePath}.`,
      `Use ${instructionPaths.sessionDeliveryDir} as your result directory.`,
      `For any written result, create ${instructionPaths.summaryPath} and put supporting artifacts under ${instructionPaths.artifactsDir}.`,
      `When you are finished, output ${SENTINEL.Done} on its own line.`,
      `If you are stuck and need help, output ${SENTINEL.NeedHelp} on its own line.`,
    ].join(" ");
    const instruction = buildTaskInstruction(instructionPaths);

    expect(instruction).toStartWith(headInstruction);
    expect(instruction).toEndWith(" Tags: see the end of the task file.");
    expect(instruction.length).toBeLessThanOrEqual(headInstruction.length + 60);
  });

  test("typed instruction contains only bare tokens surrounded by prose", () => {
    const instruction = buildTaskInstruction(instructionPaths);
    const tokens = [...instruction.matchAll(/\[AHELPA:(?:DONE|NEED_HELP)(?::[^\]\r\n]*)?\]/g)];

    expect(tokens.map((token) => token[0])).toEqual([
      SENTINEL.Done,
      SENTINEL.NeedHelp,
    ]);
    for (const token of tokens) {
      const before = instruction.slice(0, token.index);
      const after = instruction.slice(token.index + token[0].length);
      expect(before).toMatch(/\b[A-Za-z]+[ \t]+$/);
      expect(after).toStartWith(" on its own line.");
    }
    expect(instruction).not.toMatch(/\][ \t]*\[AHELPA:/);
    expect(scanSentinels(instruction)).toEqual([]);
  });

  test("review help applies only when a refusal blocks the helper and records it before signaling", () => {
    const { plan, content: instruction } = readPreparedTask();

    expect(instruction).toMatch(/external review/i);
    expect(instruction).toMatch(/auto[- ]mode/i);
    expect(instruction).toMatch(/sandbox/i);
    expect(instruction).toMatch(/project rule/i);
    expect(instruction).toMatch(/validator/i);
    expect(instruction).toMatch(/refus(?:e[ds]?|al)/i);
    expect(instruction).toContain("[AHELPA:NEED_HELP:review]");
    expect(instruction).toMatch(/(?:refused|blocked|rejected) action/i);
    expect(instruction).toMatch(/(?:verbatim[^.]*refusal|refusal[^.]*verbatim)/i);
    expect(instruction).toContain(plan.summaryPath);
    expect(instruction).toMatch(/(?:do not|don't|instead of|rather than|without)[^.]*bypass/i);
    expect(instruction).toContain("If you are blocked because an external review");
    expect(instruction).toContain("or project rule/validator refused an action, do not bypass it:");
    expect(instruction).toContain(`first write the refused action and verbatim refusal into ${plan.summaryPath}, then output [AHELPA:NEED_HELP:review].`);
    expect(instruction).not.toContain("refused an action, stop");
  });

  test("a refusal permits legitimate in-task recovery without requiring a stop", () => {
    const { content: instruction } = readPreparedTask();

    expect(instruction).toContain("Legitimate in-task recovery from a refusal does not require stopping.");
  });

  test("footer excludes attached punctuation from the signal to print", () => {
    const { content: instruction } = readPreparedTask();

    expect(instruction).toContain("Print the applicable signal alone on a line:");
    expect(instruction).toContain("Punctuation after a signal is not part of it.");
  });

  test("input help covers missing, truncated, and contradictory input and combines with review", () => {
    const { content: instruction } = readPreparedTask();

    expect(instruction).toMatch(/missing/i);
    expect(instruction).toMatch(/truncated/i);
    expect(instruction).toMatch(/contradictory/i);
    expect(instruction).toContain("[AHELPA:NEED_HELP:input]");
    expect(instruction).toMatch(/both/i);
    expect(instruction).toContain("[AHELPA:NEED_HELP:review,input]");
  });

  test("footer still asks for a help signal if writing the summary fails", () => {
    const { content: instruction } = readPreparedTask();

    expect(instruction).toMatch(/(?:even if|if)[^.]*?(?:summary|summary\.md)[^.!?]*?(?:fail|cannot|can't|unable)/i);
    expect(instruction).toMatch(/(?:still[^.]*?(?:signal|output|print|emit|NEED_HELP)|(?:signal|output|print|emit)[^.]*?anyway)/i);
  });

  test.each([
    { name: "word", wrap: wordWrap },
    { name: "character", wrap: characterWrap },
  ])("real instruction $name wrapping cannot produce a standalone sentinel", ({ wrap }) => {
    const instruction = buildTaskInstruction(instructionPaths);

    for (let width = 40; width <= 200; width++) {
      for (let indentation = 0; indentation <= 4; indentation++) {
        const padding = " ".repeat(indentation);
        const wrapped = wrap(instruction, width - indentation)
          .map((line) => `${padding}${line}`)
          .join("\n");

        expect({ width, indentation, matches: scanSentinels(wrapped) })
          .toEqual({ width, indentation, matches: [] });
      }
    }
  });

  test("instruction echo detection matches the handoff instruction prefix", () => {
    const plan = planFileHandoff(TEST_PROJECT, "codex-echo", new RuntimeLayout({ tmpDir: TEST_TMP }));

    expect(isTaskInstructionEcho(plan.taskInstruction)).toBe(true);
    expect(isTaskInstructionEcho("Working (3s)")).toBe(false);
  });
});
