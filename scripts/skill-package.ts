import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join, relative, resolve, sep } from "path";

const EXCLUDED_DIRS = new Set(["__pycache__", "node_modules"]);
const EXCLUDED_FILES = new Set([".DS_Store"]);
const ROOT_EXCLUDED_DIRS = new Set(["evals"]);

export function parseSkillName(skillMd: string): string | null {
  const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;

  const line = frontmatter[1]
    .split("\n")
    .find((entry) => entry.trimStart().startsWith("name:"));

  if (!line) return null;

  const name = line.split(":").slice(1).join(":").trim();
  return name || null;
}

export function getSkillPackageBaseName(skillDir: string): string {
  const skillMdPath = join(resolve(skillDir), "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error(`SKILL.md not found in ${resolve(skillDir)}`);
  }

  const parsed = parseSkillName(readFileSync(skillMdPath, "utf-8"));
  return parsed ?? basename(resolve(skillDir));
}

function shouldInclude(sourcePath: string, skillDir: string): boolean {
  const relPath = relative(skillDir, sourcePath);
  if (!relPath) return true;

  const parts = relPath.split(sep);
  const fileName = parts[parts.length - 1];

  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return false;
  if (parts.length > 0 && ROOT_EXCLUDED_DIRS.has(parts[0])) return false;
  if (EXCLUDED_FILES.has(fileName)) return false;
  if (fileName.endsWith(".pyc")) return false;

  return true;
}

export async function packageSkill(skillDir: string, outputDir: string): Promise<string> {
  const skillDirPath = resolve(skillDir);
  const outputDirPath = resolve(outputDir);
  const skillBaseName = getSkillPackageBaseName(skillDirPath);
  const archivePath = join(outputDirPath, `${skillBaseName}.skill`);
  const stagingParent = mkdtempSync(join(tmpdir(), "ahelpa-skill-stage-"));
  const stagingSkillDir = join(stagingParent, skillBaseName);

  mkdirSync(outputDirPath, { recursive: true });
  rmSync(archivePath, { force: true });

  try {
    cpSync(skillDirPath, stagingSkillDir, {
      recursive: true,
      filter: (source) => shouldInclude(source, skillDirPath),
    });

    await $`python3 -c ${`
import pathlib
import sys
import zipfile

archive_path = pathlib.Path(sys.argv[1])
skill_dir = pathlib.Path(sys.argv[2])
root_name = pathlib.Path(sys.argv[3])

with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zipf:
    for path in sorted(skill_dir.rglob("*")):
        zipf.write(path, root_name / path.relative_to(skill_dir))
`} ${archivePath} ${stagingSkillDir} ${skillBaseName}`.quiet();
    return archivePath;
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}
