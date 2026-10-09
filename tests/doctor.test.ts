import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
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
  const packageDir = join(bin, ".packages", name);
  const target = join(packageDir, "bin", name);
  fixture(target, `#!/bin/sh\n${body}\n`);
  chmodSync(target, 0o755);
  if (!existsSync(path)) symlinkSync(target, path);
  if (name === "codex" || name === "claude") {
    fixture(join(packageDir, "package.json"), JSON.stringify({
      name: name === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code",
      version: "1.2.3", bin: { [name]: `bin/${name}` },
    }));
  }
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
  fixture(join(directory, "config.toml"), `default_model = "fixture"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture-model"\nmax_context_size = 1024\n[providers.fixture]\ntype = "kimi"\n${auth}\n`);
}

function validCodexTokens(claims: unknown = {}) {
  // Synthetic structural JWT, never a usable signed credential.
  return { access_token: "fixture-secret", refresh_token: "fixture-refresh",
    id_token: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture` };
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
  test.each(["claude-code", "codex", "kimi"])("never executes a writing executable: %s", (agent) => {
    const binary = agent === "claude-code" ? "claude" : agent;
    stub(binary, 'printf "executed" > "$HOME/executed-marker"\nprintf "fixture 1.2.3\\n"');
    const before = snapshot(root);
    report([agent]);
    expect(existsSync(join(home, "executed-marker"))).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  test("Codex validates the whole auth shape before accepting any credentials", () => {
    stub("codex");
    const valid = validCodexTokens();
    const invalid = [
      { tokens: { access_token: "fixture-secret" } },
      { tokens: { ...valid, refresh_token: null } },
      { tokens: { ...valid, account_id: 123 } },
      { tokens: { ...valid, id_token: "fixture-id" } },
      { tokens: validCodexTokens({ email: 123 }) },
      { tokens: validCodexTokens({ "https://api.openai.com/auth": { chatgpt_account_is_fedramp: "yes" } }) },
      { OPENAI_API_KEY: "fixture-secret", auth_mode: "future" },
      { OPENAI_API_KEY: "fixture-secret", auth_mode: "chatgpt" },
      { OPENAI_API_KEY: "fixture-secret", last_refresh: 123 },
      { OPENAI_API_KEY: "fixture-secret", last_refresh: "not-a-date" },
      { OPENAI_API_KEY: "fixture-secret", last_refresh: "2026-02-30T00:00:00Z" },
      { OPENAI_API_KEY: "fixture-secret", last_refresh: "2026-10-08T24:00:00Z" },
      { OPENAI_API_KEY: "fixture-secret", tokens: { access_token: "fixture-secret" } },
    ];
    for (const auth of invalid) {
      fixture(join(home, ".codex/auth.json"), JSON.stringify(auth));
      const output = report(["codex"]);
      expect(output.agents.codex.locally_ready).toBe("unknown");
      expect(JSON.stringify(output)).not.toContain("fixture-secret");
    }
    for (const auth of [
      { OPENAI_API_KEY: "fixture-secret", auth_mode: "apikey", last_refresh: "2026-10-08T00:00:00Z" },
      { tokens: valid, auth_mode: "chatgpt", last_refresh: null },
      { tokens: valid, auth_mode: "chatgptAuthTokens" },
    ]) {
      fixture(join(home, ".codex/auth.json"), JSON.stringify(auth));
      expect(report(["codex"]).agents.codex.locally_ready).toBe(true);
    }
  });

  test("Codex selects the effective provider and does not require OpenAI auth for a local provider", () => {
    stub("codex");
    const provider = '[model_providers.local]\nname = "Fixture local"\nbase_url = "http://127.0.0.1:59999/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n';
    fixture(join(home, ".codex/config.toml"), 'model_provider = "local"\n' + provider);
    expect(report(["codex"]).agents.codex.locally_ready).toBe(true);
    fixture(join(home, ".codex/config.toml"), 'model_provider = "local"\n' + provider + 'env_key = "FIXTURE_PROVIDER_KEY"\n');
    expect(report(["codex"]).agents.codex.locally_ready).toBe(false);
    expect(report(["codex"], { FIXTURE_PROVIDER_KEY: "fixture-secret" }).agents.codex.locally_ready).toBe(true);
    fixture(join(home, ".codex/auth.json"), '{"OPENAI_API_KEY":"fixture-secret"}');
    fixture(join(home, ".codex/config.toml"), 'model_provider = "local"\n' + provider.replace('requires_openai_auth = false', 'requires_openai_auth = true') + 'env_key = "FIXTURE_PROVIDER_KEY"\n');
    expect(report(["codex"]).agents.codex.locally_ready).toBe(false);
    expect(report(["codex"], { FIXTURE_PROVIDER_KEY: "fixture-secret" }).agents.codex.locally_ready).toBe(true);
    rmSync(join(home, ".codex/auth.json"));
    for (const selection of ['model_provider = "absent"', 'model_provider = 123', 'profile = "absent"']) {
      fixture(join(home, ".codex/config.toml"), selection);
      expect(report(["codex"]).agents.codex.locally_ready).toBe("unknown");
    }
    fixture(join(home, ".codex/config.toml"), 'model_provider = "openai"');
    expect(report(["codex"]).agents.codex.locally_ready).toBe(false);
  });

  test("Codex cannot assert readiness when profile or project layers obscure the effective provider", () => {
    stub("codex");
    fixture(join(home, ".codex/auth.json"), '{"OPENAI_API_KEY":"fixture-secret"}');
    fixture(join(home, ".codex/config.toml"), 'profile = "fixture"\n[profiles.fixture]\nmodel_provider = "local"');
    expect(report(["codex"]).agents.codex.locally_ready).toBe("unknown");
    fixture(join(home, ".codex/config.toml"), '');
    fixture(join(project, ".codex/config.toml"), 'model_provider = "local"');
    expect(report(["codex"]).agents.codex.locally_ready).toBe("unknown");
  });

  test.each([
    { name: "local-invalid-model", top: "model = 123\n", extra: "" },
    { name: "invalid-model-provider", top: "model_provider = 123\n", extra: "" },
    { name: "invalid-provider-map", top: "model_providers = 123\n", extra: "" },
    { name: "invalid-provider-entry", top: "", extra: "[model_providers]\nunselected = 123\n" },
    { name: "local-invalid-unselected-provider", top: "", extra: "[model_providers.unselected]\nname = 123\n" },
    { name: "invalid-unselected-base-url", top: "", extra: "[model_providers.unselected]\nbase_url = 123\n" },
    { name: "invalid-unselected-env-key", top: "", extra: "[model_providers.unselected]\nenv_key = 123\n" },
    { name: "invalid-unselected-auth-flag", top: "", extra: "[model_providers.unselected]\nrequires_openai_auth = \"false\"\n" },
  ])("Codex rejects simple config type mismatches before accepting credentials: $name", ({ top, extra }) => {
    stub("codex");
    for (const selection of ["local", "openai"]) {
      if (selection === "openai") fixture(join(home, ".codex/auth.json"), '{"OPENAI_API_KEY":"fixture-secret"}');
      const provider = '[model_providers.local]\nname = "Fixture local"\nrequires_openai_auth = false\n';
      const config = (top.includes("model_provider =") ? "" : `model_provider = "${selection}"\n`) + top
        + (top.includes("model_providers =") ? "" : provider) + extra;
      fixture(join(home, ".codex/config.toml"), config);
      const output = report(["codex"]);
      expect(output.agents.codex.locally_ready).toBe("unknown");
      expect(output.agents.codex.reasons).toEqual(["config field types unrecognized"]);
      expect(JSON.stringify(output)).not.toContain("fixture-secret");
    }
  });

  test("Codex accepts valid simple config types without OpenAI credentials", () => {
    stub("codex");
    fixture(join(home, ".codex/config.toml"), 'model = "fixture-model"\nmodel_provider = "local"\n'
      + '[model_providers.local]\nname = "Fixture local"\nbase_url = "http://127.0.0.1:59999/v1"\nrequires_openai_auth = false\n'
      + '[model_providers.unselected]\nname = "Other provider"\nbase_url = "http://127.0.0.1:59998/v1"\nenv_key = "UNSELECTED_KEY"\nrequires_openai_auth = true\n');
    expect(report(["codex"]).agents.codex).toMatchObject({ locally_ready: true, reasons: [] });
  });

  test("Kimi requires model fields", () => {
    kimiMetadata();
    const model = 'default_model = "fixture"\n[models.fixture]\nprovider = "fixture"\n';
    const provider = '[providers.fixture]\ntype = "kimi"\napi_key = "fixture-secret"\n';
    for (const fields of ['', 'model = "fixture-model"\n', 'model = 123\nmax_context_size = 1024\n',
      'model = "fixture-model"\nmax_context_size = 0\n', 'model = "fixture-model"\nmax_context_size = 1.5\n']) {
      fixture(join(home, ".kimi-code/config.toml"), model + fields + provider);
      expect(report(["kimi"]).agents.kimi.locally_ready).toBe("unknown");
    }
  });

  test("Kimi requires mutually exclusive provider auth", () => {
    kimiMetadata();
    for (const auth of ['api_key = "fixture-secret"\n', '[providers.fixture.env]\nKIMI_API_KEY = "fixture-secret"\n']) {
      kimiConfig(auth + '[providers.fixture.oauth]\nstorage = "file"\nkey = "fixture-oauth"');
      expect(report(["kimi"]).agents.kimi.locally_ready).toBe("unknown");
    }
  });

  test("Claude normalizes exact and ancestor trust keys to NFC while preserving physical paths", () => {
    stub("claude");
    const decomposed = join(project, "cafe\u0301"); mkdirSync(decomposed);
    const physical = realpathSync(decomposed);
    const child = join(decomposed, "nested"); mkdirSync(child);
    for (const cwd of [decomposed, child]) {
      fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [physical.normalize("NFC")]: { hasTrustDialogAccepted: true } } }));
      expect(report(["claude-code", "--project", cwd]).agents["claude-code"].locally_ready).toBe(true);
    }
  });

  test("Claude trusts the canonical common repository root of a worktree without writing", () => {
    stub("claude");
    const git = Bun.which("git")!;
    const run = (args: string[]) => {
      const result = Bun.spawnSync([git, ...args], { cwd: project, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
    };
    run(["init"]);
    run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
    const worktree = join(root, "worktree");
    run(["worktree", "add", "-b", "fixture-worktree", worktree]);
    const child = join(worktree, "nested"); mkdirSync(child);
    // Make Git available without exposing real agent binaries on PATH.
    symlinkSync(git, join(bin, "git"));
    for (const trusted of [project, worktree]) {
      fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [realpathSync(trusted)]: { hasTrustDialogAccepted: true } } }));
      const before = snapshot(root);
      expect(report(["claude-code", "--project", child]).agents["claude-code"].locally_ready).toBe(true);
      expect(snapshot(root)).toEqual(before);
    }
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
    expect(report(["claude-code", "--project", child]).agents["claude-code"].locally_ready).toBe(false);
  });

  test("Claude normalizes a decomposed common repository root trust key to NFC", () => {
    stub("claude");
    const main = join(root, "cafe\u0301"); mkdirSync(main);
    const physical = realpathSync(main);
    expect(physical).not.toBe(physical.normalize("NFC"));
    const git = Bun.which("git")!;
    const run = (args: string[]) => {
      const result = Bun.spawnSync([git, ...args], { cwd: main, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
    };
    run(["init"]);
    run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
    const worktree = join(root, "worktree");
    run(["worktree", "add", "-b", "fixture-worktree", worktree]);
    const child = join(worktree, "nested"); mkdirSync(child);
    symlinkSync(git, join(bin, "git"));
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [physical.normalize("NFC")]: { hasTrustDialogAccepted: true } } }));
    const before = snapshot(root);
    expect(report(["claude-code", "--project", child]).agents["claude-code"]).toMatchObject({ locally_ready: true, reasons: [] });
    expect(snapshot(root)).toEqual(before);
  });
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
    fixture(join(custom, "auth.json"), JSON.stringify({ tokens: validCodexTokens() }));
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
      fixture(join(home, ".kimi-code/config.toml"), `default_model = "fixture"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture-model"\nmax_context_size = 1024\n[providers.fixture]\ntype = "${type}"\n`);
      const output = report(["kimi"]);
      expect(output.agents.kimi.locally_ready).toBe("unknown");
      expect(output.agents.kimi.reasons).toContain(type === "future" ? "provider type unrecognized" : "service identity auth cannot be checked read-only");
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

  test("static version probes are bounded even for a nonterminating executable", () => {
    stub("codex", 'while :; do :; done');
    fixture(join(home, ".codex/auth.json"), '{"OPENAI_API_KEY":"fixture-secret"}');
    expect(report(["codex"]).agents.codex.locally_ready).toBe(true);
    fixture(join(bin, ".packages/codex/package.json"), '{}');
    const start = performance.now();
    const output = report(["codex"]);
    expect(output.agents.codex.locally_ready).toBe("unknown");
    expect(performance.now() - start).toBeLessThan(5000);
  });

  test("missing static version metadata is unknown and never exposes arbitrary executable output", () => {
    stub("claude", 'printf "fixture-secret\\n"; printf "fixture-secret\\n" >&2; exit 1');
    fixture(join(bin, ".packages/claude/package.json"), '{}');
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    const output = report(["claude-code"]);
    expect(output.agents["claude-code"].version).toBeNull();
    expect(output.agents["claude-code"].locally_ready).toBe("unknown");
    expect(JSON.stringify(output)).not.toContain("fixture-secret");
  });

  test("Codex standalone metadata must identify the resolved executable", () => {
    stub("codex");
    const directory = join(bin, ".packages/codex");
    fixture(join(directory, "package.json"), '{}');
    fixture(join(directory, "codex-package.json"), JSON.stringify({ layoutVersion: 1, variant: "codex", version: "0.162.0", entrypoint: "bin/codex" }));
    fixture(join(home, ".codex/auth.json"), '{"OPENAI_API_KEY":"fixture-secret"}');
    expect(report(["codex"]).agents.codex.version).toBe("0.162.0");
    fixture(join(directory, "codex-package.json"), JSON.stringify({ layoutVersion: 1, variant: "codex", version: "0.162.0", entrypoint: "bin/other" }));
    expect(report(["codex"]).agents.codex.locally_ready).toBe("unknown");
  });

  test("Claude native build metadata is read without executing the binary", () => {
    stub("claude", 'exit 91\n# PACKAGE_URL:"@anthropic-ai/claude-code",README_URL:"https://code.claude.com/docs/en/overview",VERSION:"2.1.295"');
    fixture(join(bin, ".packages/claude/package.json"), '{}');
    fixture(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    expect(report(["claude-code"]).agents["claude-code"]).toMatchObject({ version: "2.1.295", locally_ready: true });
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
