import { unlinkSync, lstatSync, openSync, closeSync, writeSync, readSync, constants } from "fs";

function hasFifo(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  // Follow no symlinks, even ones pointing to a FIFO. A wakeup path must own
  // its pipe directly; regular files and other filesystem entries are not ours.
  if (!stat.isFIFO()) throw new Error(`Refusing to use non-FIFO path: ${path}`);
  return true;
}

export class FIFO {
  static async create(path: string): Promise<void> {
    // Reuse the inode: replacing a pipe disconnects readers that already have
    // it open, including another host waiting while a task is resumed.
    if (hasFifo(path)) return;
    const creation = Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "pipe" });
    const [result, stderr] = await Promise.all([creation.exited, new Response(creation.stderr).text()]);
    // Another creator can win between lstat and mkfifo. Treat that race as
    // success only after checking the resulting entry is itself a FIFO.
    if (hasFifo(path)) return;
    if (result !== 0) {
      throw new Error(`mkfifo failed for ${path} with exit code ${result}: ${stderr.trim()}`);
    }
    throw new Error(`FIFO disappeared during creation: ${path}`);
  }

  // ponytail: sync impl behind async interface; upgrade to true async only if write ever needs to block
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
