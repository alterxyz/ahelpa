import { describe, test, expect } from "bun:test";
import { parseCliArgs } from "../src/cli-args";

describe("cli arg parsing", () => {
  test("keeps flag values out of positional arguments", () => {
    const parsed = parseCliArgs(["codex-123", "--timeout", "120000"]);

    expect(parsed.positionals).toEqual(["codex-123"]);
    expect(parsed.flags.timeout).toBe("120000");
  });

  test("supports boolean flags without consuming the next positional", () => {
    const parsed = parseCliArgs(["id-1", "id-2", "--all"]);

    expect(parsed.positionals).toEqual(["id-1", "id-2"]);
    expect(parsed.flags.all).toBe("true");
  });

  test("treats an empty string as the flag value, not as a positional", () => {
    const parsed = parseCliArgs(["codex", "--model", "", "--task", "x"]);

    expect(parsed.flags.model).toBe("");
    expect(parsed.flags.task).toBe("x");
    expect(parsed.positionals).toEqual(["codex"]);
  });

  test("supports --flag=value syntax", () => {
    const parsed = parseCliArgs(["codex", "--model=gpt-5.5", "--effort=xhigh"]);

    expect(parsed.flags.model).toBe("gpt-5.5");
    expect(parsed.flags.effort).toBe("xhigh");
    expect(parsed.positionals).toEqual(["codex"]);
  });
});
