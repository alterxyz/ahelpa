import { $ } from "bun";
import { shellEscape } from "./shell";

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
    || /^no sessions$/m.test(stderr);
}

export class Tmux {
  static async create(name: string, command: string): Promise<void> {
    // Wrap command so the session persists after the command exits
    const wrapped = `bash -lc ${shellEscape(`${command}; exec bash`)}`;
    await $`tmux new-session -d -s ${name} ${wrapped}`.quiet();
  }

  static async hasSession(name: string): Promise<boolean> {
    try {
      await $`tmux has-session -t ${name}`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  static async capture(name: string, lines: number = 50): Promise<string> {
    const result = await $`tmux capture-pane -t ${name} -p -S ${-lines}`.text();
    return result.trim();
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
