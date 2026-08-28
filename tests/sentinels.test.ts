import { describe, expect, test } from "bun:test";
import {
  SENTINEL,
  hasDoneSentinel,
  hasNeedHelpSentinel,
  hasInlineSentinel,
} from "../src/drivers/sentinels";

describe("sentinel protocol", () => {
  test("standalone matching ignores sentinels embedded in instructions", () => {
    const output = [
      `Please output ${SENTINEL.Done} when finished.`,
      `If you are stuck, output ${SENTINEL.NeedHelp}.`,
    ].join("\n");

    expect(hasDoneSentinel(output)).toBe(false);
    expect(hasNeedHelpSentinel(output)).toBe(false);
  });

  test("standalone matching accepts sentinels on their own line, with agent bullets", () => {
    expect(hasDoneSentinel(`work done\n${SENTINEL.Done}\n`)).toBe(true);
    expect(hasDoneSentinel(`work done\n⏺ ${SENTINEL.Done}`)).toBe(true);
    expect(hasDoneSentinel(`work done\n● ${SENTINEL.Done}`)).toBe(true);
    expect(hasNeedHelpSentinel(`oops\n${SENTINEL.NeedHelp}\n`)).toBe(true);
  });

  test("inline matching is loose containment", () => {
    expect(hasInlineSentinel(`mid-line ${SENTINEL.Done} text`)).toBe(true);
    expect(hasInlineSentinel("no sentinel here")).toBe(false);
  });
});
