import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Archive } from "../src/archive";
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TEST_ARCHIVE: string;
let scratch: string;

describe("Archive", () => {
  let archive: Archive;

  beforeEach(() => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-archive-"));
    TEST_ARCHIVE = join(scratch, "archive");
    archive = new Archive(TEST_ARCHIVE);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
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
