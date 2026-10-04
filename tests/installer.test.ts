import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const installer = resolve(import.meta.dir, "../scripts/install.sh");
const bash = Bun.which("bash")!;
const roots: string[] = [];
const releaseBase = "https://github.com/example/ahelpa/releases/download/v9.8.7";
const oldRuntime = "previous working runtime\n";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type FixtureOptions = {
  scenario?: string;
  os?: string;
  arch?: string;
  fresh?: boolean;
};

function createFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahelpa-installer test-"));
  roots.push(root);
  const fakeBin = join(root, "fake-bin");
  const installDir = join(root, "install");
  const packageDir = join(root, "package");
  for (const path of [fakeBin, installDir, packageDir]) mkdirSync(path);
  if (!options.fresh) {
    writeFileSync(join(installDir, "ahelpa"), oldRuntime, { mode: 0o755 });
    // Replacing the destination atomically must leave its old inode unchanged.
    linkSync(join(installDir, "ahelpa"), join(root, "old-inode"));
  }
  const scenario = options.scenario ?? "success";
  if (scenario !== "missing-node") {
    writeFileSync(join(fakeBin, "node"), `#!/bin/sh
[ "$1" = "--version" ] || exit 99
[ "$INSTALLER_TEST_SCENARIO" != "node-failure" ] || exit 31
printf '%s\\n' "$INSTALLER_TEST_NODE_VERSION"
`, { mode: 0o755 });
  }
  if (scenario !== "missing-npx") {
    writeFileSync(join(fakeBin, "npx"), `#!/bin/sh
[ "$1" = "--version" ] || exit 99
[ "$INSTALLER_TEST_SCENARIO" != "npx-failure" ] || exit 32
printf '10.9.0\\n'
`, { mode: 0o755 });
  }
  const os = options.os ?? "Linux";
  const arch = options.arch ?? "x86_64";
  const platform = `${os === "Darwin" ? "darwin" : "linux"}-${["arm64", "aarch64"].includes(arch) ? "arm64" : "x64"}`;
  const asset = `ahelpa-${platform}.tar.gz`;
  const archivePath = join(root, "archive.tar.gz");
  const binarySource = `#!/usr/bin/env bun
import { appendFileSync } from "fs";
import { join } from "path";
const args = process.argv.slice(2);
appendFileSync(join(process.env.INSTALLER_TEST_ROOT!, "runtime-calls.jsonl"), JSON.stringify({
  args, home: process.env.AHELPA_HOME, runtime: process.env.AHELPA_TMP_DIR,
}) + "\\n");
if (args[0] === "version") {
  if (process.env.INSTALLER_TEST_SCENARIO === "execution-failure") process.exit(17);
  console.log(process.env.INSTALLER_TEST_SCENARIO === "wrong-version" ? "ahelpa 1.0.0" : "ahelpa 9.8.7");
} else if (args[0] === "install-skill") {
  if (process.env.INSTALLER_TEST_SCENARIO === "skill-failure") process.exit(19);
} else process.exit(2);
`;
  if (scenario === "symlink") symlinkSync("../outside", join(packageDir, "ahelpa"));
  else if (scenario === "missing-binary") writeFileSync(join(packageDir, "README"), "not a runtime");
  else writeFileSync(join(packageDir, "ahelpa"), binarySource, { mode: 0o755 });
  if (scenario === "extra-member") writeFileSync(join(packageDir, "unexpected"), "extra");
  const tar = Bun.spawnSync(["tar", "czf", archivePath, "-C", packageDir, ...readdirSync(packageDir)]);
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  if (scenario === "corrupt-archive") writeFileSync(archivePath, "not gzip or tar");
  const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  const manifestDigest = scenario === "checksum-mismatch" ? "0".repeat(64) : digest;
  const checksumEntry = `${manifestDigest}  ${asset}\n`;
  writeFileSync(join(root, "checksums.txt"), scenario === "missing-checksum" ? `${digest}  other.tar.gz\n`
    : scenario === "duplicate-checksum" ? checksumEntry + checksumEntry : checksumEntry);
  writeFileSync(join(fakeBin, "curl"), `#!/usr/bin/env bun
import { appendFileSync, copyFileSync } from "fs";
import { join } from "path";
const root = process.env.INSTALLER_TEST_ROOT!;
const args = process.argv.slice(2);
const url = args.find((arg) => arg.startsWith("https://"));
appendFileSync(join(root, "curl-calls.jsonl"), JSON.stringify(url) + "\\n");
if (url === "https://github.com/example/ahelpa/releases/latest") {
  process.stdout.write(process.env.INSTALLER_TEST_SCENARIO === "bad-latest"
    ? "https://github.com/example/ahelpa/releases" : "https://github.com/example/ahelpa/releases/tag/v9.8.7");
} else {
  const output = args[args.indexOf("-o") + 1];
  if (url === "${releaseBase}/${asset}" || url === "https://mirror.example/runtime.tar.gz") {
    if (process.env.INSTALLER_TEST_SCENARIO === "download-failure") process.exit(22);
    copyFileSync(join(root, "archive.tar.gz"), output);
  } else if (url === "${releaseBase}/SHASUMS256.txt" || url === "https://mirror.example/checksums.txt") {
    copyFileSync(join(root, "checksums.txt"), output);
  } else { console.error("Unexpected fixture URL: " + url); process.exit(23); }
}
`, { mode: 0o755 });
  writeFileSync(join(fakeBin, "uname"), `#!/usr/bin/env bash
case "$1" in
  -s) printf '%s\\n' "$INSTALLER_TEST_OS" ;;
  -m) printf '%s\\n' "$INSTALLER_TEST_ARCH" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  if (scenario === "rename-failure") {
    writeFileSync(join(fakeBin, "mv"), "#!/usr/bin/env bash\nexit 27\n", { mode: 0o755 });
  }
  const readLines = <T>(name: string): T[] => {
    const path = join(root, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  const run = async (overrides: Record<string, string> = {}) => {
    const proc = Bun.spawn([bash, installer], {
      env: {
        ...process.env,
        // Missing-tool fixtures must not discover the host's Node/npm install.
        PATH: ["missing-node", "missing-npx"].includes(scenario) ? fakeBin : `${fakeBin}:${process.env.PATH}`,
        TMPDIR: root,
        INSTALLER_TEST_ROOT: root,
        INSTALLER_TEST_SCENARIO: scenario,
        INSTALLER_TEST_OS: os,
        INSTALLER_TEST_ARCH: arch,
        INSTALLER_TEST_NODE_VERSION: "v22.20.0",
        AHELPA_REPO: "example/ahelpa",
        AHELPA_VERSION: "v9.8.7",
        AHELPA_BIN_DIR: installDir,
        AHELPA_ARCHIVE_URL: "",
        AHELPA_SHA256: "",
        AHELPA_CHECKSUM_URL: "",
        AHELPA_HOME: "/unused-existing-ahelpa-state",
        AHELPA_TMP_DIR: "/unused-existing-ahelpa-runtime",
        ...overrides,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    return {
      exitCode, stdout, stderr,
      curlCalls: readLines<string>("curl-calls.jsonl"),
      runtimeCalls: readLines<{ args: string[]; home: string; runtime: string }>("runtime-calls.jsonl"),
    };
  };
  return { root, installDir, asset, digest, binarySource, run };
}

describe("release installer", () => {
  test.each(["v20.20.0", "v22.19.9"])("rejects unsupported Node %s before any download or replacement", async (version) => {
    const fixture = createFixture();
    const result = await fixture.run({ AHELPA_VERSION: "latest", INSTALLER_TEST_NODE_VERSION: version });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`Node.js >=22.20.0 is required for skills installation; found ${version}`);
    expect(result.curlCalls).toEqual([]);
    expect(result.runtimeCalls).toEqual([]);
    expect(readFileSync(join(fixture.installDir, "ahelpa"), "utf8")).toBe(oldRuntime);
    expect(readdirSync(fixture.installDir)).toEqual(["ahelpa"]);
  });

  test.each([
    ["missing-node", "Node.js >=22.20.0 is required"],
    ["node-failure", "Could not run node --version"],
    ["missing-npx", "npx is required for skills installation"],
    ["npx-failure", "Could not run npx --version"],
  ])("rejects %s before any download or replacement", async (scenario, message) => {
    const fixture = createFixture({ scenario });
    const result = await fixture.run({ AHELPA_VERSION: "latest" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.curlCalls).toEqual([]);
    expect(result.runtimeCalls).toEqual([]);
    expect(readFileSync(join(fixture.installDir, "ahelpa"), "utf8")).toBe(oldRuntime);
    expect(readdirSync(fixture.installDir)).toEqual(["ahelpa"]);
  });

  test("accepts a newer stable Node major version", async () => {
    const fixture = createFixture();
    expect((await fixture.run({ INSTALLER_TEST_NODE_VERSION: "v24.0.0" })).exitCode).toBe(0);
  });

  test.each([
    ["Darwin", "arm64"], ["Darwin", "x86_64"], ["Linux", "x86_64"], ["Linux", "aarch64"],
  ])("installs the verified %s/%s release atomically and backs up the old runtime", async (os, arch) => {
    const fixture = createFixture({ os, arch });
    const result = await fixture.run();
    expect(result.exitCode).toBe(0);
    expect(result.curlCalls).toEqual([`${releaseBase}/${fixture.asset}`, `${releaseBase}/SHASUMS256.txt`]);
    expect(result.runtimeCalls.map((call) => call.args)).toEqual([
      ["version"], ["install-skill", "--source", "https://github.com/example/ahelpa/tree/v9.8.7/skill"], ["version"],
    ]);
    expect(readFileSync(join(fixture.installDir, "ahelpa"), "utf8")).toBe(fixture.binarySource);
    expect(readFileSync(join(fixture.root, "old-inode"), "utf8")).toBe(oldRuntime);
    const backups = readdirSync(fixture.installDir).filter((name) => name.startsWith("ahelpa.backup."));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fixture.installDir, backups[0]), "utf8")).toBe(oldRuntime);
    for (const call of result.runtimeCalls) {
      expect(call.home).toStartWith(fixture.root + "/");
      expect(call.runtime).toBe(join(call.home, "..", "runtime"));
      expect(existsSync(call.home)).toBe(false);
    }
    expect(readdirSync(fixture.installDir).some((name) => name.startsWith(".ahelpa.install."))).toBe(false);
  });

  test("resolves latest once and pins runtime, checksums, and skill to the same tag", async () => {
    const fixture = createFixture({ fresh: true });
    const result = await fixture.run({ AHELPA_VERSION: "latest" });
    expect(result.exitCode).toBe(0);
    expect(result.curlCalls).toEqual([
      "https://github.com/example/ahelpa/releases/latest",
      `${releaseBase}/${fixture.asset}`, `${releaseBase}/SHASUMS256.txt`,
    ]);
    expect(result.runtimeCalls[1].args.at(-1)).toBe("https://github.com/example/ahelpa/tree/v9.8.7/skill");
    expect(readdirSync(fixture.installDir)).toEqual(["ahelpa"]);
  });

  test("supports a custom archive with an explicit digest", async () => {
    const fixture = createFixture();
    const result = await fixture.run({ AHELPA_ARCHIVE_URL: "https://mirror.example/runtime.tar.gz", AHELPA_SHA256: fixture.digest.toUpperCase() });
    expect(result.exitCode).toBe(0);
    expect(result.curlCalls).toEqual(["https://mirror.example/runtime.tar.gz"]);
  });

  test("supports a custom archive and checksum manifest", async () => {
    const fixture = createFixture();
    const result = await fixture.run({
      AHELPA_ARCHIVE_URL: "https://mirror.example/runtime.tar.gz",
      AHELPA_CHECKSUM_URL: "https://mirror.example/checksums.txt",
    });
    expect(result.exitCode).toBe(0);
    expect(result.curlCalls).toEqual(["https://mirror.example/runtime.tar.gz", "https://mirror.example/checksums.txt"]);
  });

  test("rejects custom archives without a checksum before downloading or changing anything", async () => {
    const fixture = createFixture();
    const result = await fixture.run({ AHELPA_ARCHIVE_URL: "https://mirror.example/runtime.tar.gz" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("requires AHELPA_SHA256 or AHELPA_CHECKSUM_URL");
    expect(result.curlCalls).toEqual([]);
    expect(result.runtimeCalls).toEqual([]);
    expect(readFileSync(join(fixture.installDir, "ahelpa"), "utf8")).toBe(oldRuntime);
  });

  test.each([
    "download-failure", "checksum-mismatch", "missing-checksum", "duplicate-checksum",
    "corrupt-archive", "extra-member", "missing-binary", "symlink", "wrong-version", "execution-failure",
  ])("rejects %s without replacing the existing runtime or installing skills", async (scenario) => {
    const fixture = createFixture({ scenario });
    const result = await fixture.run();
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(fixture.installDir, "ahelpa"), "utf8")).toBe(oldRuntime);
    expect(readdirSync(fixture.installDir)).toEqual(["ahelpa"]);
    expect(result.runtimeCalls.some((call) => call.args[0] === "install-skill")).toBe(false);
    if (!["wrong-version", "execution-failure"].includes(scenario)) expect(result.runtimeCalls).toEqual([]);
  });

  test("rejects unresolved latest without downloading a binary", async () => {
    const fixture = createFixture({ scenario: "bad-latest" });
    const result = await fixture.run({ AHELPA_VERSION: "latest" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Could not resolve the latest release tag");
    expect(result.curlCalls).toHaveLength(1);
    expect(result.runtimeCalls).toEqual([]);
  });

  test("keeps the old runtime and removes staged files if atomic replacement fails", async () => {
    const fixture = createFixture({ scenario: "rename-failure" });
    const result = await fixture.run();
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(fixture.installDir, "ahelpa"), "utf8")).toBe(oldRuntime);
    expect(readdirSync(fixture.installDir).some((name) => name.startsWith(".ahelpa.install."))).toBe(false);
    expect(result.runtimeCalls.some((call) => call.args[0] === "install-skill")).toBe(false);
  });

  test("reports skill-install failure while retaining the previous runtime backup", async () => {
    const fixture = createFixture({ scenario: "skill-failure" });
    const result = await fixture.run();
    expect(result.exitCode).toBe(19);
    expect(result.stdout).not.toContain("== installed ==");
    expect(result.stdout).toContain("previous runtime backup >");
    expect(readdirSync(fixture.installDir).filter((name) => name.startsWith("ahelpa.backup."))).toHaveLength(1);
  });
});
