import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KernelError, LocalArtifactStorage, TorsorKernel,
  type KernelBootstrap, type PrincipalContext, type PublicEventEnvelope,
} from "../src/index.js";
import { prepareArtifactAttention, seedArtifactScopes, startArtifactRun } from "./artifact-scope-fixture.js";
import { bootstrap, claimRunOutboxAuthority, humanContext, runtimeContext } from "./helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(initialBootstrap: KernelBootstrap = bootstrap) {
  const directory = await mkdtemp(join(tmpdir(), "torsor-artifact-visibility-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const storage = await LocalArtifactStorage.open(join(directory, "content"));
  const read = vi.fn(storage.read.bind(storage));
  let time = new Date("2026-09-22T12:00:00Z");
  const options = {
    databasePath: join(directory, "state.sqlite"), bootstrap: initialBootstrap,
    artifactStorage: { put: storage.put.bind(storage), read }, clock: () => time,
  };
  const kernel = TorsorKernel.open(options);
  cleanups.push(() => kernel.close());
  const scopes = await seedArtifactScopes(kernel);
  const runs = [scopes.parent, scopes.sibling, scopes.child, scopes.unrelated];
  return {
    kernel, options, scopes, runs, read,
    expire() { time = new Date(time.getTime() + 300_001); },
    reopen() {
      kernel.close();
      const reopened = TorsorKernel.open(options);
      cleanups.push(() => reopened.close());
      return reopened;
    },
  };
}

async function refusal(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof KernelError)) throw error;
    return { code: error.code, message: error.message, details: error.details };
  }
  throw new Error("Expected a refused Artifact operation.");
}

describe("Artifact Run visibility and existence-neutral reads (MVP 23.2)", () => {
  it.each(["equal", "different"])("filters every projection and bounded replay across %s-byte related/unrelated Runs after restart", async (mode) => {
    const f = await fixture();
    const before = await f.kernel.query({ type: "GetBootstrap", projectId: "project-sample" }, humanContext);
    const reports = [];
    for (const [index, run] of f.runs.entries()) {
      const content = Buffer.from(mode === "equal" ? "Shared synthetic bytes." : `Synthetic report ${index}.`);
      const input = { runId: run.runId, expectedRunRevision: 1, idempotencyKey: "report", content };
      const result = await f.kernel.finalizeReport(input, run.context);
      reports.push({ id: result.entityId, input, digest: `sha256:${createHash("sha256").update(content).digest("hex")}` });
    }
    const kernel = f.reopen();
    const end = await kernel.query({ type: "GetBootstrap", projectId: "project-sample" }, humanContext);
    const humanThread = await kernel.query({ type: "GetThreadProjection", threadRootId: f.scopes.threadId }, humanContext);
    expect(humanThread.runs.find((run) => run.id === f.scopes.child.runId)).toMatchObject({
      parentRunId: f.scopes.parent.runId, causalRootId: f.scopes.threadId, delegationDepth: 1,
    });
    expect(humanThread.runs.find((run) => run.id === f.scopes.unrelated.runId)?.causalRootId).not.toBe(f.scopes.threadId);
    for (const [index, run] of f.runs.entries()) {
      const report = reports[index]!;
      expect((await kernel.finalizeReport(report.input, run.context)).entityId).toBe(report.id);
      const thread = await kernel.query({ type: "GetThreadProjection", threadRootId: f.scopes.threadId }, run.context);
      expect(thread.artifacts.map((artifact) => artifact.id)).toEqual([report.id]);
      for (const snapshotEventId of [before.latestEventId, end.latestEventId]) {
        const page = await kernel.query({
          type: "ListThreadProjections", projectId: "project-sample", snapshotEventId, limit: 1,
        }, run.context);
        expect(page.items[0]!.artifacts.map((artifact) => artifact.id))
          .toEqual(snapshotEventId === before.latestEventId ? [] : [report.id]);
        expect(page).toMatchObject({ hasMore: false, nextAfterEventId: null });
      }
      const current = await kernel.query({ type: "GetRunProjection", runId: run.runId }, run.context);
      const page = await kernel.query({
        type: "ListRunProjections", projectId: "project-sample", snapshotEventId: end.latestEventId,
      }, run.context);
      expect(page.items.map((item) => item.run.id)).toEqual([run.runId]);
      expect(page.items[0]!.artifacts).toEqual(current.artifacts);
      expect(current.artifacts.map((artifact) => artifact.id)).toEqual([report.id]);
      let cursor = before.latestEventId;
      const observed: PublicEventEnvelope[] = [];
      for (let scan = 0; scan < reports.length; scan += 1) {
        const events = await kernel.query({
          type: "ReadPublicEvents", projectId: "project-sample", afterEventId: cursor, limit: 1,
        }, run.context);
        expect(events.scannedThroughEventId).not.toBe(cursor);
        expect(events.hasMore).toBe(scan < reports.length - 1);
        cursor = events.scannedThroughEventId;
        observed.push(...events.events);
      }
      expect(cursor).toBe(end.latestEventId);
      expect(observed.map((event) => event.entityId)).toEqual([report.id]);
      expect(observed[0]!.payload).toMatchObject({ contentDigest: report.digest, runId: run.runId });
      expect(await kernel.query({
        type: "ReadPublicEvents", projectId: "project-sample", afterEventId: cursor, limit: 1,
      }, run.context)).toEqual({ events: [], scannedThroughEventId: cursor, hasMore: false });
      const absent = await refusal(kernel.query({ type: "GetArtifact", artifactId: "random-absent" }, run.context));
      expect(absent).toMatchObject({ code: "NotFound", message: "The Artifact was not found." });
      f.read.mockClear();
      for (const foreign of reports.filter((item) => item.id !== report.id)) {
        expect(await refusal(kernel.query({ type: "GetArtifact", artifactId: foreign.id }, run.context))).toEqual(absent);
        expect(await refusal(kernel.readArtifact(foreign.id, run.context))).toEqual(absent);
        expect(JSON.stringify(thread)).not.toContain(foreign.id);
      }
      expect(await refusal(kernel.readArtifact("random-absent", run.context))).toEqual(absent);
      expect(f.read).not.toHaveBeenCalled();
      expect((await kernel.readArtifact(report.id, run.context)).content).toEqual(report.input.content);
    }
    for (const context of [humanContext, runtimeContext]) {
      const thread = await kernel.query({ type: "GetThreadProjection", threadRootId: f.scopes.threadId }, context);
      expect(thread.artifacts).toHaveLength(4);
      const history = await kernel.query({
        type: "ListThreadProjections", projectId: "project-sample", snapshotEventId: end.latestEventId,
      }, context);
      expect(history.items[0]!.artifacts).toEqual(thread.artifacts);
      const events = await kernel.query({
        type: "ReadPublicEvents", projectId: "project-sample", afterEventId: before.latestEventId,
      }, context);
      expect(events.events.map((event) => event.entityId)).toEqual(reports.map((item) => item.id));
      for (const report of reports) expect((await kernel.readArtifact(report.id, context)).content).toEqual(report.input.content);
    }
  });

  it("does not leak through Attention scopes or conditional reply/completion catch-up", async () => {
    const f = await fixture();
    const before = await f.kernel.query({ type: "GetThreadProjection", threadRootId: f.scopes.threadId }, humanContext);
    const foreign = await f.kernel.finalizeReport({
      runId: f.scopes.child.runId, expectedRunRevision: 1, idempotencyKey: "foreign",
      content: Buffer.from("A child-only synthetic report."),
    }, f.scopes.child.context);
    const owned = await f.kernel.finalizeReport({
      runId: f.scopes.parent.runId, expectedRunRevision: 1, idempotencyKey: "own",
      content: Buffer.from("A parent-only synthetic report."),
    }, f.scopes.parent.context);
    const common = { runId: f.scopes.parent.runId, expectedRunRevision: 1 };
    const reply = await refusal(f.kernel.execute({
      type: "PublishRunReply", idempotencyKey: "stale-reply", ...common,
      expectedThreadCursor: before.cursor, body: "A conditional synthetic reply.",
    }, f.scopes.parent.context));
    expect(reply.code).toBe("ConditionalCheckFailed");
    expect(JSON.stringify(reply)).not.toContain(foreign.entityId);
    expect(JSON.stringify(reply)).toContain(owned.entityId);
    const completion = await refusal(f.kernel.execute({
      type: "CompleteRun", idempotencyKey: "stale-complete", ...common, incorporatedThroughInputSequence: 1,
      finalReply: { body: "Done.", expectedThreadCursor: before.cursor },
    }, f.scopes.parent.context));
    expect(completion.code).toBe("ConditionalCheckFailed");
    expect(JSON.stringify(completion)).not.toContain(foreign.entityId);
    const message = await f.kernel.execute({
      type: "ReplyToThread", idempotencyKey: "attention-only", threadRootId: f.scopes.threadId,
      body: "Consider a follow-up.", targetAgentIds: ["agent-orbit"],
    }, humanContext);
    const attention = await prepareArtifactAttention(f.kernel, message, "orbit", "attention-only");
    expect((await f.kernel.query({ type: "GetThreadProjection", threadRootId: f.scopes.threadId }, attention.context)).artifacts).toEqual([]);
    expect((await f.kernel.query({ type: "ListThreadProjections", projectId: "project-sample" }, attention.context)).items[0]!.artifacts).toEqual([]);
    expect((await f.kernel.query({ type: "ReadPublicEvents", projectId: "project-sample" }, attention.context))
      .events.filter((event) => event.entityType === "Artifact")).toEqual([]);
    for (const artifactId of ["random-absent", foreign.entityId, owned.entityId]) {
      expect(await refusal(f.kernel.readArtifact(artifactId, attention.context))).toMatchObject({ code: "NotFound" });
    }
  });

  it.each(["expired", "revoked", "replaced"] as const)("validates %s scope before Artifact existence on both APIs", async (state) => {
    const f = await fixture();
    const run = f.scopes.parent;
    const report = await f.kernel.finalizeReport({
      runId: run.runId, expectedRunRevision: 1, idempotencyKey: "report", content: Buffer.from("Synthetic bytes."),
    }, run.context);
    if (state === "expired") f.expire();
    else if (state === "revoked") await f.kernel.execute({
      type: "CancelRun", idempotencyKey: "cancel", runId: run.runId, expectedRunRevision: 1, reason: "Synthetic revocation.",
    }, humanContext);
    else {
      await f.kernel.execute({
        type: "SendToRun", idempotencyKey: "replace-input", runId: run.runId, expectedRunRevision: 1,
        body: "A replacement delivery.",
      }, humanContext);
      const authority = await claimRunOutboxAuthority(f.kernel, run.runId, "replace");
      await f.kernel.execute({
        type: "StartActivation", idempotencyKey: "replace", runId: run.runId, expectedRunRevision: 2, ...authority,
      }, runtimeContext);
    }
    const contexts: PrincipalContext[] = [
      run.context, { principalId: "missing" }, { principalId: "principal-orbit" },
      { principalId: "principal-keel", activationId: run.context.activationId },
    ];
    for (const context of contexts) {
      const real = await refusal(f.kernel.query({ type: "GetArtifact", artifactId: report.entityId }, context));
      expect(real.code).not.toBe("NotFound");
      for (const artifactId of ["random-absent", report.entityId]) {
        expect(await refusal(f.kernel.query({ type: "GetArtifact", artifactId }, context))).toEqual(real);
        expect(await refusal(f.kernel.readArtifact(artifactId, context))).toEqual(real);
      }
    }
    expect(f.read).not.toHaveBeenCalled();
  });

  it("does not disclose a foreign Project report while preserving Human/Runtime global read authority", async () => {
    const f = await fixture({
      ...bootstrap,
      principals: [...bootstrap.principals!, { id: "principal-remote", kind: "agent", displayName: "Remote" }],
      projects: [...bootstrap.projects!, { id: "project-other", name: "Other" }],
      channels: [...bootstrap.channels!, { id: "channel-other", projectId: "project-other", name: "other" }],
      agents: [...bootstrap.agents!, {
        id: "agent-remote", principalId: "principal-remote", projectId: "project-other",
        name: "Remote", configRevision: 1, config: {},
      }],
    });
    const message = await f.kernel.execute({
      type: "StartThread", idempotencyKey: "other-project",
      projectId: "project-other", channelId: "channel-other", body: "A separate synthetic Project.",
      targetAgentIds: ["agent-remote"],
    }, humanContext);
    const other = await startArtifactRun(f.kernel, message, "remote", "other-project");
    const reports = [];
    for (const run of [f.scopes.parent, other]) {
      const report = await f.kernel.finalizeReport({
        runId: run.runId, expectedRunRevision: 1, idempotencyKey: "report", content: Buffer.from("Shared bytes."),
      }, run.context);
      reports.push(report.entityId);
    }
    for (const [index, run] of [f.scopes.parent, other].entries()) {
      const absent = await refusal(f.kernel.query({ type: "GetArtifact", artifactId: "random-absent" }, run.context));
      expect(await refusal(f.kernel.query({ type: "GetArtifact", artifactId: reports[1 - index]! }, run.context))).toEqual(absent);
      expect(await refusal(f.kernel.readArtifact(reports[1 - index]!, run.context))).toEqual(absent);
    }
    expect(f.read).not.toHaveBeenCalled();
    for (const context of [humanContext, runtimeContext]) {
      for (const id of reports) expect((await f.kernel.readArtifact(id, context)).content).toEqual(Buffer.from("Shared bytes."));
    }
  });

  it("bounds a fully filtered conditional catch-up and resumes beyond it without disclosing counts or reports", async () => {
    const f = await fixture();
    const thread = await f.kernel.query({ type: "GetThreadProjection", threadRootId: f.scopes.threadId }, humanContext);
    for (let index = 0; index < 101; index += 1) {
      await f.kernel.finalizeReport({
        runId: f.scopes.child.runId, expectedRunRevision: 1, idempotencyKey: `hidden-${index}`,
        content: Buffer.from(`Synthetic hidden report ${index}.`),
      }, f.scopes.child.context);
    }
    const own = await f.kernel.finalizeReport({
      runId: f.scopes.parent.runId, expectedRunRevision: 1, idempotencyKey: "visible",
      content: Buffer.from("Synthetic visible report."),
    }, f.scopes.parent.context);
    const conflict = await refusal(f.kernel.execute({
      type: "PublishRunReply", idempotencyKey: "catch-up", runId: f.scopes.parent.runId,
      expectedRunRevision: 1, expectedThreadCursor: thread.cursor, body: "A stale reply.",
    }, f.scopes.parent.context));
    expect(conflict.code).toBe("ConditionalCheckFailed");
    expect(conflict.details).toEqual({
      currentCursor: thread.cursor + 102, events: [], hasMore: true,
      scannedThroughEventId: expect.any(String),
    });
    const details = conflict.details;
    if (!details || typeof details !== "object" || Array.isArray(details) ||
      typeof details.scannedThroughEventId !== "string") throw new Error("Expected a catch-up cursor.");
    const next = await f.kernel.query({
      type: "ReadPublicEvents", projectId: "project-sample", afterEventId: details.scannedThroughEventId, limit: 1,
    }, f.scopes.parent.context);
    expect(next.events).toEqual([]);
    expect(next.hasMore).toBe(true);
    expect(next.scannedThroughEventId).not.toBe(details.scannedThroughEventId);
    const last = await f.kernel.query({
      type: "ReadPublicEvents", projectId: "project-sample", afterEventId: next.scannedThroughEventId, limit: 1,
    }, f.scopes.parent.context);
    expect(last.events.map((event) => event.entityId)).toEqual([own.entityId]);
    expect(last.hasMore).toBe(false);
  });
});
