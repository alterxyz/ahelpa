import { afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Always isolate. A helper launched by ahelpa inherits AHELPA_HOME pointing at
// the real ~/.ahelpa, and a test run there once wrote fake sessions into the
// real archive. Tests never get to use the inherited roots.
const testRoot = mkdtempSync(join(tmpdir(), "ahelpa-tests-"));
process.env.AHELPA_HOME = join(testRoot, "state");
process.env.AHELPA_TMP_DIR = join(testRoot, "runtime");

afterAll(() => {
  // A test that reaches the real startDaemon leaves a detached daemon polling
  // this root forever. Stop it before the root disappears under it.
  try { process.kill(Number(readFileSync(join(testRoot, "state", "daemon.pid"), "utf8")), "SIGTERM"); } catch {}
  rmSync(testRoot, { recursive: true, force: true });
});
