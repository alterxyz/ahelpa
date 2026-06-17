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
