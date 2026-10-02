import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

describe("tmux existence errors", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync("/tmp/ahelpa-tmux-errors-");
    const executable = join(root, "tmux");
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$AHELPA_TEST_TMUX_ERROR" >&2\nexit 1\n');
    chmodSync(executable, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function hasSession(error: string): Promise<string> {
    // Isolate PATH in a subprocess so the real tmux integration tests and
    // other imports of Bun's shell never see this synthetic executable.
    const modulePath = join(import.meta.dir, "../src/tmux.ts");
    const proc = Bun.spawn([process.execPath, "-e", `
      import { Tmux } from ${JSON.stringify(modulePath)};
      try {
        console.log(await Tmux.hasSession("synthetic-session"));
      } catch {
        console.log("rejected");
      }
    `], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, AHELPA_TEST_TMUX_ERROR: error },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return output.trim();
  }

  test.each([
    "can't find session: synthetic-session",
    "no server running on /tmp/synthetic.sock",
    "error connecting to /tmp/synthetic.sock (No such file or directory)",
    "no sessions",
  ])("returns false for a missing terminal: %s", async (error) => {
    expect(await hasSession(error)).toBe("false");
  });

  test.each([
    "error connecting to /tmp/synthetic.sock (Permission denied)",
    "lost server",
    "temporary transport failure",
  ])("propagates an inconclusive terminal check: %s", async (error) => {
    expect(await hasSession(error)).toBe("rejected");
  });
});
