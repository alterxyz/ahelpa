import { Database } from "bun:sqlite";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "path";
import { defaultRuntimeLayout, mainCheckoutOf, type RuntimeLayout } from "./runtime-layout";

// IDs are also the exclusion vocabulary. Every namespace has a catch-all;
// classification is anchored to a root, never to arbitrary descendant names.
export const DISK_CATEGORIES = [
  "runtime.state", "runtime.daemon-logs", "runtime.need-help", "runtime.archive",
  "runtime.launch-failures", "runtime.other", "install.bin", "install.backups", "install.skills",
  "tmp.tasks", "tmp.pipes", "tmp.scratch", "tmp.legacy", "tmp.other", "delivery.inputs", "delivery.summary",
  "delivery.artifacts", "delivery.logs", "delivery.bridge", "delivery.mail", "delivery.other",
  "worktree.checkouts", "worktree.gitmeta", "dev.dist", "dev.node-modules", "dev.skill-bundle",
] as const;
type Category = typeof DISK_CATEGORIES[number];
type RootKind = "runtime" | "tmp" | "delivery" | Category;
interface Root { path: string; kind: RootKind }
interface Size { logicalBytes: number; allocatedBytes: number; files: number; dirs: number; symlinks: number }
interface Detail extends Size { path: string }
interface Usage extends Size { id: Category; partial: boolean; linkedElsewhereBytes: number; roots: Detail[] }
export interface DiskUsageReport {
  schema: 1;
  generatedAt: string;
  complete: boolean;
  changedDuringScan: number;
  scannedEntries: number;
  durationMs: number;
  totals: Size;
  categories: Usage[];
  excluded: string[];
  discovery: { projects: { path: string; sources: string[] }[]; worktrees: string[]; scan?: string; scanDepth: number };
  notCounted: { kind: string; path: string; target?: string }[];
  errors: { path: string; code: string }[];
  errorCount: number;
  notes: string[];
}
export interface DiskUsageOptions {
  layout?: RuntimeLayout;
  cwd?: string;
  exclude?: string;
  scan?: string;
  // Injected with the layout so tests never probe the developer's agent homes.
  env?: NodeJS.ProcessEnv;
  tempDirs?: string[];
}
const emptySize = (): Size => ({ logicalBytes: 0, allocatedBytes: 0, files: 0, dirs: 0, symlinks: 0 });
function addSize(to: Size, from: Size) {
  for (const key of ["logicalBytes", "allocatedBytes", "files", "dirs", "symlinks"] as const) to[key] += from[key];
}
export function parseDiskExclusions(value?: string): string[] {
  if (value === undefined) return [];
  const ids = [...new Set(value.split(",").map(id => id.trim()))];
  for (const id of ids) {
    if (!id || !DISK_CATEGORIES.some(category => category === id || category.startsWith(id + "."))) {
      throw new Error(`Unknown disk usage category: ${id || "(empty)"}. Categories: ${DISK_CATEGORIES.join(", ")}`);
    }
  }
  return ids;
}
function deliveryCategory(parts: string[]): Category {
  if (parts[0] === "jobs") return "delivery.mail";
  if (/^vibe-prompt-[a-f0-9-]{36}\.txt$/.test(parts[1] ?? "")) return "delivery.inputs";
  switch (parts[1]) {
    case "ask.md": case "task.md": return "delivery.inputs";
    case "summary.md": return "delivery.summary";
    case "artifacts": return "delivery.artifacts";
    case "turns.log": case "check.log": return "delivery.logs";
    case "inbox": return "delivery.mail";
    case "claude-settings.json": case "dsh-terminal.mjs": case "dsh.patch.yml":
    case "pi-terminal.mjs": case "pi-process.json": case "pi-turn-hook.mjs":
    case "vibe-terminal.mjs": case "vibe-process.json": case "ahelpa-helper.toml": case "vibe-hook": return "delivery.bridge";
    default: return "delivery.other";
  }
}
function classify(kind: RootKind, parts: string[]): Category {
  const first = parts[0] ?? "";
  if (kind === "install.bin" && /^ahelpa\.(?:pre-|backup\.)/.test(first)) return "install.backups";
  if (kind === "delivery") return deliveryCategory(parts);
  if (kind === "tmp") {
    if (first === "scratch") return "tmp.scratch";
    if (/^ahelpa-task-.*\.md$/.test(first)) return "tmp.tasks";
    if (first.endsWith(".pipe")) return "tmp.pipes";
    return "tmp.other";
  }
  if (kind !== "runtime") return kind;
  if (/^state\.db(?:-(?:wal|shm|journal))?$/.test(first)) return "runtime.state";
  if (/^daemon\.(?:log(?:\.\d+)?|stderr\.log)$/.test(first)) return "runtime.daemon-logs";
  if (first === "need-help.jsonl") return "runtime.need-help";
  if (first === "archive") return "runtime.archive";
  if (first === "launch-failures") return "runtime.launch-failures";
  if (first === "backups" || (first === "bin" && /^ahelpa\.(?:pre-|backup\.)/.test(parts[1] ?? ""))) return "install.backups";
  if (first === "bin") return "install.bin";
  // Sessions launched with --project ~ share the runtime namespace.
  if (/^(?:claude|codex|gemini|kimi|dsh|pi|agy|vibe|mistral|deepseek-pi|deepseek)-[a-f0-9]{12}$/.test(first)) return deliveryCategory(parts);
  return "runtime.other";
}

export function collectDiskUsage(options: DiskUsageOptions = {}): DiskUsageReport {
  const start = performance.now();
  const layout = options.layout ?? defaultRuntimeLayout;
  const env = options.env ?? process.env;
  const excluded = parseDiskExclusions(options.exclude);
  const isExcluded = (id: string) => excluded.some(prefix => id === prefix || id.startsWith(prefix + "."));
  const report: DiskUsageReport = {
    schema: 1, generatedAt: new Date().toISOString(), complete: true, changedDuringScan: 0,
    scannedEntries: 0, durationMs: 0, totals: emptySize(), categories: [], excluded,
    discovery: { projects: [], worktrees: [], scan: options.scan && resolve(options.scan), scanDepth: 8 },
    notCounted: [], errors: [], errorCount: 0,
    notes: [
      "Allocated = st_blocks × 512; logical = regular-file bytes. Metadata only; no content hashes.",
      "Live snapshot: concurrent writes may change sizes. Allocated is not reclaimable space: hardlinks, APFS clones and snapshots may share blocks.",
      "Not counted: agent-native sessions/temp, shared git objects, global tool caches and host-created worktrees.",
      "Discovery covers recorded/ledger projects and cwd. --scan adds historical projects; it skips symlinks, hidden directories (except .ahelpa), node_modules and directories below depth 8.",
    ],
  };
  const roots = new Map<string, Root>();
  const projects = new Map<string, Set<string>>();
  const knownIds = new Map<string, Set<string>>();
  function issue(path: string, error: unknown, usage?: Usage) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code)) { report.changedDuringScan++; return; }
    report.complete = false;
    report.errorCount++;
    if (report.errors.length < 100) report.errors.push({ path, code });
    if (usage) usage.partial = true;
  }
  function metadata(path: string): string | undefined {
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile()) return;
      if (stat.size > 8 * 1024 * 1024) {
        issue(path, { code: "METADATA_SIZE_LIMIT" }); return;
      }
      return readFileSync(path, "utf8");
    } catch (error) { issue(path, error); return; }
  }
  function children(path: string): string[] {
    try { return readdirSync(path).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") issue(path, error);
      return [];
    }
  }
  function root(path: string, kind: RootKind, configured = false) {
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) return;
      if (stat.isSymbolicLink() && !configured) {
        report.notCounted.push({ kind: "symlink", path: resolve(path), target: readlinkSync(path) });
        return;
      }
      const physical = realpathSync(path);
      // A configured runtime home can also be a project's .ahelpa.
      if (!roots.has(physical)) roots.set(physical, { path: physical, kind });
    } catch (error) { issue(path, error); }
  }
  function project(path: string, source: string) {
    if (!isAbsolute(path)) return;
    let physical = resolve(path);
    try { physical = realpathSync(path); } catch {}
    if (!projects.has(physical)) projects.set(physical, new Set());
    projects.get(physical)!.add(source);
    root(join(physical, ".ahelpa"), "delivery");
    const main = mainCheckoutOf(physical)?.main;
    if (main && main !== physical) project(main, source);
  }
  root(layout.ahelpaDir, "runtime", true);
  root(layout.tmpDir, "tmp", true);
  // Install/package/gate scripts and older versions also used OS temp directly.
  // Only enumerate names at these roots; never search unrelated temp trees.
  for (const directory of options.tempDirs ?? (options.layout ? [] : [tmpdir(), "/tmp"])) {
    for (const name of children(directory)) if (name.startsWith("ahelpa-")) root(join(directory, name), "tmp.legacy");
  }
  // Installation scripts do not follow AHELPA_HOME. Preserve that distinction.
  root(join(layout.homeDir, ".ahelpa", "bin"), "install.bin");
  root(join(layout.homeDir, ".ahelpa", "backups"), "install.backups");
  if (env.AHELPA_BIN_DIR) root(resolve(env.AHELPA_BIN_DIR), "install.bin", true);
  for (const path of [".agents/skills/ahelpa", ".codex/skills/ahelpa", ".claude/skills/ahelpa", ".config/kimi/skills/ahelpa", ".kimi/skills/ahelpa"]) {
    root(join(layout.homeDir, path), "install.skills");
  }
  root(join(layout.homeDir, ".local/bin/ahelpa"), "install.bin");

  // Never construct StateDB here: its constructor migrates and creates files.
  const dbPath = layout.stateDbPath();
  let db: Database | undefined;
  try {
    if (lstatSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
      db = new Database(dbPath, { readonly: true });
      const columns = new Set((db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(row => row.name));
      const selected = ["id", "project_path", "delivery_root", "target_result_dirs"].filter(name => columns.has(name));
      if (columns.has("project_path")) {
        const rows = db.query(`SELECT ${selected.join(", ")} FROM sessions`).all() as Record<string, string | null>[];
        for (const row of rows) {
          if (row.project_path) {
            project(row.project_path, "db");
            if (row.id) {
              let path = resolve(row.project_path);
              try { path = realpathSync(path); } catch {}
              if (!knownIds.has(path)) knownIds.set(path, new Set());
              knownIds.get(path)!.add(row.id);
            }
          }
          if (row.delivery_root) project(row.delivery_root, "db");
          if (row.target_result_dirs) {
            try {
              const dirs: unknown = JSON.parse(row.target_result_dirs);
              if (Array.isArray(dirs)) for (const dir of dirs) {
                if (typeof dir === "string" && isAbsolute(dir) && basename(dirname(dir)) === ".ahelpa") project(dirname(dirname(dir)), "db-history");
              }
            } catch { report.notes.push("A malformed target_result_dirs value was ignored."); }
          }
        }
      } else throw Object.assign(new Error("Missing sessions table"), { code: "SCHEMA" });
    } else report.notes.push("No state database: project discovery uses cwd, ledger and --scan only.");
  } catch (error) { issue(dbPath, error); }
  finally { db?.close(); }
  const ledger = metadata(layout.needHelpLedgerPath());
  if (ledger) for (const line of ledger.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry.projectPath === "string") project(entry.projectPath, "ledger");
      if (typeof entry.summaryPath === "string" && basename(dirname(dirname(entry.summaryPath))) === ".ahelpa") project(dirname(dirname(dirname(entry.summaryPath))), "ledger");
    } catch { /* An interrupted ledger append must not break discovery. */ }
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  project(cwd, "cwd");
  const checkout = mainCheckoutOf(cwd)?.main ?? cwd;
  try {
    if (JSON.parse(metadata(join(checkout, "package.json")) ?? "{}").name === "ahelpa") {
      root(join(checkout, "dist"), "dev.dist");
      root(join(checkout, "node_modules"), "dev.node-modules");
      root(join(checkout, "skill/bundle"), "dev.skill-bundle");
    }
  } catch { /* Not a source checkout. */ }

  if (options.scan) {
    function discover(path: string, depth: number) {
      let stat;
      try { stat = lstatSync(path); } catch (error) { issue(path, error); return; }
      if (!stat.isDirectory()) return;
      if (basename(path) === ".ahelpa") { project(dirname(path), "scan"); return; }
      if (metadata(join(path, ".git/HEAD"))) project(path, "scan");
      for (const name of children(path)) {
        if (name === "node_modules" || (name.startsWith(".") && name !== ".ahelpa")) continue;
        if (depth < report.discovery.scanDepth) discover(join(path, name), depth + 1);
      }
    }
    try {
      const scan = realpathSync(options.scan);
      if (!lstatSync(scan).isDirectory()) issue(scan, { code: "SCAN_NOT_DIRECTORY" });
      else discover(scan, 0);
    } catch (error) {
      // A missing requested scan root is an input problem, not a live deletion.
      const code = (error as NodeJS.ErrnoException).code;
      issue(options.scan, { code: code === "ENOENT" ? "SCAN_NOT_FOUND" : code });
    }
  }
  const seenMain = new Set<string>();
  for (const path of projects.keys()) {
    const main = mainCheckoutOf(path)?.main;
    if (!main || seenMain.has(main)) continue;
    seenMain.add(main);
    const worktrees = join(main, ".git/worktrees");
    for (const name of children(worktrees)) {
      const meta = join(worktrees, name);
      if (!/^ref: refs\/heads\/ahelpa\/[^\s/]+\s*$/.test(metadata(join(meta, "HEAD")) ?? "")) continue;
      const gitdir = metadata(join(meta, "gitdir"))?.trim();
      if (!gitdir || !isAbsolute(gitdir)) continue;
      const tree = dirname(gitdir);
      if (mainCheckoutOf(tree)?.main !== main) {
        report.notCounted.push({ kind: "stale-worktree", path: tree }); continue;
      }
      root(tree, "worktree.checkouts");
      root(meta, "worktree.gitmeta");
      root(join(tree, ".ahelpa"), "delivery");
      report.discovery.worktrees.push(tree);
    }
    const container = join(dirname(main), basename(main) + "-worktrees");
    for (const name of children(container)) {
      const tree = join(container, name);
      if (knownIds.get(tree)?.has(name)) {
        root(tree, "worktree.checkouts");
        root(join(tree, ".ahelpa"), "delivery");
        report.discovery.worktrees.push(tree);
      } else if (!report.discovery.worktrees.includes(tree)) report.notCounted.push({ kind: "unattributed-worktree", path: tree });
    }
    root(join(main, ".git/refs/heads/ahelpa"), "worktree.gitmeta");
    root(join(main, ".git/logs/refs/heads/ahelpa"), "worktree.gitmeta");
  }

  const usages = new Map<Category, Usage>();
  const details = new Map<string, Detail>();
  const hardlinks = new Map<string, { count: number; nlink: bigint; bytes: number; usage: Usage }>();
  const rootPaths = new Set(roots.keys());
  function walk(path: string, owner: Root, parts: string[], device?: bigint) {
    if (path !== owner.path && rootPaths.has(path)) return;
    const id = classify(owner.kind, parts);
    // Only namespace/session containers can acquire a more specific category.
    const canRefine = owner.kind === "delivery" ? parts.length < 2
      : owner.kind === "runtime" ? parts.length === 0 || (parts.length === 1 && (parts[0] === "bin" || /^(?:claude|codex|gemini|kimi|dsh|pi|agy|vibe|mistral|deepseek-pi|deepseek)-[a-f0-9]{12}$/.test(parts[0])))
      : (owner.kind === "tmp" || owner.kind === "install.bin") && parts.length === 0;
    if (isExcluded(id) && !canRefine) return;
    let stat;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) { issue(path, error, usages.get(id)); return; }
    report.scannedEntries++;
    if (device !== undefined && stat.isDirectory() && stat.dev !== device) {
      report.notCounted.push({ kind: "mount", path }); return;
    }
    let usage = usages.get(id);
    if (!usage) {
      usage = { id, ...emptySize(), partial: false, linkedElsewhereBytes: 0, roots: [] };
      usages.set(id, usage);
    }
    if (!isExcluded(id)) {
      const key = `${stat.dev}:${stat.ino}`;
      const previous = !stat.isDirectory() && stat.nlink > 1n ? hardlinks.get(key) : undefined;
      if (previous) previous.count++;
      else {
        const size: Size = {
          logicalBytes: stat.isFile() ? Number(stat.size) : 0,
          allocatedBytes: Number(stat.blocks) * 512,
          files: stat.isDirectory() ? 0 : 1, dirs: stat.isDirectory() ? 1 : 0,
          symlinks: stat.isSymbolicLink() ? 1 : 0,
        };
        addSize(usage, size);
        // Session/scratch-level detail stays small even with millions of files.
        const count = owner.kind === "delivery" || owner.kind === "tmp" ? (parts[0] === "scratch" ? 2 : 1) : 1;
        const bucket = join(owner.path, ...parts.slice(0, count));
        const detailKey = id + "\0" + bucket;
        let detail = details.get(detailKey);
        if (!detail) { detail = { path: bucket, ...emptySize() }; details.set(detailKey, detail); usage.roots.push(detail); }
        addSize(detail, size);
        if (!stat.isDirectory() && stat.nlink > 1n) hardlinks.set(key, { count: 1, nlink: stat.nlink, bytes: size.allocatedBytes, usage });
      }
    }
    if (stat.isDirectory()) {
      try {
        for (const name of readdirSync(path).sort()) walk(join(path, name), owner, [...parts, name], device ?? stat.dev);
      } catch (error) { issue(path, error, usage); }
    }
  }
  // Stable attribution of cross-root hardlinks; nested roots always own themselves.
  for (const owner of [...roots.values()].sort((a, b) => a.path.localeCompare(b.path))) walk(owner.path, owner, []);
  for (const link of hardlinks.values()) if (BigInt(link.count) < link.nlink) link.usage.linkedElsewhereBytes += link.bytes;
  report.categories = DISK_CATEGORIES.filter(id => !isExcluded(id)).flatMap(id => {
    const usage = usages.get(id);
    if (!usage) return [];
    usage.roots.sort((a, b) => b.allocatedBytes - a.allocatedBytes || a.path.localeCompare(b.path));
    addSize(report.totals, usage);
    return [usage];
  });
  report.discovery.projects = [...projects].map(([path, sources]) => ({ path, sources: [...sources].sort() }));
  report.discovery.worktrees = [...new Set(report.discovery.worktrees)].sort();
  report.durationMs = Math.round(performance.now() - start);
  return report;
}

export function formatDiskBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++; }
  return `${index ? bytes.toFixed(2) : bytes} ${units[index]}`;
}
export function formatDiskUsage(report: DiskUsageReport): string {
  const home = defaultRuntimeLayout.homeDir;
  const displayPath = (path: string) => path === home ? "~" : path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
  const lines = ["AhelpA disk usage (allocated blocks; logical file bytes)", "", "Category".padEnd(28) + "Files".padStart(10) + "Logical".padStart(16) + "Allocated".padStart(16)];
  function line(id: string, size: Size, partial = false) {
    const prefix = partial ? "≥ " : "";
    return id.padEnd(28) + String(size.files).padStart(10) + (prefix + formatDiskBytes(size.logicalBytes)).padStart(16) + (prefix + formatDiskBytes(size.allocatedBytes)).padStart(16);
  }
  for (const usage of report.categories) lines.push(line(usage.id, usage, usage.partial));
  lines.push(line("TOTAL", report.totals, !report.complete), "");
  const paths = new Map<string, number>();
  for (const usage of report.categories) for (const root of usage.roots) paths.set(root.path, (paths.get(root.path) ?? 0) + root.allocatedBytes);
  const largest = [...paths].filter(([, bytes]) => bytes > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (largest.length) lines.push("Largest counted paths (full detail in --json):", ...largest.map(([path, bytes]) => `  ${formatDiskBytes(bytes).padStart(12)}  ${displayPath(path)}`), "");
  lines.push(`${report.discovery.projects.length} project paths · ${report.discovery.worktrees.length} worktrees · ${report.scannedEntries} entries · ${(report.durationMs / 1000).toFixed(2)} s`);
  if (report.excluded.length) lines.push(`Excluded: ${report.excluded.join(", ")}`);
  if (report.notCounted.length) lines.push(`Not counted: ${report.notCounted.length} symlink roots / unattributed worktrees / mounts (paths in --json).`);
  if (report.changedDuringScan) lines.push(`${report.changedDuringScan} entries disappeared or changed during discovery/scan.`);
  if (!report.complete) lines.push(`INCOMPLETE: ${report.errorCount} errors; ≥ is a lower bound. ${report.errors.slice(0, 3).map(error => `${error.code}: ${displayPath(error.path)}`).join("; ")}`);
  const shared = report.categories.reduce((sum, usage) => sum + usage.linkedElsewhereBytes, 0);
  if (shared) lines.push(`${formatDiskBytes(shared)} has hardlinks outside the counted paths; deleting these paths may not free it.`);
  lines.push(...report.notes);
  return lines.join("\n");
}
