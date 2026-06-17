import { describe, expect, test } from "bun:test";
import { RuntimeLayout } from "../src/runtime-layout";

describe("runtime layout", () => {
  test("centralizes home, temp, archive, task, fifo, and project delivery paths", () => {
    const layout = new RuntimeLayout({
      homeDir: "/tmp/ahelpa-home",
      tmpDir: "/tmp/ahelpa-runtime",
    });

    expect(layout.ahelpaHomeDir()).toBe("/tmp/ahelpa-home/.ahelpa");
    expect(layout.stateDbPath()).toBe("/tmp/ahelpa-home/.ahelpa/state.db");
    expect(layout.daemonPidPath()).toBe("/tmp/ahelpa-home/.ahelpa/daemon.pid");
    expect(layout.daemonLogPath()).toBe("/tmp/ahelpa-home/.ahelpa/daemon.log");
    expect(layout.archiveDir()).toBe("/tmp/ahelpa-home/.ahelpa/archive");
    expect(layout.projectDeliveryDir("/tmp/project")).toBe("/tmp/project/.ahelpa");
    expect(layout.taskFilePath("codex-abc")).toBe("/tmp/ahelpa-runtime/ahelpa-task-codex-abc.md");
    expect(layout.fifoPath("codex-abc")).toBe("/tmp/ahelpa-runtime/codex-abc.pipe");
  });
});
