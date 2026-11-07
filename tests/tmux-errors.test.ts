import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("tmux existence errors", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-tmux-errors-"));
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

  async function liveSessionNames(error?: string, names = ""): Promise<unknown> {
    if (error === undefined) {
      writeFileSync(join(root, "tmux"), `#!/bin/sh
[ "$#" = 3 ] && [ "$1" = list-sessions ] && [ "$2" = -F ] && [ "$3" = '#{session_name}' ] || exit 2
printf '%s' "$AHELPA_TEST_TMUX_NAMES"
`);
    }
    const modulePath = join(import.meta.dir, "../src/tmux.ts");
    const proc = Bun.spawn([process.execPath, "-e", `
      import { Tmux } from ${JSON.stringify(modulePath)};
      // Keep a missing API outside the expected tmux-command error path.
      if (typeof Tmux.liveSessionNames !== "function") throw new Error("missing snapshot API");
      try {
        const names = await Tmux.liveSessionNames();
        console.log(JSON.stringify({ isSet: names instanceof Set, names: [...names] }));
      } catch {
        console.log(JSON.stringify("rejected"));
      }
    `], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`,
        AHELPA_TEST_TMUX_ERROR: error ?? "", AHELPA_TEST_TMUX_NAMES: names },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return JSON.parse(output);
  }

  test("snapshot returns exact unique names from list-sessions", async () => {
    expect(await liveSessionNames(undefined, "alpha\n leading space\nbeta\nalpha\n"))
      .toEqual({ isSet: true, names: ["alpha", " leading space", "beta"] });
  });

  test("snapshot accepts successful empty output", async () => {
    expect(await liveSessionNames()).toEqual({ isSet: true, names: [] });
  });

  test.each([
    "can't find session: synthetic-session",
    "no server running on /tmp/synthetic.sock",
    "error connecting to /tmp/synthetic.sock (No such file or directory)",
    "no sessions",
  ])("snapshot returns an empty set for a missing server/session: %s", async (error) => {
    expect(await liveSessionNames(error)).toEqual({ isSet: true, names: [] });
  });

  test.each([
    "error connecting to /tmp/synthetic.sock (Permission denied)",
    "lost server",
    "temporary transport failure",
  ])("snapshot propagates inconclusive failures: %s", async (error) => {
    expect(await liveSessionNames(error)).toBe("rejected");
  });
});
