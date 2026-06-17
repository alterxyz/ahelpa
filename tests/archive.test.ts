import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Archive } from "../src/archive";
import { rmSync, existsSync, readFileSync } from "fs";

const TEST_ARCHIVE = "/tmp/ahelpa-test-archive";

describe("Archive", () => {
  let archive: Archive;

  beforeEach(() => {
    archive = new Archive(TEST_ARCHIVE);
  });

  afterEach(() => {
    rmSync(TEST_ARCHIVE, { recursive: true, force: true });
  });

  test("saves a settled session", () => {
    archive.save("session-abc", { status: "idle", lastOutput: "[AHELPA:DONE]" });
    const path = `${TEST_ARCHIVE}/session-abc/message.json`;
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf-8"));
    expect(data.status).toBe("idle");
    expect(data.archivedAt).toBeDefined();
  });

  test("retrieves a saved session", () => {
    archive.save("session-abc", { status: "dead", reason: "tmux session gone" });
    const result = archive.get("session-abc");
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("tmux session gone");
  });

  test("returns null for missing session", () => {
    const result = archive.get("nonexistent");
    expect(result).toBeNull();
  });
});
