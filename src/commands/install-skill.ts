export const DEFAULT_SKILL_SOURCE = "alterxyz/ahelpa";
export const AHELPA_SKILL_NAME = "ahelpa";
export const DEFAULT_SKILL_AGENTS = ["codex", "claude-code", "kimi-code-cli"] as const;

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

async function checkSkillInstallPrerequisites(): Promise<void> {
  if (!Bun.which("node")) {
    throw new Error("Node.js >=22.20.0 is required for skills installation; install Node.js and retry.");
  }
  let version: string;
  try {
    const node = Bun.spawn(["node", "--version"], { stdout: "pipe", stderr: "ignore" });
    const [code, output] = await Promise.all([node.exited, new Response(node.stdout).text()]);
    if (code !== 0) throw new Error("node --version failed");
    version = output.trim();
  } catch {
    throw new Error("Could not run node --version; repair Node.js and retry.");
  }
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error("Could not read a stable Node.js version; Node.js >=22.20.0 is required.");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 22 || (major === 22 && minor < 20)) {
    throw new Error(`Node.js >=22.20.0 is required for skills installation; found ${version}. Upgrade Node.js and retry.`);
  }
  if (!Bun.which("npx")) {
    throw new Error("npx is required for skills installation; install Node.js with npm and retry.");
  }
  try {
    const npx = Bun.spawn(["npx", "--version"], { stdout: "ignore", stderr: "ignore" });
    if (await npx.exited !== 0) throw new Error("npx --version failed");
  } catch {
    throw new Error("Could not run npx --version; repair Node.js/npm before installing skills.");
  }
}

const defaultRunner: SkillInstallRunner = {
  async run(command, args) {
    await checkSkillInstallPrerequisites();
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
