// Mutation ablation: which test files kill each hand-written mutant?
// Used for docs/superpowers/plans/2026-11-19-test-suite-ablation.md.
//
// Run it from the root of a throwaway git copy of the repository: `run` edits src/
// and restores each file with `git checkout`, and refuses to start on a dirty tree.
//
//   bun scripts/mutation-ablation.ts coverage <dir>
//     Runs every tests/*.test.ts alone with lcov coverage into <dir>/<file>/ and writes
//     <dir>/line-tests.json: {"src/x.ts:12": ["a.test.ts", ...]} for covered src/ lines.
//
//   bun scripts/mutation-ablation.ts run <mutants.jsonl> <out.tsv> [--coverage <line-tests.json>] [--timeout <s>]
//     One mutant per line:
//       {"id":"m1","file":"src/x.ts","line":12,"span":1,"find":"===","replace":"!==",
//        "candidates":["a.test.ts"],"others":["b.test.ts"],"note":"why"}
//     `find` must occur in lines line..line+span-1 (use \n between lines). Every candidate
//     runs; `others` (or, with --coverage, every other file covering those lines) run in
//     order and stop at the first failure. A candidate's kill is exclusive when no other
//     file fails. Rows already in <out.tsv> are skipped, so a run can be resumed.
//     Status: killed, survived, stillborn (does not parse), invalid (find text not there).
//
// Machine load causes false kills (timing-bound tests miss their limits), which make a
// file look redundant. Confirm a deciding kill by rerunning that file alone.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const [command, ...args] = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const testFiles = () => readdirSync("tests").filter((f) => f.endsWith(".test.ts")).sort();
const fails = (test: string, timeoutMs: number) =>
  Bun.spawnSync(["bun", "test", `./tests/${test}`], { timeout: timeoutMs, stdout: "ignore", stderr: "ignore" }).exitCode !== 0;

if (command === "coverage") {
  const dir = args[0];
  const byLine: Record<string, string[]> = {};
  for (const test of testFiles()) {
    const out = join(dir, test);
    mkdirSync(out, { recursive: true });
    Bun.spawnSync(["bun", "test", `./tests/${test}`, "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${out}`], { stdout: "ignore", stderr: "ignore" });
    if (!existsSync(join(out, "lcov.info"))) continue;
    let file = "";
    for (const line of readFileSync(join(out, "lcov.info"), "utf8").split("\n")) {
      if (line.startsWith("SF:")) file = line.slice(3);
      else if (line.startsWith("DA:") && file.startsWith("src/")) {
        const [n, hits] = line.slice(3).split(",");
        if (Number(hits) > 0) (byLine[`${file}:${n}`] ??= []).push(test);
      }
    }
  }
  writeFileSync(join(dir, "line-tests.json"), JSON.stringify(byLine));
} else if (command === "run") {
  const [spec, out] = args;
  const timeoutMs = Number(option("--timeout") ?? 120) * 1000;
  const coverage: Record<string, string[]> = option("--coverage") ? JSON.parse(readFileSync(option("--coverage")!, "utf8")) : {};
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a]);
  if (String(git("status", "--porcelain", "src").stdout).trim()) throw new Error("src/ has uncommitted changes; run in a clean copy");
  const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").slice(1).map((l) => l.split("\t")[0]) : []);
  if (!existsSync(out)) writeFileSync(out, "id\tfile\tline\tstatus\tkilled_by\tsurvived_in\tcandidates\tnote\n");
  const row = (m: any, status: string, killed: string[] = [], survived: string[] = []) =>
    appendFileSync(out, [m.id, m.file, m.line, status, killed.join(","), survived.join(","), m.candidates.join(","), String(m.note ?? "").replace(/[\t\n]/g, " ")].join("\t") + "\n");
  for (const raw of readFileSync(spec, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    const m = JSON.parse(raw);
    if (done.has(m.id)) continue;
    const span = m.span ?? 1;
    const lines = readFileSync(m.file, "utf8").split("\n");
    const block = lines.slice(m.line - 1, m.line - 1 + span).join("\n");
    if (!block.includes(m.find)) { row(m, "invalid"); continue; }
    lines.splice(m.line - 1, span, ...block.replace(m.find, m.replace).split("\n"));
    const mutated = lines.join("\n");
    try { new Bun.Transpiler({ loader: "ts" }).transformSync(mutated); } catch { row(m, "stillborn"); continue; }
    let others: string[] = m.others;
    if (!others) {
      const covering = new Set<string>();
      for (let n = m.line; n < m.line + span; n++) for (const t of coverage[`${m.file}:${n}`] ?? []) covering.add(t);
      others = [...covering].filter((t) => !m.candidates.includes(t));
    }
    const killed: string[] = [], survived: string[] = [];
    writeFileSync(m.file, mutated);
    try {
      for (const t of m.candidates) (fails(t, timeoutMs) ? killed : survived).push(t);
      for (const t of others) { if (fails(t, timeoutMs)) { killed.push(t); break; } survived.push(t); }
    } finally {
      git("checkout", "--", m.file);
    }
    row(m, killed.length ? "killed" : "survived", killed, survived);
  }
} else {
  console.error("usage: bun scripts/mutation-ablation.ts coverage <dir> | run <mutants.jsonl> <out.tsv> [--coverage <line-tests.json>] [--timeout <s>]");
  process.exit(2);
}
