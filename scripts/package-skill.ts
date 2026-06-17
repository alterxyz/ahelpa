import { $ } from "bun";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { packageSkill } from "./skill-package";

function cleanupBunBuildArtifacts(repoRoot: string): void {
  for (const entry of readdirSync(repoRoot)) {
    if (entry.startsWith(".") && entry.endsWith(".bun-build")) {
      rmSync(resolve(repoRoot, entry), { recursive: true, force: true });
    }
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeChecksums(distDir: string, paths: string[]): void {
  const lines = paths.map((path) => `${sha256File(path)}  ${basename(path)}`);
  writeFileSync(resolve(distDir, "SHASUMS256.txt"), `${lines.join("\n")}\n`);
}

// Tag for the host platform, matching the asset names install.sh resolves
// (darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64). The runtime is
// platform-agnostic Bun; each platform's `bun build --compile` emits its own
// native binary, so the bundle is named after wherever it was built.
function currentPlatformTag(): string {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform;
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  return `${os}-${arch}`;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const distDir = resolve(repoRoot, "dist");
  const skillDir = resolve(repoRoot, "skill");
  const runtimeBundlePath = resolve(
    skillDir,
    "bundle",
    `ahelpa-${currentPlatformTag()}.tar.gz`,
  );

  mkdirSync(distDir, { recursive: true });
  mkdirSync(dirname(runtimeBundlePath), { recursive: true });

  await $`bun build src/cli.ts --compile --outfile=dist/ahelpa`.cwd(repoRoot);
  cleanupBunBuildArtifacts(repoRoot);
  await $`tar czf ${runtimeBundlePath} -C dist ahelpa`.cwd(repoRoot).quiet();

  const archivePath = await packageSkill(skillDir, distDir);
  writeChecksums(distDir, [runtimeBundlePath, archivePath]);
  console.log(archivePath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
