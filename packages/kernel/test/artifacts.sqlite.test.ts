import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LocalArtifactStorage, TorsorKernel, type ArtifactStorage } from "../src/index.js";
import { bootstrap, createRun, humanContext, runtimeContext } from "./helpers.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function fixture(wrap?: (storage: ArtifactStorage) => ArtifactStorage) {
  const directory = await mkdtemp(join(tmpdir(), "torsor-artifacts-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "content");
  const storage = await LocalArtifactStorage.open(root);
  const databasePath = join(directory, "kernel.sqlite");
  const options = { databasePath, bootstrap, artifactStorage: wrap?.(storage) ?? storage };
  const kernel = TorsorKernel.open(options);
  cleanup.push(() => kernel.close());
  const setup = await createRun(kernel);
  const content = Buffer.from("Synthetic immutable report.\n", "utf8");
  const input = { runId: setup.runId, expectedRunRevision: 1, idempotencyKey: "report-1", content };
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  return { kernel, setup, input, digest, root, storage, databasePath, options };
}

async function counts(databasePath: string) {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare(`SELECT
      (SELECT count(*) FROM artifacts) AS artifacts,
      (SELECT count(*) FROM public_events WHERE type = 'ArtifactPublished') AS events,
      (SELECT count(*) FROM outbox_events WHERE topic = 'artifact.published') AS outbox,
      (SELECT count(*) FROM idempotency_records WHERE command_name = 'PublishArtifact') AS results`).get();
  } finally {
    db.close();
  }
}

describe("trusted report finalization (MVP 21.3/21.5, 23, 35.3)", () => {
  it("hashes real streamed bytes before publishing one durable descriptor and survives restart", async () => {
    const f = await fixture();
    async function* chunks() {
      yield f.input.content.subarray(0, 9);
      yield f.input.content.subarray(9);
    }
    const result = await f.kernel.finalizeReport({ ...f.input, content: chunks() }, f.setup.agentContext);
    expect(await counts(f.databasePath)).toEqual({ artifacts: 1, events: 1, outbox: 1, results: 1 });
    expect(await readFile(join(f.root, "sha256", f.digest.slice(7)))).toEqual(f.input.content);
    f.kernel.close();
    const restarted = TorsorKernel.open(f.options);
    cleanup.push(() => restarted.close());
    const replay = await restarted.finalizeReport(f.input, f.setup.agentContext);
    expect(replay).toEqual(result);
    const read = await restarted.readArtifact(result.entityId, humanContext);
    expect(read.content).toEqual(f.input.content);
    expect(read.artifact).toMatchObject({
      contentDigest: f.digest, byteLength: f.input.content.length,
      producerRunId: f.setup.runId, producerActivationId: f.setup.activationId,
      producerThreadRootId: f.setup.threadId, visibilityChannelId: "channel-general",
      baseRevision: `run:${f.setup.runId}@1`, mediaType: "text/plain; charset=utf-8",
    });
    expect(read.artifact).not.toHaveProperty("storageLocation");
    const thread = await restarted.query({ type: "GetThreadProjection", threadRootId: f.setup.threadId }, humanContext);
    expect(thread.artifacts).toEqual([read.artifact]);
    await expect(restarted.finalizeReport({ ...f.input, content: Buffer.from("changed") }, f.setup.agentContext))
      .rejects.toMatchObject({ code: "Conflict" });
    await expect(restarted.finalizeReport({ ...f.input, idempotencyKey: "another-key" }, f.setup.agentContext))
      .rejects.toMatchObject({ code: "Conflict" });
    expect(await counts(f.databasePath)).toEqual({ artifacts: 1, events: 1, outbox: 1, results: 1 });
  });

  it("rejects forged descriptors even for an authorized Agent", async () => {
    const f = await fixture();
    await expect(f.kernel.execute({
      type: "PublishArtifact", idempotencyKey: "forged", runId: f.setup.runId,
      expectedRunRevision: 1, contentDigest: f.digest, byteLength: 12,
    }, f.setup.agentContext)).rejects.toMatchObject({ code: "Forbidden" });
    await expect(f.kernel.finalizeReport({
      ...f.input, ...{ contentDigest: f.digest, storageLocation: "file:///private/report" },
    }, f.setup.agentContext)).rejects.toMatchObject({ code: "InvalidCommand" });
    expect(await counts(f.databasePath)).toEqual({ artifacts: 0, events: 0, outbox: 0, results: 0 });
  });

  it("publishes nothing on storage failure; retries reuse an orphan after durable storage", async () => {
    let fail = true;
    const f = await fixture((storage) => ({
      read: storage.read.bind(storage),
      async put(digest, content) {
        await storage.put(digest, content);
        if (fail) throw new Error("Synthetic crash after content publication");
      },
    }));
    await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext)).rejects.toThrow("Synthetic crash");
    expect(await counts(f.databasePath)).toEqual({ artifacts: 0, events: 0, outbox: 0, results: 0 });
    expect(await readdir(join(f.root, "sha256"))).toEqual([f.digest.slice(7)]);
    fail = false;
    await f.kernel.finalizeReport(f.input, f.setup.agentContext);
    expect(await counts(f.databasePath)).toEqual({ artifacts: 1, events: 1, outbox: 1, results: 1 });
  });

  it("publishes nothing when durable storage cannot write", async () => {
    const f = await fixture((storage) => ({
      read: storage.read.bind(storage),
      async put() { throw new Error("Synthetic disk failure"); },
    }));
    await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext)).rejects.toThrow("Synthetic disk failure");
    expect(await readdir(join(f.root, "sha256"))).toEqual([]);
    expect(await counts(f.databasePath)).toEqual({ artifacts: 0, events: 0, outbox: 0, results: 0 });
  });

  it("rolls back descriptor/event/outbox/result together on a pre-commit crash", async () => {
    const f = await fixture();
    const hook = Symbol.for("torsor.kernel.command-before-commit");
    Reflect.set(globalThis, hook, ({ commandType }: { commandType: string }) => {
      if (commandType === "PublishArtifact") throw new Error("Synthetic transaction crash");
    });
    try {
      await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext)).rejects.toThrow("Synthetic transaction crash");
    } finally {
      Reflect.deleteProperty(globalThis, hook);
    }
    expect(await counts(f.databasePath)).toEqual({ artifacts: 0, events: 0, outbox: 0, results: 0 });
    await f.kernel.finalizeReport(f.input, f.setup.agentContext);
    expect(await counts(f.databasePath)).toEqual({ artifacts: 1, events: 1, outbox: 1, results: 1 });
  });

  it("bounds bytes and chunks, propagates stream failures and rejects unauthorized callers before consumption", async () => {
    const f = await fixture();
    await expect(f.kernel.finalizeReport({ ...f.input, content: Buffer.alloc(1_048_577) }, f.setup.agentContext))
      .rejects.toMatchObject({ code: "InvalidCommand" });
    async function* emptyChunks() { for (let i = 0; i < 4097; i++) yield Buffer.alloc(0); }
    await expect(f.kernel.finalizeReport({ ...f.input, content: emptyChunks() }, f.setup.agentContext))
      .rejects.toMatchObject({ code: "InvalidCommand" });
    async function* broken() { yield Buffer.from("partial"); throw new Error("Synthetic stream error"); }
    await expect(f.kernel.finalizeReport({ ...f.input, content: broken() }, f.setup.agentContext))
      .rejects.toThrow("Synthetic stream error");
    let consumed = false;
    async function* guarded() { consumed = true; yield Buffer.from("private"); }
    await expect(f.kernel.finalizeReport({ ...f.input, content: guarded() }, humanContext))
      .rejects.toMatchObject({ code: "Forbidden" });
    expect(consumed).toBe(false);
    expect(await readdir(join(f.root, "sha256"))).toEqual([]);
    expect(await counts(f.databasePath)).toEqual({ artifacts: 0, events: 0, outbox: 0, results: 0 });
  });

  it("rechecks authorization after storage and never publishes late output", async () => {
    let revoke: (() => Promise<unknown>) | undefined;
    const f = await fixture((storage) => ({
      read: storage.read.bind(storage),
      async put(digest, content) {
        await storage.put(digest, content);
        await revoke?.();
      },
    }));
    revoke = () => f.kernel.execute({
      type: "CancelRun", idempotencyKey: "cancel", runId: f.setup.runId,
      expectedRunRevision: 1, reason: "Synthetic revocation during storage",
    }, humanContext);
    await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext)).rejects.toMatchObject({ code: "TerminalRun" });
    expect(await counts(f.databasePath)).toEqual({ artifacts: 0, events: 0, outbox: 0, results: 0 });
  });

  it("reauthorizes before and after reads rather than trusting IDs, digests or stale Activation context", async () => {
    let revoke: (() => Promise<unknown>) | undefined;
    const f = await fixture((storage) => ({
      put: storage.put.bind(storage),
      async read(digest, size) {
        const content = await storage.read(digest, size);
        await revoke?.();
        return content;
      },
    }));
    const result = await f.kernel.finalizeReport(f.input, f.setup.agentContext);
    await expect(f.kernel.readArtifact(result.entityId, { principalId: "missing" }))
      .rejects.toMatchObject({ code: "Unauthorized" });
    await expect(f.kernel.readArtifact(result.entityId, { principalId: "principal-keel", activationId: f.setup.activationId }))
      .rejects.toMatchObject({ code: "Forbidden" });
    revoke = () => f.kernel.execute({
      type: "CancelRun", idempotencyKey: "cancel-read", runId: f.setup.runId,
      expectedRunRevision: 1, reason: "Synthetic revocation during read",
    }, humanContext);
    await expect(f.kernel.readArtifact(result.entityId, f.setup.agentContext))
      .rejects.toMatchObject({ code: "Conflict" });
    revoke = undefined;
    await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext)).rejects.toMatchObject({ code: "Conflict" });
    expect((await f.kernel.readArtifact(result.entityId, humanContext)).content).toEqual(f.input.content);
  });

  it("detects tampering and destination collisions without replacing content or publishing a descriptor", async () => {
    const f = await fixture();
    const path = join(f.root, "sha256", f.digest.slice(7));
    await writeFile(path, Buffer.alloc(f.input.content.length, 65));
    await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext)).rejects.toThrow(/integrity/i);
    expect(await readFile(path)).toEqual(Buffer.alloc(f.input.content.length, 65));
    expect(await counts(f.databasePath)).toEqual({ artifacts: 0, events: 0, outbox: 0, results: 0 });
    await rm(path);
    const result = await f.kernel.finalizeReport(f.input, f.setup.agentContext);
    await chmod(path, 0o600);
    await writeFile(path, "tampered");
    await expect(f.kernel.readArtifact(result.entityId, humanContext)).rejects.toThrow(/integrity/i);
  });

  it("rejects traversal, linked roots/directories and non-regular destinations", async () => {
    const f = await fixture();
    await expect(f.storage.read("../private", 1)).rejects.toThrow(/digest/i);
    await expect(f.storage.put(`sha256:${"a".repeat(64)}`, f.input.content)).rejects.toThrow(/integrity/i);
    const linkedRoot = join(f.root, "linked");
    await symlink(f.root, linkedRoot, "junction");
    await expect(LocalArtifactStorage.open(linkedRoot)).rejects.toThrow(/link/i);
    await mkdir(join(f.root, "sha256", f.digest.slice(7)));
    await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext)).rejects.toThrow(/regular/i);
    expect(await counts(f.databasePath)).toEqual({ artifacts: 0, events: 0, outbox: 0, results: 0 });
  });

  it.each(["stored", "transaction", "committed"])("recovers a real child-process exit at %s with durable SQLite evidence", async (mode) => {
    const f = await fixture();
    f.kernel.close();
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/artifact-crash.mjs", import.meta.url)),
      f.databasePath, f.root, mode,
      JSON.stringify({ ...f.input, content: f.input.content.toString("utf8") }),
      JSON.stringify(f.setup.agentContext),
    ], { encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(77);
    const n = mode === "committed" ? 1 : 0;
    expect(await counts(f.databasePath)).toEqual({ artifacts: n, events: n, outbox: n, results: n });
    const restarted = TorsorKernel.open(f.options);
    cleanup.push(() => restarted.close());
    const result = await restarted.finalizeReport(f.input, f.setup.agentContext);
    expect(await restarted.finalizeReport(f.input, f.setup.agentContext)).toEqual(result);
    expect((await restarted.readArtifact(result.entityId, humanContext)).content).toEqual(f.input.content);
    expect(await counts(f.databasePath)).toEqual({ artifacts: 1, events: 1, outbox: 1, results: 1 });
  });

  it("converges concurrent publishers and preserves provenance across a replacement Activation", async () => {
    const f = await fixture();
    const second = TorsorKernel.open(f.options);
    cleanup.push(() => second.close());
    const [firstResult, secondResult] = await Promise.all([
      f.kernel.finalizeReport(f.input, f.setup.agentContext),
      second.finalizeReport(f.input, f.setup.agentContext),
    ]);
    expect(secondResult).toEqual(firstResult);
    const replacement = await second.execute({
      type: "StartActivation", idempotencyKey: "replacement", runId: f.setup.runId,
      expectedRunRevision: 1, outboxEventId: f.setup.outboxEventId,
      outboxLeaseToken: f.setup.outboxLeaseToken,
    }, runtimeContext);
    await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext)).rejects.toMatchObject({ code: "Conflict" });
    const recovered = await second.finalizeReport(f.input, {
      principalId: f.setup.agentContext.principalId, activationId: replacement.entityId,
    });
    expect(recovered).toEqual(firstResult);
    expect((await second.query({ type: "GetArtifact", artifactId: recovered.entityId }, humanContext)).producerActivationId)
      .toBe(f.setup.activationId);
    expect(await counts(f.databasePath)).toEqual({ artifacts: 1, events: 1, outbox: 1, results: 1 });
  });

  it("accepts the exact byte bound, copies reused stream buffers, and rejects changed current visibility", async () => {
    const f = await fixture();
    const maximum = Buffer.alloc(1_048_576, 65);
    const maxResult = await f.kernel.finalizeReport({ ...f.input, content: maximum }, f.setup.agentContext);
    expect(Buffer.from((await f.kernel.readArtifact(maxResult.entityId, humanContext)).content).equals(maximum)).toBe(true);
    const chunk = Buffer.from("a");
    async function* reused() { yield chunk; chunk[0] = 98; yield chunk; }
    const small = await f.kernel.finalizeReport({ ...f.input, idempotencyKey: "reused", content: reused() }, f.setup.agentContext);
    expect((await f.kernel.readArtifact(small.entityId, humanContext)).content).toEqual(Buffer.from("ab"));
    const db = new DatabaseSync(f.databasePath);
    try {
      db.exec("INSERT INTO projects (id, name) VALUES ('project-other', 'Other')");
      db.exec("UPDATE agents SET project_id = 'project-other' WHERE id = 'agent-orbit'");
      await expect(f.kernel.readArtifact(small.entityId, f.setup.agentContext)).rejects.toMatchObject({ code: "Forbidden" });
      db.exec("UPDATE agents SET project_id = 'project-sample' WHERE id = 'agent-orbit'");
      db.exec("INSERT INTO channels (id, project_id, name) VALUES ('channel-other', 'project-sample', 'other')");
      db.prepare("UPDATE runs SET home_channel_id = 'channel-other' WHERE id = ?").run(f.setup.runId);
      await expect(f.kernel.query({ type: "GetArtifact", artifactId: small.entityId }, humanContext))
        .rejects.toMatchObject({ code: "NotFound" });
    } finally {
      db.close();
    }
  });

  it("keeps incomplete streams and linked content directories invisible", async () => {
    const f = await fixture();
    let closed = false;
    async function* overflow() {
      try {
        yield Buffer.alloc(1_048_576);
        yield Buffer.alloc(1);
      } finally {
        closed = true;
      }
    }
    await expect(f.kernel.finalizeReport({ ...f.input, content: overflow() }, f.setup.agentContext))
      .rejects.toMatchObject({ code: "InvalidCommand" });
    expect(closed).toBe(true);
    const objects = join(f.root, "sha256");
    await rm(objects, { recursive: true });
    await symlink(join(f.root, "staging"), objects, "junction");
    await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext)).rejects.toThrow(/link/i);
    expect(await counts(f.databasePath)).toEqual({ artifacts: 0, events: 0, outbox: 0, results: 0 });
  });

  it("does not grant cross-Run reads to another live Activation of the same Agent", async () => {
    const f = await fixture();
    const result = await f.kernel.finalizeReport(f.input, f.setup.agentContext);
    await f.kernel.execute({
      type: "AcknowledgeOutboxEvents", idempotencyKey: "release-first-outbox",
      outboxEventIds: [f.setup.outboxEventId], leaseToken: f.setup.outboxLeaseToken,
    }, runtimeContext);
    const other = await createRun(f.kernel, "-other");
    await expect(f.kernel.query({ type: "GetArtifact", artifactId: result.entityId }, other.agentContext))
      .rejects.toMatchObject({ code: "NotFound" });
    await expect(f.kernel.readArtifact(result.entityId, other.agentContext))
      .rejects.toMatchObject({ code: "NotFound" });
    await expect(f.kernel.finalizeReport(f.input, other.agentContext))
      .rejects.toMatchObject({ code: "Forbidden" });
    expect((await f.kernel.readArtifact(result.entityId, f.setup.agentContext)).content).toEqual(f.input.content);
  });

  it("fails explicitly on missing storage without leaking private paths into Runtime errors", async () => {
    const f = await fixture();
    const result = await f.kernel.finalizeReport(f.input, f.setup.agentContext);
    await rm(join(f.root, "sha256", f.digest.slice(7)));
    await expect(f.kernel.readArtifact(result.entityId, humanContext))
      .rejects.toThrow("Artifact storage I/O failed (ENOENT).");
    await rm(join(f.root, "sha256"), { recursive: true });
    await expect(f.kernel.finalizeReport(f.input, f.setup.agentContext))
      .rejects.toThrow("Artifact storage I/O failed (ENOENT).");
    expect(await counts(f.databasePath)).toEqual({ artifacts: 1, events: 1, outbox: 1, results: 1 });
  });
});
