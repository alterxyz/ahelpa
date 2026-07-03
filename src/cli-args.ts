export interface ParsedCliArgs {
  flags: Record<string, string>;
  positionals: string[];
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      i++;
      continue;
    }

    flags[arg.slice(2)] = "true";
  }

  return { flags, positionals };
}
