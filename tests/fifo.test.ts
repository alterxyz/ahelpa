import { describe, test, expect, afterEach } from "bun:test";
import { FIFO } from "../src/fifo";
import { unlinkSync, existsSync } from "fs";

const TEST_FIFO = "/tmp/ahelpa-test.pipe";

describe("FIFO", () => {
  afterEach(() => {
    try { unlinkSync(TEST_FIFO); } catch {}
  });

  test("creates fifo file", async () => {
    await FIFO.create(TEST_FIFO);
    expect(existsSync(TEST_FIFO)).toBe(true);
  });

  test("tryWrite delivers to a blocked reader", async () => {
    await FIFO.create(TEST_FIFO);
    const readPromise = FIFO.read(TEST_FIFO, 5000);
    await Bun.sleep(100);
    const delivered = await FIFO.tryWrite(TEST_FIFO, '{"status":"done"}');
    expect(delivered).toBe(true);
    expect(await readPromise).toBe('{"status":"done"}');
  });

  test("tryWrite returns immediately when no reader is attached", async () => {
    await FIFO.create(TEST_FIFO);
    const start = Date.now();
    await FIFO.tryWrite(TEST_FIFO, '{"status":"done"}');
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("read times out", async () => {
    await FIFO.create(TEST_FIFO);
    const data = await FIFO.read(TEST_FIFO, 100);
    expect(data).toBeNull();
  });

  test("read returns null for a missing pipe", async () => {
    const data = await FIFO.read("/tmp/ahelpa-no-such.pipe", 100);
    expect(data).toBeNull();
  });

  test("remove cleans up", async () => {
    await FIFO.create(TEST_FIFO);
    FIFO.remove(TEST_FIFO);
    expect(existsSync(TEST_FIFO)).toBe(false);
  });
});
