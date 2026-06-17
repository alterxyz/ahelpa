import { $ } from "bun";
import { mkdirSync, readdirSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { packageSkill } from "./skill-package";

function cleanupBunBuildArtifacts(repoRoot: string): void {
  for (const entry of readdirSync(repoRoot)) {
    if (entry.startsWith(".") && entry.endsWith(".bun-build")) {
      rmSync(resolve(repoRoot, entry), { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const distDir = resolve(repoRoot, "dist");
  const skillDir = resolve(repoRoot, "skill");
  const runtimeBundlePath = resolve(skillDir, "bundle", "ahelpa-darwin-arm64.tar.gz");

  mkdirSync(distDir, { recursive: true });
  mkdirSync(dirname(runtimeBundlePath), { recursive: true });

  await $`bun build src/cli.ts --compile --outfile=dist/ahelpa`.cwd(repoRoot);
  cleanupBunBuildArtifacts(repoRoot);
  await $`tar czf ${runtimeBundlePath} -C dist ahelpa`.cwd(repoRoot).quiet();

  const archivePath = await packageSkill(skillDir, distDir);
  console.log(archivePath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
