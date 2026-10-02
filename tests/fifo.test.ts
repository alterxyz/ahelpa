import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FIFO } from "../src/fifo";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("FIFO", () => {
  let testDir: string;
  let testFifo: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ahelpa-fifo-"));
    testFifo = join(testDir, "test.pipe");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("creates fifo file", async () => {
    await FIFO.create(testFifo);
    expect(lstatSync(testFifo).isFIFO()).toBe(true);
  });

  test("concurrent creators share one FIFO without failing", async () => {
    await Promise.all(Array.from({ length: 16 }, () => FIFO.create(testFifo)));
    expect(lstatSync(testFifo).isFIFO()).toBe(true);
  });

  test("reusing a FIFO keeps its existing reader connected", async () => {
    await FIFO.create(testFifo);
    const before = lstatSync(testFifo);
    const reading = FIFO.read(testFifo, 2000);

    await Promise.all(Array.from({ length: 4 }, () => FIFO.create(testFifo)));
    const delivered = await FIFO.tryWrite(testFifo, "still connected");
    const message = await reading;

    expect(lstatSync(testFifo).ino).toBe(before.ino);
    expect(delivered).toBe(true);
    expect(message).toBe("still connected");
  });

  test("preserves a regular file at the requested FIFO path", async () => {
    writeFileSync(testFifo, "existing content");

    await expect(FIFO.create(testFifo)).rejects.toThrow("non-FIFO path");

    expect(readFileSync(testFifo, "utf8")).toBe("existing content");
    expect(lstatSync(testFifo).isFile()).toBe(true);
  });

  test.each([false, true])("preserves a symlink instead of following it (target exists: %s)", async (targetExists) => {
    const target = join(testDir, "target.pipe");
    if (targetExists) await FIFO.create(target);
    symlinkSync(target, testFifo);

    await expect(FIFO.create(testFifo)).rejects.toThrow("non-FIFO path");

    expect(lstatSync(testFifo).isSymbolicLink()).toBe(true);
    expect(readlinkSync(testFifo)).toBe(target);
    expect(existsSync(target)).toBe(targetExists);
  });

  test("reports creation failure when no FIFO was created", async () => {
    await expect(FIFO.create(join(testDir, "missing-parent", "test.pipe")))
      .rejects.toThrow("mkfifo failed");
  });

  test("tryWrite delivers to a blocked reader", async () => {
    await FIFO.create(testFifo);
    const readPromise = FIFO.read(testFifo, 5000);
    await Bun.sleep(100);
    const delivered = await FIFO.tryWrite(testFifo, '{"status":"done"}');
    expect(delivered).toBe(true);
    expect(await readPromise).toBe('{"status":"done"}');
  });

  test("tryWrite returns immediately when no reader is attached", async () => {
    await FIFO.create(testFifo);
    const start = Date.now();
    await FIFO.tryWrite(testFifo, '{"status":"done"}');
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("read times out", async () => {
    await FIFO.create(testFifo);
    const data = await FIFO.read(testFifo, 100);
    expect(data).toBeNull();
  });

  test("read returns null for a missing pipe", async () => {
    const data = await FIFO.read(testFifo, 100);
    expect(data).toBeNull();
  });

  test("remove cleans up", async () => {
    await FIFO.create(testFifo);
    FIFO.remove(testFifo);
    expect(existsSync(testFifo)).toBe(false);
  });
});
