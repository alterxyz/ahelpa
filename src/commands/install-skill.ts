export const DEFAULT_SKILL_SOURCE = "alterxyz/ahelpa";
export const AHELPA_SKILL_NAME = "ahelpa";
export const DEFAULT_SKILL_AGENTS = ["codex", "claude-code"] as const;

export interface SkillInstallRunner {
  run(command: string, args: string[]): Promise<number>;
}

export interface InstallSkillInput {
  source?: string;
  runner?: SkillInstallRunner;
}

export interface InstallSkillResult {
  source: string;
  agents: readonly string[];
  scope: "global";
  mode: "copy";
}

export function buildSkillsCliArgs(source: string = DEFAULT_SKILL_SOURCE): string[] {
  const args = [
    "--yes",
    "skills@latest",
    "add",
    source,
    "--skill",
    AHELPA_SKILL_NAME,
    "--global",
    "--copy",
    "--yes",
  ];

  for (const agent of DEFAULT_SKILL_AGENTS) {
    args.push("--agent", agent);
  }

  return args;
}

const defaultRunner: SkillInstallRunner = {
  async run(command, args) {
    const proc = Bun.spawn({
      cmd: [command, ...args],
      stdout: "inherit",
      stderr: "inherit",
    });
    return await proc.exited;
  },
};

export async function installSkill(input: InstallSkillInput = {}): Promise<InstallSkillResult> {
  const source = input.source || DEFAULT_SKILL_SOURCE;
  const runner = input.runner || defaultRunner;
  const code = await runner.run("npx", buildSkillsCliArgs(source));

  if (code !== 0) {
    throw new Error(`npx skills failed with exit code ${code}`);
  }

  return {
    source,
    agents: DEFAULT_SKILL_AGENTS,
    scope: "global",
    mode: "copy",
  };
}
