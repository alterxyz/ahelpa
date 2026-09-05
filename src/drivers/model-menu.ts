import type { DriverRuntime } from "./types";

export interface ModelMenuChoice {
  number: string;
  label: string;
  lineIndex: number;
  selected: boolean;
  disabled: boolean;
}

function normalize(value: string): string {
  // Hyphens are part of model IDs: gpt-5.4 and gpt-5.4-mini are different models.
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseModelMenuChoices(output: string): ModelMenuChoice[] {
  return output.split("\n").flatMap((line, lineIndex) => {
    const match = line.match(/^\s*(❯|›|>)?\s*(\d+)\.\s+(.+?)(?:\s{2,}| ✔|$)/);
    if (!match) return [];
    return [{
      number: match[2],
      label: match[3].trim(),
      lineIndex,
      selected: Boolean(match[1]),
      disabled: /disabled/i.test(line),
    }];
  });
}

export function findModelChoice(output: string, model: string): ModelMenuChoice {
  const wanted = normalize(model);
  const choices = parseModelMenuChoices(output);
  const exact = choices.find((candidate) => normalize(candidate.label) === wanted);
  // Keep display labels such as "Opus 4.6" and "gpt-5.5 (current)" usable,
  // without accepting a substring of another model ID or its description.
  const matches = exact ? [exact] : choices.filter((candidate) => {
    const label = normalize(candidate.label);
    return label.startsWith(`${wanted} `);
  });
  if (matches.length > 1) throw new Error(`Model "${model}" matches multiple model menu entries; use a more specific name`);
  const choice = matches[0];
  if (!choice) throw new Error(`Model "${model}" is not available in the model menu`);
  if (choice.disabled) throw new Error(`Model "${model}" is disabled in the model menu`);
  return choice;
}

export function findSelectedChoice(output: string): ModelMenuChoice {
  const choice = parseModelMenuChoices(output).find((candidate) => candidate.selected);
  if (!choice) throw new Error("Could not find the selected model menu row");
  return choice;
}

export async function waitForOutput(
  sessionId: string,
  runtime: DriverRuntime,
  predicate: (output: string) => boolean,
  description: string,
  lines: number = 80,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await runtime.sleep(250);
    const output = await runtime.capture(sessionId, lines);
    if (predicate(output)) return output;
  }
  throw new Error(`Timed out waiting for ${description}`);
}
