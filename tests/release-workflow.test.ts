import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
const step = workflow.match(/      - name: publish verified draft release\n        run: \|\n((?:          [^\n]*(?:\n|$))+)/)?.[1];
if (!step) throw new Error("Release publishing step not found in workflow");
const publishScript = step.replace(/^          /gm, "");

describe("release workflow publication", () => {
  let root: string;
  let fakeBin: string;

  beforeEach(() => {
    root = mkdtempSync("/tmp/ahelpa-release-workflow-");
    fakeBin = join(root, "bin");
    mkdirSync(fakeBin);
    mkdirSync(join(root, "assets"));
    for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      writeFileSync(join(root, "assets", `ahelpa-${platform}.tar.gz`), "synthetic release asset");
    }
    writeFileSync(join(root, "assets", "SHASUMS256.txt"), "synthetic checksum manifest");
    writeFileSync(join(fakeBin, "gh"), `#!/usr/bin/env bun
import { appendFileSync } from "fs";
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_TEST_LOG!, JSON.stringify(args) + "\\n");
const scenario = process.env.RELEASE_TEST_SCENARIO;
if (args[0] !== "release") process.exit(99);
switch (args[1]) {
  case "view":
    if (scenario === "missing") process.exit(1);
    console.log(scenario === "published" ? "false" : "true");
    break;
  case "create":
    if (scenario !== "missing" || !args.includes("--draft")) process.exit(98);
    break;
  case "upload":
    if (scenario === "upload-failure") process.exit(23);
    break;
  case "edit":
    break;
  default: process.exit(97);
}
`, { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function run(scenario: string) {
    const log = join(root, "gh-calls.jsonl");
    const proc = Bun.spawn(["bash", "-euo", "pipefail", "-c", publishScript], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "",
        GH_REPO: "example/ahelpa",
        RELEASE_TAG: "v9.8.7",
        RELEASE_TEST_SCENARIO: scenario,
        RELEASE_TEST_LOG: log,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    return { exitCode, stdout, stderr, calls };
  }

  test("creates an absent release as a draft and publishes only after uploading all assets", async () => {
    const result = await run("missing");

    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call[1])).toEqual(["view", "create", "upload", "edit"]);
    expect(result.calls[1]).toEqual([
      "release", "create", "v9.8.7", "--verify-tag", "--draft", "--title", "v9.8.7", "--generate-notes",
    ]);
    expect(result.calls[2]).toEqual([
      "release", "upload", "v9.8.7", "assets/ahelpa-darwin-arm64.tar.gz", "assets/ahelpa-darwin-x64.tar.gz",
      "assets/ahelpa-linux-arm64.tar.gz", "assets/ahelpa-linux-x64.tar.gz", "assets/SHASUMS256.txt", "--clobber",
    ]);
    expect(result.calls[3]).toEqual(["release", "edit", "v9.8.7", "--draft=false"]);
  });

  test("continues an existing draft without creating another release", async () => {
    const result = await run("draft");

    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call[1])).toEqual(["view", "upload", "edit"]);
  });

  test("refuses an already published release before uploading or changing it", async () => {
    const result = await run("published");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already published; refusing to overwrite its assets");
    expect(result.calls).toEqual([["release", "view", "v9.8.7", "--json", "isDraft", "--jq", ".isDraft"]]);
  });

  test("leaves the release unpublished when asset upload fails", async () => {
    const result = await run("upload-failure");

    expect(result.exitCode).toBe(23);
    expect(result.calls.map((call) => call[1])).toEqual(["view", "upload"]);
  });
});
