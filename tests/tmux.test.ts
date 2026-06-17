import { describe, test, expect, afterEach } from "bun:test";
import { Tmux } from "../src/tmux";

const TEST_SESSION = "ahelpa-test-tmux";

describe("Tmux", () => {
  afterEach(async () => {
    try { await Tmux.kill(TEST_SESSION); } catch {}
  });

  test("creates and detects session", async () => {
    await Tmux.create(TEST_SESSION, "echo hello");
    const exists = await Tmux.hasSession(TEST_SESSION);
    expect(exists).toBe(true);
  });

  test("captures pane output", async () => {
    await Tmux.create(TEST_SESSION, "echo 'AHELPA_TEST_OUTPUT'");
    await Bun.sleep(500);
    const output = await Tmux.capture(TEST_SESSION, 20);
    expect(output).toContain("AHELPA_TEST_OUTPUT");
  });

  test("sends keys", async () => {
    await Tmux.create(TEST_SESSION, "bash");
    await Bun.sleep(300);
    await Tmux.sendKeys(TEST_SESSION, "echo SENT_BY_AHELPA");
    await Bun.sleep(500);
    const output = await Tmux.capture(TEST_SESSION, 20);
    expect(output).toContain("SENT_BY_AHELPA");
  });

  test("sends Enter even when text is empty", async () => {
    await Tmux.create(TEST_SESSION, 'bash -lc "read _; echo EMPTY_ENTER_OK; exec bash"');
    await Bun.sleep(300);
    await Tmux.sendKeys(TEST_SESSION, "");
    await Bun.sleep(500);
    const output = await Tmux.capture(TEST_SESSION, 20);
    expect(output).toContain("EMPTY_ENTER_OK");
  });

  test("kills session", async () => {
    await Tmux.create(TEST_SESSION, "bash");
    await Tmux.kill(TEST_SESSION);
    const exists = await Tmux.hasSession(TEST_SESSION);
    expect(exists).toBe(false);
  });

  test("lists sessions", async () => {
    await Tmux.create(TEST_SESSION, "bash");
    const sessions = await Tmux.listSessions();
    expect(sessions.some(s => s === TEST_SESSION)).toBe(true);
  });
});
