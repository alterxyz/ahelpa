import { describe, expect, test } from "bun:test";
import {
  buildSkillsCliArgs,
  DEFAULT_SKILL_AGENTS,
  DEFAULT_SKILL_SOURCE,
  installSkill,
} from "../src/commands/install-skill";

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
});
