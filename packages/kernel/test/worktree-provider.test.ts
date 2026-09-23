import { describe, expect, it } from "vitest";

import {
  TorsorKernel, type StartWorktreeExecutionCommand, type WorktreeProviderBinding,
} from "../src/index.js";
import { bootstrap, createRun, humanContext, runtimeContext } from "./helpers.js";

export async function providerFixture(databasePath = ":memory:") {
  const kernel = TorsorKernel.open({
    databasePath, bootstrap, clock: () => new Date("2026-09-23T00:00:00Z"),
  });
  const run = await createRun(kernel);
  await registerTree(kernel, run.runId, "tree");
  const attempt = await startAttempt(kernel, run);
  const lease = await kernel.execute({
    type: "AcquireWorktreeWriterLease", idempotencyKey: "lease",
    worktreeId: "tree", leaseDurationMs: 30_000,
  }, runtimeContext);
  const provider: WorktreeProviderBinding = {
    providerAttemptId: attempt.entityId, policy: "trusted-local", permissionMode: "provider-default",
  };
  const command: StartWorktreeExecutionCommand = {
    type: "StartWorktreeExecution", idempotencyKey: "native",
    worktreeId: "tree", activationId: run.activationId, executorId: "synthetic-executor",
    generation: lease.leaseGeneration!, fencingToken: lease.fencingToken!, leaseToken: lease.leaseToken!,
    provider,
  };
  return { kernel, run, command, provider };
}

async function registerTree(kernel: TorsorKernel, runId: string, worktreeId: string) {
  await kernel.execute({
    type: "RegisterPhysicalWorktree", idempotencyKey: `register-${worktreeId}`,
    worktreeId, runId, repositoryId: "synthetic", repositoryPath: "synthetic-repository",
    baseRevision: "a".repeat(40), directoryPath: `synthetic-${worktreeId}`, directoryIdentity: `identity-${worktreeId}`,
  }, runtimeContext);
}

async function startAttempt(kernel: TorsorKernel, run: Awaited<ReturnType<typeof createRun>>, suffix = "") {
  return kernel.execute({
    type: "StartProviderAttempt", idempotencyKey: `attempt${suffix}`, activationId: run.activationId,
    outboxEventId: run.outboxEventId, outboxLeaseToken: run.outboxLeaseToken,
    adapter: "synthetic", adapterVersion: "1", capabilitySnapshot: {},
    runInputIds: [run.runInputId], requestIdempotencyKey: `request${suffix}`,
  }, runtimeContext);
}

describe("native Worktree provider binding", () => {
  it.each([
    ["Started", "provider-default"], ["Started", "allow-all"],
    ["Acknowledged", "provider-default"], ["Acknowledged", "allow-all"],
  ] as const)("binds a %s attempt with %s permission and preserves replay", async (status, permissionMode) => {
    const f = await providerFixture();
    try {
      if (status === "Acknowledged") {
        await f.kernel.execute({
          type: "FinishProviderAttempt", idempotencyKey: "acknowledge",
          providerAttemptId: f.provider.providerAttemptId, status,
        }, runtimeContext);
      }
      const provider = { ...f.provider, permissionMode };
      const command = { ...f.command, provider };
      const result = await f.kernel.execute(command, runtimeContext);
      expect(await f.kernel.execute(command, runtimeContext)).toEqual(result);
      const tree = await f.kernel.query({ type: "GetPhysicalWorktree", worktreeId: "tree" }, runtimeContext);
      expect(tree.latestExecution).toMatchObject({
        id: result.entityId, activationId: f.run.activationId, state: "Starting", provider,
      });
      expect(tree.latestExecution?.events).toHaveLength(1);
      const page = await f.kernel.query({
        type: "ListPhysicalWorktrees", runId: f.run.runId, limit: 2,
      }, runtimeContext);
      expect(page).toEqual({ items: [tree], hasMore: false });
      expect(JSON.stringify(tree)).not.toContain(result.executionToken);
      await expect(f.kernel.execute(command, humanContext)).rejects.toMatchObject({ code: "Forbidden" });
    } finally { f.kernel.close(); }
  });

  it("omits the provider key entirely for the original fixed probe", async () => {
    const f = await providerFixture();
    try {
      const { provider: _provider, ...probe } = f.command;
      await f.kernel.execute(probe, runtimeContext);
      const tree = await f.kernel.query({ type: "GetPhysicalWorktree", worktreeId: "tree" }, runtimeContext);
      expect(tree.latestExecution).not.toHaveProperty("provider");
    } finally { f.kernel.close(); }
  });

  const invalidBindings: readonly [string, (provider: WorktreeProviderBinding) => unknown][] = [
    ["null", () => null],
    ["string", () => "synthetic-private-value"],
    ["array", (provider) => [provider]],
    ["missing attempt", ({ providerAttemptId: _id, ...rest }) => rest],
    ["missing policy", ({ policy: _policy, ...rest }) => rest],
    ["missing permission", ({ permissionMode: _mode, ...rest }) => rest],
    ["empty attempt", (provider) => ({ ...provider, providerAttemptId: " " })],
    ["non-string attempt", (provider) => ({ ...provider, providerAttemptId: 1 })],
    ["unknown policy", (provider) => ({ ...provider, policy: "synthetic-private-policy" })],
    ["unknown permission", (provider) => ({ ...provider, permissionMode: "synthetic-private-mode" })],
    ["environment", (provider) => ({ ...provider, environment: { SYNTHETIC_SECRET: "private" } })],
    ["cwd", (provider) => ({ ...provider, cwd: "synthetic-private-directory" })],
    ["diagnostic session", (provider) => ({ ...provider, diagnosticSessionId: "synthetic-private-session" })],
    ["text", (provider) => ({ ...provider, text: "synthetic-private-output" })],
    ["unknown undefined field", (provider) => ({ ...provider, extra: undefined })],
    ["non-enumerable field", (provider) => Object.defineProperty({ ...provider }, "private", { value: "synthetic" })],
    ["symbol field", (provider) => ({ ...provider, [Symbol("synthetic-private")]: "synthetic" })],
    ["inherited fields", (provider) => Object.create(provider)],
    ["class instance", (provider) => Object.assign(new (class Binding {})(), provider)],
    ["accessor field", (provider) => Object.defineProperty({ ...provider }, "policy", { get: () => "trusted-local" })],
  ];

  it.each(invalidBindings)("rejects %s with a fixed error and no durable intent", async (_name, invalid) => {
    const f = await providerFixture();
    try {
      const events = await f.kernel.readEvents(null, 500);
      await expect(f.kernel.execute({
        ...f.command, provider: invalid(f.provider) as WorktreeProviderBinding,
      }, runtimeContext)).rejects.toMatchObject({
        code: "InvalidCommand", message: "Worktree provider binding is invalid.",
      });
      expect((await f.kernel.query({ type: "GetPhysicalWorktree", worktreeId: "tree" }, runtimeContext))
        .latestExecution).toBeNull();
      expect(await f.kernel.readEvents(null, 500)).toEqual(events);
      await expect(f.kernel.execute(f.command, runtimeContext)).resolves.toMatchObject({
        commandType: "StartWorktreeExecution",
      });
    } finally { f.kernel.close(); }
  });

  it("does not accept invalid non-JSON fields through the idempotency cache", async () => {
    const f = await providerFixture();
    try {
      await f.kernel.execute(f.command, runtimeContext);
      for (const invalid of [
        Object.defineProperty({ ...f.provider }, "private", { value: "synthetic" }),
        { ...f.provider, [Symbol("private")]: "synthetic" },
        Object.assign(new (class Binding {})(), f.provider),
      ]) {
        await expect(f.kernel.execute({
          ...f.command, provider: invalid,
        }, runtimeContext)).rejects.toMatchObject({
          code: "InvalidCommand", message: "Worktree provider binding is invalid.",
        });
      }
    } finally { f.kernel.close(); }
  });

  it("rejects another Activation's provider even in the same Run", async () => {
    const f = await providerFixture();
    try {
      const replacement = await f.kernel.execute({
        type: "StartActivation", idempotencyKey: "replacement", runId: f.run.runId,
        expectedRunRevision: 1, outboxEventId: f.run.outboxEventId, outboxLeaseToken: f.run.outboxLeaseToken,
      }, runtimeContext);
      await expect(f.kernel.execute({
        ...f.command, activationId: replacement.entityId,
      }, runtimeContext)).rejects.toMatchObject({
        code: "Forbidden", message: "Worktree ProviderAttempt belongs to a different Activation.",
      });
    } finally { f.kernel.close(); }
  });

  it("rejects a missing attempt with a fixed error that does not echo the identifier", async () => {
    const f = await providerFixture();
    try {
      await expect(f.kernel.execute({
        ...f.command, provider: { ...f.provider, providerAttemptId: "synthetic-private-missing" },
      }, runtimeContext)).rejects.toMatchObject({
        code: "NotFound", message: "Worktree ProviderAttempt does not exist.",
      });
    } finally { f.kernel.close(); }
  });

  it.each(["Completed", "Failed", "Unknown"] as const)("rejects a terminal %s attempt", async (status) => {
    const f = await providerFixture();
    try {
      await f.kernel.execute(status === "Failed" ? {
        type: "FailProviderAttempt", idempotencyKey: "terminal",
        providerAttemptId: f.provider.providerAttemptId, error: "Synthetic failure.",
      } : {
        type: "FinishProviderAttempt", idempotencyKey: "terminal",
        providerAttemptId: f.provider.providerAttemptId, status, detail: "Synthetic terminal evidence.",
      }, runtimeContext);
      await expect(f.kernel.execute(f.command, runtimeContext)).rejects.toMatchObject({
        code: "Conflict", message: "Worktree ProviderAttempt is not executing.",
      });
    } finally { f.kernel.close(); }
  });

  it("revalidates a cached native launch when its attempt finishes", async () => {
    const f = await providerFixture();
    try {
      await f.kernel.execute(f.command, runtimeContext);
      await f.kernel.execute({
        type: "FailProviderAttempt", idempotencyKey: "failed",
        providerAttemptId: f.provider.providerAttemptId, error: "Synthetic failure.",
      }, runtimeContext);
      await expect(f.kernel.execute(f.command, runtimeContext)).rejects.toMatchObject({
        code: "Conflict", message: "Worktree ProviderAttempt is not executing.",
      });
    } finally { f.kernel.close(); }
  });

  it("does not let a valid provider bypass the original lease or Activation fences", async () => {
    const f = await providerFixture();
    try {
      for (const override of [
        { leaseToken: "forged" }, { generation: 0 }, { fencingToken: 0 },
        { activationId: f.run.attentionActivationId },
      ]) {
        await expect(f.kernel.execute({ ...f.command, ...override }, runtimeContext)).rejects.toThrow();
      }
      expect((await f.kernel.query({ type: "GetPhysicalWorktree", worktreeId: "tree" }, runtimeContext))
        .latestExecution).toBeNull();
    } finally { f.kernel.close(); }
  });
});

describe("physical Worktree Run discovery", () => {
  it("filters in SQL before bounded pagination, retains unfiltered queries and rejects missing Runs", async () => {
    const f = await providerFixture();
    try {
      const finish = async (run: Awaited<ReturnType<typeof createRun>>, key: string) => {
        await f.kernel.execute({
          type: "CompleteRun", idempotencyKey: `complete-${key}`, runId: run.runId,
          expectedRunRevision: 1, incorporatedThroughInputSequence: 1,
        }, run.agentContext);
        await f.kernel.execute({
          type: "AcknowledgeOutboxEvents", idempotencyKey: `ack-${key}`,
          outboxEventIds: [run.outboxEventId], leaseToken: run.outboxLeaseToken,
        }, runtimeContext);
      };
      await finish(f.run, "first");
      const other = await createRun(f.kernel, "-other");
      await finish(other, "other");
      const empty = await createRun(f.kernel, "-empty");
      await registerTree(f.kernel, other.runId, "a-other");
      await registerTree(f.kernel, f.run.runId, "tree-two");
      expect(await f.kernel.query({
        type: "ListPhysicalWorktrees", runId: empty.runId, limit: 2,
      }, runtimeContext)).toEqual({ items: [], hasMore: false });
      const page = await f.kernel.query({
        type: "ListPhysicalWorktrees", runId: f.run.runId, limit: 1,
      }, runtimeContext);
      expect(page.items.map((tree) => tree.worktreeId)).toEqual(["tree"]);
      expect(page.hasMore).toBe(true);
      const next = await f.kernel.query({
        type: "ListPhysicalWorktrees", runId: f.run.runId, afterWorktreeId: "tree", limit: 1,
      }, runtimeContext);
      expect(next.items.map((tree) => tree.worktreeId)).toEqual(["tree-two"]);
      expect(next.hasMore).toBe(false);
      const ambiguous = await f.kernel.query({
        type: "ListPhysicalWorktrees", runId: f.run.runId, limit: 2,
      }, runtimeContext);
      expect(ambiguous.items.map((tree) => tree.worktreeId)).toEqual(["tree", "tree-two"]);
      expect((await f.kernel.query({ type: "ListPhysicalWorktrees" }, runtimeContext)).items)
        .toHaveLength(3);
      await expect(f.kernel.query({
        type: "ListPhysicalWorktrees", runId: "missing", limit: 2,
      }, runtimeContext)).rejects.toMatchObject({ code: "NotFound" });
      for (const actor of [humanContext, f.run.agentContext]) {
        await expect(f.kernel.query({
          type: "ListPhysicalWorktrees", runId: f.run.runId, limit: 2,
        }, actor)).rejects.toMatchObject({ code: "Forbidden" });
      }
    } finally { f.kernel.close(); }
  });
});
