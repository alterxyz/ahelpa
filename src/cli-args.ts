export interface ParsedCliArgs {
  flags: Record<string, string>;
  positionals: string[];
}

export function parseCliArgs(args: string[], booleanFlags?: ReadonlySet<string>): ParsedCliArgs {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const name = arg.slice(2);
    const next = args[i + 1];
    if (booleanFlags?.has(name)) {
      if (next === "true" || next === "false") {
        flags[name] = next;
        i++;
      } else {
        flags[name] = "true";
      }
      continue;
    }

    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      i++;
      continue;
    }

    flags[name] = booleanFlags ? "" : "true";
  }

  return { flags, positionals };
}
