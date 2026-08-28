// The single source of truth for every CLI command: name, usage text, flag
// schema, and handler live in one contract record. cli.ts is only a process
// shell around runCli, so the whole command surface is testable without
// spawning a process.

import type { StateDB } from "./state";
import { parseCliArgs } from "./cli-args";
import { launch, resume } from "./commands/launch";
import { installSkill } from "./commands/install-skill";
import { wait, DEFAULT_WAIT_TIMEOUT_MS } from "./commands/wait";
import { send, capture, sendTask, switchModel, kill, logs, check, status, clean } from "./commands/session-ops";
import { isDaemonRunning, refreshSessionStatuses, startDaemon, stopDaemon } from "./daemon";
import { getDriver, listDrivers } from "./drivers/registry";
import type { AgentModelCatalog, ModelCatalogEntry } from "./drivers/types";
import { SessionAccessError } from "./session-access";
import { VERSION } from "./version";

export class UsageError extends Error {}

export interface FlagSpec {
  kind: "string" | "number" | "boolean";
  required?: boolean;
}

export interface ResolvedFlags {
  strings: Record<string, string | undefined>;
  numbers: Record<string, number | undefined>;
  booleans: Record<string, boolean>;
}

export interface CommandContext {
  db: StateDB;
  positionals: string[];
  flags: ResolvedFlags;
  print(text: string): void;
}

export interface CommandContract {
  name: string;
  usage: string;
  description: string;
  minPositionals?: number;
  flags?: Record<string, FlagSpec>;
  run(ctx: CommandContext): Promise<void>;
}

export function resolveWaitTimeoutMs(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  if (timeoutSeconds < 0) throw new UsageError("--timeout must be >= 0 seconds");
  return timeoutSeconds * 1000;
}

export function resolveParentId(
  env: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): string {
  return env.AHELPA_PARENT_ID
    || env.CLAUDE_CODE_SESSION_ID
    || env.CODEX_THREAD_ID
    || env.CODEX_COMPANION_SESSION_ID
    || `cli-${now()}`;
}

function renderModelLine(model: ModelCatalogEntry): string {
  const details: string[] = [];
  if (model.efforts?.length) details.push(`effort: ${model.efforts.join(", ")}`);
  if (model.defaultEffort) details.push(`default: ${model.defaultEffort}`);
  return details.length ? `  ${model.name} (${details.join("; ")})` : `  ${model.name}`;
}

function renderCatalog(agent: string, catalog: AgentModelCatalog): string {
  const lines = [agent, ...catalog.models.map(renderModelLine)];
  if (catalog.effortNote) lines.push(`  ${catalog.effortNote}`);
  return lines.join("\n");
}

export function renderModelsText(agent?: string): string {
  const agents = agent === undefined ? listDrivers() : [agent];
  const catalogs = agents.map((name) => renderCatalog(name, getDriver(name).modelCatalog));
  return ["Available models", "", catalogs.join("\n\n")].join("\n");
}

export const COMMAND_CONTRACTS: CommandContract[] = [
  {
    name: "launch",
    usage: "launch <type> --task \"...\" [--label \"...\"] [--project <path>] [--parent <id>] [--safe] [--model <model>] [--effort <level>]",
    description: "Launch a helper agent",
    minPositionals: 1,
    flags: {
      task: { kind: "string", required: true },
      project: { kind: "string" },
      parent: { kind: "string" },
      label: { kind: "string" },
      safe: { kind: "boolean" },
      model: { kind: "string" },
      effort: { kind: "string" },
    },
    async run(ctx) {
      const result = await launch({
        db: ctx.db,
        agentType: ctx.positionals[0],
        task: ctx.flags.strings.task!,
        projectPath: ctx.flags.strings.project || process.cwd(),
        parentId: ctx.flags.strings.parent || resolveParentId(),
        label: ctx.flags.strings.label,
        safe: ctx.flags.booleans.safe,
        model: ctx.flags.strings.model,
        effort: ctx.flags.strings.effort,
      });
      ctx.print(JSON.stringify(result, null, 2));
    },
  },
  {
    name: "wait",
    usage: "wait <id...> [--all] [--timeout <seconds>]",
    description: "Wait for helper(s) to finish",
    minPositionals: 1,
    flags: { all: { kind: "boolean" }, timeout: { kind: "number" } },
    async run(ctx) {
      const result = await wait(
        ctx.db,
        ctx.positionals,
        ctx.flags.booleans.all,
        resolveWaitTimeoutMs(ctx.flags.numbers.timeout),
      );
      ctx.print(JSON.stringify(result, null, 2));
    },
  },
  {
    name: "check",
    usage: "check [--parent <id>]",
    description: "Check session status (non-blocking)",
    flags: { parent: { kind: "string" } },
    async run(ctx) {
      if (!isDaemonRunning()) {
        await refreshSessionStatuses(ctx.db);
      }
      ctx.print(JSON.stringify(check(ctx.db, ctx.flags.strings.parent), null, 2));
    },
  },
  {
    name: "models",
    usage: "models [agent]",
    description: "List launch-time model options",
    async run(ctx) {
      ctx.print(renderModelsText(ctx.positionals[0]));
    },
  },
  {
    name: "send",
    usage: "send <id> \"msg\" --token <token>",
    description: "Send message to helper",
    minPositionals: 2,
    flags: { token: { kind: "string", required: true } },
    async run(ctx) {
      await send(ctx.db, ctx.positionals[0], ctx.flags.strings.token!, ctx.positionals[1]);
      ctx.print("sent");
    },
  },
  {
    name: "capture",
    usage: "capture <id> --token <token> [--lines <n>]",
    description: "Read helper's terminal output",
    minPositionals: 1,
    flags: { token: { kind: "string", required: true }, lines: { kind: "number" } },
    async run(ctx) {
      ctx.print(await capture(ctx.db, ctx.positionals[0], ctx.flags.strings.token!, ctx.flags.numbers.lines ?? 50));
    },
  },
  {
    name: "task",
    usage: "task <id> --file <path> --token <token>",
    description: "Send task file to helper",
    minPositionals: 1,
    flags: { file: { kind: "string", required: true }, token: { kind: "string", required: true } },
    async run(ctx) {
      await sendTask(ctx.db, ctx.positionals[0], ctx.flags.strings.token!, ctx.flags.strings.file!);
      ctx.print("task sent");
    },
  },
  {
    name: "model",
    usage: "model <id> --to <model> --token <token> [--effort <level>] [--persist]",
    description: "Switch a running helper's model",
    minPositionals: 1,
    flags: {
      to: { kind: "string", required: true },
      token: { kind: "string", required: true },
      effort: { kind: "string" },
      persist: { kind: "boolean" },
    },
    async run(ctx) {
      const result = await switchModel(ctx.db, ctx.positionals[0], ctx.flags.strings.token!, {
        model: ctx.flags.strings.to!,
        effort: ctx.flags.strings.effort,
        persist: ctx.flags.booleans.persist,
      });
      ctx.print(result);
    },
  },
  {
    name: "kill",
    usage: "kill <id> --token <token>",
    description: "Terminate helper",
    minPositionals: 1,
    flags: { token: { kind: "string", required: true } },
    async run(ctx) {
      await kill(ctx.db, ctx.positionals[0], ctx.flags.strings.token!);
      ctx.print("killed");
    },
  },
  {
    name: "logs",
    usage: "logs <id> --token <token>",
    description: "View full session log",
    minPositionals: 1,
    flags: { token: { kind: "string", required: true } },
    async run(ctx) {
      ctx.print(await logs(ctx.db, ctx.positionals[0], ctx.flags.strings.token!));
    },
  },
  {
    name: "status",
    usage: "status",
    description: "List all sessions",
    async run(ctx) {
      const daemonRunning = isDaemonRunning();
      if (!daemonRunning) {
        await refreshSessionStatuses(ctx.db);
      }
      ctx.print(status(ctx.db, daemonRunning));
    },
  },
  {
    name: "resume",
    usage: "resume <id> --token <token> [--safe]",
    description: "Resume a dead helper (preserving its safe posture)",
    minPositionals: 1,
    flags: { token: { kind: "string", required: true }, safe: { kind: "boolean" } },
    async run(ctx) {
      const result = await resume({
        db: ctx.db,
        sessionId: ctx.positionals[0],
        ownerToken: ctx.flags.strings.token!,
        safe: ctx.flags.booleans.safe,
      });
      ctx.print(JSON.stringify(result, null, 2));
    },
  },
  {
    name: "clean",
    usage: "clean",
    description: "Remove dead session records and leftovers",
    async run(ctx) {
      const result = clean(ctx.db);
      ctx.print(`removed ${result.removed} dead session record(s), swept ${result.orphanFiles} orphan file(s)`);
    },
  },
  {
    name: "install-skill",
    usage: "install-skill [--source <repo-or-path>]",
    description: "Install the ahelpa skill globally for supported agents",
    flags: { source: { kind: "string" } },
    async run(ctx) {
      const result = await installSkill({ source: ctx.flags.strings.source });
      ctx.print(
        [
          `installed ${result.mode} skill globally for ${result.agents.join(", ")}`,
          `source: ${result.source}`,
        ].join("\n"),
      );
    },
  },
  {
    name: "version",
    usage: "version",
    description: "Show runtime version",
    async run(ctx) {
      ctx.print(`ahelpa ${VERSION}`);
    },
  },
  {
    name: "daemon",
    usage: "daemon start|stop",
    description: "Manage daemon",
    minPositionals: 1,
    async run(ctx) {
      const sub = ctx.positionals[0];
      if (sub === "start") {
        startDaemon();
        ctx.print("daemon started");
      } else if (sub === "stop") {
        stopDaemon();
        ctx.print("daemon stopped");
      } else {
        throw new UsageError("Usage: ahelpa daemon start|stop");
      }
    },
  },
];

export function renderHelpText(): string {
  const usageWidth = Math.max(...COMMAND_CONTRACTS.map((command) => command.usage.length));
  const commands = COMMAND_CONTRACTS
    .map((command) => `  ${command.usage.padEnd(usageWidth)}   ${command.description}`)
    .join("\n");

  return `ahelpa - Agent Help Agent

Commands:
${commands}`;
}

function resolveFlags(contract: CommandContract, raw: Record<string, string>): ResolvedFlags {
  const specs = contract.flags ?? {};
  for (const name of Object.keys(raw)) {
    if (!(name in specs)) throw new UsageError(`Unknown flag --${name}. Usage: ahelpa ${contract.usage}`);
  }
  const resolved: ResolvedFlags = { strings: {}, numbers: {}, booleans: {} };
  for (const [name, spec] of Object.entries(specs)) {
    const value = raw[name];
    // An empty string means "flag given without a usable value" — treat as absent.
    if (value === undefined || value === "") {
      if (spec.required) throw new UsageError(`--${name} is required`);
      if (spec.kind === "boolean") resolved.booleans[name] = false;
      continue;
    }
    switch (spec.kind) {
      case "string":
        resolved.strings[name] = value;
        break;
      case "number": {
        const parsed = parseInt(value, 10);
        if (Number.isNaN(parsed)) throw new UsageError(`--${name} must be a number`);
        resolved.numbers[name] = parsed;
        break;
      }
      case "boolean":
        resolved.booleans[name] = value === "true";
        break;
    }
  }
  return resolved;
}

export interface CliIO {
  print(text: string): void;
  printError(text: string): void;
}

export async function runCli(db: StateDB, argv: string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;

  if (!name || name === "help") {
    io.print(renderHelpText());
    return 0;
  }

  const contract = COMMAND_CONTRACTS.find((candidate) => candidate.name === name);
  if (!contract) {
    io.printError(`Unknown command: ${name}`);
    return 1;
  }

  try {
    const { flags: rawFlags, positionals } = parseCliArgs(rest);
    if (positionals.length < (contract.minPositionals ?? 0)) {
      throw new UsageError(`Usage: ahelpa ${contract.usage}`);
    }
    const flags = resolveFlags(contract, rawFlags);
    await contract.run({ db, positionals, flags, print: io.print });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.printError(error.message);
    } else if (error instanceof SessionAccessError) {
      io.printError(`Error [${error.code}]: ${error.message}`);
    } else {
      io.printError(`Error: ${(error as Error).message}`);
    }
    return 1;
  }
}
