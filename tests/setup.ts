import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Always isolate. A helper launched by ahelpa inherits AHELPA_HOME pointing at
// the real ~/.ahelpa, and a test run there once wrote fake sessions into the
// real archive. Tests never get to use the inherited roots.
const testRoot = mkdtempSync(join(tmpdir(), "ahelpa-tests-"));
process.env.AHELPA_HOME = join(testRoot, "state");
process.env.AHELPA_TMP_DIR = join(testRoot, "runtime");

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});
