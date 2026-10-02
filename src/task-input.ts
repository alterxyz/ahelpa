import { closeSync, constants, fstatSync, openSync, readFileSync } from "fs";

export function readTaskFile(filePath: string): string {
  // Open non-blocking before checking the descriptor: a FIFO (including a
  // symlink to one) must not hang, and a path swap cannot bypass the check.
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`Task file must point to a regular file: ${filePath}`);
    }
    const content = readFileSync(fd, "utf-8");
    if (!content.trim()) throw new Error("Task must not be empty");
    return content;
  } finally {
    closeSync(fd);
  }
}
