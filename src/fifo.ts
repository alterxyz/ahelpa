import { unlinkSync, existsSync, openSync, closeSync, writeSync, readSync, constants } from "fs";

export class FIFO {
  static async create(path: string): Promise<void> {
    // Remove existing file first
    if (existsSync(path)) {
      unlinkSync(path);
    }
    const result = await Bun.spawn(["mkfifo", path]).exited;
    if (result !== 0) {
      throw new Error(`mkfifo failed with exit code ${result}`);
    }
  }

  static async tryWrite(path: string, data: string): Promise<boolean> {
    let fd: number | null = null;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
      writeSync(fd, `${data}\n`);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENXIO" || code === "EPIPE" || code === "ENOENT") {
        return false;
      }
      throw error;
    } finally {
      if (fd !== null) {
        closeSync(fd);
      }
    }
  }

  static async read(path: string, timeoutMs: number): Promise<string | null> {
    // Non-blocking open succeeds with no writer attached; poll the fd until
    // a newline-terminated message arrives or the deadline passes. The fd
    // closes with the process, so an abandoned read leaks nothing.
    const deadline = Date.now() + timeoutMs;
    let fd: number | null = null;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    const buffer = Buffer.alloc(4096);
    let collected = "";
    try {
      while (Date.now() < deadline) {
        let bytesRead = 0;
        try {
          bytesRead = readSync(fd, buffer, 0, buffer.length, null);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw error;
        }
        if (bytesRead > 0) {
          collected += buffer.toString("utf-8", 0, bytesRead);
          if (collected.includes("\n")) {
            return collected.replace(/\n$/, "");
          }
        }
        await Bun.sleep(50);
      }
      return collected.length > 0 ? collected.replace(/\n$/, "") : null;
    } finally {
      closeSync(fd);
    }
  }

  static remove(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // ignore if already gone
    }
  }
}
