import { fileURLToPath } from "node:url";

import { CopilotAcpAdapter, LocalWorktreeExecutor, ProviderExecutionError } from "@torsor/agent-runtime";
import { KernelError, TorsorKernel } from "@torsor/kernel";
import { OperationalLogger } from "@torsor/operational-logging";
import { describe, expect, it, vi } from "vitest";
import { createLocalRuntimeHost } from "../src/local-runtime-host.js";
import { bootstrap, syntheticRepository } from "../../../packages/agent-runtime/test/fixtures/worktree-fixture.js";
import { deferred } from "../../../packages/agent-runtime/test/fixtures/deferred.js";

const fixture = fileURLToPath(new URL(
  "../../../packages/agent-runtime/test/fixtures/native-acp-provider.mjs", import.meta.url,
));
const headers = { Authorization: "Bearer synthetic-human-token", "Content-Type": "application/json" };

describe("trusted-local HTTP Host", () => {
  it.each([
    { phase: "before-admission", cancel: true, failure: "none" },
    { phase: "before-return", cancel: true, failure: "none" },
    { phase: "forced-before-return", cancel: true, failure: "none" },
    { phase: "running-receipt", cancel: true, failure: "none" },
    { phase: "running-receipt", cancel: true, failure: "persistence" },
    { phase: "before-return", cancel: true, failure: "spawn" },
    { phase: "before-return", cancel: true, failure: "provider" },
    { phase: "before-return", cancel: true, failure: "process-exit" },
    { phase: "before-return", cancel: true, failure: "settlement" },
    { phase: "before-return", cancel: false, failure: "authority" },
  ] as const)("settles native launch before delivery and preserves observation: $phase / $failure", async ({ phase, cancel, failure }) => {
    const repo = syntheticRepository();
    const entered = deferred<string>();
    const release = deferred<void>();
    const aborted = deferred<void>();
    const acknowledged = deferred<void>();
    let runActivation: string | undefined;
    let launchingRunId: string | undefined;
    let returned = false;
    let acknowledgedEarly = false;
    let spawns = 0;
    let childClosed: Promise<PromiseSettledResult<unknown>> | undefined;
    let ownerClosed = false;
    let kernel: TorsorKernel | undefined;
    const operationalLines: string[] = [];
    const operationalLogger = new OperationalLogger({
      sink: { write: (line) => { operationalLines.push(line); } },
    });
    const host = createLocalRuntimeHost({
      databasePath: repo.databasePath, bootstrap, port: 0,
      credentials: [{ token: "synthetic-human-token", principalContext: { principalId: "human" } }],
      runtimePrincipalId: "runtime", projectIds: ["project"], runtimePollIntervalMs: 1,
      operationalLogger,
      providerTimeoutMs: 120_000, activationDurationMs: 125_000,
      attentionLeaseMs: 125_000, outboxLeaseMs: 125_000,
      // Before admission, exercise the authoritative rejection rather than the poll.
      cancellationPollMs: phase === "before-admission" ? 60_000 : 5,
      adapter: new CopilotAcpAdapter({
        policy: { kind: "trusted-local", permissionMode: "allow-all" },
        command: process.execPath, commandArgs: [fixture, "hang"],
        unsafeAllowCustomCommandArgs: true, userEnvironment: {},
      }),
      worktreeExecutorFactory: (ownedKernel, logger) => {
        kernel = ownedKernel;
        const executor = new LocalWorktreeExecutor({
          kernel: ownedKernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: 125_000,
          ...(logger ? { operationalLogger: logger } : {}),
          ...(phase === "forced-before-return" ? { stopGraceMs: 1 } : {}),
        });
        const start = executor.startProvider.bind(executor);
        vi.spyOn(executor, "startProvider").mockImplementation(async (input) => {
          runActivation = input.activationId;
          launchingRunId = input.runId;
          input.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
          if (phase === "before-admission") {
            entered.resolve(input.runId);
            await release.promise;
          }
          const handle = await start({
            ...input,
            start: (cwd) => {
              spawns += 1;
              const child = input.start(cwd);
              childClosed = Promise.allSettled([child.closed]).then(([observation]) => {
                ownerClosed = true;
                return observation;
              });
              return child;
            },
          });
          if (phase === "before-return" || phase === "forced-before-return") {
            entered.resolve(input.runId);
            await release.promise;
          }
          returned = true;
          if (failure === "spawn") throw new ProviderExecutionError("provider_process_start_failed", "Failed");
          if (failure === "provider") throw new ProviderExecutionError("provider_protocol_error", "Failed");
          if (failure === "process-exit") throw new ProviderExecutionError("provider_process_exited", "Unknown");
          if (failure === "authority") throw new KernelError("WriterAuthorityLost", "Synthetic fencing loss.");
          return handle;
        });
        const stop = executor.stopActivation.bind(executor);
        vi.spyOn(executor, "stopActivation").mockImplementation(async (activationId) => {
          await stop(activationId);
          if (activationId === runActivation && failure === "settlement") {
            throw new Error("Synthetic stop settlement failure.");
          }
        });
        const execute = ownedKernel.execute.bind(ownedKernel);
        vi.spyOn(ownedKernel, "execute").mockImplementation(
          async (command, context, operationContext) => {
            const result = await execute(command, context, operationContext);
          if (phase === "running-receipt" && command.type === "RecordWorktreeExecution" && command.state === "Running") {
            entered.resolve(launchingRunId!);
            await release.promise;
            if (failure === "persistence") throw new Error("Synthetic Running receipt persistence failure.");
          }
          if (command.type === "AcknowledgeOutboxEvents" && runActivation) {
            acknowledgedEarly ||= phase !== "before-admission" && (!returned || !ownerClosed);
            acknowledged.resolve();
          }
            return result;
          },
        );
        return executor;
      },
    });
    void host.finished.catch((error: unknown) => {
      entered.reject(error);
      acknowledged.reject(error);
    });
    void acknowledged.promise.catch(() => undefined);
    try {
      const origin = await host.start();
      const startResponse = await fetch(`${origin}/api/v1/commands/start-thread`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "launch-window", projectId: "project", channelId: "channel",
          body: "Synthetic launch-window cancellation.", targetAgentIds: ["orbit"],
        }),
      });
      expect(startResponse.status).toBe(200);
      const startResult = (await startResponse.json()).result as {
        correlationId: string;
      };
      const runId = await entered.promise;
      if (cancel) {
        const projection = await kernel!.query({ type: "GetRunProjection", runId }, { principalId: "human" });
        expect((await fetch(`${origin}/api/v1/commands/cancel-run`, {
          method: "POST", headers,
          body: JSON.stringify({
            idempotencyKey: "cancel-launch-window", runId,
            expectedRunRevision: projection.run.revision, reason: "Synthetic Human cancellation.",
          }),
        })).status).toBe(200);
        if (phase !== "before-admission") {
          await aborted.promise;
          await vi.waitFor(() => expect(ownerClosed).toBe(true), { timeout: 3_000 });
          await childClosed;
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(acknowledgedEarly).toBe(false);
        }
      }
      release.resolve();
      if (failure === "none") {
        await acknowledged.promise;
        expect(acknowledgedEarly).toBe(false);
        expect((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) })).status).toBe(200);
        const refresh = await fetch(`${origin}/api/v1/runs/${runId}`, { headers, signal: AbortSignal.timeout(2_000) });
        expect(refresh.status).toBe(200);
        const projection = (await refresh.json()).run;
        expect(projection.run.state).toBe("Cancelled");
        expect(projection.providerAttempts.at(-1)?.status).toBe("Unknown");
        expect(projection.activity.items).toEqual([]);
        const operationalEvents = operationalLines.map((line) => JSON.parse(line));
        expect(operationalEvents).toContainEqual(expect.objectContaining({
          event: "runtime.activation",
          outcome: "started",
          correlationId: startResult.correlationId,
        }));
        const runActivation = operationalEvents.find((event) =>
          event.event === "runtime.activation" &&
          event.outcome === "started" &&
          event.runId === runId
        );
        expect(runActivation).toMatchObject({
          correlationId: startResult.correlationId,
        });
        expect(operationalEvents).toContainEqual(
          expect.objectContaining({
            event: "runtime.run_terminal",
            outcome: "cancelled",
            errorCode: "run_cancelled",
            correlationId: startResult.correlationId,
          }),
        );
        const serializedOperationalLog = operationalLines.join("");
        expect(serializedOperationalLog).not.toContain(fixture);
        expect(serializedOperationalLog).not.toContain("Synthetic launch-window cancellation.");
        expect((await fetch(`${origin}/api/v1/commands/start-thread`, {
          method: "POST", headers, signal: AbortSignal.timeout(2_000),
          body: JSON.stringify({
            idempotencyKey: "after-launch-cancellation", projectId: "project", channelId: "channel",
            body: "The observation Host remains usable.", targetAgentIds: [],
          }),
        })).status).toBe(200);
      } else {
        if (failure === "settlement") await expect(host.finished).rejects.toThrow("Synthetic stop settlement failure.");
        else await expect(host.finished).rejects.toMatchObject({
          diagnosticCode: failure === "spawn" ? "provider_process_start_failed"
            : failure === "provider" ? "provider_protocol_error"
            : failure === "process-exit" ? "provider_process_exited"
            : failure === "persistence" ? "provider_execution_failed" : "provider_worktree_authority_lost",
        });
        await expect(fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
      }
      expect(spawns).toBe(phase === "before-admission" ? 0 : 1);
    } finally {
      release.resolve();
      const [closed] = await Promise.allSettled([host.close()]);
      const observation = await childClosed;
      vi.restoreAllMocks();
      const reopened = TorsorKernel.open({ databasePath: repo.databasePath });
      try {
        const trees = await reopened.query({ type: "ListPhysicalWorktrees" }, { principalId: "runtime" });
        for (const tree of trees.items) {
          expect(["StopConfirmed", "ForceTerminated", "Uncertain"]).toContain(tree.latestExecution?.state);
          if (tree.latestExecution?.state === "Uncertain") expect(tree.state).toBe("Quarantined");
          if (observation?.status === "rejected") {
            expect(observation.reason).toMatchObject({ outcome: "Unknown" });
            expect(tree).toMatchObject({ state: "Quarantined", latestExecution: { state: "Uncertain" } });
          }
          if (phase === "forced-before-return") {
            if (process.platform === "win32") {
              expect(observation).toMatchObject({
                status: "fulfilled", value: { code: 137, signal: null, error: null },
              });
              expect(tree).toMatchObject({ state: "Ready", latestExecution: { state: "ForceTerminated" } });
            } else {
              expect(observation?.status).toBe("rejected");
              expect(tree).toMatchObject({ state: "Quarantined", latestExecution: { state: "Uncertain" } });
            }
          }
          const run = await reopened.query({ type: "GetRunProjection", runId: tree.runId }, { principalId: "human" });
          expect(run.run.state).not.toBe("Completed");
          expect(run.providerAttempts.at(-1)?.status).not.toBe("Completed");
          expect(run.activity.items).toEqual([]);
        }
      } finally { reopened.close(); repo.dispose(); }
      if (failure === "none") expect(closed.status).toBe("fulfilled");
    }
  }, 150_000);

  it("propagates independent fencing loss after Human cancellation without acknowledging delivery", async () => {
    const repo = syntheticRepository();
    const running = deferred<string>();
    const release = deferred<void>();
    const aborted = deferred<void>();
    const childClosed = deferred<void>();
    let kernel: TorsorKernel | undefined;
    let leaseAuthority: {
      readonly worktreeId: string;
      readonly generation: number;
      readonly fencingToken: number;
      readonly leaseToken: string;
    } | undefined;
    const host = createLocalRuntimeHost({
      databasePath: repo.databasePath, bootstrap, port: 0,
      credentials: [{ token: "synthetic-human-token", principalContext: { principalId: "human" } }],
      runtimePrincipalId: "runtime", projectIds: ["project"], runtimePollIntervalMs: 1,
      providerTimeoutMs: 120_000, activationDurationMs: 125_000,
      attentionLeaseMs: 125_000, outboxLeaseMs: 125_000, cancellationPollMs: 5,
      adapter: new CopilotAcpAdapter({
        policy: { kind: "trusted-local", permissionMode: "allow-all" },
        command: process.execPath, commandArgs: [fixture, "hang"],
        unsafeAllowCustomCommandArgs: true, userEnvironment: {},
      }),
      worktreeExecutorFactory: (ownedKernel) => {
        kernel = ownedKernel;
        const execute = ownedKernel.execute.bind(ownedKernel);
        vi.spyOn(ownedKernel, "execute").mockImplementation(async (command, context, operationContext) => {
          const result = await execute(command, context, operationContext);
          if (command.type === "AcquireWorktreeWriterLease") {
            leaseAuthority = {
              worktreeId: command.worktreeId,
              generation: result.leaseGeneration!,
              fencingToken: result.fencingToken!,
              leaseToken: result.leaseToken!,
            };
          }
          return result;
        });
        const executor = new LocalWorktreeExecutor({
          kernel: ownedKernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: 125_000,
        });
        const start = executor.startProvider.bind(executor);
        vi.spyOn(executor, "startProvider").mockImplementation(async (input) => {
          input.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
          await start({
            ...input,
            start: (cwd) => {
              const child = input.start(cwd);
              void child.closed.finally(() => childClosed.resolve());
              return child;
            },
          });
          running.resolve(input.runId);
          await release.promise;
          throw new KernelError("WriterAuthorityLost", "Synthetic independent fencing loss.");
        });
        return executor;
      },
    });
    void host.finished.catch((error: unknown) => running.reject(error));
    try {
      const origin = await host.start();
      expect((await fetch(`${origin}/api/v1/commands/start-thread`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "independent-fencing-loss", projectId: "project", channelId: "channel",
          body: "Synthetic independent fencing loss.", targetAgentIds: ["orbit"],
        }),
      })).status).toBe(200);
      const runId = await running.promise;
      expect(leaseAuthority).toMatchObject({ generation: 1, fencingToken: 1 });
      const quarantined = await kernel!.execute({
        type: "QuarantineWorktreeWriterLease",
        idempotencyKey: "independent-fencing-quarantine",
        ...leaseAuthority!,
        expectedGeneration: leaseAuthority!.generation,
        expectedFencingToken: leaseAuthority!.fencingToken,
        reason: "Synthetic independent fencing incident.",
        evidence: { source: "synthetic-review-regression" },
      }, { principalId: "runtime" });
      expect(quarantined.worktreeWriterLease).toMatchObject({
        status: "Quarantined", generation: 1, fencingToken: 2,
      });
      const projection = await kernel!.query({ type: "GetRunProjection", runId }, { principalId: "human" });
      expect((await fetch(`${origin}/api/v1/commands/cancel-run`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "cancel-after-independent-fencing-loss", runId,
          expectedRunRevision: projection.run.revision, reason: "Synthetic Human cancellation.",
        }),
      })).status).toBe(200);
      await aborted.promise;
      release.resolve();
      await expect(Promise.race([
        host.finished,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Host did not reject independent fencing loss.")), 3_000);
        }),
      ])).rejects.toMatchObject({
        diagnosticCode: "provider_worktree_authority_lost",
        outcome: "Unknown",
      });
      await childClosed.promise;
    } finally {
      release.resolve();
      await Promise.allSettled([host.close(), childClosed.promise]);
      vi.restoreAllMocks();
      const reopened = TorsorKernel.open({ databasePath: repo.databasePath });
      try {
        const trees = await reopened.query({ type: "ListPhysicalWorktrees" }, { principalId: "runtime" });
        expect(trees.items).toHaveLength(1);
        expect(trees.items[0]?.latestExecution).toMatchObject({ state: "StopConfirmed" });
        expect(await reopened.query(
          { type: "GetWorktreeWriterLease", worktreeId: trees.items[0]!.worktreeId },
          { principalId: "runtime" },
        )).toMatchObject({ status: "Quarantined", generation: 1, fencingToken: 2 });
        const run = await reopened.query(
          { type: "GetRunProjection", runId: trees.items[0]!.runId },
          { principalId: "human" },
        );
        expect(run.run.state).toBe("Cancelled");
        expect(run.providerAttempts.at(-1)?.status).toBe("Unknown");
        const outbox = await reopened.query(
          { type: "ListOutboxEvents", includeAcknowledged: true, limit: 500 },
          { principalId: "runtime" },
        );
        expect(outbox.items.filter((event) =>
          event.aggregateId === run.run.id &&
          (event.topic === "run.activation-requested" || event.topic === "run-input.available")
        ).every((event) => event.acknowledgedAt === null)).toBe(true);
      } finally {
        reopened.close();
        repo.dispose();
      }
    }
  }, 150_000);

  it("propagates an independently observed provider exit when Human cancellation follows it", async () => {
    const repo = syntheticRepository();
    const providerExited = deferred<string>();
    const releaseClose = deferred<void>();
    let kernel: TorsorKernel | undefined;
    const host = createLocalRuntimeHost({
      databasePath: repo.databasePath, bootstrap, port: 0,
      credentials: [{ token: "synthetic-human-token", principalContext: { principalId: "human" } }],
      runtimePrincipalId: "runtime", projectIds: ["project"], runtimePollIntervalMs: 1,
      providerTimeoutMs: 120_000, activationDurationMs: 125_000,
      attentionLeaseMs: 125_000, outboxLeaseMs: 125_000, cancellationPollMs: 5,
      adapter: new CopilotAcpAdapter({
        policy: { kind: "trusted-local", permissionMode: "allow-all" },
        command: process.execPath, commandArgs: [fixture, "independent-exit"],
        unsafeAllowCustomCommandArgs: true, userEnvironment: {},
      }),
      worktreeExecutorFactory: (ownedKernel) => {
        kernel = ownedKernel;
        const executor = new LocalWorktreeExecutor({
          kernel: ownedKernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: 125_000,
        });
        const start = executor.startProvider.bind(executor);
        vi.spyOn(executor, "startProvider").mockImplementation((input) => start({
          ...input,
          start: (cwd) => {
            const child = input.start(cwd);
            const observed = "providerExit" in child && child.providerExit instanceof Promise
              ? child.providerExit : child.closed;
            void observed.then(() => providerExited.resolve(input.runId));
            return {
              pid: child.pid,
              result: child.result,
              ...("providerExit" in child ? { providerExit: child.providerExit } : {}),
              closed: child.closed.then(async (evidence) => {
                await releaseClose.promise;
                return evidence;
              }),
              requestStop: () => child.requestStop(),
              forceStop: () => child.forceStop(),
            };
          },
        }));
        return executor;
      },
    });
    void host.finished.catch((error: unknown) => providerExited.reject(error));
    try {
      const origin = await host.start();
      expect((await fetch(`${origin}/api/v1/commands/start-thread`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "exit-before-cancel", projectId: "project", channelId: "channel",
          body: "Synthetic independent provider exit.", targetAgentIds: ["orbit"],
        }),
      })).status).toBe(200);
      const runId = await providerExited.promise;
      const projection = await kernel!.query({ type: "GetRunProjection", runId }, { principalId: "human" });
      expect((await fetch(`${origin}/api/v1/commands/cancel-run`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "cancel-after-provider-exit", runId,
          expectedRunRevision: projection.run.revision, reason: "Synthetic Human cancellation.",
        }),
      })).status).toBe(200);
      releaseClose.resolve();
      const finished = Promise.race([
        host.finished,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Host did not reject independent provider exit.")), 3_000);
        }),
      ]);
      await expect(finished).rejects.toMatchObject({
        diagnosticCode: "provider_process_exited",
        outcome: "Unknown",
      });
    } finally {
      releaseClose.resolve();
      await Promise.allSettled([host.close()]);
      vi.restoreAllMocks();
      const reopened = TorsorKernel.open({ databasePath: repo.databasePath });
      try {
        const trees = await reopened.query({ type: "ListPhysicalWorktrees" }, { principalId: "runtime" });
        expect(trees.items).toHaveLength(1);
        expect(trees.items[0]?.latestExecution).toMatchObject({ state: "StopConfirmed" });
        const run = await reopened.query(
          { type: "GetRunProjection", runId: trees.items[0]!.runId },
          { principalId: "human" },
        );
        expect(run.run.state).toBe("Cancelled");
        expect(run.providerAttempts.at(-1)?.status).toBe("Unknown");
        const outbox = await reopened.query(
          { type: "ListOutboxEvents", includeAcknowledged: true, limit: 500 },
          { principalId: "runtime" },
        );
        expect(outbox.items.filter((event) =>
          event.aggregateId === run.run.id &&
          (event.topic === "run.activation-requested" || event.topic === "run-input.available")
        ).every((event) => event.acknowledgedAt === null)).toBe(true);
      } finally {
        reopened.close();
        repo.dispose();
      }
    }
  }, 150_000);

  it("rejects cancellation suppression when an independent quarantine advances the fence", async () => {
    const repo = syntheticRepository();
    const running = deferred<string>();
    const settling = deferred<void>();
    const releaseSettlement = deferred<void>();
    let kernel: TorsorKernel | undefined;
    let launchingRunId: string | undefined;
    let leaseAuthority: {
      readonly worktreeId: string;
      readonly generation: number;
      readonly fencingToken: number;
      readonly leaseToken: string;
    } | undefined;
    const host = createLocalRuntimeHost({
      databasePath: repo.databasePath, bootstrap, port: 0,
      credentials: [{ token: "synthetic-human-token", principalContext: { principalId: "human" } }],
      runtimePrincipalId: "runtime", projectIds: ["project"], runtimePollIntervalMs: 1,
      providerTimeoutMs: 120_000, activationDurationMs: 125_000,
      attentionLeaseMs: 125_000, outboxLeaseMs: 125_000, cancellationPollMs: 5,
      adapter: new CopilotAcpAdapter({
        policy: { kind: "trusted-local", permissionMode: "allow-all" },
        command: process.execPath, commandArgs: [fixture, "hang"],
        unsafeAllowCustomCommandArgs: true, userEnvironment: {},
      }),
      worktreeExecutorFactory: (ownedKernel) => {
        kernel = ownedKernel;
        const execute = ownedKernel.execute.bind(ownedKernel);
        vi.spyOn(ownedKernel, "execute").mockImplementation(async (command, context, operationContext) => {
          if (command.type === "RecordWorktreeExecution" && command.state === "StopConfirmed") {
            settling.resolve();
            await releaseSettlement.promise;
          }
          const result = await execute(command, context, operationContext);
          if (command.type === "AcquireWorktreeWriterLease") {
            leaseAuthority = {
              worktreeId: command.worktreeId,
              generation: result.leaseGeneration!,
              fencingToken: result.fencingToken!,
              leaseToken: result.leaseToken!,
            };
          }
          if (command.type === "RecordWorktreeExecution" && command.state === "Running") {
            running.resolve(launchingRunId!);
          }
          return result;
        });
        const executor = new LocalWorktreeExecutor({
          kernel: ownedKernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: 125_000,
        });
        const start = executor.startProvider.bind(executor);
        vi.spyOn(executor, "startProvider").mockImplementation((input) => {
          launchingRunId = input.runId;
          return start(input);
        });
        return executor;
      },
    });
    void host.finished.catch((error: unknown) => {
      running.reject(error);
      settling.reject(error);
    });
    try {
      const origin = await host.start();
      expect((await fetch(`${origin}/api/v1/commands/start-thread`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "cancel-before-quarantine", projectId: "project", channelId: "channel",
          body: "Synthetic inverse fencing race.", targetAgentIds: ["orbit"],
        }),
      })).status).toBe(200);
      const runId = await running.promise;
      expect(leaseAuthority).toMatchObject({ generation: 1, fencingToken: 1 });
      const projection = await kernel!.query({ type: "GetRunProjection", runId }, { principalId: "human" });
      expect((await fetch(`${origin}/api/v1/commands/cancel-run`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "cancel-before-independent-quarantine", runId,
          expectedRunRevision: projection.run.revision, reason: "Synthetic Human cancellation.",
        }),
      })).status).toBe(200);
      await settling.promise;
      const quarantined = await kernel!.execute({
        type: "QuarantineWorktreeWriterLease",
        idempotencyKey: "quarantine-after-cancellation-stop",
        ...leaseAuthority!,
        expectedGeneration: leaseAuthority!.generation,
        expectedFencingToken: leaseAuthority!.fencingToken,
        reason: "Synthetic independent fencing incident after cancellation.",
        evidence: { source: "synthetic-inverse-review-regression" },
      }, { principalId: "runtime" });
      expect(quarantined.worktreeWriterLease).toMatchObject({
        status: "Quarantined", generation: 1, fencingToken: 2,
      });
      releaseSettlement.resolve();
      await expect(Promise.race([
        host.finished,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Host did not reject the advanced fencing token.")), 3_000);
        }),
      ])).rejects.toMatchObject({
        diagnosticCode: "provider_worktree_authority_lost",
        outcome: "Unknown",
      });
    } finally {
      releaseSettlement.resolve();
      await Promise.allSettled([host.close()]);
      vi.restoreAllMocks();
      const reopened = TorsorKernel.open({ databasePath: repo.databasePath });
      try {
        const trees = await reopened.query({ type: "ListPhysicalWorktrees" }, { principalId: "runtime" });
        expect(trees.items).toHaveLength(1);
        expect(trees.items[0]).toMatchObject({
          state: "Ready",
          latestExecution: { state: "StopConfirmed", generation: 1, fencingToken: 1 },
        });
        expect(await reopened.query(
          { type: "GetWorktreeWriterLease", worktreeId: trees.items[0]!.worktreeId },
          { principalId: "runtime" },
        )).toMatchObject({ status: "Quarantined", generation: 1, fencingToken: 2 });
        const run = await reopened.query(
          { type: "GetRunProjection", runId: trees.items[0]!.runId },
          { principalId: "human" },
        );
        expect(run.run.state).toBe("Cancelled");
        expect(run.providerAttempts.at(-1)?.status).toBe("Unknown");
        const outbox = await reopened.query(
          { type: "ListOutboxEvents", includeAcknowledged: true, limit: 500 },
          { principalId: "runtime" },
        );
        expect(outbox.items.filter((event) =>
          event.aggregateId === run.run.id &&
          (event.topic === "run.activation-requested" || event.topic === "run-input.available")
        ).every((event) => event.acknowledgedAt === null)).toBe(true);
      } finally {
        reopened.close();
        repo.dispose();
      }
    }
  }, 150_000);

  it.each(["success", "hang", "cancel"])("publishes safe Timeline facts and closes its owned process: %s", async (scenario) => {
    const repo = syntheticRepository();
    const observed = deferred<string>();
    const settled = deferred<void>();
    let runId: string | undefined;
    const host = createLocalRuntimeHost({
      databasePath: repo.databasePath, bootstrap, port: 0,
      credentials: [{ token: "synthetic-human-token", principalContext: { principalId: "human" } }],
      runtimePrincipalId: "runtime", projectIds: ["project"], runtimePollIntervalMs: 1,
      providerTimeoutMs: 120_000, activationDurationMs: 125_000,
      attentionLeaseMs: 125_000, outboxLeaseMs: 125_000,
      adapter: new CopilotAcpAdapter({
        policy: { kind: "trusted-local", permissionMode: "allow-all" },
        command: process.execPath, commandArgs: [fixture, scenario === "cancel" ? "hang" : scenario], unsafeAllowCustomCommandArgs: true,
        userEnvironment: {},
      }),
      worktreeExecutorFactory: (kernel) => {
        const execute = kernel.execute.bind(kernel);
        vi.spyOn(kernel, "execute").mockImplementation(async (command, context, operationContext) => {
          const result = await execute(command, context, operationContext);
          if (command.type === "AppendRunActivity" && command.kind === "tool_started") {
            runId = command.runId;
            if (scenario !== "success") observed.resolve(runId);
          }
          if (command.type === "FinishProviderAttempt" && command.status === "Completed" && runId) {
            observed.resolve(runId);
          }
          if (command.type === "AcknowledgeOutboxEvents" && runId) settled.resolve();
          return result;
        });
        return new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: 125_000 });
      },
    });
    void host.finished.catch((error: unknown) => {
      observed.reject(error);
      settled.reject(error);
    });
    void settled.promise.catch(() => undefined);
    try {
      const origin = await host.start();
      const response = await fetch(`${origin}/api/v1/commands/start-thread`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "native-http", projectId: "project", channelId: "channel",
          body: "Edit and test the disposable synthetic Worktree.", targetAgentIds: ["orbit"],
        }),
      });
      expect(response.status).toBe(200);
      const id = await observed.promise;
      const projected = await fetch(`${origin}/api/v1/runs/${id}`, { headers });
      expect(projected.status).toBe(200);
      const body = await projected.text();
      expect(body).toContain("tool_started");
      expect(body).not.toContain("synthetic-private");
      expect(body).not.toContain("diagnosticSessionId");
      if (scenario === "success") expect(body).toContain("tool_completed");
      if (scenario === "cancel") {
        const projection = JSON.parse(body);
        const cancellation = await fetch(`${origin}/api/v1/commands/cancel-run`, {
          method: "POST", headers, body: JSON.stringify({
            idempotencyKey: "human-native-cancel", runId: id,
            expectedRunRevision: projection.run.run.revision, reason: "Synthetic Human cancellation.",
          }),
        });
        expect(cancellation.status).toBe(200);
        await settled.promise;
        const refresh = await fetch(`${origin}/api/v1/runs/${id}`, { headers });
        expect(refresh.status).toBe(200);
        expect((await refresh.json()).run.run.state).toBe("Cancelled");
      }
      if (scenario === "hang") await expect(host.close()).rejects.toMatchObject({ diagnosticCode: "provider_cancelled" });
      else await host.close();
      const reopened = TorsorKernel.open({ databasePath: repo.databasePath });
      try {
        const tree = (await reopened.query({ type: "ListPhysicalWorktrees" }, { principalId: "runtime" })).items[0]!;
        expect(tree.latestExecution).toMatchObject({ state: "StopConfirmed", authorityRevokedAt: expect.any(String) });
        const run = await reopened.query({ type: "GetRunProjection", runId: id }, { principalId: "human" });
        if (scenario === "success") expect(run.run.state).toBe("Completed");
        else expect(run.run.state).not.toBe("Completed");
        expect(JSON.stringify(run)).not.toContain("synthetic-private");
      } finally { reopened.close(); }
    } finally {
      if (scenario === "hang") await expect(host.close()).rejects.toMatchObject({ diagnosticCode: "provider_cancelled" });
      else await host.close();
      vi.restoreAllMocks(); repo.dispose();
    }
  }, 150_000);
});
