import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeterministicFakeAdapter } from "@torsor/agent-runtime";
import type { AgentRuntimeHooks } from "@torsor/agent-runtime";
import {
  LocalArtifactStorage,
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
  createTorsorHttpService,
  type LocalRuntimeHost,
} from "../src/index.js";

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
