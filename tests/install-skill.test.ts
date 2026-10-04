import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  buildSkillsCliArgs,
  DEFAULT_SKILL_AGENTS,
  DEFAULT_SKILL_SOURCE,
  installSkill,
} from "../src/commands/install-skill";

const prerequisiteRoots: string[] = [];

afterEach(() => {
  for (const root of prerequisiteRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runPrerequisiteFixture(scenario: string, version = "v22.20.0") {
  const root = mkdtempSync(join(tmpdir(), "ahelpa-skill-prerequisites-"));
  prerequisiteRoots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (scenario !== "missing-node") {
    writeFileSync(join(bin, "node"), `#!/bin/sh
[ "$1" = "--version" ] || exit 99
[ "$SKILL_TEST_SCENARIO" != "node-failure" ] || exit 31
printf '%s\\n' "$SKILL_TEST_NODE_VERSION"
`, { mode: 0o755 });
  }
  if (scenario !== "missing-npx") {
    writeFileSync(join(bin, "npx"), `#!/bin/sh
printf '%s\\n' "$*" >> "$SKILL_TEST_CALLS"
if [ "$1" = "--version" ]; then
  [ "$SKILL_TEST_SCENARIO" != "npx-failure" ] || exit 32
  printf '10.9.0\\n'
else
  [ "$SKILL_TEST_SCENARIO" != "install-failure" ] || exit 17
fi
`, { mode: 0o755 });
  }
  const logPath = join(root, "npx-calls.txt");
  const modulePath = resolve(import.meta.dir, "../src/commands/install-skill.ts");
  const proc = Bun.spawn([process.execPath, "-e", `
    import { installSkill } from ${JSON.stringify(modulePath)};
    try { await installSkill({ source: "./synthetic-skill" }); }
    catch (error) { console.error(error.message); process.exit(1); }
  `], {
    env: {
      ...process.env,
      PATH: bin,
      SKILL_TEST_SCENARIO: scenario,
      SKILL_TEST_NODE_VERSION: version,
      SKILL_TEST_CALLS: logPath,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  const calls = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : [];
  return { exitCode, stderr, calls };
}

describe("install-skill", () => {
  test("builds a global hard-copy install through the skills CLI", () => {
    expect(buildSkillsCliArgs()).toEqual([
      "--yes",
      "skills@latest",
      "add",
      DEFAULT_SKILL_SOURCE,
      "--skill",
      "ahelpa",
      "--global",
      "--copy",
      "--yes",
      "--agent",
      "codex",
      "--agent",
      "claude-code",
      "--agent",
      "kimi-code-cli",
    ]);
  });

  test("allows a local or fork source while keeping install policy fixed", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    const result = await installSkill({
      source: "./skill",
      runner: {
        async run(command, args) {
          calls.push({ command, args });
          return 0;
        },
      },
    });

    expect(calls).toEqual([{ command: "npx", args: buildSkillsCliArgs("./skill") }]);
    expect(result).toEqual({
      source: "./skill",
      agents: DEFAULT_SKILL_AGENTS,
      scope: "global",
      mode: "copy",
    });
  });

  test("surfaces skills CLI failures", async () => {
    await expect(
      installSkill({
        runner: {
          async run() {
            return 17;
          },
        },
      }),
    ).rejects.toThrow("npx skills failed with exit code 17");
  });

  test.each(["v22.20.0", "v22.20.1", "v24.0.0"])("checks prerequisites before installing with Node %s", async (version) => {
    const result = await runPrerequisiteFixture("success", version);
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual(["--version", buildSkillsCliArgs("./synthetic-skill").join(" ")]);
  });

  test.each(["v20.20.0", "v22.19.9"])("rejects unsupported Node %s before invoking npx", async (version) => {
    const result = await runPrerequisiteFixture("success", version);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Node.js >=22.20.0 is required for skills installation; found ${version}`);
    expect(result.calls).toEqual([]);
  });

  test.each([
    ["missing-node", "Node.js >=22.20.0 is required", false],
    ["node-failure", "Could not run node --version", false],
    ["missing-npx", "npx is required for skills installation", false],
    ["npx-failure", "Could not run npx --version", true],
  ])("reports %s without starting skill installation", async (scenario, message, npxInvoked) => {
    const result = await runPrerequisiteFixture(scenario);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.calls).toEqual(npxInvoked ? ["--version"] : []);
  });

  test("still reports skills process errors after successful prerequisites", async () => {
    const result = await runPrerequisiteFixture("install-failure");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("npx skills failed with exit code 17");
    expect(result.calls).toHaveLength(2);
  });
});
