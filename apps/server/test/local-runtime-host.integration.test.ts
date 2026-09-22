import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeterministicFakeAdapter, LocalWorktreeExecutor } from "@torsor/agent-runtime";
import type { AgentRuntimeHooks } from "@torsor/agent-runtime";
import {
  TorsorKernel,
  type KernelBootstrap,
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
      await closing;
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
      await host.close();
      actual?.forceStop();
      if (actual) await actual.closed;
      repository.dispose();
    }
  });

  it("runs the optional physical tracer through HTTP, Runtime, Kernel, and confirmed shutdown", async () => {
    const repository = syntheticRepository();
    repository.addWorktree("probe");
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
        await context.capabilities.complete({ incorporatedThroughInputSequence: 1 });
      }
    });
    const host = createLocalRuntimeHost({
      databasePath: repository.databasePath, bootstrap,
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
): Promise<ThreadProjection> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${origin}/api/v1/threads/${threadRootId}`,
      { headers: authorization() },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { thread: ThreadProjection };
    if (body.thread.runs.some((run) => run.state === "Completed")) {
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
