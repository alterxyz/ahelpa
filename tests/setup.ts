import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const needsStateRoot = !process.env.AHELPA_HOME?.trim();
const needsRuntimeRoot = !process.env.AHELPA_TMP_DIR?.trim();
const testRoot = needsStateRoot || needsRuntimeRoot
  ? mkdtempSync(join(tmpdir(), "ahelpa-tests-"))
  : null;

if (needsStateRoot) process.env.AHELPA_HOME = join(testRoot!, "state");
if (needsRuntimeRoot) process.env.AHELPA_TMP_DIR = join(testRoot!, "runtime");

afterAll(() => {
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
});
