import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export const MAX_REPORT_BYTES = 1_048_576;
export const MAX_REPORT_CHUNKS = 4096;

/** Trusted Host adapter: put resolves only after immutable content is durable. */
export interface ArtifactStorage {
  put(contentDigest: string, content: Uint8Array): Promise<void>;
  read(contentDigest: string, byteLength: number): Promise<Uint8Array>;
}

export function artifactDigest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function verifyArtifactContent(
  content: Uint8Array,
  digest: string,
  byteLength: number,
): void {
  digestHex(digest);
  if (
    !(content instanceof Uint8Array) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > MAX_REPORT_BYTES ||
    content.byteLength !== byteLength ||
    artifactDigest(content) !== digest
  ) {
    throw new Error("Artifact content integrity verification failed.");
  }
}

/** Private Host-owned storage, never a Provider/Worktree directory or OS sandbox. */
export class LocalArtifactStorage implements ArtifactStorage {
  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<LocalArtifactStorage> {
    if (!isAbsolute(root)) {
      throw new Error("Artifact storage requires an absolute private root.");
    }
    const storage = new LocalArtifactStorage(resolve(root));
    await assertDirectoryChain(dirname(storage.root));
    await createDirectory(storage.root);
    await createDirectory(join(storage.root, "sha256"));
    await createDirectory(join(storage.root, "staging"));
    await flushDirectory(storage.root);
    await flushDirectory(dirname(storage.root));
    return storage;
  }

  async put(digest: string, content: Uint8Array): Promise<void> {
    try {
      await this.#put(digest, content);
    } catch (error) {
      throw sanitizeIoError(error);
    }
  }

  async #put(digest: string, content: Uint8Array): Promise<void> {
    if (!(content instanceof Uint8Array) || content.byteLength > MAX_REPORT_BYTES) {
      throw new Error("Artifact content integrity size limit exceeded.");
    }
    const bytes = Buffer.from(content);
    verifyArtifactContent(bytes, digest, bytes.length);
    await this.#assertDirectories();
    const target = join(this.root, "sha256", digestHex(digest));
    const temporary = join(this.root, "staging", `${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.chmod(0o400);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.#assertDirectories();
      try {
        // Unlike rename, hard-link publication cannot overwrite a concurrent winner.
        await link(temporary, target);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      const existing = await this.read(digest, bytes.length);
      if (!bytes.equals(existing)) {
        throw new Error("Artifact content integrity collision.");
      }
      await flushDirectory(join(this.root, "sha256"));
    } finally {
      await unlink(temporary);
    }
  }

  async read(digest: string, byteLength: number): Promise<Uint8Array> {
    try {
      return await this.#read(digest, byteLength);
    } catch (error) {
      throw sanitizeIoError(error);
    }
  }

  async #read(digest: string, byteLength: number): Promise<Uint8Array> {
    const hex = digestHex(digest);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_REPORT_BYTES) {
      throw new Error("Artifact content integrity length is invalid.");
    }
    await this.#assertDirectories();
    const path = join(this.root, "sha256", hex);
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error("Artifact content must be a regular file, not a link.");
    }
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("Artifact content must be the same regular file.");
      }
      if (opened.size !== byteLength) {
        throw new Error("Artifact content integrity length mismatch.");
      }
      // Bounded even if an out-of-band writer grows a file after stat.
      const buffer = Buffer.alloc(byteLength + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const content = buffer.subarray(0, length);
      verifyArtifactContent(content, digest, byteLength);
      return content;
    } finally {
      await file.close();
    }
  }

  async #assertDirectories(): Promise<void> {
    await assertDirectoryChain(join(this.root, "sha256"));
    await assertDirectoryChain(join(this.root, "staging"));
  }
}

function digestHex(digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Artifact digest must be a canonical SHA-256 digest.");
  }
  return digest.slice(7);
}

async function assertDirectoryChain(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Artifact storage directories must not be links or non-directories.");
    }
  }
}

async function createDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await assertDirectoryChain(path);
}

async function flushDirectory(path: string): Promise<void> {
  // Node cannot open/flush directory handles on Windows; see MVP 23.1 durability boundary.
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sanitizeIoError(error: unknown): unknown {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^E[A-Z0-9]+$/.test(error.code)
  ) {
    // Runtime persists failures; native fs messages contain the private storage path.
    return new Error(`Artifact storage I/O failed (${error.code}).`);
  }
  return error;
}
