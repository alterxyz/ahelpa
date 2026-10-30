import { $ } from "bun";
import { shellEscape } from "./shell";

// Host identity must not become the tmux server's global environment.
const HOST_SESSION_ENV = /^(?:CLAUDECODE|CLAUDE_CODE_(?:SESSION_.*|HOST_SESSION_.*|MESSAGING_.*|ACCOUNT_UUID|USER_EMAIL|PARENT_SESSION_ID|CHILD_SESSION|ENTRYPOINT|EXECPATH|DESKTOP_APP_VERSION|ORGANIZATION_UUID|OAUTH_SCOPES|SDK_HAS_HOST_AUTH_REFRESH|TERMINAL_MCP_TOOLS|REPORT_FINDINGS)|CLAUDE_(?:PID|EFFORT|PLUGIN_DATA|AGENT_SDK_VERSION|AGENT_SDK_MCP_NO_PREFIX)|CODEX_(?:THREAD_ID|SESSION_ID|TOOL_CALL_ID|COMPANION_.*|SANDBOX.*|CI|VERSION)|AI_AGENT|BAGGAGE|__CFBundleIdentifier)$/;

export function tmuxClientEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !HOST_SESSION_ENV.test(entry[0]),
  ));
}

function stderrText(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return "";
  const stderr = error.stderr;
  if (typeof stderr === "string") return stderr;
  if (stderr instanceof Uint8Array) return new TextDecoder().decode(stderr);
  return "";
}

export function isMissingTmuxSessionError(error: unknown): boolean {
  const stderr = stderrText(error).trim();
  return /^can't find session: .+$/m.test(stderr)
    || /^no server running on .+$/m.test(stderr)
    || /^error connecting to .+ \(No such file or directory\)$/m.test(stderr)
    || /^no sessions$/m.test(stderr);
}

export class Tmux {
  static async create(name: string, command: string): Promise<void> {
    // Wrap command so the session persists after the command exits
    const wrapped = `bash -lc ${shellEscape(`${command}; exec bash`)}`;
    await $`tmux new-session -d -s ${name} ${wrapped}`.env(tmuxClientEnv()).quiet();
  }

  static async hasSession(name: string): Promise<boolean> {
    try {
      await $`tmux has-session -t ${name}`.quiet();
      return true;
    } catch (error) {
      if (isMissingTmuxSessionError(error)) return false;
      // A permission or connection failure says nothing about whether the
      // helper is alive. Let monitoring retry instead of settling it dead.
      throw error;
    }
  }

  static async capture(name: string, lines: number = 50): Promise<string> {
    const result = await $`tmux capture-pane -t ${name} -p -S ${-lines}`.text();
    // Column-zero UI markers must stay distinguishable from indented quotes.
    return result.trimEnd();
  }

  static async sendKeys(name: string, text: string): Promise<void> {
    if (text.length > 0) {
      await $`tmux send-keys -t ${name} ${text}`.quiet();
      await Bun.sleep(250);
    }
    await $`tmux send-keys -t ${name} Enter`.quiet();
  }

  // Send a single named key (e.g. "Escape", "C-c") without appending Enter.
  static async sendKey(name: string, key: string): Promise<void> {
    await $`tmux send-keys -t ${name} ${key}`.quiet();
  }

  static async kill(name: string): Promise<void> {
    try {
      await $`tmux kill-session -t ${name}`.quiet();
    } catch (error) {
      if (isMissingTmuxSessionError(error)) return;
      throw error;
    }
  }

  static async listSessions(): Promise<string[]> {
    try {
      const result = await $`tmux list-sessions -F '#{session_name}'`.text();
      return result.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}
