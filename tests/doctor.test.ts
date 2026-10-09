import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let root: string;
let bin: string;
let home: string;
let project: string;

function fixture(path: string, content: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function stub(name: string, body = 'if [ "$1" = "--version" ]; then printf "fixture 1.2.3\\n"; else exit 91; fi') {
  const path = join(bin, name);
  fixture(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function doctor(args: string[] = [], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, cli, "doctor", ...args], {
    cwd: project,
    env: {
      PATH: bin, HOME: home, CODEX_HOME: join(home, ".codex"),
      AHELPA_HOME: join(root, "runtime"), AHELPA_TMP_DIR: join(root, "fifo"),
      // Source-mode Bun caches transpiled modules before CLI code runs. The
      // compiled install has no such cache; isolate application writes here.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      ...env,
    },
    stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
}

function report(args: string[] = [], env: Record<string, string> = {}) {
  const result = doctor(args, env);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

function snapshot(path: string): Record<string, string> {
  return Object.fromEntries(readdirSync(path, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return [file.slice(path.length), entry.isFile() ? readFileSync(file).toString("base64") : "directory"];
    }));
}

function kimiMetadata() {
  stub("kimi", 'exit 93\n# KIMI_BUILD_INFO = { version: optionalBuildString("0.37.2"), forkVersion: optionalBuildString("0.1.34") };');
}

function kimiConfig(auth = 'api_key = "fixture-secret"', directory = join(home, ".kimi-code")) {
  fixture(join(directory, "config.toml"), `default_model = "fixture"\n[models.fixture]\nprovider = "fixture"\n[providers.fixture]\ntype = "kimi"\n${auth}\n`);
}

beforeEach(() => {
  const fixtureRoot = resolve(import.meta.dir, "../.ahelpa");
  mkdirSync(fixtureRoot, { recursive: true });
  root = mkdtempSync(join(fixtureRoot, "doctor-test-"));
  bin = join(root, "bin"); home = join(root, "home"); project = join(root, "project");
  for (const dir of [bin, home, project, join(root, "runtime"), join(root, "fifo")]) mkdirSync(dir);
  stub("tmux", "exit 92"); // doctor must only resolve it, never create/connect to a server
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("doctor", () => {
  test("reports present and missing agents with JSON reasons, using no model calls", () => {
    stub("claude");
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    const output = report();
    expect(output.project).toBe(project);
    expect(output.tmux).toMatchObject({ present: true, executable: join(bin, "tmux") });
    expect(output.agents["claude-code"]).toMatchObject({ executable: join(bin, "claude"), version: "1.2.3", locally_ready: true, reasons: [] });
    for (const name of ["codex", "kimi"]) {
      expect(output.agents[name]).toMatchObject({ executable: null, version: null, locally_ready: false, reasons: ["binary not found"] });
    }
  });

  test("the process entry point writes nothing, including config, runtime, project and FIFO roots", () => {
    stub("claude"); stub("codex"); stub("kimi");
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    fixture(join(home, ".codex/auth.json"), '{"OPENAI_API_KEY":"fixture-secret"}');
    const before = snapshot(root);
    report();
    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(join(root, "runtime"))).toEqual([]);
    expect(readdirSync(join(root, "fifo"))).toEqual([]);
    report([], { AHELPA_HOME: join(root, "absent-runtime"), AHELPA_TMP_DIR: join(root, "absent-fifo") });
    expect(snapshot(root)).toEqual(before);
  });

  test("selects one agent and resolves --project relative to the caller", () => {
    stub("claude");
    const other = join(project, "nested"); mkdirSync(other);
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [other]: { hasTrustDialogAccepted: true } } }));
    const output = report(["claude-code", "--project", "nested"]);
    expect(output.project).toBe(other);
    expect(Object.keys(output.agents)).toEqual(["claude-code"]);
    expect(output.agents["claude-code"].locally_ready).toBe(true);
  });

  test("missing tmux makes even a configured agent not ready", () => {
    rmSync(join(bin, "tmux")); stub("codex");
    fixture(join(home, ".codex/auth.json"), '{"OPENAI_API_KEY":"fixture-secret"}');
    const output = report(["codex"]);
    expect(output.tmux.present).toBe(false);
    expect(output.agents.codex.locally_ready).toBe(false);
    expect(output.agents.codex.reasons).toContain("tmux not found");
  });

  test("reports untrusted and malformed Claude config without disclosing content", () => {
    stub("claude");
    expect(report(["claude-code"]).agents["claude-code"].locally_ready).toBe(false);
    fixture(join(home, ".claude.json"), '{"secret":"fixture-secret", invalid');
    const output = report(["claude-code"]);
    expect(output.agents["claude-code"].locally_ready).toBe("unknown");
    expect(JSON.stringify(output)).not.toContain("fixture-secret");
  });

  test("Claude accepts trusted ancestors within a Git root, without trusting siblings or higher ancestors", () => {
    stub("claude");
    const child = join(project, "nested"); mkdirSync(child);
    mkdirSync(join(project, ".git"));
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    expect(report(["claude-code", "--project", child]).agents["claude-code"].locally_ready).toBe(true);
    for (const trusted of [root, `${project}-sibling`]) {
      fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true } } }));
      expect(report(["claude-code", "--project", child]).agents["claude-code"].locally_ready).toBe(false);
    }
  });

  test("Claude ancestor trust is unknown for worktree markers, but exact trust remains usable", () => {
    stub("claude");
    fixture(join(project, ".git"), "gitdir: ../somewhere\n");
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
    expect(report(["claude-code"]).agents["claude-code"].locally_ready).toBe("unknown");
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    expect(report(["claude-code"]).agents["claude-code"].locally_ready).toBe(true);
  });

  test("Claude honours config directory overrides and the legacy config precedence", () => {
    stub("claude");
    const custom = join(home, "custom-claude");
    fixture(join(custom, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    expect(report(["claude-code"], { CLAUDE_CONFIG_DIR: custom }).agents["claude-code"].locally_ready).toBe(true);
    fixture(join(custom, ".config.json"), '{}');
    expect(report(["claude-code"], { CLAUDE_CONFIG_DIR: custom }).agents["claude-code"].locally_ready).toBe(false);
  });

  test("Claude custom OAuth uses its separate trust config", () => {
    stub("claude");
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    const env = { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://fixture.invalid" };
    expect(report(["claude-code"], env).agents["claude-code"].locally_ready).toBe(false);
    fixture(join(home, ".claude-custom-oauth.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    expect(report(["claude-code"], env).agents["claude-code"].locally_ready).toBe(true);
  });

  test("Codex auth uses CODEX_HOME and distinguishes missing, present, and unknown shape", () => {
    stub("codex");
    const custom = join(home, "custom-codex");
    expect(report(["codex"], { CODEX_HOME: custom }).agents.codex.locally_ready).toBe(false);
    fixture(join(custom, "auth.json"), '{"tokens":{"access_token":"fixture-secret","refresh_token":"fixture-refresh","id_token":"fixture-id"}}');
    const output = report(["codex"], { CODEX_HOME: custom });
    expect(output.agents.codex.locally_ready).toBe(true);
    expect(JSON.stringify(output)).not.toContain("fixture-secret");
    fixture(join(custom, "auth.json"), '{"future_auth":"fixture-secret"}');
    expect(report(["codex"], { CODEX_HOME: custom }).agents.codex.locally_ready).toBe("unknown");
    fixture(join(custom, "auth.json"), '{}');
    expect(report(["codex"], { CODEX_HOME: custom }).agents.codex.locally_ready).toBe(false);
  });

  test("Codex keyring, auto storage and malformed files stay unknown", () => {
    stub("codex");
    for (const store of ["keyring", "auto", "ephemeral", "future"]) {
      fixture(join(home, ".codex/config.toml"), `cli_auth_credentials_store = "${store}"`);
      expect(report(["codex"]).agents.codex.locally_ready).toBe("unknown");
    }
    fixture(join(home, ".codex/config.toml"), 'malformed fixture-secret');
    expect(report(["codex"]).agents.codex.locally_ready).toBe("unknown");
    fixture(join(home, ".codex/config.toml"), 'cli_auth_credentials_store = "file"');
    fixture(join(home, ".codex/auth.json"), '{"fixture-secret":');
    const output = report(["codex"]);
    expect(output.agents.codex.locally_ready).toBe("unknown");
    expect(JSON.stringify(output)).not.toContain("fixture-secret");
  });

  test("unknown credential shapes are never treated as a known logout", () => {
    stub("codex"); stub("claude");
    for (const auth of ['{"tokens":{"future_token":"fixture-secret"}}', '{"OPENAI_API_KEY":123}', '{"tokens":"fixture-secret"}']) {
      fixture(join(home, ".codex/auth.json"), auth);
      expect(report(["codex"]).agents.codex.locally_ready).toBe("unknown");
    }
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: "yes" } } }));
    expect(report(["claude-code"]).agents["claude-code"].locally_ready).toBe("unknown");
  });

  test("Kimi reads static version metadata and configured auth without executing its bootstrap", () => {
    kimiMetadata(); kimiConfig();
    const before = snapshot(root);
    const output = report(["kimi"]);
    expect(output.agents.kimi).toMatchObject({ version: "0.1.34", locally_ready: true, reasons: [] });
    expect(JSON.stringify(output)).not.toContain("fixture-secret");
    expect(snapshot(root)).toEqual(before);
    stub("kimi");
    expect(report(["kimi"]).agents.kimi.locally_ready).toBe("unknown");
  });

  test("Kimi checks default-model config, provider auth, and malformed TOML", () => {
    kimiMetadata();
    expect(report(["kimi"]).agents.kimi.reasons).toContain("config not found");
    fixture(join(home, ".kimi-code/config.toml"), '{} invalid fixture-secret');
    expect(report(["kimi"]).agents.kimi.locally_ready).toBe("unknown");
    fixture(join(home, ".kimi-code/config.toml"), 'default_model = "absent"');
    expect(report(["kimi"]).agents.kimi.reasons).toContain("default model or provider not found");
    kimiConfig('');
    expect(report(["kimi"]).agents.kimi.locally_ready).toBe(false);
    kimiConfig('[providers.fixture.env]\nKIMI_API_KEY = "fixture-secret"');
    expect(report(["kimi"]).agents.kimi.locally_ready).toBe(true);
    kimiConfig('[providers.fixture.env]\nOPENAI_API_KEY = "fixture-secret"');
    expect(report(["kimi"]).agents.kimi.locally_ready).toBe(false);
  });

  test("Kimi unsupported provider types and service identities remain unknown", () => {
    kimiMetadata();
    for (const type of ["future", "vertexai"]) {
      fixture(join(home, ".kimi-code/config.toml"), `default_model = "fixture"\n[models.fixture]\nprovider = "fixture"\n[providers.fixture]\ntype = "${type}"\n`);
      expect(report(["kimi"]).agents.kimi.locally_ready).toBe("unknown");
    }
  });

  test("Kimi file OAuth checks presence only; keyring and malformed auth are unknown", () => {
    kimiMetadata();
    const custom = join(home, "custom-kimi");
    const oauth = (store: string) => kimiConfig(`[providers.fixture.oauth]\nstorage = "${store}"\nkey = "fixture-oauth"`, custom);
    oauth("file");
    expect(report(["kimi"], { KIMI_CODE_HOME: custom }).agents.kimi.locally_ready).toBe(false);
    fixture(join(custom, "credentials/fixture-oauth.json"), '{"access_token":"fixture-secret"}');
    expect(report(["kimi"], { KIMI_CODE_HOME: custom }).agents.kimi.locally_ready).toBe(true);
    fixture(join(custom, "credentials/fixture-oauth.json"), '{"access_token":""}');
    expect(report(["kimi"], { KIMI_CODE_HOME: custom }).agents.kimi.locally_ready).toBe(false);
    fixture(join(custom, "credentials/fixture-oauth.json"), 'malformed fixture-secret');
    expect(report(["kimi"], { KIMI_CODE_HOME: custom }).agents.kimi.locally_ready).toBe("unknown");
    oauth("keyring");
    expect(report(["kimi"], { KIMI_CODE_HOME: custom }).agents.kimi.locally_ready).toBe("unknown");
  });

  test("Kimi model environment overrides work without a config file", () => {
    kimiMetadata();
    expect(report(["kimi"], { KIMI_MODEL_NAME: "fixture" }).agents.kimi.locally_ready).toBe(false);
    expect(report(["kimi"], { KIMI_MODEL_NAME: "fixture", KIMI_MODEL_API_KEY: "fixture-secret" }).agents.kimi.locally_ready).toBe(true);
  });

  test("missing tmux takes precedence over unknown auth", () => {
    rmSync(join(bin, "tmux")); stub("codex");
    fixture(join(home, ".codex/auth.json"), 'malformed');
    expect(report(["codex"]).agents.codex.locally_ready).toBe(false);
  });

  test("version probes are bounded and run from the selected project", () => {
    stub("codex", 'if [ "$PWD" != "$EXPECTED_PROJECT" ]; then exit 91; fi\nprintf "codex-cli 1.2.3\\n"');
    fixture(join(home, ".codex/auth.json"), '{"OPENAI_API_KEY":"fixture-secret"}');
    expect(report(["codex"], { EXPECTED_PROJECT: project }).agents.codex.locally_ready).toBe(true);
    stub("codex", 'while :; do :; done');
    const start = performance.now();
    const output = report(["codex"]);
    expect(output.agents.codex.locally_ready).toBe("unknown");
    expect(performance.now() - start).toBeLessThan(5000);
  });

  test("a failed version probe is unknown and never exposes stderr or arbitrary output", () => {
    stub("claude", 'printf "fixture-secret\\n"; printf "fixture-secret\\n" >&2; exit 1');
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    const output = report(["claude-code"]);
    expect(output.agents["claude-code"].version).toBeNull();
    expect(output.agents["claude-code"].locally_ready).toBe("unknown");
    expect(JSON.stringify(output)).not.toContain("fixture-secret");
  });

  test.each([
    { args: ["no-such-agent"] }, { args: ["codex", "kimi"] }, { args: ["--project"] },
    { args: ["--bogus"] }, { args: ["--project", "absent"] },
  ])("rejects invalid input read-only: $args", ({ args }) => {
    const before = snapshot(root);
    expect(doctor([...args]).exitCode).toBe(1);
    expect(snapshot(root)).toEqual(before);
  });

  test("resolves relative PATH from the selected project, including Codex launch resolution", () => {
    const local = join(project, "bin"); mkdirSync(local);
    const previous = bin; bin = local; stub("codex"); stub("tmux"); bin = previous;
    fixture(join(home, ".codex/auth.json"), '{"OPENAI_API_KEY":"fixture-secret"}');
    const output = report(["codex"], { PATH: "bin" });
    expect(output.agents.codex.executable).toBe(join(local, "codex"));
    expect(output.agents.codex.locally_ready).toBe(true);
  });
});
