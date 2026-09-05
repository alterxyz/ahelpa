import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { isDeepStrictEqual } from "util";

export interface CodexConfigSnapshot {
  path: string;
  content: string | null;
  otherSettings: Record<string, unknown>;
}

function readConfig(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot read Codex configuration; defaults were not restored");
  }
}

function otherSettings(content: string | null): Record<string, unknown> {
  if (content === null) return {};
  let config: Record<string, unknown>;
  try {
    config = Object.fromEntries(Object.entries(Bun.TOML.parse(content)));
  } catch {
    // Parser errors can contain configuration values. Keep them out of output.
    throw new Error("Cannot safely restore Codex defaults: invalid TOML; current config was preserved");
  }
  const { model, model_reasoning_effort, ...other } = config;
  if ((model !== undefined && typeof model !== "string")
    || (model_reasoning_effort !== undefined && typeof model_reasoning_effort !== "string")) {
    throw new Error("Cannot safely restore Codex defaults: unrecognized model settings; current config was preserved");
  }
  return other;
}

export function snapshotCodexConfig(
  path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"),
): CodexConfigSnapshot {
  const content = readConfig(path);
  return { path, content, otherSettings: otherSettings(content) };
}

export function restoreCodexConfig(snapshot: CodexConfigSnapshot): void {
  const current = readConfig(snapshot.path);
  if (current === snapshot.content) return;
  if (current === null) {
    throw new Error("Cannot safely restore Codex defaults: config was removed during the switch; current state was preserved");
  }
  if (!isDeepStrictEqual(snapshot.otherSettings, otherSettings(current))) {
    throw new Error("Cannot safely restore Codex defaults: non-model settings changed during the switch; current config was preserved");
  }

  // Optimistic protection, not filesystem compare-and-swap: an external writer
  // can still race this check or change the same model fields. Avoid rewriting
  // until unrelated TOML settings have been verified against the snapshot.
  if (snapshot.content === null) {
    unlinkSync(snapshot.path);
  } else {
    writeFileSync(snapshot.path, snapshot.content);
  }
}
