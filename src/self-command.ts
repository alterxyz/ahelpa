import { existsSync } from "fs";
import { join } from "path";

// Source invocation needs Bun + cli.ts; a compiled runtime re-invokes itself.
export function getSelfCommand(execPath = process.execPath, moduleDir = import.meta.dir): string[] {
  const cliPath = join(moduleDir, "cli.ts");
  return existsSync(cliPath) ? [execPath, cliPath] : [execPath];
}
