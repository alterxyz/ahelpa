import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { packageSkill, parseSkillName } from "../scripts/skill-package";

describe("skill packaging", () => {
  test("parses the skill name from frontmatter", () => {
    const skillMd = `---
name: ahelpa
description: test
---
`;

    expect(parseSkillName(skillMd)).toBe("ahelpa");
  });

  test("packages the skill as <name>.skill with a renamed archive root", async () => {
    const root = mkdtempSync(join(tmpdir(), "ahelpa-skill-package-test-"));
    const skillDir = join(root, "skill");
    const outDir = join(root, "dist");

    mkdirSync(join(skillDir, "bundle"), { recursive: true });
    mkdirSync(join(skillDir, "references"), { recursive: true });

    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: ahelpa
description: test skill
---
`,
    );
    writeFileSync(join(skillDir, "bundle", "ahelpa-darwin-arm64.tar.gz"), "bundle");
    writeFileSync(join(skillDir, "references", "claude-code.md"), "reference");
    writeFileSync(join(skillDir, "references", "kimi.md"), "reference");
    writeFileSync(join(skillDir, ".DS_Store"), "ignore me");

    const archivePath = await packageSkill(skillDir, outDir);
    const listing = await $`python3 -c ${`import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print("\\n".join(z.namelist()))`} ${archivePath}`.text();

    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(archivePath).length).toBeGreaterThan(0);
    expect(archivePath.endsWith("ahelpa.skill")).toBe(true);
    expect(listing).toContain("ahelpa/SKILL.md");
    expect(listing).toContain("ahelpa/bundle/ahelpa-darwin-arm64.tar.gz");
    expect(listing).toContain("ahelpa/references/claude-code.md");
    expect(listing).toContain("ahelpa/references/kimi.md");
    expect(listing).not.toContain("skill/SKILL.md");
    expect(listing).not.toContain("ahelpa/.DS_Store");

    rmSync(root, { recursive: true, force: true });
  });
});
