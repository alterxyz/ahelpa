import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "fs";
import { createHash } from "crypto";
import { basename, dirname, join, resolve } from "path";
import { TASK_INSTRUCTION_PREFIX } from "./file-handoff";
import { getSelfCommand } from "./self-command";
import { shellEscape } from "./shell";

export const TURN_HOOK_SUBCOMMAND = "__turn-hook";
export type TurnHookAgent = "claude-code" | "codex";
export interface TurnEvent {
  ts: string;
  agent: TurnHookAgent;
  event: "prompt" | "stop" | "stop_failure" | "turn_complete";
  inputDigest?: string;
  sessionId?: string;
  promptId?: string;
  threadId?: string;
  turnId?: string;
  error?: string;
  stopHookActive?: boolean;
  assistantMessagePresent: boolean;
  assistantMessageLength: number;
  inputMessagesPresent?: boolean;
  inputMessagesLength?: number;
}

const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export const normalizeTurnInput = (input: string): string => input.replace(/\r\n?/g, "\n").trim();

function claudePromptInput(input: string): string {
  const normalized = normalizeTurnInput(input);
  // Claude expands a whole-message paste into this documented wrapper before
  // UserPromptSubmit. Only unwrap a complete, paired wrapper; partial/mixed
  // paste layouts remain unattributed and use the inactivity fallback.
  const pasted = normalized.match(/^<pasted_content id="([a-f0-9]{4})">\n([\s\S]*)\n<\/pasted_content id="\1">$/u);
  return (pasted?.[2] ?? normalized).trim();
}
export const inputDigest = (input: string): string => createHash("sha256").update(normalizeTurnInput(input)).digest("hex");

// The parent CLI must stay silent and successful if this runtime is moved,
// removed, or no longer executable. "$@" preserves Codex's final JSON argument.
function wrapTurnHookCommand(command: string[]): string[] {
  const wrapper = `[ -x ${shellEscape(command[0])} ] || exit 0; (exec ${command.map(shellEscape).join(" ")} "$@" >/dev/null 2>&1) || exit 0`;
  return ["/bin/sh", "-c", wrapper, "sh"];
}

export function turnHookCommand(sessionDir: string, agent: TurnHookAgent, resumeThread?: string): string[] {
  return wrapTurnHookCommand([...getSelfCommand(), TURN_HOOK_SUBCOMMAND, sessionDir, agent, ...(resumeThread ? ["--thread", resumeThread] : [])]);
}

export function parseTurnPayload(agent: string, raw: string, boundThread?: string): TurnEvent | null {
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const message = agent === "codex" ? p["last-assistant-message"] : p.last_assistant_message;
    const metadata = {
      assistantMessagePresent: typeof message === "string",
      assistantMessageLength: typeof message === "string" ? message.length : 0,
    };
    const ts = new Date().toISOString();
    if (agent === "claude-code") {
      if (p.hook_event_name === "UserPromptSubmit" && id(p.session_id) && id(p.prompt_id) && typeof p.prompt === "string") {
        return { ts, agent, event: "prompt", sessionId: p.session_id, promptId: p.prompt_id, inputDigest: inputDigest(claudePromptInput(p.prompt)), ...metadata };
      }
      if (!["Stop", "StopFailure"].includes(p.hook_event_name) || !id(p.session_id) || !id(p.prompt_id)) return null;
      return { ts, agent, event: p.hook_event_name === "Stop" ? "stop" : "stop_failure",
        sessionId: p.session_id, promptId: p.prompt_id,
        ...(typeof p.stop_hook_active === "boolean" ? { stopHookActive: p.stop_hook_active } : {}),
        ...(p.hook_event_name === "StopFailure" ? { error: id(p.error) ? p.error : "unknown" } : {}), ...metadata };
    }
    if (agent === "codex") {
      if (p.type !== "agent-turn-complete" || !id(p["thread-id"]) || !id(p["turn-id"])) return null;
      const messages = p["input-messages"];
      if (boundThread ? p["thread-id"] !== boundThread
        : !Array.isArray(messages) || !messages.some((m: unknown) => typeof m === "string" && m.startsWith(TASK_INSTRUCTION_PREFIX))) return null;
      return { ts, agent, event: "turn_complete", threadId: p["thread-id"], turnId: p["turn-id"], ...metadata,
        ...(Array.isArray(messages) && typeof messages.at(-1) === "string" ? { inputDigest: inputDigest(messages.at(-1)) } : {}),
        inputMessagesPresent: Array.isArray(messages),
        inputMessagesLength: Array.isArray(messages) ? messages.reduce((n: number, m: unknown) => n + (typeof m === "string" ? m.length : 0), 0) : 0 };
    }
  } catch {}
  return null;
}

function eventKey(event: TurnEvent): string {
  return JSON.stringify([event.agent, event.event, event.sessionId, event.promptId, event.threadId, event.turnId]);
}

// Both the writer and monitor reject malformed/truncated log lines.
function parseLogLine(raw: string): TurnEvent | null {
  try {
    const e = JSON.parse(raw);
    if (!e || !Number.isFinite(Date.parse(e.ts)) || typeof e.assistantMessagePresent !== "boolean"
      || !Number.isInteger(e.assistantMessageLength) || e.assistantMessageLength < 0) return null;
    if (e.agent === "codex" && e.event === "turn_complete" && id(e.threadId) && id(e.turnId)) return e;
    if (e.agent === "claude-code" && e.event === "prompt" && id(e.sessionId) && id(e.promptId) && digest(e.inputDigest)) return e;
    if (e.agent === "claude-code" && ["stop", "stop_failure"].includes(e.event)
      && id(e.sessionId) && id(e.promptId) && (e.event !== "stop_failure" || id(e.error))) return e;
  } catch {}
  return null;
}

export function readTurnEvents(path: string, offset = 0, since = "", agent?: string, currentDigest?: string | null): { offset: number; event: TurnEvent | null; ignored?: TurnEvent[] } {
  try {
    const bytes = readFileSync(path);
    let cursor = Math.min(offset, bytes.length);
    let event: TurnEvent | null = null;
    const ignored: TurnEvent[] = [];
    // Prompt events can have been consumed in an earlier poll; reconstruct
    // attribution from the append-only history rather than mutable last-prompt state.
    const prompts = new Map<string, TurnEvent>();
    for (const line of bytes.toString("utf8").split("\n").slice(0, -1)) {
      const prompt = parseLogLine(line);
      if (prompt?.event === "prompt") prompts.set(JSON.stringify([prompt.sessionId, prompt.promptId]), prompt);
    }
    while (cursor < bytes.length) {
      const end = bytes.indexOf(10, cursor);
      if (end < 0) break; // Retry a partial append on the next poll.
      const next = parseLogLine(bytes.subarray(cursor, end).toString("utf8"));
      cursor = end + 1;
      if (!next || next.event === "prompt" || (agent && next.agent !== agent)) continue;
      const prompt = prompts.get(JSON.stringify([next.sessionId, next.promptId]));
      const attributed = currentDigest === undefined || (!!currentDigest && (next.agent === "codex"
        ? next.inputDigest === currentDigest
        : prompt?.inputDigest === currentDigest && (!since || Date.parse(prompt.ts) >= Date.parse(since))));
      if (attributed && (!since || Date.parse(next.ts) >= Date.parse(since))) {
        // An error in this batch takes precedence over an ordinary Stop.
        if (event?.event !== "stop_failure") event = next;
      } else ignored.push(next);
    }
    return { offset: cursor, event, ignored };
  } catch { return { offset, event: null }; }
}

// No DB, process spawning, or user configuration access. Failure is best-effort:
// the existing inactivity path remains available if the log cannot be written.
export function writeTurnHook(sessionDir: string, agent: string, raw: string, resumeThread?: string): void {
  let fd: number | undefined;
  try {
    const dir = resolve(sessionDir);
    if (basename(dirname(dir)) !== ".ahelpa" || !id(basename(dir))
      || !lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) return;
    const path = join(dir, "turns.log");
    let checked;
    try { checked = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    if (checked && (!checked.isFile() || checked.nlink !== 1)) return;
    if (!checked && !parseTurnPayload(agent, raw, resumeThread)) return;
    fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || current.nlink !== 1
      || opened.dev !== current.dev || opened.ino !== current.ino
      || (checked && (opened.dev !== checked.dev || opened.ino !== checked.ino))) return;
    const previous = readFileSync(fd, "utf8").split("\n").flatMap(line => {
      const event = parseLogLine(line);
      return event ? [event] : [];
    });
    if (resumeThread !== undefined && !id(resumeThread)) return;
    const boundThread = resumeThread ?? previous.find(e => e.agent === "codex")?.threadId;
    const event = parseTurnPayload(agent, raw, boundThread);
    if (!event || previous.some(e => eventKey(e) === eventKey(event))) return;
    appendFileSync(fd, JSON.stringify(event) + "\n");
  } catch {} finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

export async function runTurnHook(args: string[]): Promise<void> {
  try {
    if (args.length < 2) return;
    const [dir, agent] = args;
    if (agent === "codex" && args.length >= 3) {
      const raw = args.at(-1)!;
      if (raw.length <= 4 * 1024 * 1024) writeTurnHook(dir, agent, raw, args[2] === "--thread" ? args[3] : undefined);
    } else if (agent === "claude-code") {
      // Hooks must never hold up the CLI, even if stdin is accidentally left open.
      const reader = Bun.stdin.stream().getReader();
      const deadline = Date.now() + 500;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const result = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
          if (!result) return;
          if (result.done) break;
          size += result.value.length;
          if (size > 4 * 1024 * 1024) return;
          chunks.push(result.value);
        }
        writeTurnHook(dir, agent, Buffer.concat(chunks).toString("utf8"));
      } finally { void reader.cancel().catch(() => {}); }
    }
  } catch {}
}
