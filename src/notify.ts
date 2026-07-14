import { appendFileSync, existsSync, readFileSync } from "fs";
import { Tmux } from "./tmux";
import { defaultRuntimeLayout, RuntimeLayout } from "./runtime-layout";
import { planFileHandoff } from "./file-handoff";
import { SESSION_STATUS, type SessionStatus } from "./session-lifecycle";
import type { SessionRecord } from "./state";

interface RuntimeNotifyConfig {
  notify?: {
    tmux?: string;
    command?: string;
  };
}

const NOTIFY_STATUSES = new Set<SessionStatus>([
  SESSION_STATUS.NeedsAttention,
  SESSION_STATUS.Dead,
  SESSION_STATUS.Error,
]);

function logNotify(message: string, layout: RuntimeLayout): void {
  try {
    appendFileSync(layout.daemonLogPath(), `[${new Date().toISOString()}] notify: ${message}\n`);
  } catch {
    // Notification logging is best-effort, just like notification delivery.
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function readNotifyConfig(
  layout: RuntimeLayout = defaultRuntimeLayout,
): RuntimeNotifyConfig {
  const path = layout.configPath();
  if (!existsSync(path)) return {};

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const notify = (raw as { notify?: unknown }).notify;
    if (!notify || typeof notify !== "object") return {};
    return {
      notify: {
        tmux: asNonEmptyString((notify as { tmux?: unknown }).tmux),
        command: asNonEmptyString((notify as { command?: unknown }).command),
      },
    };
  } catch (error) {
    logNotify(`failed to read config: ${(error as Error).message}`, layout);
    return {};
  }
}

export function buildTmuxNotificationMessage(
  session: Pick<SessionRecord, "id" | "label" | "projectPath">,
  status: SessionStatus,
  layout: RuntimeLayout = defaultRuntimeLayout,
): string {
  const name = session.label?.trim() || session.id;
  const summaryPath = planFileHandoff(session.projectPath, session.id, layout).summaryPath;
  return `【ahelpa:${name}】${status}. summary: ${summaryPath}`;
}

async function notifyTmuxTarget(
  target: string,
  message: string,
  layout: RuntimeLayout,
): Promise<void> {
  try {
    if (!(await Tmux.hasTarget(target))) return;
    await Tmux.sendLiteral(target, message);
  } catch (error) {
    logNotify(`tmux target ${target} failed: ${(error as Error).message}`, layout);
  }
}

function notifyCommand(command: string, session: SessionRecord, status: SessionStatus, layout: RuntimeLayout): void {
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      env: {
        ...process.env,
        AHELPA_SESSION_ID: session.id,
        AHELPA_STATUS: status,
        AHELPA_LABEL: session.label ?? "",
        AHELPA_PROJECT: session.projectPath,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
        logNotify(`command timed out for ${session.id}`, layout);
      } catch (error) {
        logNotify(`command timeout kill failed for ${session.id}: ${(error as Error).message}`, layout);
      }
    }, 10_000);

    void proc.exited.then((code) => {
      clearTimeout(timer);
      if (code !== 0) logNotify(`command exited ${code} for ${session.id}`, layout);
    }).catch((error) => {
      clearTimeout(timer);
      logNotify(`command failed for ${session.id}: ${(error as Error).message}`, layout);
    });
  } catch (error) {
    logNotify(`command spawn failed for ${session.id}: ${(error as Error).message}`, layout);
  }
}

export async function notifySettledSession(
  session: SessionRecord,
  status: SessionStatus,
  layout: RuntimeLayout = defaultRuntimeLayout,
): Promise<void> {
  if (!NOTIFY_STATUSES.has(status)) return;

  const config = readNotifyConfig(layout);
  const tmuxTarget = asNonEmptyString(session.notifyTmux) ?? config.notify?.tmux;
  if (tmuxTarget) {
    await notifyTmuxTarget(tmuxTarget, buildTmuxNotificationMessage(session, status, layout), layout);
  }
  if (config.notify?.command) {
    notifyCommand(config.notify.command, session, status, layout);
  }
}
