import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { daemonSpawnOptions, getDaemonLaunchCommand, DAEMON_SUBCOMMAND, spawnDetached } from "../src/daemon";
import { RuntimeLayout } from "../src/runtime-layout";

describe("daemon launch command", () => {
  test("uses bun plus cli.ts when source files are present", () => {
    const root = mkdtempSync(join(tmpdir(), "ahelpa-daemon-launch-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "cli.ts"), "console.log('stub');");

    const command = getDaemonLaunchCommand("/opt/homebrew/bin/bun", root);

    expect(command).toEqual([
      "/opt/homebrew/bin/bun",
      join(root, "cli.ts"),
      DAEMON_SUBCOMMAND,
    ]);

    rmSync(root, { recursive: true, force: true });
  });

  test("restarts the compiled binary directly when source files are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "ahelpa-daemon-launch-"));
    const installedBinary = join(tmpdir(), ".ahelpa", "bin", "ahelpa");

    const command = getDaemonLaunchCommand(installedBinary, root);

    expect(command).toEqual([
      installedBinary,
      DAEMON_SUBCOMMAND,
    ]);

    rmSync(root, { recursive: true, force: true });
  });

  test("does not duplicate the binary path for a real compiled-binary argv", () => {
    // A bun compiled binary's process.argv is [bunInternal, binaryPath, ...args]
    // — argv[1] is the binary path itself (and it exists on disk). The launch
    // command must re-invoke the binary ONCE via execPath, never also pass
    // argv[1]; doing so produced the broken `ahelpa <binpath> __daemon` that
    // exited as "Unknown command" and left the daemon stopped (macOS + Linux).
    const root = mkdtempSync(join(tmpdir(), "ahelpa-daemon-launch-"));
    const binary = join(root, "ahelpa");
    writeFileSync(binary, "#!/bin/sh\n"); // argv[1] must exist to reproduce the bug

    const command = getDaemonLaunchCommand(binary, root);

    expect(command).toEqual([binary, DAEMON_SUBCOMMAND]);

    rmSync(root, { recursive: true, force: true });
  });

  test("a started daemon runs in its home with its starter's roots, even ones set after Bun started", async () => {
    // tests/setup.ts sets AHELPA_HOME after startup, like this test does.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ahelpa-daemon-env-")));
    try {
      process.env.AHELPA_DAEMON_ENV_PROBE = "late";
      const layout = new RuntimeLayout({ ahelpaDir: join(root, "home"), tmpDir: join(root, "tmp") });
      mkdirSync(layout.ahelpaHomeDir());
      const out = join(root, "out");
      spawnDetached(["/bin/sh", "-c", `printf '%s|%s|%s|%s' "$PWD" "$AHELPA_HOME" "$AHELPA_TMP_DIR" "$AHELPA_DAEMON_ENV_PROBE" > '${out}'`],
        undefined, daemonSpawnOptions(layout));
      for (let i = 0; i < 100 && !existsSync(out); i++) await Bun.sleep(50);
      await Bun.sleep(50);
      expect(readFileSync(out, "utf8")).toBe(`${layout.ahelpaHomeDir()}|${layout.ahelpaHomeDir()}|${layout.tmpDir}|late`);
    } finally {
      delete process.env.AHELPA_DAEMON_ENV_PROBE;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("spawnDetached leaves the child process running", async () => {
    const pid = await spawnDetached(["/bin/sh", "-c", "sleep 5"]);

    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore cleanup races
    }
  });
});
