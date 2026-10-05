import { describe, expect, test } from "bun:test";
import {
  maskSentinels,
  SENTINEL,
  hasDoneSentinel,
  hasNeedHelpSentinel,
  detectSentinelOutcome,
  detectSentinelStatus,
  scanSentinels,
  type PositionedSentinel,
} from "../src/drivers/sentinels";

describe("sentinel protocol", () => {
  test("masking preserves UTF-16 offsets and line breaks without changing the grammar", () => {
    const output = [
      "Progress 🌟", "", "  ● [AHELPA:NEED_HELP:review,thinking...,🌕] \r",
      "  🌘 real generation", "[AHELPA:DONE]", "● Using Write (/tmp/result.md)",
      "[AHELPA:DONE:payload]", "inline [AHELPA:NEED_HELP:thinking...]",
    ].join("\n");
    const masked = maskSentinels(output);
    expect(masked.length).toBe(output.length);
    expect(masked.split("\n")[2]).toBe(output.split("\n")[2].replace(/[^\r\n]/g, " "));
    expect(masked.split("\n")[4]).toBe(" ".repeat("[AHELPA:DONE]".length));
    for (const line of ["  🌘 real generation", "● Using Write (/tmp/result.md)", "[AHELPA:DONE:payload]", "inline [AHELPA:NEED_HELP:thinking...]"]) {
      expect(masked.indexOf(line)).toBe(output.indexOf(line));
    }
    expect(scanSentinels(masked)).toEqual([]);
    expect(maskSentinels(masked)).toBe(masked);
  });
  test("standalone matching ignores sentinels embedded in instructions", () => {
    const output = [
      `Please output ${SENTINEL.Done} when finished.`,
      `If you are stuck, output ${SENTINEL.NeedHelp}.`,
    ].join("\n");

    expect(hasDoneSentinel(output)).toBe(false);
    expect(hasNeedHelpSentinel(output)).toBe(false);
    expect(scanSentinels(output)).toEqual([]);
    expect(detectSentinelOutcome(output)).toEqual({ status: "running", needHelpTags: null });
  });

  test("standalone matching accepts sentinels on their own line, with agent bullets", () => {
    expect(hasDoneSentinel(`work done\n${SENTINEL.Done}\n`)).toBe(true);
    expect(hasDoneSentinel(`work done\n⏺ ${SENTINEL.Done}`)).toBe(true);
    expect(hasDoneSentinel(`work done\n● ${SENTINEL.Done}`)).toBe(true);
    expect(hasNeedHelpSentinel(`oops\n${SENTINEL.NeedHelp}\n`)).toBe(true);
  });

  test.each(["", "- ", "• ", "● ", "⏺ "])("scans standalone signals with bullet %j", (bullet) => {
    const output = `  ${bullet}${SENTINEL.Done}  \n\t${bullet}[AHELPA:NEED_HELP:review,input]\t`;

    expect(scanSentinels(output).map(({ status, needHelpTags }) => ({ status, needHelpTags })))
      .toEqual([
        { status: "idle", needHelpTags: null },
        { status: "error", needHelpTags: ["review", "input"] },
      ]);
    expect(hasDoneSentinel(output)).toBe(true);
    expect(hasNeedHelpSentinel(output)).toBe(true);
  });

  test.each([
    { payload: " REVIEW , Input,review,INPUT ", tags: ["review", "input"] },
    { payload: "custom-tag, FUTURE_2 , unknown,0", tags: ["custom-tag", "future_2", "unknown", "0"] },
    { payload: "review,not valid, bad.tag, input,foo/bar,help!,中文", tags: ["review", "input"] },
    { payload: " , !!!,bad tag,bad.tag,foo/bar,中文, ", tags: [] },
    { payload: "", tags: [] },
    { payload: "   ", tags: [] },
    { payload: ",,,", tags: [] },
  ])("parses NEED_HELP payload $payload", ({ payload, tags }) => {
    const output = `[AHELPA:NEED_HELP:${payload}]`;

    expect(scanSentinels(output)).toEqual([{ index: 0, status: "error", needHelpTags: [...tags] }]);
    expect(detectSentinelOutcome(output)).toEqual({ status: "error", needHelpTags: [...tags] });
    expect(hasNeedHelpSentinel(output)).toBe(true);
  });

  test("bare NEED_HELP reports an empty tag list, not null", () => {
    expect(scanSentinels(SENTINEL.NeedHelp)).toEqual([{ index: 0, status: "error", needHelpTags: [] }]);
    expect(detectSentinelOutcome(SENTINEL.NeedHelp)).toEqual({ status: "error", needHelpTags: [] });
  });

  test.each([
    "[AHELPA:NEED_HELP:review\n,input]",
    "[AHELPA:NEED_HELP:review\r\n,input]",
    "[AHELPA:NEED_HELP:review\rinput]",
    "[AHELPA:NEED_HELP\n]",
    "[AHELPA:NEED_HELP:review",
    "[AHELPA:NEED_HELP",
    "[AHELPA:DONE:review]",
    "[AHELPA:DONE:]",
    "[AHELPA:DONE: ]",
    "[AHELPA:DONE",
    "before [AHELPA:NEED_HELP:review]",
    "[AHELPA:NEED_HELP:review] after",
    "[AHELPA:NEED_HELP:review].",
    "[AHELPA:DONE][AHELPA:NEED_HELP:input]",
    "[AHELPA:DONE] [AHELPA:NEED_HELP:input]",
    "`[AHELPA:NEED_HELP:review]`",
  ])("rejects malformed or embedded signal %j", (output) => {
    expect(scanSentinels(output)).toEqual([]);
    expect(detectSentinelOutcome(output)).toEqual({ status: "running", needHelpTags: null });
    expect(hasDoneSentinel(output)).toBe(false);
    expect(hasNeedHelpSentinel(output)).toBe(false);
  });

  test("scanner returns ordered capture offsets and fresh results on repeated calls", () => {
    const output = "Progress 🌟\n[AHELPA:DONE]\nMore output\n[AHELPA:NEED_HELP:REVIEW]\n[AHELPA:NEED_HELP:input]";
    const expected: PositionedSentinel[] = [
      { index: output.indexOf(SENTINEL.Done), status: "idle", needHelpTags: null },
      { index: output.indexOf("[AHELPA:NEED_HELP:REVIEW]"), status: "error", needHelpTags: ["review"] },
      { index: output.indexOf("[AHELPA:NEED_HELP:input]"), status: "error", needHelpTags: ["input"] },
    ];

    expect(scanSentinels(output)).toEqual(expected);
    expect(scanSentinels("nothing here")).toEqual([]);
    expect(scanSentinels(output)).toEqual(expected);
  });

  test.each([
    { output: "", status: "running", needHelpTags: null },
    { output: SENTINEL.Done, status: "idle", needHelpTags: null },
    { output: `${SENTINEL.Done}\n[AHELPA:NEED_HELP:review]`, status: "error", needHelpTags: ["review"] },
    { output: `[AHELPA:NEED_HELP:review]\n${SENTINEL.Done}`, status: "error", needHelpTags: ["review"] },
    {
      output: `[AHELPA:NEED_HELP:review]\n[AHELPA:NEED_HELP:input]\n${SENTINEL.Done}`,
      status: "error",
      needHelpTags: ["input"],
    },
    {
      output: `[AHELPA:NEED_HELP:review]\n${SENTINEL.Done}\n${SENTINEL.NeedHelp}`,
      status: "error",
      needHelpTags: [],
    },
    {
      output: `[AHELPA:NEED_HELP:review]\n[AHELPA:NEED_HELP:!!!]\n${SENTINEL.Done}`,
      status: "error",
      needHelpTags: [],
    },
  ])("shared outcome chooses HELP over DONE and the last HELP payload ($output)", ({ output, status, needHelpTags }) => {
    expect(detectSentinelOutcome(output)).toEqual({
      status,
      needHelpTags: needHelpTags === null ? null : [...needHelpTags],
    });
    expect(detectSentinelStatus(output)).toBe(status);
  });
});
