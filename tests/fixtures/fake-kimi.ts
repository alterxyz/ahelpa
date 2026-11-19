// A stand-in for the Kimi Code TUI, used by tests/e2e.test.ts through a `kimi`
// wrapper on PATH. It draws the screens the real Kimi driver recognizes (the
// session box, the boxed composer, `❯` user turns, `● Using` tool rows, the
// spinner, the sentinels) and reads what `tmux send-keys` types, so the real
// CLI, daemon and tmux can be exercised without a model, a login or a network.
//
// Behavior is chosen by directives in the task text, e.g. `[fake:spawn]`:
//   remember=<x>  keep <x> in this native session's state file
//   recall        the summary quotes what was remembered (proves `resume` reopened it)
//   release=<path> keep working until that file exists (otherwise the turn takes 0.8 s)
//   spawn         run `sleep 600` as a tool child for the turn
//   hold          never finish the turn (spinner and tool row stay up)
//   need-help     write a partial summary, print NEED_HELP, and wait for an answer
// A line that is not a task instruction is read as the answer to NEED_HELP.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const resumed = args.indexOf("--session");
const nativeId = resumed >= 0 ? args[resumed + 1] : `session_${crypto.randomUUID()}`;
const stateFile = join(process.env.HOME ?? ".", ".fake-kimi", `${nativeId}.json`);
let state: { marker?: string } = {};
try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
const save = () => {
  mkdirSync(join(stateFile, ".."), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));
};
save();

const out = (text: string) => process.stdout.write(`${text}\n`);
const composer = () => out([
  "╭──────────────────────────────────╮",
  "│ >                                │",
  "╰──────────────────────────────────╯",
  " Never Ask  fake-kimi thinking: high",
].join("\n"));

const row = (text: string) => `│ ${text.padEnd(55)} │`;
out(`╭${"─".repeat(57)}╮`);
out(row("Welcome to Kimi Code!"));
out(row(`Session: ${nativeId}`));
out(`╰${"─".repeat(57)}╯`);
composer();

function directives(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/\[fake:([a-z-]+)(?:=([^\]]*))?\]/g)].map(m => [m[1], m[2] ?? ""]));
}

let helpSummary: string | null = null; // set while NEED_HELP waits for an answer
let summaryPath: string | undefined; // the answer to NEED_HELP is not an instruction, so it reuses the last one

async function turn(line: string): Promise<void> {
  // Clipped like a narrow TUI would; it also keeps the echoed instruction from ever being a sentinel line.
  out(` ❯ ${line.slice(0, 70)}`);
  const taskFile = /described in (\S+\.md)\./.exec(line)?.[1];
  summaryPath = /create (\S+summary\.md) /.exec(line)?.[1] ?? summaryPath;
  const answering = helpSummary !== null;
  const task = taskFile ? readFileSync(taskFile, "utf8").split("\n\n---\n\n")[0] : line;
  const d = directives(task);
  const headline = task.replace(/\[fake:[^\]]*\]/g, "").trim().split("\n")[0];
  out(" ● Read 1 file");
  let tool: ReturnType<typeof Bun.spawn> | null = null;
  if ("spawn" in d) {
    tool = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] });
    out(" ● Using Shell (sleep 600)");
  }
  out(" ⠇ thinking…");
  composer();
  if ("hold" in d) return new Promise(() => {});
  if (d.release) while (!existsSync(d.release)) await Bun.sleep(50);
  else await Bun.sleep(800);
  tool?.kill();

  if (d.remember) { state.marker = d.remember; save(); }
  const lines = [`# fake-agent summary`, ``, `task: ${headline}`];
  if ("recall" in d) lines.push(`recalled=${state.marker ?? "nothing"}`);
  if (answering) lines.push(helpSummary!, `answer: ${line}`);
  const blocked = "need-help" in d && !answering;
  if (blocked) lines.push("blocked: need a colour");
  if (summaryPath) writeFileSync(summaryPath, `${lines.join("\n")}\n`);
  out(` ● Used Write (summary.md) · ${lines.length} lines`);
  if (blocked) {
    helpSummary = lines.join("\n");
    out(" ● [AHELPA:NEED_HELP:input]");
  } else {
    helpSummary = null;
    out(" ● [AHELPA:DONE]");
  }
  composer();
}

let typed = "";
let queue = Promise.resolve();
process.stdin.setRawMode?.(true);
process.stdin.on("data", chunk => {
  for (const ch of chunk.toString()) {
    if (ch !== "\r" && ch !== "\n") { typed += ch; continue; }
    const line = typed.trim();
    typed = "";
    if (!line) continue;
    if (line === "/exit") {
      out(`To resume this session: kimi -r ${nativeId}`);
      process.exit(0);
    }
    queue = queue.then(() => turn(line));
  }
});
