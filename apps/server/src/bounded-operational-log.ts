import {
  appendFile,
  chmod,
  rename,
  stat,
  unlink,
} from "node:fs/promises";

import { type OperationalLogSink } from "@torsor/operational-logging";

export interface BoundedOperationalLogSinkOptions {
  readonly path: string;
  readonly maximumBytes: number;
}

export class OperationalLogFileError extends Error {
  readonly code = "operational_log_file_error";

  constructor() {
    super("The operational log file could not be written.");
    this.name = "OperationalLogFileError";
  }
}

export class BoundedOperationalLogSink implements OperationalLogSink {
  readonly #path: string;
  readonly #previousPath: string;
  readonly #maximumBytes: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: BoundedOperationalLogSinkOptions) {
    if (!options.path) {
      throw new Error("The operational log path must not be empty.");
    }
    if (
      !Number.isSafeInteger(options.maximumBytes) ||
      options.maximumBytes < 65_536 ||
      options.maximumBytes > 16_777_216
    ) {
      throw new Error(
        "The operational log maximum must be between 65536 and 16777216 bytes.",
      );
    }
    this.#path = options.path;
    this.#previousPath = `${options.path}.1`;
    this.#maximumBytes = options.maximumBytes;
  }

  write(line: string): Promise<void> {
    const write = this.#tail.then(() => this.#write(line));
    this.#tail = write.catch(() => undefined);
    return write;
  }

  async #write(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line);
    if (bytes > this.#maximumBytes) {
      throw new OperationalLogFileError();
    }
    try {
      const currentBytes = await fileSize(this.#path);
      if (currentBytes > 0 && currentBytes + bytes > this.#maximumBytes) {
        await removeIfPresent(this.#previousPath);
        await rename(this.#path, this.#previousPath);
      }
      await appendFile(this.#path, line, {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
      await chmod(this.#path, 0o600);
    } catch (error) {
      if (error instanceof OperationalLogFileError) throw error;
      throw new OperationalLogFileError();
    }
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
