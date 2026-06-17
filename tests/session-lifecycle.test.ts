import { describe, expect, test } from "bun:test";
import { getDriver } from "../src/drivers/registry";
import { SESSION_STATUS, statusFromCapture } from "../src/session-lifecycle";

describe("session lifecycle", () => {
  test("maps driver capture output to session status", () => {
    const driver = getDriver("claude-code");

    expect(statusFromCapture("still working", driver)).toBe(SESSION_STATUS.Running);
    expect(statusFromCapture("[AHELPA:DONE]", driver)).toBe(SESSION_STATUS.Idle);
    expect(statusFromCapture("[AHELPA:NEED_HELP]", driver)).toBe(SESSION_STATUS.Error);
  });

  test("error takes precedence over idle when both sentinels appear", () => {
    const driver = getDriver("claude-code");

    expect(statusFromCapture("[AHELPA:DONE]\n[AHELPA:NEED_HELP]", driver)).toBe(SESSION_STATUS.Error);
  });
});
