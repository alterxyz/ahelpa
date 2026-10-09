// The single source of truth for every CLI command: name, usage text, flag
// schema, and handler live in one contract record. cli.ts is only a process
// shell around runCli, so the whole command surface is testable without
// spawning a process.

import type { StateDB } from "./state";
import { parseCliArgs } from "./cli-args";
import { launch, resume } from "./commands/launch";
import { installSkill } from "./commands/install-skill";
import { doctor } from "./commands/doctor";
import { wait, DEFAULT_WAIT_TIMEOUT_MS } from "./commands/wait";
import { send, capture, sendTask, switchModel, kill, logs, check, status, clean } from "./commands/session-ops";
import { isDaemonRunning, refreshSessionStatuses, startDaemon, stopDaemon } from "./daemon";
import { getDriver, listDrivers } from "./drivers/registry";
import type { AgentDriver, ModelCatalogEntry } from "./drivers/types";
import { SessionAccessError } from "./session-access";
import { VERSION } from "./version";
import { readTaskFile } from "./task-input";
import { parseHelperRole } from "./launch-profiles";
import { mail, inbox } from "./commands/peer-mail";
import { resolveParentId } from "./caller-identity";
export { resolveParentId } from "./caller-identity";

export class UsageError extends Error {}

function readLaunchTask(task?: string, file?: string): string {
  if (task !== undefined && file !== undefined) {
    throw new UsageError("Use exactly one of --task or --file");
  }
  if (task === undefined && file === undefined) {
    throw new UsageError("--task or --file is required");
  }
  const content = file === undefined ? task! : readTaskFile(file);
  if (!content.trim()) throw new UsageError("Task must not be empty");
  return content;
}

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
  // Read-only commands can run before the process shell opens the state DB.
  stateless?: boolean;
  minPositionals?: number;
  // Fixed-arity commands default to minPositionals (or zero). Variadic
  // commands explicitly opt in with Infinity; optional arguments set a bound.
  maxPositionals?: number;
  flags?: Record<string, FlagSpec>;
  run(ctx: CommandContext): Promise<void>;
}

export function resolveWaitTimeoutMs(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  if (timeoutSeconds < 0) throw new UsageError("--timeout must be >= 0 seconds");
  const timeoutMs = timeoutSeconds * 1000;
  if (!Number.isFinite(timeoutMs)) throw new UsageError("--timeout must be a finite duration");
  return timeoutMs;
}

// A job is resolved to its sessions that are still working when wait starts,
// so finished hands do not end the wait and later hands are not waited on.
export function resolveWaitTargets(db: StateDB, ids: string[], job?: string): string[] {
  if (job === undefined) {
    if (ids.length === 0) throw new UsageError("Usage: ahelpa wait (<id...> | --job <id>) [--all] [--timeout <seconds>]");
    return ids;
  }
  if (ids.length > 0) throw new UsageError("wait takes session ids or --job, not both");
  const active = db.listJobSessions(job).filter((session) => session.status === "running");
  if (active.length === 0) throw new Error(`Job ${job} has no running sessions`);
  return active.map((session) => session.id);
}

function renderModelLine(model: ModelCatalogEntry): string {
  const details: string[] = [];
  if (model.efforts?.length) details.push(`effort: ${model.efforts.join(", ")}`);
  if (model.defaultEffort) details.push(`default: ${model.defaultEffort}`);
  return details.length ? `  ${model.name} (${details.join("; ")})` : `  ${model.name}`;
}

function renderCatalog(agent: string, driver: AgentDriver): string {
  const { modelCatalog: catalog, launchProfiles } = driver;
  const lines = [agent];
  if (launchProfiles) {
    lines.push("  Launch defaults (explicit --model and --effort override these):");
    for (const [role, profile] of Object.entries(launchProfiles.profiles)) {
      if (!profile) continue;
      const defaultLabel = role === launchProfiles.defaultRole ? " (default)" : "";
      lines.push(`    ${role}${defaultLabel}: ${profile.model}; effort: ${profile.effort}`);
    }
    lines.push("  Model catalog (model defaults may differ from launch defaults):");
  }
  lines.push(...catalog.models.map(renderModelLine));
  if (catalog.effortNote) lines.push(`  ${catalog.effortNote}`);
  return lines.join("\n");
}

export function renderModelsText(agent?: string): string {
  const agents = agent === undefined ? listDrivers() : [agent];
  const catalogs = agents.map((name) => renderCatalog(name, getDriver(name)));
  return ["Available models", "", catalogs.join("\n\n")].join("\n");
}

export const COMMAND_CONTRACTS: CommandContract[] = [
  {
    name: "doctor",
    usage: "doctor [agent] [--project <path>]",
    description: "Check local readiness without a model call or runtime writes",
    stateless: true,
    maxPositionals: 1,
    flags: { project: { kind: "string" } },
    async run(ctx) {
      ctx.print(JSON.stringify(doctor(ctx.positionals[0], ctx.flags.strings.project), null, 2));
    },
  },
  {
    name: "mail",
    usage: 'mail (<to-id> | --peers) (--file <path> | --text "...")',
    description: "Send bounded file mail to job peers",
    maxPositionals: 1,
    flags: { peers: { kind: "boolean" }, file: { kind: "string" }, text: { kind: "string" } },
    async run(ctx) {
      const to = ctx.positionals[0];
      if (Boolean(to) === ctx.flags.booleans.peers) throw new UsageError("Use exactly one of <to-id> or --peers");
      const { file, text } = ctx.flags.strings;
      if ((file !== undefined) === (text !== undefined)) throw new UsageError("Use exactly one of --file or --text");
      const content = file === undefined ? text! : readTaskFile(file);
      if (!content.trim()) throw new UsageError("Peer message must not be empty");
      ctx.print(JSON.stringify(mail(ctx.db, to, ctx.flags.booleans.peers, content), null, 2));
    },
  },
  {
    name: "inbox",
    usage: "inbox [--read <seq>]",
    description: "List peer mail or read and mark a message",
    flags: { read: { kind: "number" } },
    async run(ctx) {
      const result = inbox(ctx.db, ctx.flags.numbers.read);
      ctx.print(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    },
  },
  {
    name: "launch",
    usage: "launch <type> (--task \"...\" | --file <path>) [--role worker|advisor|reviewer] [--label \"...\"] [--project <path>] [--parent <id>] [--job <id>] [--safe] [--model <model>] [--effort <level>] [--check \"<cmd>\"] [--after <id>] [--unblind] [--worktree]",
    description: "Launch a helper agent",
    minPositionals: 1,
    flags: {
      task: { kind: "string" },
      file: { kind: "string" },
      project: { kind: "string" },
      parent: { kind: "string" },
      label: { kind: "string" },
      safe: { kind: "boolean" },
      role: { kind: "string" },
      model: { kind: "string" },
      effort: { kind: "string" },
      check: { kind: "string" },
      after: { kind: "string" },
      unblind: { kind: "boolean" },
      worktree: { kind: "boolean" },
      job: { kind: "string" },
    },
    async run(ctx) {
      const result = await launch({
        db: ctx.db,
        agentType: ctx.positionals[0],
        task: readLaunchTask(ctx.flags.strings.task, ctx.flags.strings.file),
        projectPath: ctx.flags.strings.project || process.cwd(),
        parentId: ctx.flags.strings.parent || resolveParentId(),
        label: ctx.flags.strings.label,
        safe: ctx.flags.booleans.safe,
        role: parseHelperRole(ctx.flags.strings.role),
        model: ctx.flags.strings.model,
        effort: ctx.flags.strings.effort,
        check: ctx.flags.strings.check,
        after: ctx.flags.strings.after,
        unblind: ctx.flags.booleans.unblind,
        worktree: ctx.flags.booleans.worktree,
        job: ctx.flags.strings.job,
        taskFromFile: Boolean(ctx.flags.strings.file),
      });
      ctx.print(JSON.stringify(result, null, 2));
    },
  },
  {
    name: "wait",
    usage: "wait (<id...> | --job <id>) [--all] [--timeout <seconds>]",
    description: "Wait for helper(s) to finish",
    maxPositionals: Infinity,
    flags: { all: { kind: "boolean" }, timeout: { kind: "number" }, job: { kind: "string" } },
    async run(ctx) {
      const result = await wait(
        ctx.db,
        resolveWaitTargets(ctx.db, ctx.positionals, ctx.flags.strings.job),
        ctx.flags.booleans.all,
        resolveWaitTimeoutMs(ctx.flags.numbers.timeout),
      );
      ctx.print(JSON.stringify(result, null, 2));
    },
  },
  {
    name: "check",
    usage: "check [--parent <id>] [--job <id>]",
    description: "Check session status (non-blocking)",
    flags: { parent: { kind: "string" }, job: { kind: "string" } },
    async run(ctx) {
      if (!isDaemonRunning()) {
        await refreshSessionStatuses(ctx.db);
      }
      ctx.print(JSON.stringify(check(ctx.db, ctx.flags.strings.parent, ctx.flags.strings.job, resolveParentId()), null, 2));
    },
  },
  {
    name: "models",
    usage: "models [agent]",
    description: "List model options and role defaults",
    maxPositionals: 1,
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
      const lines = ctx.flags.numbers.lines ?? 50;
      if (!Number.isSafeInteger(lines) || lines <= 0) throw new UsageError("--lines must be a positive integer");
      ctx.print(await capture(ctx.db, ctx.positionals[0], ctx.flags.strings.token!, lines));
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
    usage: "kill <id> --token <token> [--tree]",
    description: "Terminate helper, optionally including descendants",
    minPositionals: 1,
    flags: { token: { kind: "string", required: true }, tree: { kind: "boolean" } },
    async run(ctx) {
      const result = await kill(ctx.db, ctx.positionals[0], ctx.flags.strings.token!, { tree: ctx.flags.booleans.tree });
      ctx.print(result ? JSON.stringify(result, null, 2) : "killed");
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
      ctx.print(status(ctx.db, daemonRunning, resolveParentId()));
    },
  },
  {
    name: "resume",
    usage: "resume <id> --token <token> [--safe]",
    description: "Resume a completed helper (preserving its safe posture)",
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
    description: "Remove settled session records and leftovers",
    async run(ctx) {
      const result = await clean(ctx.db);
      ctx.print(`removed ${result.removed} settled session record(s), swept ${result.orphanFiles} orphan file(s)`);
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
    if (!Object.hasOwn(specs, name)) throw new UsageError(`Unknown flag --${name}. Usage: ahelpa ${contract.usage}`);
  }
  const resolved: ResolvedFlags = { strings: {}, numbers: {}, booleans: {} };
  for (const [name, spec] of Object.entries(specs)) {
    const value = raw[name];
    if (value === undefined) {
      if (spec.required) throw new UsageError(`--${name} is required`);
      if (spec.kind === "boolean") resolved.booleans[name] = false;
      continue;
    }
    // Explicit empty values and options with a missing value must not silently
    // restore defaults (cwd, wait timeout, permission posture, task source).
    if (value === "") throw new UsageError(`--${name} requires a value`);
    switch (spec.kind) {
      case "string":
        resolved.strings[name] = value;
        break;
      case "number": {
        const parsed = Number(value);
        if (!value.trim() || !Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number`);
        resolved.numbers[name] = parsed;
        break;
      }
      case "boolean":
        if (value !== "true" && value !== "false") {
          throw new UsageError(`--${name} must be true or false`);
        }
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

export async function runCli(db: StateDB | undefined, argv: string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;

  if (!name || name === "help") {
    if (rest.length > 0) {
      io.printError("Usage: ahelpa help");
      return 1;
    }
    io.print(renderHelpText());
    return 0;
  }

  const contract = COMMAND_CONTRACTS.find((candidate) => candidate.name === name);
  if (!contract) {
    io.printError(`Unknown command: ${name}`);
    return 1;
  }

  try {
    const booleanFlags = new Set(Object.entries(contract.flags ?? {})
      .filter(([, spec]) => spec.kind === "boolean")
      .map(([flag]) => flag));
    const { flags: rawFlags, positionals } = parseCliArgs(rest, booleanFlags);
    const minPositionals = contract.minPositionals ?? 0;
    const maxPositionals = contract.maxPositionals ?? minPositionals;
    if (positionals.length < minPositionals || positionals.length > maxPositionals) {
      throw new UsageError(`Usage: ahelpa ${contract.usage}`);
    }
    const flags = resolveFlags(contract, rawFlags);
    if (!db && !contract.stateless) throw new Error("This command requires the state database");
    // Stateless handlers never access db; retaining the context type keeps
    // stateful handlers' existing DB contract unchanged.
    await contract.run({ db: db!, positionals, flags, print: io.print });
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
