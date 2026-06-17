import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getDaemonLaunchCommand, DAEMON_SUBCOMMAND, spawnDetached } from "../src/daemon";

describe("daemon launch command", () => {
  test("uses bun plus cli.ts when source files are present", () => {
    const root = mkdtempSync(join(tmpdir(), "ahelpa-daemon-launch-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "cli.ts"), "console.log('stub');");

    const command = getDaemonLaunchCommand(["bun", "src/cli.ts"], "/opt/homebrew/bin/bun", root);

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

    const command = getDaemonLaunchCommand(
      [installedBinary],
      installedBinary,
      root,
    );

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

    const command = getDaemonLaunchCommand(
      ["bun", binary, "daemon", "start"],
      binary,
      root,
    );

    expect(command).toEqual([binary, DAEMON_SUBCOMMAND]);

    rmSync(root, { recursive: true, force: true });
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
