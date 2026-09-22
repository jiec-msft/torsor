import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import type { FileIdentity, PublicationPrimitives } from "./artifact-native.js";
import { record } from "./facts.js";
import { toJsonl } from "./transcript.js";
import type { RunResult } from "./index.js";

export class ArtifactError extends Error {}

const names = ["result.json", "transcript.jsonl", "manifest.json"] as const;
const identitySchema = z.strictObject({
  dev: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), ino: z.string().regex(/^[1-9][0-9]{0,19}$/),
});
const claimSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("acp-artifact-attempt"), state: z.literal("staging"),
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), commitId: z.uuidv4(), destination: z.string().max(74),
  directory: identitySchema, claim: identitySchema, bundle: identitySchema,
  files: z.strictObject({ "result.json": identitySchema, "transcript.jsonl": identitySchema, "manifest.json": identitySchema }),
});
type Claim = z.infer<typeof claimSchema>;
const attemptPattern = /^\.acp-artifact-([a-zA-Z][a-zA-Z0-9_-]{0,63})-([0-9a-f-]{36})$/;
const encode = (value: unknown) => JSON.stringify(value) + "\n";
const identity = (stat: BigIntStats): FileIdentity => ({ dev: stat.dev.toString(), ino: stat.ino.toString() });
const matches = (stat: BigIntStats, id: FileIdentity) => stat.dev.toString() === id.dev && stat.ino.toString() === id.ino;
const regular = (stat: BigIntStats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;

async function stat(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (record(error) && error.code === "ENOENT") return undefined; throw error; }
}

async function entries(path: string, limit: number): Promise<string[] | undefined> {
  const result: string[] = [];
  for await (const entry of await opendir(path)) {
    if (result.length === limit) return undefined;
    result.push(entry.name);
  }
  return result;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform !== "linux") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readClaim(handle: FileHandle): Promise<Claim | undefined> {
  if ((await handle.stat()).size > 8192) return undefined;
  const buffer = Buffer.alloc(8193);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  if (length > 8192) return undefined;
  const text = buffer.subarray(0, length).toString("utf8");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
  const parsed = claimSchema.safeParse(value);
  return parsed.success && encode(parsed.data) === text ? parsed.data : undefined;
}

async function validLayout(path: string, claim: Claim, handle: FileHandle): Promise<boolean> {
  const directory = await stat(path);
  const marker = await stat(join(path, "claim.json"));
  if (!directory?.isDirectory() || directory.isSymbolicLink() || !matches(directory, claim.directory) ||
      !marker || !regular(marker) || !matches(marker, claim.claim) ||
      !matches(await handle.stat({ bigint: true }), claim.claim)) return false;
  const children = await entries(path, 2);
  if (!children || children.some((name) => name !== "claim.json" && name !== "bundle")) return false;
  const bundle = join(path, "bundle");
  const info = await stat(bundle);
  if (!info) return true;
  if (!info.isDirectory() || info.isSymbolicLink() || !matches(info, claim.bundle)) return false;
  const files = await entries(bundle, 3);
  if (!files || files.some((name) => !names.some((allowed) => allowed === name))) return false;
  for (const name of names) {
    const file = await stat(join(bundle, name));
    if (file && (!regular(file) || !matches(file, claim.files[name]))) return false;
  }
  return true;
}

async function removeClaimed(path: string, claim: Claim, handle: FileHandle): Promise<void> {
  if (!await validLayout(path, claim, handle)) throw new ArtifactError("Artifact staging identity changed; no cleanup was authorized.");
  const bundle = join(path, "bundle");
  if (await stat(bundle)) {
    for (const name of names) {
      const file = join(bundle, name);
      const info = await stat(file);
      if (!info) continue;
      if (!regular(info) || !matches(info, claim.files[name])) throw new ArtifactError("Artifact staging file identity changed.");
      await unlink(file);
    }
    await rmdir(bundle);
  }
  await unlink(join(path, "claim.json"));
}

async function recoverAttempt(path: string, id: string, commitId: string, native: PublicationPrimitives): Promise<"removed" | "busy" | "untrusted"> {
  const directory = await stat(path);
  if (!directory) return "removed";
  if (!directory.isDirectory() || directory.isSymbolicLink()) return "untrusted";
  const claimPath = join(path, "claim.json");
  const marker = await stat(claimPath);
  if (!marker || !regular(marker) || marker.size > 8192) return "untrusted";
  let handle: FileHandle;
  try { handle = await open(claimPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if (record(error) && error.code === "ENOENT") return "removed"; throw error; }
  let release: (() => void) | undefined;
  let removed = false;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!regular(opened) || !matches(opened, identity(marker))) return "untrusted";
    release = native.lock(claimPath, handle.fd, identity(opened));
    if (!release) return "busy";
    const claim = await readClaim(handle);
    if (!claim || claim.id !== id || claim.commitId !== commitId || claim.destination !== `${id}.artifacts` ||
        !await validLayout(path, claim, handle)) return "untrusted";
    await removeClaimed(path, claim, handle);
    removed = true;
  } finally {
    try { release?.(); } finally { await handle.close(); }
  }
  if (removed) await rmdir(path);
  return "removed";
}

async function recover(directory: string, id: string, native: PublicationPrimitives): Promise<void> {
  let scanned = 0;
  let candidates = 0;
  let preserved = false;
  for await (const entry of await opendir(directory)) {
    if (++scanned > 4096) { preserved = true; break; }
    const match = attemptPattern.exec(entry.name);
    if (!match || match[1]!.toLowerCase() !== id.toLowerCase()) continue;
    if (++candidates > 128) { preserved = true; break; }
    if (await recoverAttempt(join(directory, entry.name), match[1]!, match[2]!, native) === "untrusted") preserved = true;
  }
  if (preserved) console.error("Unverified or excess artifact staging residue was preserved; fresh publication remains available.");
}

async function closeFiles(handles: FileHandle[]): Promise<void> {
  const results = await Promise.allSettled(handles.map((handle) => handle.close()));
  if (results.some((result) => result.status === "rejected")) throw new ArtifactError("Could not close artifact staging files.");
}

async function publish(directory: string, result: RunResult, native: PublicationPrimitives): Promise<void> {
  await recover(directory, result.id, native);
  const commitId = randomUUID();
  const destination = `${result.id}.artifacts`;
  const path = join(directory, `.acp-artifact-${result.id}-${commitId}`);
  await mkdir(path, { mode: 0o700 });
  let handle: FileHandle | undefined;
  let release: (() => void) | undefined;
  let claim: Claim | undefined;
  let removed = false;
  let committed = false;
  const handles: FileHandle[] = [];
  try {
    handle = await open(join(path, "claim.json"), "wx+", 0o600);
    const marker = identity(await handle.stat({ bigint: true }));
    release = native.lock(join(path, "claim.json"), handle.fd, marker);
    if (!release) throw new ArtifactError("New artifact claim could not be locked.");
    const bundle = join(path, "bundle");
    await mkdir(bundle, { mode: 0o700 });
    for (const name of names) handles.push(await open(join(bundle, name), "wx", 0o600));
    claim = claimSchema.parse({
      schemaVersion: 1, kind: "acp-artifact-attempt", state: "staging", id: result.id, commitId, destination,
      directory: identity((await stat(path))!), claim: marker, bundle: identity((await stat(bundle))!),
      files: Object.fromEntries(await Promise.all(names.map(async (name, index) =>
        [name, identity(await handles[index]!.stat({ bigint: true }))]))),
    });
    await handle.writeFile(encode(claim));
    await handle.sync();
    await syncDirectory(bundle);
    await syncDirectory(path);
    await syncDirectory(directory);
    const { transcript: _transcript, ...summary } = result;
    const content = [JSON.stringify(summary, null, 2) + "\n", toJsonl(result)];
    content.push(encode({
      schemaVersion: 1, kind: "acp-artifact-bundle", id: result.id, commitId,
      files: Object.fromEntries(content.map((value, index) => [
        names[index], { bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") },
      ])),
    }));
    for (let index = 0; index < handles.length; index++) {
      await handles[index]!.writeFile(content[index]!);
      await handles[index]!.sync();
    }
    await closeFiles(handles);
    await syncDirectory(bundle);
    if (!await validLayout(path, claim, handle) || (await entries(bundle, 3))?.length !== names.length) {
      throw new ArtifactError("Artifact staging changed before publication; no bundle was committed.");
    }
    native.publish(bundle, join(directory, destination));
    committed = true;
    await syncDirectory(path);
    await syncDirectory(directory);
  } catch (error) {
    if (committed) throw new ArtifactError("Artifact bundle committed, but directory synchronization failed.");
    throw error;
  } finally {
    try {
      try {
        await closeFiles(handles);
        if (claim && handle) {
          await removeClaimed(path, claim, handle);
          removed = true;
        }
      } finally {
        try { release?.(); } finally { await handle?.close(); }
        if (removed) await rmdir(path);
      }
    } catch (error) {
      if (committed) throw new ArtifactError("Artifact bundle committed, but staging cleanup failed; retry will preserve the committed bundle.");
      throw error;
    }
  }
}

export async function writeArtifacts(directory: string, result: RunResult): Promise<void> {
  const native = await import("./artifact-native.js");
  try { await publish(resolve(directory), result, native.publicationPrimitives()); }
  catch (error) {
    if (error instanceof ArtifactError) throw error;
    if (error instanceof native.NativeArtifactError) throw new ArtifactError(error.message);
    throw new ArtifactError("Could not publish or recover artifact bundle; incomplete staging was preserved.");
  }
}
