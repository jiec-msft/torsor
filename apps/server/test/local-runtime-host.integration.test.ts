import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRuntime, DeterministicFakeAdapter, LocalWorktreeExecutor } from "@torsor/agent-runtime";
import type { AgentRuntimeHooks } from "@torsor/agent-runtime";
import {
  LocalArtifactStorage,
  TorsorKernel,
  type CommandResult,
  type KernelBootstrap,
  type RunProjection,
  type ThreadProjection,
} from "@torsor/kernel";
import {
  afterEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

import {
  createLocalRuntimeHost,
  createTorsorHttpService,
  type LocalRuntimeHost,
} from "../src/index.js";
import { syntheticRepository } from "../../../packages/agent-runtime/test/fixtures/worktree-fixture.js";
import { nodeProbeDriver, type ControlledChild } from "../../../packages/agent-runtime/src/controlled-process.js";

const bootstrap: KernelBootstrap = {
  principals: [
    { id: "principal-human", kind: "human", displayName: "Avery Stone" },
    { id: "principal-runtime", kind: "runtime", displayName: "Local Runtime" },
    { id: "principal-orbit", kind: "agent", displayName: "Orbit" },
  ],
  projects: [{ id: "project-sample", name: "Sample Project" }],
  channels: [
    {
      id: "channel-general",
      projectId: "project-sample",
      name: "general",
    },
  ],
  agents: [
    {
      id: "agent-orbit",
      principalId: "principal-orbit",
      projectId: "project-sample",
      name: "Orbit",
      configRevision: 1,
      config: { provider: "deterministic-fake" },
    },
  ],
};

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe("Local runtime host", () => {
  it("does not open HTTP or dispatch after shutdown is requested during physical recovery", async () => {
    const directory = await temporaryDirectory();
    const recovery = deferred<void>();
    let executorClosed = false;
    const adapter = new DeterministicFakeAdapter();
    const host = createLocalRuntimeHost({
      databasePath: join(directory, "kernel.sqlite"), bootstrap,
      credentials: [{ token: "human-token", principalContext: { principalId: "principal-human" } }],
      runtimePrincipalId: "principal-runtime", projectIds: ["project-sample"], adapter,
      worktreeExecutorFactory: () => ({
        recover: () => recovery.promise,
        probe: async () => { throw new Error("No probe should be admitted."); },
        stopActivation: async () => {},
        close: async () => { executorClosed = true; },
      }),
    });
    const starting = host.start();
    const rejected = expect(starting).rejects.toThrow(/closed during recovery/);
    const closing = host.close();
    recovery.resolve();
    await closing;
    await rejected;
    await host.finished;
    expect(host.origin).toBeNull();
    expect(adapter.invocationCount).toBe(0);
    expect(executorClosed).toBe(true);
  });

  it("persists quarantine before closing Kernel when physical stop cannot be confirmed", async () => {
    const repository = syntheticRepository();
    repository.addWorktree("probe");
    let executor!: LocalWorktreeExecutor;
    let actual: ControlledChild | undefined;
    const childStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        const runId = await context.capabilities.createRunFromAttention();
        await executor.register({
          worktreeId: "uncertain-host", directoryName: "probe", runId, baseRevision: repository.baseRevision,
        });
      } else {
        const child = await executor.start({ worktreeId: "uncertain-host", activationId: context.activationId });
        await child.result;
        childStarted.resolve();
        await releaseProvider.promise;
        await context.capabilities.wait("Physical stop requires independent confirmation.");
      }
    });
    const host = createLocalRuntimeHost({
      databasePath: repository.databasePath, bootstrap,
      port: 0,
      credentials: [{ token: "human-token", principalContext: { principalId: "principal-human" } }],
      runtimePrincipalId: "principal-runtime", projectIds: ["project-sample"], adapter,
      runtimePollIntervalMs: 10,
      worktreeExecutorFactory: (kernel) => {
        executor = new LocalWorktreeExecutor({
          kernel, runtimePrincipalId: "principal-runtime", ...repository, stopGraceMs: 20, forceGraceMs: 20,
          driver: { start: (input) => {
            actual = nodeProbeDriver.start(input);
            return { ...actual, requestStop: () => {}, forceStop: () => false };
          } },
        });
        return executor;
      },
    });
    try {
      const origin = await host.start();
      const response = await fetch(`${origin}/api/v1/commands/start-thread`, {
        method: "POST", headers: { ...authorization(), "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "uncertain-host", projectId: "project-sample", channelId: "channel-general",
          body: "Exercise controlled shutdown uncertainty.", targetAgentIds: ["agent-orbit"],
        }),
      });
      expect(response.status).toBe(200);
      await childStarted.promise;
      const closing = host.close();
      releaseProvider.resolve();
      await expect(closing).rejects.toMatchObject({ outcome: "Unknown" });
      process.kill(actual!.pid!, 0);
      const reopened = TorsorKernel.open({ databasePath: repository.databasePath });
      try {
        expect(await reopened.query({
          type: "GetPhysicalWorktree", worktreeId: "uncertain-host",
        }, { principalId: "principal-runtime" })).toMatchObject({
          state: "Quarantined", latestExecution: { state: "Uncertain" },
        });
      } finally { reopened.close(); }
    } finally {
      releaseProvider.resolve();
      try {
        await expect(host.close()).rejects.toMatchObject({ outcome: "Unknown" });
      } finally {
        actual?.forceStop();
        if (actual) await actual.closed;
        repository.dispose();
      }
    }
  });

  it("runs the physical tracer through authorized report finalization, HTTP, Runtime and confirmed shutdown", async () => {
    const repository = syntheticRepository();
    repository.addWorktree("probe");
    const artifactStorage = await LocalArtifactStorage.open(join(repository.directory, "artifacts"));
    let executor!: LocalWorktreeExecutor;
    let lateProbe: (() => Promise<unknown>) | undefined;
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        expect(context.worktree).toBeUndefined();
        const runId = await context.capabilities.createRunFromAttention();
        await executor.register({
          worktreeId: "host-probe", directoryName: "probe", runId, baseRevision: repository.baseRevision,
        });
      } else {
        if (!context.worktree) throw new Error("Expected the explicitly enabled controlled executor.");
        lateProbe = () => context.worktree!.probe("host-probe");
        const result = await context.worktree.probe("host-probe");
        expect(result.stop).toBe("StopConfirmed");
        await context.capabilities.appendActivity("worktree_probe", result.digest);
        await context.capabilities.publishReport({
          idempotencyKey: "controlled-report", text: `Controlled probe SHA-256: ${result.digest}\n`,
        });
        await context.capabilities.complete({ incorporatedThroughInputSequence: 1 });
      }
    });
    const host = createLocalRuntimeHost({
      databasePath: repository.databasePath, bootstrap, artifactStorage,
      port: 0,
      credentials: [{ token: "human-token", principalContext: { principalId: "principal-human" } }],
      runtimePrincipalId: "principal-runtime", projectIds: ["project-sample"], adapter,
      runtimePollIntervalMs: 10,
      worktreeExecutorFactory: (kernel) => {
        executor = new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "principal-runtime", ...repository });
        return executor;
      },
    });
    try {
      const origin = await host.start();
      const response = await fetch(`${origin}/api/v1/commands/start-thread`, {
        method: "POST",
        headers: { ...authorization(), "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "physical-host-tracer", projectId: "project-sample", channelId: "channel-general",
          body: "Run the synthetic controlled Worktree probe.", targetAgentIds: ["agent-orbit"],
        }),
      });
      expect(response.status).toBe(200);
      const { result } = await response.json() as { result: { entityId: string } };
      const thread = await waitForCompletedThread(origin, result.entityId);
      expect(thread.runs).toMatchObject([{ state: "Completed" }]);
      expect(thread.artifacts).toHaveLength(1);
      expect(thread.artifacts[0]).toMatchObject({
        producerRunId: thread.runs[0]!.id, producerThreadRootId: result.entityId,
        mediaType: "text/plain; charset=utf-8",
      });
      expect(thread.runs[0]).toMatchObject({ causalRootId: result.entityId, delegationDepth: 0 });
      const report = await fetch(`${origin}/api/v1/artifacts/${thread.artifacts[0]!.id}/content`, {
        headers: authorization(),
      });
      expect(report.status).toBe(200);
      expect(await report.text()).toMatch(/^Controlled probe SHA-256: [a-f0-9]{64}\n$/);
      expect(JSON.stringify(thread)).not.toContain(repository.directory);
      await host.close();
      await expect(lateProbe!()).rejects.toThrow(/scope is closed/);
      const reopened = TorsorKernel.open({ databasePath: repository.databasePath });
      try {
        expect(await reopened.query({
          type: "GetPhysicalWorktree", worktreeId: "host-probe",
        }, { principalId: "principal-runtime" })).toMatchObject({
          state: "Ready", latestExecution: { state: "StopConfirmed" },
        });
        await expect(reopened.query({
          type: "GetPhysicalWorktree", worktreeId: "host-probe",
        }, { principalId: "principal-human" })).rejects.toMatchObject({ code: "Forbidden" });
      } finally { reopened.close(); }
    } finally { await host.close(); repository.dispose(); }
  });

  it("finalizes Runtime reports, downloads authorized real bytes and restores SQLite/HTTP after restart", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "reports.sqlite");
    const root = join(directory, "content");
    const storage = await LocalArtifactStorage.open(root);
    const report = "Synthetic Host report.\n";
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
      } else {
        const input = { idempotencyKey: "report", text: report };
        const id = await context.capabilities.publishReport(input);
        expect(await context.capabilities.publishReport(input)).toBe(id);
        await context.capabilities.complete({ finalReply: { body: `Report Artifact: ${id}` } });
      }
    });
    const host = createLocalRuntimeHost({
      databasePath, bootstrap, artifactStorage: storage, adapter, port: 0,
      credentials: [{ token: "human-token", principalContext: { principalId: "principal-human" } }],
      runtimePrincipalId: "principal-runtime", projectIds: ["project-sample"],
      runtimePollIntervalMs: 5,
    });
    cleanup.push(() => host.close());
    const origin = await host.start();
    const response = await fetch(`${origin}/api/v1/commands/start-thread`, {
      method: "POST", headers: { ...authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "report-thread", projectId: "project-sample", channelId: "channel-general",
        body: "Produce a synthetic report.", targetAgentIds: ["agent-orbit"],
      }),
    });
    expect(response.status).toBe(200);
    const { result } = await response.json() as { result: { entityId: string } };
    const thread = await waitForCompletedThread(origin, result.entityId);
    expect(thread.artifacts).toHaveLength(1);
    const artifact = thread.artifacts[0]!;
    const digest = createHash("sha256").update(report).digest("hex");
    expect(artifact.contentDigest).toBe(`sha256:${digest}`);
    expect(artifact.producerThreadRootId).toBe(thread.threadRootId);
    const contentPath = `/api/v1/artifacts/${artifact.id}/content`;
    expect((await fetch(`${origin}${contentPath}`)).status).toBe(401);
    const download = await fetch(`${origin}${contentPath}`, { headers: authorization() });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="report.txt"');
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await download.text()).toBe(report);
    await host.close();

    const reopenedStorage = await LocalArtifactStorage.open(root);
    let onRead: (() => Promise<void>) | undefined;
    const kernel = TorsorKernel.open({
      databasePath,
      artifactStorage: {
        put: reopenedStorage.put.bind(reopenedStorage),
        async read(digest, size) {
          const content = await reopenedStorage.read(digest, size);
          await onRead?.();
          return content;
        },
      },
    });
    cleanup.push(async () => kernel.close());
    const service = createTorsorHttpService({
      kernel, port: 0,
      credentials: [
        { token: "human-token", principalContext: { principalId: "principal-human" } },
        { token: "expired-agent", principalContext: { principalId: "principal-orbit", activationId: artifact.producerActivationId } },
      ],
    });
    cleanup.push(() => service.close());
    const restarted = await service.listen();
    const descriptor = await fetch(`${restarted}/api/v1/artifacts/${artifact.id}`, { headers: authorization() });
    expect(await descriptor.json()).toEqual({ artifact });
    expect(JSON.stringify(artifact)).not.toContain(root);
    expect(artifact).not.toHaveProperty("storageLocation");
    expect((await fetch(`${restarted}${contentPath}`, { headers: { Authorization: "Bearer expired-agent" } })).status).toBe(409);
    expect(await (await fetch(`${restarted}${contentPath}`, { headers: authorization() })).text()).toBe(report);
    const session = await fetch(`${restarted}/api/v1/session`, { method: "POST", headers: authorization() });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    await session.json();
    onRead = async () => {
      const logout = await fetch(`${restarted}/api/v1/session`, { method: "DELETE", headers: { Cookie: cookie } });
      expect(logout.status).toBe(204);
    };
    const revoked = await fetch(`${restarted}${contentPath}`, { headers: { Cookie: cookie } });
    expect(revoked.status).toBe(401);
    onRead = undefined;
    expect((await fetch(`${restarted}/api/v1/commands/publish-artifact`, {
      method: "POST", headers: { ...authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({ contentDigest: `sha256:${digest}`, storageLocation: "file:///private" }),
    })).status).toBe(404);
    const blob = join(root, "sha256", digest);
    await chmod(blob, 0o600);
    await writeFile(blob, "tampered");
    const failed = await fetch(`${restarted}${contentPath}`, { headers: authorization() });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain(root);
  });

  it("keeps causal parent/child reports and Live history through Host restart and HTTP command replay", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "causal-reports.sqlite");
    const root = join(directory, "content");
    const storage = await LocalArtifactStorage.open(root);
    const report = "Shared synthetic delegated report.\n";
    const graphBootstrap: KernelBootstrap = {
      ...bootstrap,
      principals: [...bootstrap.principals!, { id: "principal-keel", kind: "agent", displayName: "Keel" }],
      agents: [...bootstrap.agents!, {
        id: "agent-keel", principalId: "principal-keel", projectId: "project-sample",
        name: "Keel", configRevision: 1, config: { provider: "deterministic-fake" },
      }],
    };
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return;
      }
      await context.capabilities.reportStatus("processing-report");
      const input = { idempotencyKey: "shared-report", text: report };
      const artifactId = await context.capabilities.publishReport(input);
      expect(await context.capabilities.publishReport(input)).toBe(artifactId);
      await context.capabilities.reportStatus("report-ready");
      if (context.cause.run.run.delegationDepth === 0) {
        await context.capabilities.publishReply({
          body: `Follow up report ${artifactId}.`, targetAgentIds: ["agent-keel"],
        });
      }
      await context.capabilities.complete({ finalReply: { body: `Report ${artifactId} is available.` } });
    });
    const host = createLocalRuntimeHost({
      databasePath, bootstrap: graphBootstrap, artifactStorage: storage, adapter, port: 0,
      credentials: [{ token: "human-token", principalContext: { principalId: "principal-human" } }],
      runtimePrincipalId: "principal-runtime", projectIds: ["project-sample"], runtimePollIntervalMs: 5,
    });
    cleanup.push(() => host.close());
    const origin = await host.start();
    const command = {
      idempotencyKey: "causal-report-thread", projectId: "project-sample", channelId: "channel-general",
      body: "Produce and delegate a synthetic report.", targetAgentIds: ["agent-orbit"],
    };
    const request = {
      method: "POST", headers: { ...authorization(), "Content-Type": "application/json" },
      body: JSON.stringify(command),
    };
    const response = await fetch(`${origin}/api/v1/commands/start-thread`, request);
    expect(response.status).toBe(200);
    const created = await response.json() as { result: CommandResult };
    const thread = await waitForCompletedThread(origin, created.result.entityId, 2);
    expect(adapter.invocationCount).toBe(4);
    const parent = thread.runs.find((run) => run.delegationDepth === 0)!;
    const child = thread.runs.find((run) => run.delegationDepth === 1)!;
    expect(parent).toMatchObject({ causalRootId: thread.threadRootId, parentRunId: null });
    expect(child).toMatchObject({ causalRootId: thread.threadRootId, parentRunId: parent.id });
    expect(thread.artifacts).toHaveLength(2);
    expect(new Set(thread.artifacts.map((artifact) => artifact.id)).size).toBe(2);
    const digest = createHash("sha256").update(report).digest("hex");
    expect(await readdir(join(root, "sha256"))).toEqual([digest]);
    const runResponse = await fetch(`${origin}/api/v1/runs/${child.id}`, { headers: authorization() });
    const { run } = await runResponse.json() as { run: RunProjection };
    expect(run.run).toEqual(child);
    expect(run.artifacts).toHaveLength(1);
    expect(run.activity.items.some((item) => item.kind === "status")).toBe(true);
    const historyPath = `/api/v1/runs/${child.id}/activity?beforeSequence=${run.activity.items.at(-1)!.sequence}&limit=1`;
    const history = await (await fetch(`${origin}${historyPath}`, { headers: authorization() })).json();
    await host.close();

    const kernel = TorsorKernel.open({
      databasePath, artifactStorage: await LocalArtifactStorage.open(root),
    });
    cleanup.push(async () => kernel.close());
    const retryAdapter = new DeterministicFakeAdapter();
    await new AgentRuntime({
      kernel, adapter: retryAdapter, runtimePrincipalId: "principal-runtime", projectIds: ["project-sample"],
    }).drainUntilIdle();
    expect(retryAdapter.invocationCount).toBe(0);
    const service = createTorsorHttpService({
      kernel, port: 0,
      credentials: [{ token: "human-token", principalContext: { principalId: "principal-human" } }],
    });
    cleanup.push(() => service.close());
    const restarted = await service.listen();
    const replay = await fetch(`${restarted}/api/v1/commands/start-thread`, request);
    expect(await replay.json()).toEqual(created);
    const restored = await fetch(`${restarted}/api/v1/threads/${thread.threadRootId}`, { headers: authorization() });
    expect(await restored.json()).toEqual({ thread });
    expect(await (await fetch(`${restarted}${historyPath}`, { headers: authorization() })).json()).toEqual(history);
    for (const artifact of thread.artifacts) {
      expect(artifact).toMatchObject({
        contentDigest: `sha256:${digest}`, producerThreadRootId: thread.threadRootId,
      });
      const download = await fetch(`${restarted}/api/v1/artifacts/${artifact.id}/content`, { headers: authorization() });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe(report);
    }
    const rejected = await fetch(`${restarted}/api/v1/commands/send-to-run`, {
      method: "POST", headers: { ...authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "terminal-followup", runId: child.id, expectedRunRevision: child.revision,
        body: "This must not silently become a Reply.",
      }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "terminal_run", requestId: expect.any(String) } });
    expect(await (await fetch(`${restarted}/api/v1/threads/${thread.threadRootId}`, { headers: authorization() })).json())
      .toEqual({ thread });
  });

  it("runs an HTTP request through the production host composition", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    const adapter = new DeterministicFakeAdapter();
    const host = createHost(databasePath, adapter);
    cleanup.push(() => host.close());

    const origin = await host.start();
    const created = await fetch(
      `${origin}/api/v1/commands/start-thread`,
      {
        method: "POST",
        headers: {
          ...authorization(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "host-vertical-slice",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Orbit, complete this durable request.",
          targetAgentIds: ["agent-orbit"],
        }),
      },
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      result: { entityId: string };
    };

    const thread = await waitForCompletedThread(
      origin,
      createdBody.result.entityId,
    );
    expect(adapter.invocationCount).toBe(2);
    expect(thread.attentions).toMatchObject([{ status: "Resolved" }]);
    expect(thread.runs).toMatchObject([{ state: "Completed" }]);
    expect(thread.messages.at(-1)?.revisions[0]?.body).toBe(
      "The deterministic fake completed the requested work.",
    );

    await host.close();
    await expect(fetch(`${origin}/health`)).rejects.toThrow();

    const reopened = TorsorKernel.open({ databasePath, bootstrap });
    try {
      const persisted = await reopened.query(
        {
          type: "GetThreadProjection",
          threadRootId: createdBody.result.entityId,
        },
        { principalId: "principal-human" },
      );
      expect(persisted.runs).toMatchObject([{ state: "Completed" }]);
    } finally {
      reopened.close();
    }
  });

  it("rejects the host lifecycle when the runtime loop fails", async () => {
    const directory = await temporaryDirectory();
    const host = createHost(
      join(directory, "torsor.sqlite"),
      new DeterministicFakeAdapter(),
      { projectIds: ["project-missing"] },
    );

    await host.start();
    await expect(host.finished).rejects.toThrow(
      "Project project-missing does not exist.",
    );
    expect(host.origin).toBeNull();
  });

  it("yields between busy passes so shutdown interrupts an outbox backlog", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    const backlogSize = 100;
    await seedOutboxBacklog(databasePath, backlogSize);
    const firstAcknowledgement = deferred<void>();
    const releaseFirstAcknowledgement = deferred<void>();
    let acknowledgementCount = 0;
    const host = createHost(
      databasePath,
      new DeterministicFakeAdapter(),
      {
        runtimePollIntervalMs: 60_000,
        runtimeHooks: {
          beforeOutboxAcknowledge: async () => {
            acknowledgementCount += 1;
            if (acknowledgementCount === 1) {
              firstAcknowledgement.resolve();
              await releaseFirstAcknowledgement.promise;
            }
          },
        },
      },
    );
    cleanup.push(() => host.close());

    await host.start();
    await firstAcknowledgement.promise;
    let acknowledgementsWhenCloseRan = -1;
    let closePromise: Promise<void> | undefined;
    const closeTimer = new Promise<void>((resolve) => {
      setTimeout(() => {
        acknowledgementsWhenCloseRan = acknowledgementCount;
        closePromise = host.close();
        resolve();
      }, 0);
    });
    releaseFirstAcknowledgement.resolve();

    await closeTimer;
    await closePromise;

    expect(acknowledgementsWhenCloseRan).toBeGreaterThan(0);
    expect(acknowledgementsWhenCloseRan).toBeLessThan(backlogSize);
  });

  it("cleans idle polling listeners and timers across repeated passes", async () => {
    vi.useFakeTimers();
    const addListener = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const removeListener = vi.spyOn(
      AbortSignal.prototype,
      "removeEventListener",
    );
    const directory = await temporaryDirectory();
    const host = createHost(
      join(directory, "torsor.sqlite"),
      new DeterministicFakeAdapter(),
      { runtimePollIntervalMs: 60_000 },
    );

    try {
      await host.start();
      await waitForTimerCount(1);

      for (let pass = 0; pass < 3; pass += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(vi.getTimerCount()).toBe(1);
      }
      expect(abortListenerCount(addListener)).toBe(
        abortListenerCount(removeListener) + 1,
      );

      await host.close();

      expect(vi.getTimerCount()).toBe(0);
      expect(abortListenerCount(addListener)).toBe(
        abortListenerCount(removeListener),
      );
    } finally {
      await host.close();
      addListener.mockRestore();
      removeListener.mockRestore();
      vi.useRealTimers();
    }
  });
});

interface HostTestOptions {
  readonly projectIds?: readonly string[];
  readonly runtimePollIntervalMs?: number;
  readonly runtimeHooks?: AgentRuntimeHooks;
}

function createHost(
  databasePath: string,
  adapter: DeterministicFakeAdapter,
  options: HostTestOptions = {},
): LocalRuntimeHost {
  return createLocalRuntimeHost({
    databasePath,
    bootstrap,
    credentials: [
      {
        token: "human-token",
        principalContext: { principalId: "principal-human" },
      },
    ],
    runtimePrincipalId: "principal-runtime",
    projectIds: options.projectIds ?? ["project-sample"],
    adapter,
    port: 0,
    runtimePollIntervalMs: options.runtimePollIntervalMs ?? 5,
    ...(options.runtimeHooks ? { runtimeHooks: options.runtimeHooks } : {}),
  });
}

async function seedOutboxBacklog(
  databasePath: string,
  itemCount: number,
): Promise<void> {
  const kernel = TorsorKernel.open({ databasePath, bootstrap });
  try {
    for (let index = 0; index < itemCount; index += 1) {
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: `busy-backlog:${index}`,
          projectId: "project-sample",
          channelId: "channel-general",
          body: `Synthetic backlog item ${index}.`,
        },
        { principalId: "principal-human" },
      );
    }
  } finally {
    kernel.close();
  }
}

async function waitForCompletedThread(
  origin: string,
  threadRootId: string,
  expectedRunCount = 1,
): Promise<ThreadProjection> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${origin}/api/v1/threads/${threadRootId}`,
      { headers: authorization() },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { thread: ThreadProjection };
    if (
      body.thread.runs.length === expectedRunCount &&
      body.thread.runs.every((run) => run.state === "Completed")
    ) {
      return body.thread;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The production host did not complete the Run in time.");
}

function authorization(): Record<string, string> {
  return { Authorization: ["Bearer", "human-token"].join(" ") };
}

interface TestDeferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): TestDeferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitForTimerCount(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (vi.getTimerCount() === expected) {
      return;
    }
    await Promise.resolve();
  }
  expect(vi.getTimerCount()).toBe(expected);
}

function abortListenerCount(
  spy: MockInstance,
): number {
  return spy.mock.calls.filter((call) => call[0] === "abort").length;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "torsor-host-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
