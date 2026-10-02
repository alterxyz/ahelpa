import { describe, test, expect } from "bun:test";
import { parseCliArgs } from "../src/cli-args";

describe("cli arg parsing", () => {
  test("boolean flags before positionals do not consume session IDs", () => {
    const parsed = parseCliArgs(["--all", "id-1", "id-2"], new Set(["all"]));
    expect(parsed.positionals).toEqual(["id-1", "id-2"]);
    expect(parsed.flags.all).toBe("true");
  });

  test("boolean flags still accept explicit space-separated false", () => {
    const parsed = parseCliArgs(["--all", "false", "id-1"], new Set(["all"]));
    expect(parsed.positionals).toEqual(["id-1"]);
    expect(parsed.flags.all).toBe("false");
  });

  test("double dash preserves flag-like message contents", () => {
    const parsed = parseCliArgs(["id-1", "--token", "tok", "--", "--help"]);
    expect(parsed.positionals).toEqual(["id-1", "--help"]);
    expect(parsed.flags).toEqual({ token: "tok" });
  });

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

  test.each([
    { args: ["--project"] },
    { args: ["--project="] },
    { args: ["--project", ""] },
    { args: ["--project", "--safe"] },
  ])("preserves explicit missing values for contract validation: $args", ({ args }) => {
    const parsed = parseCliArgs([...args], new Set(["safe"]));
    expect(Object.hasOwn(parsed.flags, "project")).toBe(true);
    expect(parsed.flags.project).toBe("");
  });

  test("retains prototype-like flag names for unknown-option rejection", () => {
    const parsed = parseCliArgs(["--__proto__=x", "--constructor=y"], new Set());
    expect(Object.hasOwn(parsed.flags, "__proto__")).toBe(true);
    expect(parsed.flags.__proto__).toBe("x");
    expect(Object.entries(parsed.flags)).toContainEqual(["constructor", "y"]);
  });
});
