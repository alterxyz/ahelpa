import type { DriverRuntime } from "./types";

export interface ModelMenuChoice {
  number: string;
  label: string;
  lineIndex: number;
  selected: boolean;
  disabled: boolean;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

export function parseModelMenuChoices(output: string): ModelMenuChoice[] {
  return output.split("\n").flatMap((line, lineIndex) => {
    const match = line.match(/(❯)?\s*(\d+)\.\s+(.+?)(?:\s{2,}| ✔|$)/);
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
  const choice = choices.find((candidate) => {
    const label = normalize(candidate.label);
    return label === wanted || label.startsWith(`${wanted} `) || label.includes(wanted);
  });
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
