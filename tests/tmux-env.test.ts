import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { shellEscape } from "../src/shell";
import { tmuxClientEnv } from "../src/tmux";

const removedNames = [
  "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_FUTURE",
  "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_FUTURE",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_USER_EMAIL", "CLAUDE_CODE_PARENT_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "CLAUDE_CODE_TERMINAL_MCP_TOOLS", "CLAUDE_CODE_REPORT_FINDINGS",
  "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_PLUGIN_DATA", "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TOOL_CALL_ID", "CODEX_COMPANION_FUTURE",
  "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_SANDBOXFUTURE",
  "CODEX_CI", "CODEX_VERSION", "AI_AGENT", "BAGGAGE", "__CFBundleIdentifier",
];
const keptNames = [
  "PATH", "HOME", "TMUX", "TMUX_TMPDIR", "AHELPA_PARENT_ID", "SSH_AUTH_SOCK",
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
  "CODEX_HOME", "DSH_HOME", "KIMI_CODE_HOME", "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CI",
  "CLAUDE_CODE_SESSION", "CLAUDE_AGENT_SDK", "CODEX_COMPANION", "CODEX_CI_EXTRA",
  "PREFIX_CLAUDECODE", "BAGGAGE_EXTRA", "claudecode",
];

describe("tmuxClientEnv", () => {
  test.each(removedNames)("removes %s without mutating the input", name => {
    const env = Object.freeze({ [name]: "fake-host-value" });
    expect(tmuxClientEnv(env)).toEqual({});
    expect(env[name]).toBe("fake-host-value");
  });

  test.each(keptNames)("preserves %s exactly", name => {
    const env = Object.freeze({ [name]: "fake-user-value" });
    const result = tmuxClientEnv(env);
    expect(result).toEqual(env);
    expect(result).not.toBe(env);
  });

  test("keeps empty values and omits undefined values", () => {
    const env = Object.freeze({ EMPTY: "", UNDEFINED: undefined });
    expect(tmuxClientEnv(env)).toStrictEqual({ EMPTY: "" });
    expect(Object.hasOwn(env, "UNDEFINED")).toBe(true);
  });
});

test("Tmux.create keeps host identity out of an isolated server's global environment", async () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "tmux-env-"));
  const socket = join(scratch, "s");
  const tmux = Bun.which("tmux")!;
  try {
    writeFileSync(join(scratch, "tmux"),
      `#!/bin/sh\nexec ${shellEscape(tmux)} -f /dev/null -S ${shellEscape(socket)} "$@"\n`,
      { mode: 0o755 });
    const source = new URL("../src/tmux.ts", import.meta.url).pathname;
    const probe = join(scratch, "probe.ts");
    writeFileSync(probe, `
      import { Tmux } from ${JSON.stringify(source)};
      // Set after import to also catch a module-load environment snapshot.
      process.env.CLAUDE_CODE_SESSION_ID = "fake-late-host";
      process.env.ANTHROPIC_BASE_URL = "https://fake-kept.invalid";
      await Tmux.create("env-test", "sleep 30");
    `);
    const child = Bun.spawn([process.execPath, probe], {
      env: {
        PATH: `${scratch}:${process.env.PATH}`,
        HOME: scratch,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        ...Object.fromEntries(removedNames.map(name => [name, "fake-host-value"])),
      },
      stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const result = Bun.spawnSync([tmux, "-S", socket, "show-environment", "-g"], {
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.toString().split("\n");
    const names = lines.map(line => line.split("=", 1)[0]);
    for (const name of removedNames) expect(names).not.toContain(name);
    expect(lines).toContain("ANTHROPIC_BASE_URL=https://fake-kept.invalid");
  } finally {
    Bun.spawnSync([tmux, "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    rmSync(scratch, { recursive: true, force: true });
  }
});
