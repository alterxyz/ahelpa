import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

test("bun test streams progress even when Bun detects an AI agent", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ahelpa-progress-"));
  try {
    const probe = join(root, "probe.test.ts");
    writeFileSync(probe, 'import { test } from "bun:test";\ntest("probe", () => {});\n');
    // Run from the checkout so its bunfig.toml applies; AGENT=1 forces Bun's agent mode.
    const result = Bun.spawnSync([process.execPath, "test", probe], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, AGENT: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString() + result.stderr.toString()).toMatch(/^\.$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
