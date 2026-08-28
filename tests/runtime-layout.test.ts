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

  test("accepts isolated state and temp roots without changing the process home", () => {
    const layout = new RuntimeLayout({
      ahelpaDir: "/tmp/ahelpa-isolated/state",
      tmpDir: "/tmp/ahelpa-isolated/runtime",
    });

    expect(layout.ahelpaHomeDir()).toBe("/tmp/ahelpa-isolated/state");
    expect(layout.stateDbPath()).toBe("/tmp/ahelpa-isolated/state/state.db");
    expect(layout.tmpDir).toBe("/tmp/ahelpa-isolated/runtime");
  });

  test("uses environment overrides for the default runtime layout", () => {
    const previousHome = process.env.AHELPA_HOME;
    const previousTmp = process.env.AHELPA_TMP_DIR;
    try {
      process.env.AHELPA_HOME = "/tmp/ahelpa-env/state";
      process.env.AHELPA_TMP_DIR = "/tmp/ahelpa-env/runtime";
      const layout = new RuntimeLayout();

      expect(layout.ahelpaHomeDir()).toBe("/tmp/ahelpa-env/state");
      expect(layout.tmpDir).toBe("/tmp/ahelpa-env/runtime");
    } finally {
      if (previousHome === undefined) delete process.env.AHELPA_HOME;
      else process.env.AHELPA_HOME = previousHome;
      if (previousTmp === undefined) delete process.env.AHELPA_TMP_DIR;
      else process.env.AHELPA_TMP_DIR = previousTmp;
    }
  });

  test("ignores blank environment overrides", () => {
    const previousHome = process.env.AHELPA_HOME;
    const previousTmp = process.env.AHELPA_TMP_DIR;
    try {
      process.env.AHELPA_HOME = "   ";
      process.env.AHELPA_TMP_DIR = "";
      const layout = new RuntimeLayout({ homeDir: "/tmp/ahelpa-blank-env-home" });

      expect(layout.ahelpaHomeDir()).toBe("/tmp/ahelpa-blank-env-home/.ahelpa");
      expect(layout.tmpDir).toBe("/tmp/ahelpa");
    } finally {
      if (previousHome === undefined) delete process.env.AHELPA_HOME;
      else process.env.AHELPA_HOME = previousHome;
      if (previousTmp === undefined) delete process.env.AHELPA_TMP_DIR;
      else process.env.AHELPA_TMP_DIR = previousTmp;
    }
  });
});
