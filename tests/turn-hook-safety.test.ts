import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { shellEscape } from "../src/shell";
import { turnHookCommand, writeTurnHook } from "../src/turn-hooks";
let root: string, dir: string;
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".ahelpa", "safety-test-"));
  dir = join(root, ".ahelpa", "session-test");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const claude = JSON.stringify({ hook_event_name: "Stop", session_id: "native", prompt_id: "one" });
const codex = JSON.stringify({ type: "agent-turn-complete", "thread-id": "main", "turn-id": "one", "input-messages": ["Please read and complete the task described in fixture"] });
test("hardlinked turns.log never modifies the outside-session victim", () => {
  const victim = join(root, "outside-session.txt");
  writeFileSync(victim, "must remain unchanged\n");
  linkSync(victim, join(dir, "turns.log"));
  writeTurnHook(dir, "claude-code", claude);
  expect(readFileSync(victim, "utf8")).toBe("must remain unchanged\n");
});
test("saved Claude and Codex hooks stay silent and successful after compiled runtime moves or becomes unusable", async () => {
  const binary = join(root, "runtime 'quote' $literal 中文");
  const build = Bun.spawn([process.execPath, "build", join(process.cwd(), "src/cli.ts"), "--compile", `--outfile=${binary}`], { stdout: "pipe", stderr: "pipe" });
  const [exit, , stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const cli = join(process.cwd(), "src/cli.ts");
  const saved = (agent: "claude-code" | "codex") => turnHookCommand(dir, agent).flatMap(arg => {
    if (arg === process.execPath) return [binary];
    if (arg === cli) return [];
    return [arg.replace(`${shellEscape(process.execPath)} ${shellEscape(cli)}`, shellEscape(binary))];
  });
  const commands = { "claude-code": saved("claude-code"), codex: saved("codex") };
  const invoke = async (agent: "claude-code" | "codex") => {
    const argv = [...commands[agent], ...(agent === "codex" ? [codex] : [])];
    const child = Bun.spawn(["/bin/sh", "-c", argv.map(shellEscape).join(" ")], { stdin: agent === "claude-code" ? new Blob([claude]) : "ignore", stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
  };
  for (const agent of ["claude-code", "codex"] as const) await invoke(agent);
  const events = readFileSync(join(dir, "turns.log"), "utf8");
  expect(events).toContain('"event":"stop"');
  expect(events).toContain('"event":"turn_complete"'); // final JSON arg survived sh forwarding
  renameSync(binary, binary + ".moved");
  for (const agent of ["claude-code", "codex"] as const) await invoke(agent);
  writeFileSync(binary, "not an executable image\n");
  chmodSync(binary, 0o700);
  for (const agent of ["claude-code", "codex"] as const) await invoke(agent);
  expect(readFileSync(join(dir, "turns.log"), "utf8")).toBe(events);
}, 20000);
