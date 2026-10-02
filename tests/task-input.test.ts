import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { readTaskFile } from "../src/task-input";

describe("task file input", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync("/tmp/ahelpa-task-input-");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("snapshots a regular file without trimming or interpreting its content", () => {
    const path = join(root, "task.md");
    const content = "  Review `literal code`.\n\nKeep $(shell text) and 中文.\n";
    writeFileSync(path, content);

    const task = readTaskFile(path);
    writeFileSync(path, "later changes");

    expect(task).toBe(content);
  });

  test.each(["", " \n\t"])("rejects empty or whitespace-only files: %j", (content) => {
    const path = join(root, "empty.md");
    writeFileSync(path, content);

    expect(() => readTaskFile(path)).toThrow("Task must not be empty");
  });

  test("rejects directories and missing files", () => {
    expect(() => readTaskFile(root)).toThrow("must point to a regular file");
    expect(() => readTaskFile(join(root, "missing.md"))).toThrow("ENOENT");
  });

  test.each([false, true])("rejects an unwritten FIFO without blocking (symlink: %s)", async (throughLink) => {
    const fifo = join(root, "task.pipe");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const input = throughLink ? join(root, "task-link") : fifo;
    if (throughLink) symlinkSync(fifo, input);
    const modulePath = join(import.meta.dir, "../src/task-input.ts");
    // A subprocess keeps this regression bounded even if a blocking open is
    // accidentally reintroduced; the fixture never attaches a FIFO writer.
    const child = Bun.spawn([process.execPath, "-e", `
      import { readTaskFile } from ${JSON.stringify(modulePath)};
      try { readTaskFile(${JSON.stringify(input)}); process.exit(2); }
      catch (error) { console.log(error.message); }
    `], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 2000);
    try {
      const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(output).toContain("must point to a regular file");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });
});
