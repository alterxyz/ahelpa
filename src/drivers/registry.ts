import type { AgentDriver, ModelCatalogEntry } from "./types";
import { claudeCodeDriver } from "./claude-code";
import { codexDriver } from "./codex";
import { kimiDriver } from "./kimi";
import { piDriver } from "./pi";
import { agyDriver } from "./agy";
import { vibeDriver } from "./vibe";

export const REMOVED_DSH_MESSAGE = "dsh was removed on 2026-11-06";

export interface HelperName {
  name: string;
  aliases: readonly string[];
  harnessId: string;
  driver: AgentDriver;
  purpose: string;
  harnessName: string;
  route: string;
  prerequisites: string;
  // A host may choose this next route; the runtime never follows it itself.
  // The source and destination are unrestricted (API -> subscription also fits).
  fallback: readonly { when: string; name: string }[];
}

// Public names and aliases are launch pointers. Stored sessions resolve by
// harnessId instead, so renaming a public pointer cannot redirect a resume.
export const HELPER_NAMES: readonly HelperName[] = [
  {
    name: "claude", aliases: ["claude-code"], harnessId: "claude-code",
    driver: { ...claudeCodeDriver, name: "claude", sessionPrefix: "claude" },
    purpose: "Advice, implementation, and review with Claude.",
    harnessName: "Claude Code", route: "Claude subscription",
    prerequisites: "Install Claude Code, sign in to the Claude subscription, and trust the project in Claude Code first.",
    fallback: [],
  },
  {
    name: "codex", aliases: ["gpt"], harnessId: "codex",
    driver: { ...codexDriver, name: "codex", sessionPrefix: "codex" },
    purpose: "Implementation and review with Codex.",
    harnessName: "OpenAI Codex CLI", route: "ChatGPT subscription",
    prerequisites: "Install Codex CLI and sign in with the ChatGPT subscription.",
    fallback: [],
  },
  {
    name: "gemini", aliases: ["agy", "antigravity"], harnessId: "agy",
    driver: { ...agyDriver, name: "gemini", sessionPrefix: "gemini" },
    purpose: "Gemini implementation and review through a Google account.",
    harnessName: "Google Antigravity CLI (agy)", route: "Google account",
    prerequisites: "Install agy >= 1.5.2 and sign in to agy with the Google account.",
    fallback: [],
  },
  {
    name: "kimi", aliases: [], harnessId: "kimi",
    driver: { ...kimiDriver, name: "kimi", sessionPrefix: "kimi" },
    purpose: "Tasks with Kimi's configured model.",
    harnessName: "Kimi Code CLI", route: "Kimi subscription",
    prerequisites: "Install Kimi Code CLI and configure its subscription sign-in and model.",
    fallback: [],
  },
  {
    name: "mistral", aliases: ["vibe"], harnessId: "vibe",
    driver: {
      ...vibeDriver, name: "mistral", sessionPrefix: "mistral",
      modelCatalog: { ...vibeDriver.modelCatalog,
        models: vibeDriver.modelCatalog.models.filter(model => model.name.startsWith("mistral-")),
      },
    },
    purpose: "Mistral tasks through the Mistral subscription.",
    harnessName: "Mistral Vibe CLI", route: "Mistral subscription (Vibe sign-in)",
    prerequisites: "Install Vibe >= 3.1.0 and Node.js, and sign in to an eligible Mistral subscription in Vibe.",
    fallback: [],
  },
  {
    name: "deepseek", aliases: ["deepseek-vibe"], harnessId: "vibe",
    driver: {
      ...vibeDriver, name: "deepseek", sessionPrefix: "deepseek",
      launchProfiles: { defaultRole: "worker", profiles: {
        worker: { model: "deepseek-v4-1-flash-1017", effort: "high" },
        reviewer: { model: "deepseek-v4-1-flash-1017", effort: "high" },
      } },
      modelCatalog: { ...vibeDriver.modelCatalog, models: [
        { name: "deepseek-v4-1-flash-1017", efforts: ["low", "high", "max"], defaultEffort: "high" },
      ] },
    },
    purpose: "DeepSeek tasks through the subscription first.",
    harnessName: "Mistral Vibe CLI", route: "Mistral subscription (Vibe sign-in)",
    prerequisites: "Install Vibe >= 3.1.0 and Node.js, sign in to Vibe, and use a Mistral subscription that includes deepseek-v4-1-flash-1017.",
    fallback: [{ when: "The first turn reports model unavailable (the Mistral subscription may not include it), or authentication fails", name: "deepseek-pi" }],
  },
  {
    name: "deepseek-pi", aliases: ["pi"], harnessId: "pi",
    driver: {
      ...piDriver, name: "deepseek-pi", sessionPrefix: "deepseek-pi",
      modelCatalog: {
        models: [{ name: "cc-switch-deep-seek/deepseek-flash", defaultEffort: "high" }],
        effortNote: "--model <provider>/<model> overrides the standard API model; --effort support is model-dependent and verified at startup. Runtime model switching and --safe are not supported.",
      },
      launchProfiles: { defaultRole: "worker", profiles: {
        worker: { model: "cc-switch-deep-seek/deepseek-flash", effort: "high" },
        reviewer: { model: "cc-switch-deep-seek/deepseek-flash", effort: "high" },
      } },
    },
    purpose: "DeepSeek through the API as the backup for deepseek.",
    harnessName: "Pi Coding Agent", route: "DeepSeek official API",
    prerequisites: "Install Pi >= 1.4.0 and Node.js; configure DeepSeek in CC-Switch and sync it to Pi so provider cc-switch-deep-seek exists.",
    fallback: [],
  },
];

export function getHelperName(name: string): HelperName {
  if (name === "dsh") throw new Error(REMOVED_DSH_MESSAGE);
  const entry = HELPER_NAMES.find(entry => entry.name === name || entry.aliases.includes(name))
    ?? HELPER_NAMES.find(entry => entry.harnessId === name);
  if (!entry) throw new Error(`Unknown helper name: "${name}".\n\n${renderNameDirectory()}`);
  return entry;
}

export function getDriver(name: string): AgentDriver {
  return getHelperName(name).driver;
}

export function getHarnessDriver(id: string): AgentDriver {
  if (id === "dsh") throw new Error(REMOVED_DSH_MESSAGE);
  const entry = HELPER_NAMES.find(entry => entry.harnessId === id);
  if (!entry) throw new Error(`Unknown harness ID: "${id}"`);
  return entry.driver;
}

export function listDrivers(): string[] {
  return HELPER_NAMES.map(entry => entry.name);
}

function renderModelLine(model: ModelCatalogEntry): string {
  const details: string[] = [];
  if (model.efforts?.length) details.push(`effort: ${model.efforts.join(", ")}`);
  if (model.defaultEffort) details.push(`default: ${model.defaultEffort}`);
  return details.length ? `  ${model.name} (${details.join("; ")})` : `  ${model.name}`;
}

// Shared second-layer disclosure for models and unknown-name errors.
export function renderNameDirectory(name?: string): string {
  const entries = name === undefined ? HELPER_NAMES : [getHelperName(name)];
  const text = entries.map(entry => {
    const { modelCatalog: catalog, launchProfiles } = entry.driver;
    const lines = [entry.name, `  ${entry.purpose}`,
      `  Aliases: ${entry.aliases.join(", ") || "none"}`,
      `  Harness: ${entry.harnessName} (ID: ${entry.harnessId})`,
      `  Route: ${entry.route}`, `  Prerequisites: ${entry.prerequisites}`,
      `  Fallback: ${entry.fallback.length ? entry.fallback.map(step => `${step.when}: host may choose ${step.name}.`).join(" ") : "Host decides whether to repair this route or explicitly choose another helper."}`,
      "  No automatic fallback; the host controls cost, permissions, and resume changes.",
    ];
    if (launchProfiles) {
      lines.push("  Launch defaults (explicit --model and --effort override these):");
      for (const [role, profile] of Object.entries(launchProfiles.profiles)) {
        if (!profile) continue;
        const defaultLabel = role === launchProfiles.defaultRole ? " (default)" : "";
        lines.push(`    ${role}${defaultLabel}: ${profile.model ?? "native default"}; effort: ${profile.effort ?? "native default"}`);
      }
      lines.push("  Model catalog (model defaults may differ from launch defaults):");
    } else lines.push("  Defaults: native model; effort: native default");
    lines.push(...catalog.models.map(renderModelLine));
    if (catalog.effortNote) lines.push(`  ${catalog.effortNote}`);
    return lines.join("\n");
  }).join("\n\n");
  return `${text}\n\nUse ahelpa models <name> for model options.`;
}
