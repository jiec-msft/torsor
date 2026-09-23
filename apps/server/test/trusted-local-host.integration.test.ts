import { fileURLToPath } from "node:url";

import { CopilotAcpAdapter, LocalWorktreeExecutor, ProviderExecutionError } from "@torsor/agent-runtime";
import { KernelError, TorsorKernel } from "@torsor/kernel";
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
    const host = createLocalRuntimeHost({
      databasePath: repo.databasePath, bootstrap, port: 0,
      credentials: [{ token: "synthetic-human-token", principalContext: { principalId: "human" } }],
      runtimePrincipalId: "runtime", projectIds: ["project"], runtimePollIntervalMs: 1,
      providerTimeoutMs: 120_000, activationDurationMs: 125_000,
      attentionLeaseMs: 125_000, outboxLeaseMs: 125_000,
      // Before admission, exercise the authoritative rejection rather than the poll.
      cancellationPollMs: phase === "before-admission" ? 60_000 : 5,
      adapter: new CopilotAcpAdapter({
        policy: { kind: "trusted-local", permissionMode: "allow-all" },
        command: process.execPath, commandArgs: [fixture, "hang"],
        unsafeAllowCustomCommandArgs: true, userEnvironment: {},
      }),
      worktreeExecutorFactory: (ownedKernel) => {
        kernel = ownedKernel;
        const executor = new LocalWorktreeExecutor({
          kernel: ownedKernel, runtimePrincipalId: "runtime", ...repo, leaseDurationMs: 125_000,
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
        vi.spyOn(ownedKernel, "execute").mockImplementation(async (command, context) => {
          const result = await execute(command, context);
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
        });
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
      expect((await fetch(`${origin}/api/v1/commands/start-thread`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "launch-window", projectId: "project", channelId: "channel",
          body: "Synthetic launch-window cancellation.", targetAgentIds: ["orbit"],
        }),
      })).status).toBe(200);
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
          const run = await reopened.query({ type: "GetRunProjection", runId: tree.runId }, { principalId: "human" });
          expect(run.run.state).not.toBe("Completed");
          expect(run.providerAttempts.at(-1)?.status).not.toBe("Completed");
          expect(run.activity.items).toEqual([]);
        }
      } finally { reopened.close(); repo.dispose(); }
      if (phase === "forced-before-return") expect(observation?.status).toBe("rejected");
      if (failure === "none") expect(closed.status).toBe("fulfilled");
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
        vi.spyOn(kernel, "execute").mockImplementation(async (command, context) => {
          const result = await execute(command, context);
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
