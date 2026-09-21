import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KernelError,
  TorsorKernel,
  type KernelBootstrap,
} from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";

import {
  AgentRuntime,
  CopilotAcpAdapter,
  DeterministicFakeAdapter,
  KernelActivationCapabilityBridge,
  ProviderExecutionError,
  type CopilotAcpLimits,
  type ProviderAdapter,
} from "../src/index.js";

const bootstrap: KernelBootstrap = {
  principals: [
    { id: "principal-human", kind: "human", displayName: "Avery Stone" },
    { id: "principal-runtime", kind: "runtime", displayName: "Local Runtime" },
    { id: "principal-orbit", kind: "agent", displayName: "Orbit" },
    { id: "principal-keel", kind: "agent", displayName: "Keel" },
    { id: "principal-lumen", kind: "agent", displayName: "Lumen" },
    { id: "principal-rivet", kind: "agent", displayName: "Rivet" },
    { id: "principal-sable", kind: "agent", displayName: "Sable" },
  ],
  projects: [
    { id: "project-sample", name: "Sample Project" },
    { id: "project-secondary", name: "Secondary Project" },
    { id: "project-third", name: "Third Project" },
    { id: "project-fourth", name: "Fourth Project" },
    { id: "project-fifth", name: "Fifth Project" },
  ],
  channels: [
    {
      id: "channel-general",
      projectId: "project-sample",
      name: "general",
    },
    {
      id: "channel-secondary",
      projectId: "project-secondary",
      name: "general",
    },
    {
      id: "channel-third",
      projectId: "project-third",
      name: "general",
    },
    {
      id: "channel-fourth",
      projectId: "project-fourth",
      name: "general",
    },
    {
      id: "channel-fifth",
      projectId: "project-fifth",
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
    {
      id: "agent-keel",
      principalId: "principal-keel",
      projectId: "project-secondary",
      name: "Keel",
      configRevision: 1,
      config: { provider: "deterministic-fake" },
    },
    {
      id: "agent-lumen",
      principalId: "principal-lumen",
      projectId: "project-third",
      name: "Lumen",
      configRevision: 1,
      config: { provider: "deterministic-fake" },
    },
    {
      id: "agent-rivet",
      principalId: "principal-rivet",
      projectId: "project-fourth",
      name: "Rivet",
      configRevision: 1,
      config: { provider: "deterministic-fake" },
    },
    {
      id: "agent-sable",
      principalId: "principal-sable",
      projectId: "project-fifth",
      name: "Sable",
      configRevision: 1,
      config: { provider: "deterministic-fake" },
    },
  ],
};

const humanContext = { principalId: "principal-human" } as const;
const runtimeContext = { principalId: "principal-runtime" } as const;
let kernelInstance = 0;

describe("AgentRuntime", () => {
  it("drives Attention to durable Run result through a provider attempt", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter();
    try {
      const thread = await mentionAgent(kernel, "vertical-slice");
      const runtime = createRuntime(kernel, adapter);

      await runtime.drainUntilIdle();

      const projection = await kernel.query(
        { type: "GetThreadProjection", threadRootId: thread.entityId },
        humanContext,
      );
      expect(projection.attentions).toHaveLength(1);
      expect(projection.attentions[0]).toMatchObject({
        status: "Resolved",
      });
      expect(projection.runs).toHaveLength(1);
      expect(projection.runs[0]).toMatchObject({ state: "Completed" });
      const run = await kernel.query(
        { type: "GetRunProjection", runId: projection.runs[0]!.id },
        humanContext,
      );
      expect(run.providerAttempts).toHaveLength(1);
      expect(run.providerAttempts[0]).toMatchObject({
        adapter: "deterministic-fake",
        status: "Completed",
      });
      expect(run.activity.items.map((item) => item.kind)).toEqual([
        "status",
        "provider_result",
      ]);
      expect(run.inputs[0]).toMatchObject({ disposition: "Incorporated" });
      expect(projection.messages.at(-1)?.revisions[0]?.body).toBe(
        "The deterministic fake completed the requested work.",
      );
    } finally {
      kernel.close();
    }
  });

  it("presents ten independent triggering messages for explicit decisions", async () => {
    const kernel = openKernel(":memory:");
    const seenBodies: string[] = [];
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type !== "attention") {
        throw new Error("Ignoring Attention must not create Run work.");
      }
      const cause = context.cause;
      seenBodies.push(cause.triggeringRevision.body);
      expect(
        cause.triggeringMessage.revisions.some(
          (revision) => revision.id === cause.attention.messageRevisionId,
        ),
      ).toBe(true);
      expect(cause.eligibleRuns).toEqual([]);
      await context.capabilities.ignoreAttention("No durable work requested.");
    });
    try {
      for (let index = 0; index < 10; index += 1) {
        await kernel.execute(
          {
            type: "StartThread",
            idempotencyKey: `independent-thread:${index}`,
            projectId: "project-sample",
            channelId: "channel-general",
            body: `Independent request ${index}.`,
            targetAgentIds: ["agent-orbit"],
          },
          humanContext,
        );
      }

      await createRuntime(kernel, adapter).drainUntilIdle();

      expect(new Set(seenBodies)).toEqual(
        new Set(
          Array.from(
            { length: 10 },
            (_, index) => `Independent request ${index}.`,
          ),
        ),
      );
      const events = await kernel.readEvents(null, 500);
      expect(
        events.filter((event) => event.type === "AttentionIgnored"),
      ).toHaveLength(10);
      expect(events.some((event) => event.type === "RunCreated")).toBe(false);
    } finally {
      kernel.close();
    }
  });

  it("processes independent Attentions concurrently within the configured bound", async () => {
    const kernel = openKernel(":memory:");
    const overlapBarrier = createBarrier(4);
    let active = 0;
    let maximumActive = 0;
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type !== "attention") {
        throw new Error("The overlap test must not create Run work.");
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await overlapBarrier.wait();
        await context.capabilities.ignoreAttention(
          "Concurrent synthetic Attention handled.",
        );
      } finally {
        active -= 1;
      }
    });
    try {
      for (let index = 0; index < 10; index += 1) {
        await mentionAgent(kernel, `concurrent-attention-${index}`);
      }

      await createRuntime(kernel, adapter, {
        attentionConcurrency: 4,
      }).drainUntilIdle();

      expect(adapter.invocationCount).toBe(10);
      expect(maximumActive).toBe(4);
      const events = await kernel.readEvents(null, 500);
      expect(
        events.filter((event) => event.type === "AttentionIgnored"),
      ).toHaveLength(10);
    } finally {
      kernel.close();
    }
  });

  it(
    "starts an independent next-page domain without waiting for a busy first page",
    async () => {
      const kernel = openKernel(":memory:");
      let releaseBusy!: () => void;
      let signalBusyStarted!: () => void;
      let signalIndependentStarted!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseBusy = resolve;
      });
      const busyStarted = new Promise<void>((resolve) => {
        signalBusyStarted = resolve;
      });
      const independentStarted = new Promise<void>((resolve) => {
        signalIndependentStarted = resolve;
      });
      let busyReleased = false;
      let independentOverlapped = false;
      let maximumBuffered = 0;
      let observedBufferLimit = 0;
      try {
        const busyThread = await startMention(
          kernel,
          "paged-overlap-busy-root",
          "Orbit, handle busy paged item 0.",
        );
        for (let index = 1; index < 100; index += 1) {
          await kernel.execute(
            {
              type: "ReplyToThread",
              idempotencyKey: `paged-overlap-busy:${index}`,
              threadRootId: busyThread.entityId,
              body: `Orbit, handle busy paged item ${index}.`,
              targetAgentIds: ["agent-orbit"],
            },
            humanContext,
          );
        }
        const independentThread = await startMention(
          kernel,
          "paged-overlap-independent",
          "Orbit, handle the independent next-page item.",
        );
        const adapter = new DeterministicFakeAdapter(async (context) => {
          if (context.cause.type !== "attention") {
            throw new Error("The page overlap test must not create Run work.");
          }
          if (context.cause.attention.threadRootId === busyThread.entityId) {
            if (
              context.cause.triggeringRevision.body.endsWith("item 0.")
            ) {
              signalBusyStarted();
              await release;
            }
          } else if (
            context.cause.attention.threadRootId ===
            independentThread.entityId
          ) {
            independentOverlapped = !busyReleased;
            signalIndependentStarted();
          }
          await context.capabilities.ignoreAttention(
            "Synthetic paged Attention handled.",
          );
        });
        const runtime = createRuntime(kernel, adapter, {
          projectIds: ["project-sample", "project-secondary"],
          attentionConcurrency: 2,
          hooks: {
            attentionBufferChanged: ({ size, limit }) => {
              maximumBuffered = Math.max(maximumBuffered, size);
              observedBufferLimit = limit;
            },
          },
        });

        const pass = runtime.runOnce();
        await busyStarted;
        await independentStarted;
        busyReleased = true;
        releaseBusy();
        const result = await pass;

        expect(result.attentionsDispatched).toBe(101);
        expect(independentOverlapped).toBe(true);
        expect(observedBufferLimit).toBe(200);
        expect(maximumBuffered).toBeLessThanOrEqual(observedBufferLimit);
      } finally {
        releaseBusy();
        kernel.close();
      }
    },
    20_000,
  );

  it("shares the global Attention concurrency bound across Projects", async () => {
    const kernel = openKernel(":memory:");
    let releaseBusy!: () => void;
    let signalBusyStarted!: () => void;
    let signalSecondaryStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseBusy = resolve;
    });
    const busyStarted = new Promise<void>((resolve) => {
      signalBusyStarted = resolve;
    });
    const secondaryStarted = new Promise<void>((resolve) => {
      signalSecondaryStarted = resolve;
    });
    let busyReleased = false;
    let secondaryOverlapped = false;
    let active = 0;
    let maximumActive = 0;
    try {
      let firstPrimaryThreadId: string | undefined;
      for (let index = 0; index < 200; index += 1) {
        const thread = await mentionAgent(
          kernel,
          `project-overlap-primary-${index}`,
        );
        firstPrimaryThreadId ??= thread.entityId;
      }
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "project-overlap-secondary",
          projectId: "project-secondary",
          channelId: "channel-secondary",
          body: "Keel, handle independent Project work.",
          targetAgentIds: ["agent-keel"],
        },
        humanContext,
      );
      const adapter = new DeterministicFakeAdapter(async (context) => {
        if (context.cause.type !== "attention") {
          throw new Error("The Project overlap test must not create Run work.");
        }
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (
            context.cause.attention.projectId === "project-sample" &&
            context.cause.attention.threadRootId === firstPrimaryThreadId
          ) {
            signalBusyStarted();
            await release;
          } else {
            if (context.cause.attention.projectId === "project-secondary") {
              secondaryOverlapped = !busyReleased;
              signalSecondaryStarted();
            }
          }
          await context.capabilities.ignoreAttention(
            "Independent Project Attention handled.",
          );
        } finally {
          active -= 1;
        }
      });
      const runtime = createRuntime(kernel, adapter, {
        projectIds: ["project-sample", "project-secondary"],
        attentionConcurrency: 2,
      });

      const pass = runtime.runOnce();
      await busyStarted;
      await secondaryStarted;
      busyReleased = true;
      releaseBusy();
      const result = await pass;

      expect(result.attentionsDispatched).toBe(201);
      expect(secondaryOverlapped).toBe(true);
      expect(maximumActive).toBe(2);
    } finally {
      releaseBusy();
      kernel.close();
    }
  }, 20_000);

  it(
    "gives a fifth Project a bounded turn after 400 earlier domains",
    async () => {
      const kernel = openKernel(":memory:");
      const earlyProjects = [
        {
          projectId: "project-sample",
          channelId: "channel-general",
          agentId: "agent-orbit",
        },
        {
          projectId: "project-secondary",
          channelId: "channel-secondary",
          agentId: "agent-keel",
        },
        {
          projectId: "project-third",
          channelId: "channel-third",
          agentId: "agent-lumen",
        },
        {
          projectId: "project-fourth",
          channelId: "channel-fourth",
          agentId: "agent-rivet",
        },
      ] as const;
      let releaseEarly!: () => void;
      let signalEarlyStarted!: () => void;
      let signalFifthStarted!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseEarly = resolve;
      });
      const earlyStarted = new Promise<void>((resolve) => {
        signalEarlyStarted = resolve;
      });
      const fifthStarted = new Promise<void>((resolve) => {
        signalFifthStarted = resolve;
      });
      const blockedProjects = new Set<string>();
      const domainActive = new Map<string, number>();
      let active = 0;
      let maximumActive = 0;
      let maximumDomainActive = 0;
      let totalExecutions = 0;
      let executionsWhenFifthStarted = Number.POSITIVE_INFINITY;
      try {
        for (const project of earlyProjects) {
          for (let index = 0; index < 100; index += 1) {
            await startProjectMention(
              kernel,
              project,
              `cross-project-fairness:${project.projectId}:${index}`,
              `${project.agentId}, handle cross-Project item ${index}.`,
            );
          }
        }
        await startProjectMention(
          kernel,
          {
            projectId: "project-fifth",
            channelId: "channel-fifth",
            agentId: "agent-sable",
          },
          "cross-project-fairness:fifth",
          "Sable, handle the fifth Project.",
        );
        const adapter = new DeterministicFakeAdapter(async (context) => {
          if (context.cause.type !== "attention") {
            throw new Error(
              "The cross-Project fairness test must not create Run work.",
            );
          }
          const { projectId, threadRootId } = context.cause.attention;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          const nextDomainActive =
            (domainActive.get(threadRootId) ?? 0) + 1;
          domainActive.set(threadRootId, nextDomainActive);
          maximumDomainActive = Math.max(
            maximumDomainActive,
            nextDomainActive,
          );
          totalExecutions += 1;
          try {
            if (
              projectId !== "project-fifth" &&
              !blockedProjects.has(projectId)
            ) {
              blockedProjects.add(projectId);
              if (blockedProjects.size === earlyProjects.length) {
                signalEarlyStarted();
              }
              await release;
            }
            if (projectId === "project-fifth") {
              executionsWhenFifthStarted = totalExecutions;
              signalFifthStarted();
            }
            await context.capabilities.ignoreAttention(
              "Hierarchically scheduled synthetic Attention.",
            );
          } finally {
            active -= 1;
            domainActive.set(threadRootId, nextDomainActive - 1);
          }
        });
        const runtime = createRuntime(kernel, adapter, {
          projectIds: [
            ...earlyProjects.map((project) => project.projectId),
            "project-fifth",
          ],
          attentionConcurrency: 4,
        });

        const pass = runtime.runOnce();
        await earlyStarted;
        releaseEarly();
        await fifthStarted;
        const result = await pass;

        expect(result.attentionsDispatched).toBe(401);
        expect(executionsWhenFifthStarted).toBeLessThanOrEqual(9);
        expect(maximumActive).toBe(4);
        expect(maximumDomainActive).toBe(1);
      } finally {
        releaseEarly();
        kernel.close();
      }
    },
    60_000,
  );

  it(
    "rotates through more ready Projects and rescans exhausted Projects after refill",
    async () => {
      const projectCount = 102;
      const fairnessBootstrap =
        createProjectFairnessBootstrap(projectCount);
      const kernel = openKernel(
        ":memory:",
        () => new Date("2026-09-21T08:00:00.000Z"),
        fairnessBootstrap,
      );
      const projectIds = Array.from(
        { length: projectCount },
        (_, index) => `project-fair-${index}`,
      );
      let releaseFirst!: () => void;
      let signalFirstStarted!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        signalFirstStarted = resolve;
      });
      let phase = 1;
      let phaseOrdinal = 0;
      let blocked = false;
      const firstStartOrdinal = new Map<string, number>();
      const refillStartOrdinal = new Map<string, number>();
      let maximumActive = 0;
      let active = 0;
      try {
        for (let index = 0; index < projectCount; index += 1) {
          const project = {
            projectId: `project-fair-${index}`,
            channelId: `channel-fair-${index}`,
            agentId: `agent-fair-${index}`,
          };
          for (let item = 0; item < 2; item += 1) {
            await startProjectMention(
              kernel,
              project,
              `project-rotation:${index}:${item}`,
              `Fair Agent ${index}, handle rotation item ${item}.`,
            );
          }
        }
        const adapter = new DeterministicFakeAdapter(async (context) => {
          if (context.cause.type !== "attention") {
            throw new Error(
              "The Project rotation test must not create Run work.",
            );
          }
          const projectId = context.cause.attention.projectId;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          phaseOrdinal += 1;
          try {
            const ordinals =
              phase === 1 ? firstStartOrdinal : refillStartOrdinal;
            if (!ordinals.has(projectId)) {
              ordinals.set(projectId, phaseOrdinal);
            }
            if (!blocked) {
              blocked = true;
              signalFirstStarted();
              await release;
            }
            await context.capabilities.ignoreAttention(
              "Persistently rotated synthetic Attention.",
            );
          } finally {
            active -= 1;
          }
        });
        const runtime = createRuntime(kernel, adapter, {
          projectIds,
          attentionConcurrency: 1,
        });

        const firstPass = runtime.runOnce();
        await firstStarted;
        releaseFirst();
        const firstResult = await firstPass;

        expect(firstResult.attentionsDispatched).toBe(projectCount * 2);
        expect(firstStartOrdinal.size).toBe(projectCount);
        expect(
          Math.max(...firstStartOrdinal.values()),
        ).toBeLessThanOrEqual(projectCount);
        expect(maximumActive).toBe(1);

        phase = 2;
        phaseOrdinal = 0;
        await startProjectMention(
          kernel,
          {
            projectId: "project-fair-0",
            channelId: "channel-fair-0",
            agentId: "agent-fair-0",
          },
          "project-rotation:refill:0",
          "Fair Agent 0, handle refilled work.",
        );
        await startProjectMention(
          kernel,
          {
            projectId: "project-fair-101",
            channelId: "channel-fair-101",
            agentId: "agent-fair-101",
          },
          "project-rotation:refill:101",
          "Fair Agent 101, handle refilled work.",
        );

        const refillResult = await runtime.runOnce();

        expect(refillResult.attentionsDispatched).toBe(2);
        expect(refillStartOrdinal.size).toBe(2);
        expect(
          Math.max(...refillStartOrdinal.values()),
        ).toBeLessThanOrEqual(2);
      } finally {
        releaseFirst();
        kernel.close();
      }
    },
    60_000,
  );

  it(
    "resumes a hot Project at page two within one Project rotation",
    async () => {
      const projectCount = 102;
      const fairnessBootstrap =
        createProjectFairnessBootstrap(projectCount);
      const kernel = openKernel(
        ":memory:",
        () => new Date("2026-09-21T08:00:00.000Z"),
        fairnessBootstrap,
      );
      const projectIds = Array.from(
        { length: projectCount },
        (_, index) => `project-fair-${index}`,
      );
      let releaseFirst!: () => void;
      let signalFirstStarted!: () => void;
      let signalBufferFilled!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        signalFirstStarted = resolve;
      });
      const bufferFilled = new Promise<void>((resolve) => {
        signalBufferFilled = resolve;
      });
      let firstBlocked = false;
      let invocationOrdinal = 0;
      let projectZeroOrdinal = Number.POSITIVE_INFINITY;
      let projectOneOhOneFirstAttentionId = "";
      const projectOneOhOneClaimAttempts: string[] = [];
      try {
        for (let index = 0; index < 101; index += 1) {
          const thread = await startProjectMention(
            kernel,
            {
              projectId: "project-fair-0",
              channelId: "channel-fair-0",
              agentId: "agent-fair-0",
            },
            `project-page-continuation:0:${index}`,
            `Fair Agent 0, handle page item ${index}.`,
          );
          if (index < 100) {
            const projection = await kernel.query(
              {
                type: "GetThreadProjection",
                threadRootId: thread.entityId,
              },
              runtimeContext,
            );
            const attention = projection.attentions[0]!;
            await kernel.execute(
              {
                type: "ClaimAttention",
                idempotencyKey:
                  `project-page-continuation:0:${index}:lease`,
                attentionId: attention.id,
                expectedAttentionRevision: attention.revision,
                leaseDurationMs: 300_000,
              },
              runtimeContext,
            );
          }
        }
        for (let index = 1; index < projectCount; index += 1) {
          const initialThread = await startProjectMention(
            kernel,
            {
              projectId: `project-fair-${index}`,
              channelId: `channel-fair-${index}`,
              agentId: `agent-fair-${index}`,
            },
            `project-page-continuation:${index}:initial`,
            `Fair Agent ${index}, handle initial independent work.`,
          );
          if (index === projectCount - 1) {
            const projection = await kernel.query(
              {
                type: "GetThreadProjection",
                threadRootId: initialThread.entityId,
              },
              runtimeContext,
            );
            projectOneOhOneFirstAttentionId =
              projection.attentions[0]!.id;
          }
          await startProjectMention(
            kernel,
            {
              projectId: `project-fair-${index}`,
              channelId: `channel-fair-${index}`,
              agentId: `agent-fair-${index}`,
            },
            `project-page-continuation:${index}:refill`,
            `Fair Agent ${index}, handle refilled independent work.`,
          );
        }
        const adapter = new DeterministicFakeAdapter(async (context) => {
          if (context.cause.type !== "attention") {
            throw new Error(
              "The Project continuation test must not create Run work.",
            );
          }
          invocationOrdinal += 1;
          const projectId = context.cause.attention.projectId;
          if (projectId === "project-fair-0") {
            projectZeroOrdinal = invocationOrdinal;
          }
          if (!firstBlocked) {
            firstBlocked = true;
            signalFirstStarted();
            await release;
          }
          await context.capabilities.ignoreAttention(
            "Resumed Project page candidate.",
          );
        });
        const runtime = createRuntime(kernel, adapter, {
          projectIds: [...projectIds, "project-fair-0"],
          attentionConcurrency: 1,
          attentionLeaseMs: 120_000,
          outboxLeaseMs: 120_000,
          providerTimeoutMs: 60_000,
          hooks: {
            attentionBufferChanged: ({ size, limit }) => {
              if (size === limit) {
                signalBufferFilled();
              }
            },
            beforeAttentionClaim: async (attention) => {
              if (attention.projectId === "project-fair-101") {
                projectOneOhOneClaimAttempts.push(attention.id);
              }
            },
          },
        });

        const pass = runtime.runOnce();
        await firstStarted;
        await bufferFilled;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        const projectOneOhOneProjection = await kernel.query(
          {
            type: "GetThreadProjection",
            threadRootId: (
              await kernel.query(
                {
                  type: "ListOpenAttentions",
                  projectId: "project-fair-101",
                  limit: 1,
                },
                runtimeContext,
              )
            ).items[0]!.threadRootId,
          },
          runtimeContext,
        );
        const projectOneOhOneAttention =
          projectOneOhOneProjection.attentions.find(
            (attention) =>
              attention.id === projectOneOhOneFirstAttentionId,
          )!;
        const competingClaim = await kernel.execute(
          {
            type: "ClaimAttention",
            idempotencyKey:
              "project-page-continuation:101:competing-claim",
            attentionId: projectOneOhOneAttention.id,
            expectedAttentionRevision:
              projectOneOhOneAttention.revision,
            leaseDurationMs: 120_000,
          },
          runtimeContext,
        );
        const competingActivation = await kernel.execute(
          {
            type: "StartActivation",
            idempotencyKey:
              "project-page-continuation:101:competing-activation",
            attentionId: projectOneOhOneAttention.id,
            handlerLeaseToken:
              competingClaim.relatedIds!.handlerLeaseToken!,
          },
          runtimeContext,
        );
        await kernel.execute(
          {
            type: "IgnoreAttention",
            idempotencyKey:
              "project-page-continuation:101:competing-ignore",
            attentionId: projectOneOhOneAttention.id,
            expectedAttentionRevision: competingClaim.revision!,
            handlerLeaseToken:
              competingClaim.relatedIds!.handlerLeaseToken!,
            reason: "Competing Runtime resolved the saturated candidate.",
          },
          {
            principalId: "principal-fair-101",
            activationId: competingActivation.entityId,
          },
        );
        const replacement = await startProjectMention(
          kernel,
          {
            projectId: "project-fair-101",
            channelId: "channel-fair-101",
            agentId: "agent-fair-101",
          },
          "project-page-continuation:101:replacement",
          "Fair Agent 101, handle replacement work.",
        );
        const replacementProjection = await kernel.query(
          {
            type: "GetThreadProjection",
            threadRootId: replacement.entityId,
          },
          runtimeContext,
        );
        const replacementAttentionId =
          replacementProjection.attentions[0]!.id;
        releaseFirst();
        const result = await pass;

        expect(result.attentionsDispatched).toBe(
          1 + (projectCount - 1) * 2,
        );
        expect(projectZeroOrdinal).toBeLessThanOrEqual(projectCount);
        expect(projectOneOhOneClaimAttempts).toContain(
          projectOneOhOneFirstAttentionId,
        );
        expect(
          projectOneOhOneClaimAttempts.indexOf(
            projectOneOhOneFirstAttentionId,
          ),
        ).toBeLessThan(
          projectOneOhOneClaimAttempts.indexOf(replacementAttentionId),
        );
      } finally {
        releaseFirst();
        kernel.close();
      }
    },
    90_000,
  );

  it(
    "admits a fifth later domain before four early domains drain",
    async () => {
      const kernel = openKernel(":memory:");
      let releaseEarly!: () => void;
      let signalEarlyStarted!: () => void;
      let signalFifthStarted!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseEarly = resolve;
      });
      const earlyStarted = new Promise<void>((resolve) => {
        signalEarlyStarted = resolve;
      });
      const fifthStarted = new Promise<void>((resolve) => {
        signalFifthStarted = resolve;
      });
      const earlyThreadIds: string[] = [];
      let active = 0;
      let maximumActive = 0;
      let maximumDomainActive = 0;
      let totalExecutions = 0;
      let earlyHeadsStarted = 0;
      let executionsWhenFifthStarted = Number.POSITIVE_INFINITY;
      const domainActive = new Map<string, number>();
      let maximumBuffered = 0;
      let bufferLimit = 0;
      try {
        for (let domain = 0; domain < 4; domain += 1) {
          const thread = await startMention(
            kernel,
            `fair-admission-domain:${domain}:0`,
            `Orbit, handle fair domain ${domain} item 0.`,
          );
          earlyThreadIds.push(thread.entityId);
          for (let item = 1; item < 101; item += 1) {
            await kernel.execute(
              {
                type: "ReplyToThread",
                idempotencyKey:
                  `fair-admission-domain:${domain}:${item}`,
                threadRootId: thread.entityId,
                body: `Orbit, handle fair domain ${domain} item ${item}.`,
                targetAgentIds: ["agent-orbit"],
              },
              humanContext,
            );
          }
        }
        const fifthThread = await startMention(
          kernel,
          "fair-admission-fifth",
          "Orbit, handle the fifth later domain.",
        );
        const adapter = new DeterministicFakeAdapter(async (context) => {
          if (context.cause.type !== "attention") {
            throw new Error("The fairness test must not create Run work.");
          }
          const domain = context.cause.attention.threadRootId;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          const nextDomainActive = (domainActive.get(domain) ?? 0) + 1;
          domainActive.set(domain, nextDomainActive);
          maximumDomainActive = Math.max(
            maximumDomainActive,
            nextDomainActive,
          );
          totalExecutions += 1;
          try {
            if (
              earlyThreadIds.includes(domain) &&
              context.cause.triggeringRevision.body.endsWith("item 0.")
            ) {
              earlyHeadsStarted += 1;
              if (earlyHeadsStarted === 4) {
                signalEarlyStarted();
              }
              await release;
            }
            if (domain === fifthThread.entityId) {
              executionsWhenFifthStarted = totalExecutions;
              signalFifthStarted();
            }
            await context.capabilities.ignoreAttention(
              "Fairly admitted synthetic Attention.",
            );
          } finally {
            active -= 1;
            domainActive.set(domain, nextDomainActive - 1);
          }
        });
        const runtime = createRuntime(kernel, adapter, {
          attentionConcurrency: 4,
          hooks: {
            attentionBufferChanged: ({ size, limit }) => {
              maximumBuffered = Math.max(maximumBuffered, size);
              bufferLimit = limit;
            },
          },
        });

        const pass = runtime.runOnce();
        await earlyStarted;
        releaseEarly();
        await fifthStarted;
        const result = await pass;

        expect(result.attentionsDispatched).toBe(405);
        expect(executionsWhenFifthStarted).toBeLessThanOrEqual(8);
        expect(maximumActive).toBe(4);
        expect(maximumDomainActive).toBe(1);
        expect(bufferLimit).toBe(400);
        expect(maximumBuffered).toBeLessThanOrEqual(bufferLimit);
      } finally {
        releaseEarly();
        kernel.close();
      }
    },
    30_000,
  );

  it("serializes same-thread Attention decisions within the concurrent pass", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        if (context.cause.eligibleRuns.length === 0) {
          await context.capabilities.createRunFromAttention();
        } else {
          await context.capabilities.continueAttentionWithRun(
            context.cause.eligibleRuns[0]!.id,
          );
        }
        return;
      }
      await context.capabilities.wait("Keep the synthetic Run available.");
    });
    try {
      const thread = await mentionAgent(kernel, "same-thread-serialization");
      const runtime = createRuntime(kernel, adapter, {
        attentionConcurrency: 4,
      });
      await runtime.drainUntilIdle();
      await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "same-thread-follow-up:1",
          threadRootId: thread.entityId,
          body: "First same-thread follow-up.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "same-thread-follow-up:2",
          threadRootId: thread.entityId,
          body: "Second same-thread follow-up.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );

      const pass = await runtime.runOnce();

      expect(pass.attentionsDispatched).toBe(2);
      const projection = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: thread.entityId,
        },
        humanContext,
      );
      expect(projection.runs).toHaveLength(1);
      expect(projection.attentions.map((attention) => attention.status)).toEqual([
        "Resolved",
        "Resolved",
        "Resolved",
      ]);
      const run = await kernel.query(
        {
          type: "GetRunProjection",
          runId: projection.runs[0]!.id,
        },
        humanContext,
      );
      expect(run.inputs).toHaveLength(3);
    } finally {
      kernel.close();
    }
  });

  it("continues other work after losing an Attention claim race", async () => {
    const kernel = openKernel(":memory:");
    const claimBarrier = createBarrier(2);
    let releaseFirst!: () => void;
    const secondHandled = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    try {
      const firstThread = await startMention(
        kernel,
        "claim-race-first",
        "Orbit, handle claim-race-first.",
      );
      const secondThread = await startMention(
        kernel,
        "claim-race-second",
        "Orbit, handle claim-race-second.",
      );
      const firstProjection = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: firstThread.entityId,
        },
        runtimeContext,
      );
      const firstAttentionId = firstProjection.attentions[0]!.id;
      let signalFirstClaimed!: () => void;
      const firstClaimed = new Promise<void>((resolve) => {
        signalFirstClaimed = resolve;
      });
      const adapter = new DeterministicFakeAdapter(async (context) => {
        if (context.cause.type !== "attention") {
          throw new Error("The claim race must not create Run work.");
        }
        if (
          context.cause.triggeringRevision.body.includes("claim-race-first")
        ) {
          await context.capabilities.ignoreAttention("Claim race handled.");
          await secondHandled;
          return;
        }
        await context.capabilities.ignoreAttention("Claim race handled.");
        if (
          context.cause.triggeringRevision.body.includes("claim-race-second")
        ) {
          releaseFirst();
        }
      });
      const firstHooks = {
        beforeAttentionClaim: async (attention: { readonly id: string }) => {
          if (attention.id === firstAttentionId) {
            await claimBarrier.wait();
          }
        },
        afterProviderAttemptStarted: async ({
          causeType,
        }: {
          readonly causeType: "attention" | "run";
        }) => {
          if (causeType === "attention") {
            signalFirstClaimed();
          }
        },
      };
      const secondHooks = {
        beforeAttentionClaim: async (attention: { readonly id: string }) => {
          if (attention.id === firstAttentionId) {
            await claimBarrier.wait();
            await firstClaimed;
          }
        },
      };
      const firstRuntime = createRuntime(kernel, adapter, {
        attentionConcurrency: 1,
        hooks: firstHooks,
      });
      const secondRuntime = createRuntime(kernel, adapter, {
        attentionConcurrency: 1,
        hooks: secondHooks,
      });

      const passes = await Promise.all([
        firstRuntime.runOnce(),
        secondRuntime.runOnce(),
      ]);

      expect(
        passes.reduce(
          (total, pass) => total + pass.attentionsDispatched,
          0,
        ),
      ).toBe(2);
      const secondProjection = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: secondThread.entityId,
        },
        runtimeContext,
      );
      expect(firstProjection.attentions).toHaveLength(1);
      expect(secondProjection.attentions[0]?.status).toBe("Ignored");
      const refreshedFirst = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: firstThread.entityId,
        },
        runtimeContext,
      );
      expect(refreshedFirst.attentions[0]?.status).toBe("Ignored");
    } finally {
      kernel.close();
    }
  });

  it("retries the domain when a lost Attention claim was already resolved", async () => {
    const kernel = openKernel(":memory:");
    try {
      const thread = await startMention(
        kernel,
        "resolved-claim-race-root",
        "Orbit, handle resolved claim race item 0.",
      );
      await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "resolved-claim-race:1",
          threadRootId: thread.entityId,
          body: "Orbit, handle resolved claim race item 1.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const projection = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: thread.entityId,
        },
        runtimeContext,
      );
      const orderedAttentions = [...projection.attentions].sort(
        (left, right) => left.cursor - right.cursor,
      );
      const firstAttention = orderedAttentions[0]!;
      let resolvedByCompetitor = false;
      const runtime = createRuntime(
        kernel,
        new DeterministicFakeAdapter(async (context) => {
          if (context.cause.type !== "attention") {
            throw new Error("The claim race must not create Run work.");
          }
          await context.capabilities.ignoreAttention(
            "The remaining Attention was retried.",
          );
        }),
        {
          hooks: {
            beforeAttentionClaim: async (attention) => {
              if (
                attention.id !== firstAttention.id ||
                resolvedByCompetitor
              ) {
                return;
              }
              resolvedByCompetitor = true;
              const claim = await kernel.execute(
                {
                  type: "ClaimAttention",
                  idempotencyKey: "resolved-claim-race:competitor-claim",
                  attentionId: firstAttention.id,
                  expectedAttentionRevision: firstAttention.revision,
                  leaseDurationMs: 30_000,
                },
                runtimeContext,
              );
              const activation = await kernel.execute(
                {
                  type: "StartActivation",
                  idempotencyKey:
                    "resolved-claim-race:competitor-activation",
                  attentionId: firstAttention.id,
                  handlerLeaseToken:
                    claim.relatedIds!.handlerLeaseToken!,
                },
                runtimeContext,
              );
              await kernel.execute(
                {
                  type: "IgnoreAttention",
                  idempotencyKey:
                    "resolved-claim-race:competitor-decision",
                  attentionId: firstAttention.id,
                  expectedAttentionRevision: claim.revision!,
                  handlerLeaseToken:
                    claim.relatedIds!.handlerLeaseToken!,
                  reason: "A competing runtime resolved the head Attention.",
                },
                {
                  principalId: "principal-orbit",
                  activationId: activation.entityId,
                },
              );
            },
          },
        },
      );

      const result = await runtime.drainUntilIdle();

      expect(result.attentionsDispatched).toBe(1);
      const after = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: thread.entityId,
        },
        runtimeContext,
      );
      expect(
        after.attentions.every(
          (attention) => attention.status === "Ignored",
        ),
      ).toBe(true);
    } finally {
      kernel.close();
    }
  });

  it("bounds buffered work while claim losses leave live leases", async () => {
    const kernel = openKernel(":memory:");
    let claimLosses = 0;
    let providerExecutions = 0;
    let maximumRetained = 0;
    let retainedLimit = 0;
    try {
      for (let index = 0; index < 250; index += 1) {
        await mentionAgent(kernel, `bounded-claim-loss-${index}`);
      }
      const runtime = createRuntime(
        kernel,
        new DeterministicFakeAdapter(async (context) => {
          providerExecutions += 1;
          await context.capabilities.ignoreAttention(
            "Deferred Attention handled on the next pass.",
          );
        }),
        {
          attentionConcurrency: 2,
          hooks: {
            beforeAttentionClaim: async (attention) => {
              if (claimLosses >= 200) {
                return;
              }
              await kernel.execute(
                {
                  type: "ClaimAttention",
                  idempotencyKey: `preempt:${attention.id}`,
                  attentionId: attention.id,
                  expectedAttentionRevision: attention.revision,
                  leaseDurationMs: 30_000,
                },
                runtimeContext,
              );
              claimLosses += 1;
            },
            attentionBufferChanged: ({ size, limit }) => {
              maximumRetained = Math.max(maximumRetained, size);
              retainedLimit = limit;
            },
          },
        },
      );

      let attentionsDispatched = 0;
      let passes = 0;
      while (providerExecutions < 50 && passes < 3) {
        const result = await runtime.runOnce();
        attentionsDispatched += result.attentionsDispatched;
        passes += 1;
      }

      expect(attentionsDispatched).toBe(50);
      expect(passes).toBeLessThanOrEqual(3);
      expect(claimLosses).toBe(200);
      expect(providerExecutions).toBe(50);
      expect(retainedLimit).toBe(200);
      expect(maximumRetained).toBeLessThanOrEqual(retainedLimit);
    } finally {
      kernel.close();
    }
  }, 20_000);

  it("reconsiders later work when a saturated batch loses every claim", async () => {
    const kernel = openKernel(":memory:");
    let laterThreadId = "";
    let claimLosses = 0;
    let laterExecutions = 0;
    try {
      for (let index = 0; index < 101; index += 1) {
        const thread = await mentionAgent(
          kernel,
          `saturated-claim-race-${index}`,
        );
        if (index === 100) {
          laterThreadId = thread.entityId;
        }
      }
      const runtime = createRuntime(
        kernel,
        new DeterministicFakeAdapter(async (context) => {
          if (context.cause.type !== "attention") {
            throw new Error("The saturation race must not create Run work.");
          }
          expect(context.cause.attention.threadRootId).toBe(laterThreadId);
          laterExecutions += 1;
          await context.capabilities.ignoreAttention(
            "Later work survived saturated claim losses.",
          );
        }),
        {
          attentionConcurrency: 1,
          hooks: {
            beforeAttentionClaim: async (attention) => {
              if (attention.threadRootId === laterThreadId) {
                return;
              }
              await kernel.execute(
                {
                  type: "ClaimAttention",
                  idempotencyKey: `saturated-preempt:${attention.id}`,
                  attentionId: attention.id,
                  expectedAttentionRevision: attention.revision,
                  leaseDurationMs: 30_000,
                },
                runtimeContext,
              );
              claimLosses += 1;
            },
          },
        },
      );

      const result = await runtime.runOnce();

      expect(result.attentionsDispatched).toBe(1);
      expect(claimLosses).toBe(100);
      expect(laterExecutions).toBe(1);
    } finally {
      kernel.close();
    }
  }, 20_000);

  it("does not claim a later same-thread Attention after losing the domain race", async () => {
    const kernel = openKernel(":memory:");
    let signalFirstProvider!: () => void;
    let releaseFirstProvider!: () => void;
    const firstProviderStarted = new Promise<void>((resolve) => {
      signalFirstProvider = resolve;
    });

    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    try {
      const thread = await startMention(
        kernel,
        "same-thread-runtime-race-root",
        "Orbit, handle the first same-thread race item.",
      );
      await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "same-thread-runtime-race-reply",
          threadRootId: thread.entityId,
          body: "Orbit, handle the second same-thread race item.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const before = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: thread.entityId,
        },
        runtimeContext,
      );
      expect(
        before.attentions.map((attention) => ({
          targetAgentId: attention.targetAgentId,
          threadRootId: attention.threadRootId,
        })),
      ).toEqual([
        {
          targetAgentId: "agent-orbit",
          threadRootId: thread.entityId,
        },
        {
          targetAgentId: "agent-orbit",
          threadRootId: thread.entityId,
        },
      ]);
      const orderedAttentions = [...before.attentions].sort(
        (left, right) => left.cursor - right.cursor,
      );
      const firstAttentionId = orderedAttentions[0]!.id;
      const decisionInputs: Array<{
        readonly attentionId: string;
        readonly eligibleRunIds: readonly string[];
      }> = [];
      const adapter = new DeterministicFakeAdapter(async (context) => {
        if (context.cause.type !== "attention") {
          await context.capabilities.wait("Keep the synthetic Run waiting.");
          return;
        }
        decisionInputs.push({
          attentionId: context.cause.attention.id,
          eligibleRunIds: context.cause.eligibleRuns.map((run) => run.id),
        });
        if (context.cause.attention.id === firstAttentionId) {
          signalFirstProvider();
          await releaseFirst;
          await context.capabilities.createRunFromAttention();
          return;
        }
        if (context.cause.eligibleRuns.length === 0) {
          await context.capabilities.createRunFromAttention();
        } else {
          await context.capabilities.continueAttentionWithRun(
            context.cause.eligibleRuns[0]!.id,
          );
        }
      });
      const firstRuntime = createRuntime(kernel, adapter, {
        attentionConcurrency: 1,
      });
      const secondClaims: string[] = [];
      const secondRuntime = createRuntime(kernel, adapter, {
        attentionConcurrency: 1,
        hooks: {
          beforeAttentionClaim: async (attention) => {
            secondClaims.push(attention.id);
          },
        },
      });

      const firstPass = firstRuntime.runOnce();
      await firstProviderStarted;
      const losingPass = await secondRuntime.runOnce();
      expect(losingPass.attentionsDispatched).toBe(0);
      expect(secondClaims).toEqual([]);
      releaseFirstProvider();
      await firstPass;
      await firstRuntime.drainUntilIdle();

      const after = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: thread.entityId,
        },
        humanContext,
      );
      expect(decisionInputs).toEqual([
        {
          attentionId: firstAttentionId,
          eligibleRunIds: [],
        },
        {
          attentionId: orderedAttentions[1]!.id,
          eligibleRunIds: [after.runs[0]!.id],
        },
      ]);
      expect(after.runs).toHaveLength(1);
      expect(after.attentions.every(
        (attention) => attention.status === "Resolved",
      )).toBe(true);
      const run = await kernel.query(
        {
          type: "GetRunProjection",
          runId: after.runs[0]!.id,
        },
        humanContext,
      );
      expect(run.inputs).toHaveLength(2);
    } finally {
      releaseFirstProvider();
      kernel.close();
    }
  });

  it("does not spin on later same-thread work behind a live lease", async () => {
    const kernel = openKernel(":memory:");
    let providerExecutions = 0;
    const adapter = new DeterministicFakeAdapter(async () => {
      providerExecutions += 1;
    });
    try {
      const thread = await startMention(
        kernel,
        "live-lease-domain-root",
        "Orbit, handle live lease item 0.",
      );
      for (let index = 1; index < 3; index += 1) {
        await kernel.execute(
          {
            type: "ReplyToThread",
            idempotencyKey: `live-lease-domain:${index}`,
            threadRootId: thread.entityId,
            body: `Orbit, handle live lease item ${index}.`,
            targetAgentIds: ["agent-orbit"],
          },
          humanContext,
        );
      }
      const projection = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: thread.entityId,
        },
        runtimeContext,
      );
      const firstAttention = [...projection.attentions].sort(
        (left, right) => left.cursor - right.cursor,
      )[0]!;
      await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "live-lease-domain:claim",
          attentionId: firstAttention.id,
          expectedAttentionRevision: firstAttention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );

      await expect(
        createRuntime(kernel, adapter).drainUntilIdle(4),
      ).resolves.toEqual({
        attentionsDispatched: 0,
        outboxEventsProcessed: 3,
      });
      expect(providerExecutions).toBe(0);
    } finally {
      kernel.close();
    }
  });

  it(
    "preserves a lost same-thread claim across Attention page boundaries",
    async () => {
      const kernel = openKernel(":memory:");
      let signalFirstProvider!: () => void;
      let releaseFirstProvider!: () => void;
      const firstProviderStarted = new Promise<void>((resolve) => {
        signalFirstProvider = resolve;
      });
      const releaseFirst = new Promise<void>((resolve) => {
        releaseFirstProvider = resolve;
      });
      try {
        const thread = await startMention(
          kernel,
          "paged-domain-race-root",
          "Orbit, handle paged domain item 0.",
        );
        for (let index = 1; index < 101; index += 1) {
          await kernel.execute(
            {
              type: "ReplyToThread",
              idempotencyKey: `paged-domain-race:${index}`,
              threadRootId: thread.entityId,
              body: `Orbit, handle paged domain item ${index}.`,
              targetAgentIds: ["agent-orbit"],
            },
            humanContext,
          );
        }
        const before = await kernel.query(
          {
            type: "GetThreadProjection",
            threadRootId: thread.entityId,
          },
          runtimeContext,
        );
        const orderedAttentions = [...before.attentions].sort(
          (left, right) => left.cursor - right.cursor,
        );
        const firstAttentionId = orderedAttentions[0]!.id;
        const adapter = new DeterministicFakeAdapter(async (context) => {
          if (context.cause.type !== "attention") {
            await context.capabilities.wait("Keep the paged Run waiting.");
            return;
          }
          if (context.cause.attention.id === firstAttentionId) {
            signalFirstProvider();
            await releaseFirst;
            await context.capabilities.createRunFromAttention();
            return;
          }
          await context.capabilities.continueAttentionWithRun(
            context.cause.eligibleRuns[0]!.id,
          );
        });
        const firstRuntime = createRuntime(kernel, adapter, {
          attentionConcurrency: 1,
        });
        const secondClaims: string[] = [];
        const secondRuntime = createRuntime(kernel, adapter, {
          attentionConcurrency: 1,
          hooks: {
            beforeAttentionClaim: async (attention) => {
              secondClaims.push(attention.id);
            },
          },
        });

        const firstPass = firstRuntime.runOnce();
        await firstProviderStarted;
        const losingPass = await secondRuntime.runOnce();

        expect(losingPass.attentionsDispatched).toBe(0);
        expect(secondClaims).toEqual([]);
        releaseFirstProvider();
        const firstResult = await firstPass;
        const secondResult = await firstRuntime.runOnce();
        const after = await kernel.query(
          {
            type: "GetThreadProjection",
            threadRootId: thread.entityId,
          },
          humanContext,
        );
        expect(after.runs).toHaveLength(1);
        const orderedAfter = [...after.attentions].sort(
          (left, right) => left.cursor - right.cursor,
        );
        expect(firstResult.attentionsDispatched).toBe(100);
        expect(secondResult.attentionsDispatched).toBe(1);
        expect(
          orderedAfter.every((attention) => attention.status === "Resolved"),
        ).toBe(true);
        const run = await kernel.query(
          {
            type: "GetRunProjection",
            runId: after.runs[0]!.id,
          },
          humanContext,
        );
        expect(run.inputs).toHaveLength(101);
      } finally {
        releaseFirstProvider();
        kernel.close();
      }
    },
    20_000,
  );

  it("continues only the existing Run explicitly selected by the provider", async () => {
    const kernel = openKernel(":memory:");
    let runExecutions = 0;
    let selectedRunId: string | undefined;
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        if (context.cause.eligibleRuns.length === 0) {
          selectedRunId =
            await context.capabilities.createRunFromAttention();
        } else {
          expect(context.cause.eligibleRuns.map((run) => run.id)).toEqual([
            selectedRunId,
          ]);
          await context.capabilities.continueAttentionWithRun(selectedRunId!);
        }
        return;
      }
      runExecutions += 1;
      if (runExecutions === 1) {
        await context.capabilities.wait("Waiting for the follow-up.");
      } else {
        await context.capabilities.complete();
      }
    });
    try {
      const thread = await mentionAgent(kernel, "continue-existing-run");
      const runtime = createRuntime(kernel, adapter);
      await runtime.drainUntilIdle();

      await kernel.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "continue-existing-run:follow-up",
          threadRootId: thread.entityId,
          body: "Continue the same durable work.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      await runtime.drainUntilIdle();

      const projection = await kernel.query(
        { type: "GetThreadProjection", threadRootId: thread.entityId },
        humanContext,
      );
      expect(projection.runs).toHaveLength(1);
      expect(projection.runs[0]).toMatchObject({
        id: selectedRunId,
        state: "Completed",
      });
      const run = await kernel.query(
        { type: "GetRunProjection", runId: selectedRunId! },
        humanContext,
      );
      expect(run.inputs).toHaveLength(2);
      expect(run.inputs[1]?.sourceAttentionId).toBe(
        projection.attentions[1]?.id,
      );
    } finally {
      kernel.close();
    }
  });

  it("persists an ignore decision without creating Run work", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type !== "attention") {
        throw new Error("No Run should be dispatched.");
      }
      await context.capabilities.ignoreAttention("Informational mention only.");
    });
    try {
      const thread = await mentionAgent(kernel, "ignore-attention");
      await createRuntime(kernel, adapter).drainUntilIdle();

      const projection = await kernel.query(
        { type: "GetThreadProjection", threadRootId: thread.entityId },
        humanContext,
      );
      expect(projection.attentions[0]).toMatchObject({
        status: "Ignored",
        resolutionOutcome: "Ignored",
      });
      expect(projection.runs).toEqual([]);
    } finally {
      kernel.close();
    }
  });

  it("does not repeat an Attention decision on duplicate runtime delivery", async () => {
    const kernel = openKernel(":memory:");
    let decisions = 0;
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type !== "attention") {
        throw new Error("No Run should be dispatched.");
      }
      decisions += 1;
      await context.capabilities.ignoreAttention("Handled exactly once.");
    });
    try {
      await mentionAgent(kernel, "duplicate-attention-delivery");
      const runtime = createRuntime(kernel, adapter);
      await runtime.drainUntilIdle();
      await runtime.drainUntilIdle();

      expect(decisions).toBe(1);
      const events = await kernel.readEvents(null, 500);
      expect(
        events.filter((event) => event.type === "AttentionIgnored"),
      ).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

  it("rejects a stale Attention decision after lease replacement", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    try {
      await mentionAgent(kernel, "stale-attention-decision");
      const open = await kernel.query(
        {
          type: "ListOpenAttentions",
          projectId: "project-sample",
          limit: 10,
        },
        runtimeContext,
      );
      const attention = open.items[0]!;
      const firstClaim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "stale-attention:first-claim",
          attentionId: attention.id,
          expectedAttentionRevision: attention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      const firstActivation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "stale-attention:first-activation",
          attentionId: attention.id,
          handlerLeaseToken: firstClaim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      const bootstrapView = await kernel.query(
        { type: "GetBootstrap", projectId: "project-sample" },
        runtimeContext,
      );
      const firstBridge = new KernelActivationCapabilityBridge({
        kernel,
        agent: bootstrapView.agents[0]!,
        activationId: firstActivation.entityId,
        providerAttemptId: "provider-attempt-stale",
        causeType: "attention",
        attention,
        attentionRevision: firstClaim.revision!,
        handlerLeaseToken: firstClaim.relatedIds!.handlerLeaseToken!,
        eligibleRuns: [],
      });

      now = new Date(now.getTime() + 31_000);
      const replacementClaim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "stale-attention:replacement-claim",
          attentionId: attention.id,
          expectedAttentionRevision: firstClaim.revision!,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "stale-attention:replacement-activation",
          attentionId: attention.id,
          handlerLeaseToken:
            replacementClaim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );

      await expect(
        firstBridge.ignoreAttention("This stale decision must not persist."),
      ).rejects.toBeInstanceOf(KernelError);
      const stillOpen = await kernel.query(
        {
          type: "ListOpenAttentions",
          projectId: "project-sample",
          limit: 10,
        },
        runtimeContext,
      );
      expect(stillOpen.items[0]).toMatchObject({
        id: attention.id,
        revision: replacementClaim.revision,
      });
    } finally {
      kernel.close();
    }
  });

  it("immediately reconciles a finished Attention with an unfinished ProviderAttempt", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    try {
      await mentionAgent(kernel, "decision-attempt-recovery");
      const open = await kernel.query(
        {
          type: "ListOpenAttentions",
          projectId: "project-sample",
          limit: 10,
        },
        runtimeContext,
      );
      const attention = open.items[0]!;
      const claim = await kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: "decision-recovery:claim",
          attentionId: attention.id,
          expectedAttentionRevision: attention.revision,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      const activation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "decision-recovery:activation",
          attentionId: attention.id,
          handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      const attempt = await kernel.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "decision-recovery:attempt",
          activationId: activation.entityId,
          adapter: "synthetic-crash",
          adapterVersion: "1",
          capabilitySnapshot: { attentionDecision: true },
          runInputIds: [],
          requestIdempotencyKey: "decision-recovery:provider-request",
        },
        runtimeContext,
      );
      const bootstrapView = await kernel.query(
        { type: "GetBootstrap", projectId: "project-sample" },
        runtimeContext,
      );
      const bridge = new KernelActivationCapabilityBridge({
        kernel,
        agent: bootstrapView.agents[0]!,
        activationId: activation.entityId,
        providerAttemptId: attempt.entityId,
        causeType: "attention",
        attention,
        attentionRevision: claim.revision!,
        handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        eligibleRuns: [],
      });
      await bridge.ignoreAttention("Decision persisted before process loss.");
      const recoverable = await kernel.query(
        {
          type: "ListRecoverableAttentionExecutions",
          limit: 10,
        },
        runtimeContext,
      );
      expect(recoverable.items[0]?.activation).toMatchObject({
        id: activation.entityId,
        finishedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      });

      await createRuntime(
        kernel,
        new DeterministicFakeAdapter(),
        { clock: () => now },
      ).runOnce();

      const events = await kernel.readEvents(null, 500);
      const finish = events.find(
        (event) =>
          event.type === "ProviderAttemptFinished" &&
          event.entityId === attempt.entityId,
      );
      expect(finish?.payload).toMatchObject({ status: "Unknown" });
    } finally {
      kernel.close();
    }
  });

  it("does not fail live Attention completion when recovery settles its attempt", async () => {
    const kernel = openKernel(":memory:");
    let signalDecisionCommitted!: () => void;
    let releaseProvider!: () => void;
    const decisionCommitted = new Promise<void>((resolve) => {
      signalDecisionCommitted = resolve;
    });

    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type !== "attention") {
        throw new Error("The recovery race must not create Run work.");
      }
      await context.capabilities.ignoreAttention(
        "Persist the decision before returning.",
      );
      signalDecisionCommitted();
      await providerRelease;
    });
    try {
      await mentionAgent(kernel, "live-decision-recovery-race");
      const ownerPass = createRuntime(kernel, adapter).runOnce();
      await decisionCommitted;

      await createRuntime(kernel, new DeterministicFakeAdapter()).runOnce();
      releaseProvider();
      await expect(ownerPass).resolves.toMatchObject({
        attentionsDispatched: 1,
      });

      const events = await kernel.readEvents(null, 500);
      const attemptFinishes = events.filter(
        (event) => event.type === "ProviderAttemptFinished",
      );
      expect(attemptFinishes).toHaveLength(1);
      expect(attemptFinishes[0]?.payload).toMatchObject({
        status: "Unknown",
      });
    } finally {
      releaseProvider();
      kernel.close();
    }
  });

  it("does not fail Attention recovery when live completion settles first", async () => {
    const kernel = openKernel(":memory:");
    let signalDecisionCommitted!: () => void;
    let releaseProvider!: () => void;
    const decisionCommitted = new Promise<void>((resolve) => {
      signalDecisionCommitted = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type !== "attention") {
        throw new Error("The recovery race must not create Run work.");
      }
      await context.capabilities.ignoreAttention(
        "Persist the decision before returning.",
      );
      signalDecisionCommitted();
      await providerRelease;
    });
    try {
      await mentionAgent(kernel, "recovery-after-live-completion-race");
      const ownerPass = createRuntime(kernel, adapter).runOnce();
      await decisionCommitted;

      const recoveryPass = createRuntime(
        kernel,
        new DeterministicFakeAdapter(),
        {
          hooks: {
            beforeAttentionRecoverySettlement: async () => {
              releaseProvider();
              await ownerPass;
            },
          },
        },
      ).runOnce();

      await expect(recoveryPass).resolves.toMatchObject({
        attentionsDispatched: 0,
      });
      const events = await kernel.readEvents(null, 500);
      const attemptFinishes = events.filter(
        (event) => event.type === "ProviderAttemptFinished",
      );
      expect(attemptFinishes).toHaveLength(1);
      expect(attemptFinishes[0]?.payload).toMatchObject({
        status: "Completed",
      });
    } finally {
      releaseProvider();
      kernel.close();
    }
  });

  it("surfaces Attention buffer observer failures without hanging", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type !== "attention") {
        throw new Error("The observer test must not create Run work.");
      }
      await context.capabilities.ignoreAttention("Observer failure test.");
    });
    try {
      await mentionAgent(kernel, "buffer-observer-failure");
      const runtime = createRuntime(kernel, adapter, {
        hooks: {
          attentionBufferChanged: () => {
            throw new Error("Synthetic Attention observer failure.");
          },
        },
      });

      await expect(runtime.runOnce()).rejects.toThrow(
        "Synthetic Attention observer failure.",
      );
    } finally {
      kernel.close();
    }
  });

  it("recovers an unfinished idempotent provider attempt after process replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "torsor-runtime-recovery-"));
    const databasePath = join(directory, "torsor.sqlite");
    let now = new Date("2026-09-21T08:00:00.000Z");
    let kernel = openKernel(databasePath, () => now);
    const firstAdapter = new DeterministicFakeAdapter();
    try {
      await mentionAgent(kernel, "process-replacement");
      const firstRuntime = createRuntime(kernel, firstAdapter, {
        hooks: {
          afterProviderAttemptStarted: async ({ causeType }) => {
            if (causeType === "run") {
              throw new Error("simulated process replacement");
            }
          },
        },
      });
      await firstRuntime.runOnce();
      await expect(firstRuntime.runOnce()).rejects.toThrow(
        "simulated process replacement",
      );
      kernel.close();

      now = new Date(now.getTime() + 31_000);
      kernel = openKernel(databasePath, () => now);
      const replacementAdapter = new DeterministicFakeAdapter();
      const replacementRuntime = createRuntime(kernel, replacementAdapter);
      await replacementRuntime.drainUntilIdle();

      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      expect(runId).toBeTruthy();
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Completed");
      expect(run.providerAttempts.at(-1)?.status).toBe("Completed");
    } finally {
      kernel.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("discovers Projects encountered in the global outbox", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter();
    try {
      const thread = await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "secondary-project-thread",
          projectId: "project-secondary",
          channelId: "channel-secondary",
          body: "Keel, process this global outbox event.",
          targetAgentIds: ["agent-keel"],
        },
        humanContext,
      );
      const runtime = createRuntime(kernel, adapter);
      await runtime.drainUntilIdle();

      const projection = await kernel.query(
        { type: "GetThreadProjection", threadRootId: thread.entityId },
        humanContext,
      );
      expect(projection.runs).toHaveLength(1);
      expect(projection.runs[0]?.state).toBe("Completed");
    } finally {
      kernel.close();
    }
  });

  it("does not reconcile a live Attention provider before lease expiry", async () => {
    const kernel = openKernel(":memory:");
    let signalProviderStarted!: () => void;
    let releaseAttention!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseAttention = resolve;
    });
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        signalProviderStarted();
        await release;
        await context.capabilities.createRunFromAttention();
        return;
      }
      await context.capabilities.complete();
    });
    try {
      await mentionAgent(kernel, "live-attention-recovery");
      const firstRuntime = createRuntime(kernel, adapter);
      const liveExecution = firstRuntime.runOnce();
      await providerStarted;

      const secondRuntime = createRuntime(kernel, adapter);
      await secondRuntime.runOnce();
      const beforeRelease = await kernel.readEvents(null, 500);
      const attentionActivationId = beforeRelease.find(
        (event) =>
          event.type === "ActivationStarted" &&
          event.payload !== null &&
          !Array.isArray(event.payload) &&
          typeof event.payload === "object" &&
          event.payload.attentionId !== null,
      )?.entityId;
      expect(
        beforeRelease.some(
          (event) =>
            event.type === "ActivationFinished" &&
            event.entityId === attentionActivationId,
        ),
      ).toBe(false);

      releaseAttention();
      await liveExecution;
    } finally {
      kernel.close();
    }
  });

  it("rejects stale Activation capabilities after replacement", async () => {
    const kernel = openKernel(":memory:");
    let replacementStarted = false;
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return;
      }
      if (!replacementStarted) {
        replacementStarted = true;
        await kernel.execute(
          {
            type: "StartActivation",
            idempotencyKey: "test-replacement-activation",
            runId: context.cause.run.run.id,
            expectedRunRevision: context.cause.run.run.revision,
          },
          runtimeContext,
        );
      }
      await context.capabilities.appendActivity("stale", { accepted: false });
    });
    try {
      await mentionAgent(kernel, "stale-activation");
      const runtime = createRuntime(kernel, adapter);
      await expect(runtime.drainUntilIdle()).rejects.toMatchObject({
        outcome: "Failed",
      });
      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.activity.items).toHaveLength(0);
      expect(run.providerAttempts.at(-1)?.status).toBe("Failed");
      expect(run.run.activationGeneration).toBe(2);
    } finally {
      kernel.close();
    }
  });

  it("cancels a provider when its Run Activation is superseded", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return;
      }
      await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "supersede-running-provider",
          runId: context.cause.run.run.id,
          expectedRunRevision: context.cause.run.run.revision,
        },
        runtimeContext,
      );
      if (context.signal.aborted) {
        throw context.signal.reason;
      }
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        );
      });
    });
    try {
      await mentionAgent(kernel, "superseded-provider");
      const runtime = createRuntime(kernel, adapter, {
        cancellationPollMs: 5,
      });
      await runtime.runOnce();

      await expect(runtime.runOnce()).rejects.toMatchObject({
        outcome: "Unknown",
      });
      const run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Active");
      expect(run.run.activationGeneration).toBe(2);
      expect(run.providerAttempts.at(-1)?.status).toBe("Unknown");
    } finally {
      kernel.close();
    }
  });

  it("does not repeat semantic effects when a completed outbox batch is redelivered", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    const adapter = new DeterministicFakeAdapter();
    let crashBeforeAck = true;
    try {
      await mentionAgent(kernel, "duplicate-delivery");
      const firstRuntime = createRuntime(kernel, adapter, {
        hooks: {
          beforeOutboxAcknowledge: async (events) => {
            if (
              crashBeforeAck &&
              events[0]?.topic === "run.activation-requested"
            ) {
              crashBeforeAck = false;
              throw new Error("simulated crash before acknowledgement");
            }
          },
        },
      });
      await firstRuntime.runOnce();
      await expect(firstRuntime.runOnce()).rejects.toThrow(
        "simulated crash before acknowledgement",
      );
      const invocationsAfterCompletion = adapter.invocationCount;
      now = new Date(now.getTime() + 31_000);

      const replacementRuntime = createRuntime(kernel, adapter);
      await replacementRuntime.drainUntilIdle();

      expect(adapter.invocationCount).toBe(invocationsAfterCompletion);
      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.activity.items.filter((item) => item.kind === "status")).toHaveLength(1);
      expect(run.artifacts).toHaveLength(0);
      expect(run.run.state).toBe("Completed");
    } finally {
      kernel.close();
    }
  });

  it("does not repeat a completed Waiting transition on outbox redelivery", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return;
      }
      await context.capabilities.appendActivity("waiting_marker", {
        delivered: true,
      });
      await context.capabilities.wait("Waiting after one delivery.");
    });
    let crashBeforeAck = true;
    try {
      await mentionAgent(kernel, "waiting-redelivery");
      const firstRuntime = createRuntime(kernel, adapter, {
        clock: () => now,
        hooks: {
          beforeOutboxAcknowledge: async (events) => {
            if (
              crashBeforeAck &&
              events[0]?.topic === "run.activation-requested"
            ) {
              crashBeforeAck = false;
              throw new Error("simulated waiting acknowledgement crash");
            }
          },
        },
      });
      await firstRuntime.runOnce();
      await expect(firstRuntime.runOnce()).rejects.toThrow(
        "simulated waiting acknowledgement crash",
      );
      const invocations = adapter.invocationCount;
      now = new Date(now.getTime() + 31_000);

      await createRuntime(kernel, adapter, {
        clock: () => now,
      }).drainUntilIdle();

      expect(adapter.invocationCount).toBe(invocations);
      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Waiting");
      expect(
        run.activity.items.filter((item) => item.kind === "waiting_marker"),
      ).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

  it("coalesces stale outbox wake-ups onto the current Run revision", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter();
    try {
      await mentionAgent(kernel, "stale-outbox-revision");
      const attentionRuntime = createRuntime(kernel, adapter, {
        outboxBatchSize: 1,
      });
      await attentionRuntime.runOnce();
      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      expect(runId).toBeTruthy();
      await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "advance-run-before-wakeup",
          runId: runId!,
          expectedRunRevision: 1,
          body: "Include this newer durable input too.",
        },
        humanContext,
      );

      const runtime = createRuntime(kernel, adapter);
      await runtime.drainUntilIdle();

      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Completed");
      expect(run.inputs).toHaveLength(2);
      expect(run.inputs.every((input) => input.disposition === "Incorporated")).toBe(
        true,
      );
    } finally {
      kernel.close();
    }
  });

  it("reactivates a Waiting Run when a new durable input arrives", async () => {
    const kernel = openKernel(":memory:");
    const waitingAdapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return;
      }
      await context.capabilities.wait("Waiting for a follow-up input.");
    });
    try {
      await mentionAgent(kernel, "waiting-reactivation");
      await createRuntime(kernel, waitingAdapter).drainUntilIdle();
      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      let run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Waiting");
      await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "wake-waiting-run",
          runId: runId!,
          expectedRunRevision: run.run.revision,
          body: "Here is the follow-up input.",
        },
        humanContext,
      );

      await createRuntime(
        kernel,
        new DeterministicFakeAdapter(),
      ).drainUntilIdle();
      run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Completed");
      expect(run.inputs.every((input) => input.disposition === "Incorporated")).toBe(
        true,
      );
    } finally {
      kernel.close();
    }
  });

  it("does not deliver withdrawn inputs from an Activation snapshot", async () => {
    const kernel = openKernel(":memory:");
    const waitingAdapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return;
      }
      await context.capabilities.wait("Waiting before withdrawal.");
    });
    try {
      await mentionAgent(kernel, "withdrawn-input");
      await createRuntime(kernel, waitingAdapter).drainUntilIdle();
      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      let run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      const sent = await kernel.execute(
        {
          type: "SendToRun",
          idempotencyKey: "send-withdrawn-input",
          runId: runId!,
          expectedRunRevision: run.run.revision,
          body: "Withdraw this before provider delivery.",
        },
        humanContext,
      );
      await kernel.execute(
        {
          type: "WithdrawRunInput",
          idempotencyKey: "withdraw-before-delivery",
          runInputId: sent.relatedIds!.runInputId!,
          expectedRunRevision: sent.revision!,
          expectedDispositionRevision: 1,
          reason: "No longer needed.",
        },
        humanContext,
      );

      await createRuntime(
        kernel,
        new DeterministicFakeAdapter(),
      ).drainUntilIdle();

      run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Completed");
      expect(
        run.inputs.find((input) => input.id === sent.relatedIds!.runInputId)
          ?.disposition,
      ).toBe("Withdrawn");
    } finally {
      kernel.close();
    }
  });

  it("does not mistake provider-owned completion cleanup for cancellation", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return;
      }
      await context.capabilities.complete();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    try {
      await mentionAgent(kernel, "terminal-cleanup");
      const runtime = createRuntime(kernel, adapter, {
        cancellationPollMs: 5,
      });
      await runtime.drainUntilIdle();

      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Completed");
      expect(run.providerAttempts.at(-1)?.status).toBe("Completed");
      expect(run.activations.at(-1)?.outcome).toBe("Completed");
    } finally {
      kernel.close();
    }
  });

  it("runs the Copilot ACP stdio adapter and applies only validated actions", async () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/mock-acp-server.mjs", import.meta.url),
    );
    const kernel = openKernel(":memory:");
    const attentionAdapter = new DeterministicFakeAdapter();
    try {
      await mentionAgent(kernel, "copilot-acp");
      const attentionRuntime = createRuntime(kernel, attentionAdapter, {
        outboxBatchSize: 1,
      });
      await attentionRuntime.runOnce();

      const copilot = new CopilotAcpAdapter({
        command: process.execPath,
        commandArgs: [fixture],
        unsafeAllowCustomCommandArgs: true,
        cwd: process.cwd(),
      });
      const runtime = createRuntime(kernel, copilot);
      await runtime.drainUntilIdle();

      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Completed");
      expect(run.providerAttempts.at(-1)).toMatchObject({
        adapter: "github-copilot-cli-acp",
        status: "Completed",
      });
      expect(run.activity.items.map((item) => item.kind)).toContain(
        "agent_message_chunk",
      );
    } finally {
      kernel.close();
    }
  });

  it("validates the complete ACP action plan before applying effects", async () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/mock-acp-server.mjs", import.meta.url),
    );
    const kernel = openKernel(":memory:");
    try {
      await mentionAgent(kernel, "invalid-copilot-plan");
      const attentionRuntime = createRuntime(
        kernel,
        new DeterministicFakeAdapter(),
        { outboxBatchSize: 1 },
      );
      await attentionRuntime.runOnce();
      const copilot = new CopilotAcpAdapter({
        command: process.execPath,
        commandArgs: [fixture, "invalid-plan"],
        unsafeAllowCustomCommandArgs: true,
        cwd: process.cwd(),
      });
      const runtime = createRuntime(kernel, copilot);
      await expect(runtime.runOnce()).rejects.toMatchObject({
        outcome: "Failed",
      });

      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Waiting");
      expect(run.inputs[0]?.disposition).toBe("Pending");
      expect(run.providerAttempts.at(-1)?.status).toBe("Failed");
    } finally {
      kernel.close();
    }
  });

  it("launches Copilot ACP with deny-by-default tools and a sanitized environment", () => {
    const adapter = new CopilotAcpAdapter({
      environment: {
        COPILOT_PROVIDER_API_KEY: "synthetic-provider-key",
      },
    });
    const launch = adapter.getLaunchConfiguration();

    expect(launch.command).toBe("copilot");
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--acp",
        "--disable-builtin-mcps",
        "--available-tools=torsor-runtime-action-channel",
        "--deny-tool=shell",
        "--deny-tool=write",
        "--deny-tool=url",
      ]),
    );
    expect(launch.environment).toMatchObject({
      COPILOT_PROVIDER_API_KEY: "synthetic-provider-key",
    });
    expect(launch.environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(launch.environment).not.toHaveProperty("GH_TOKEN");
    expect(launch.environment).not.toHaveProperty("COPILOT_ALLOW_ALL");
    expect(() =>
      new CopilotAcpAdapter({
        environment: { COPILOT_ALLOW_ALL: "true" },
      }),
    ).toThrow("not in the explicit provider allowlist");
    expect(() =>
      new CopilotAcpAdapter({
        commandArgs: ["--acp"],
      }),
    ).toThrow("unsafeAllowCustomCommandArgs=true");
  });

  it("cancels ACP permission requests without exposing a built-in tool", async () => {
    const kernel = openKernel(":memory:");
    try {
      await prepareAcpRun(kernel, "permission-request");
      const runtime = createRuntime(
        kernel,
        createFixtureAcpAdapter("permission"),
      );

      await runtime.runOnce();

      const run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Completed");
      expect(run.providerAttempts.at(-1)?.status).toBe("Completed");
    } finally {
      kernel.close();
    }
  });

  it("settles a permission request racing with ACP shutdown", async () => {
    const kernel = openKernel(":memory:");
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await prepareAcpRun(kernel, "trailing-permission");
      const runtime = createRuntime(
        kernel,
        createFixtureAcpAdapter("trailing-permission"),
      );

      await runtime.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(unhandled).toEqual([]);
      const run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Completed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      kernel.close();
    }
  });

  it("fails closed when ACP reports forbidden tool activity", async () => {
    const kernel = openKernel(":memory:");
    try {
      await prepareAcpRun(kernel, "forbidden-tool");
      const runtime = createRuntime(
        kernel,
        createFixtureAcpAdapter("tool-activity"),
      );

      await expect(runtime.runOnce()).rejects.toThrow(
        "deny-by-default tool policy",
      );
      const run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Waiting");
      expect(run.providerAttempts.at(-1)?.status).toBe("Failed");
    } finally {
      kernel.close();
    }
  });

  it("fails closed on forbidden ACP activity trailing the prompt response", async () => {
    const kernel = openKernel(":memory:");
    try {
      await prepareAcpRun(kernel, "trailing-forbidden-tool");
      const runtime = createRuntime(
        kernel,
        createFixtureAcpAdapter("trailing-tool"),
      );

      await expect(runtime.runOnce()).rejects.toThrow(
        "deny-by-default tool policy",
      );
      const run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Waiting");
      expect(run.providerAttempts.at(-1)?.status).toBe("Failed");
    } finally {
      kernel.close();
    }
  });

  it("fails closed on delayed ACP activity after the prompt response", async () => {
    const kernel = openKernel(":memory:");
    try {
      await prepareAcpRun(kernel, "delayed-forbidden-tool");
      const runtime = createRuntime(
        kernel,
        createFixtureAcpAdapter("delayed-trailing-tool"),
      );

      await expect(runtime.runOnce()).rejects.toThrow(
        "deny-by-default tool policy",
      );
      const run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Waiting");
      expect(run.providerAttempts.at(-1)?.status).toBe("Failed");
    } finally {
      kernel.close();
    }
  });

  it("rejects model-supplied Artifact descriptors before Kernel effects", async () => {
    const kernel = openKernel(":memory:");
    try {
      await prepareAcpRun(kernel, "untrusted-artifact");
      const runtime = createRuntime(
        kernel,
        createFixtureAcpAdapter("artifact"),
      );

      await expect(runtime.runOnce()).rejects.toThrow(
        "Unsupported action type publish_artifact",
      );
      const events = await kernel.readEvents(null, 500);
      expect(events.some((event) => event.type === "ArtifactPublished")).toBe(
        false,
      );
      const run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Waiting");
    } finally {
      kernel.close();
    }
  });

  it.each([
    {
      name: "frame bytes",
      mode: "oversized-frame",
      parameter: 65,
      limits: { maxFrameBytes: 64 },
      message: "ACP frame exceeded 64 bytes",
    },
    {
      name: "stream bytes",
      mode: "long-field",
      parameter: 512,
      limits: { maxStreamBytes: 128, maxFieldLength: 1024 },
      message: "ACP output stream exceeded 128 bytes",
    },
    {
      name: "activity bytes",
      mode: "long-field",
      parameter: 512,
      limits: {
        maxStreamBytes: 2048,
        maxActivityBytes: 128,
        maxFieldLength: 1024,
      },
      message: "persisted ACP activity exceeded 128 bytes",
    },
    {
      name: "pending persistence operations",
      mode: "split-actions",
      parameter: 8,
      limits: { maxPendingPersistenceOperations: 1 },
      message: "ACP persistence exceeded 1 pending operations",
    },
    {
      name: "JSON depth",
      mode: "deep-json",
      parameter: 12,
      limits: { maxJsonDepth: 6 },
      message: "action envelope exceeded JSON depth 6",
    },
    {
      name: "action count",
      mode: "many-actions",
      parameter: 3,
      limits: { maxActionCount: 2 },
      message: "action envelope exceeded 2 actions",
    },
    {
      name: "target count",
      mode: "many-targets",
      parameter: 3,
      limits: { maxTargetCount: 2 },
      message: "targetAgentIds exceeded 2 entries",
    },
    {
      name: "field length",
      mode: "long-field",
      parameter: 65,
      limits: { maxFieldLength: 64 },
      message: "action.status exceeded 64 characters",
    },
  ])(
    "rejects ACP output beyond the $name limit",
    async ({ mode, parameter, limits, message }) => {
      const kernel = openKernel(":memory:");
      try {
        await prepareAcpRun(kernel, `limit-${mode}`);
        const runtime = createRuntime(
          kernel,
          createFixtureAcpAdapter(mode, parameter, limits),
        );

        await expect(runtime.runOnce()).rejects.toThrow(message);
        const run = await getOnlyRun(kernel);
        expect(run.run.state).toBe("Waiting");
        expect(run.providerAttempts.at(-1)?.status).toBe("Failed");
      } finally {
        kernel.close();
      }
    },
  );

  it.each(["malformed", "prompt-error", "exit"])(
    "settles ACP writes and process state after %s failure",
    async (mode) => {
      const kernel = openKernel(":memory:");
      try {
        await prepareAcpRun(kernel, `cleanup-${mode}`);
        const runtime = createRuntime(
          kernel,
          createFixtureAcpAdapter(mode),
        );

        await expect(runtime.runOnce()).rejects.toBeInstanceOf(
          ProviderExecutionError,
        );
        const run = await getOnlyRun(kernel);
        expect(run.run.state).toBe("Waiting");
        expect(["Failed", "Unknown"]).toContain(
          run.providerAttempts.at(-1)?.status,
        );
      } finally {
        kernel.close();
      }
    },
  );

  it.each(["close-after-initialize", "permission-close-stdin"])(
    "settles ACP stdin failure during %s without affecting later Runs",
    async (mode) => {
      let now = new Date("2026-09-21T08:00:00.000Z");
      const kernel = openKernel(":memory:", () => now);
      const faults = captureProcessFaults();
      try {
        await prepareAcpRun(kernel, `stdin-${mode}`);
        const runtime = createRuntime(
          kernel,
          createFixtureAcpAdapter(mode),
          { clock: () => now },
        );

        await expect(runtime.runOnce()).rejects.toMatchObject({
          outcome: "Unknown",
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(faults.errors).toEqual([]);

        now = new Date(now.getTime() + 31_000);
        const unrelated = await startMention(
          kernel,
          `unrelated-after-${mode}`,
          `Orbit, complete unrelated work after ${mode}.`,
        );
        await createRuntime(kernel, new DeterministicFakeAdapter(), {
          clock: () => now,
        }).drainUntilIdle();
        const projection = await kernel.query(
          {
            type: "GetThreadProjection",
            threadRootId: unrelated.entityId,
          },
          humanContext,
        );
        expect(projection.runs[0]?.state).toBe("Completed");
      } finally {
        faults.stop();
        kernel.close();
      }
    },
  );

  it("settles ACP stdin failure while sending cancellation", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    const faults = captureProcessFaults();
    try {
      await prepareAcpRun(kernel, "stdin-cancellation");
      const runtime = createRuntime(
        kernel,
        createFixtureAcpAdapter("cancel-close-stdin"),
        { cancellationPollMs: 1, clock: () => now },
      );
      const execution = runtime.runOnce();
      const before = await waitForRunActivity(kernel);
      await kernel.execute(
        {
          type: "CancelRun",
          idempotencyKey: "cancel-closed-acp-stdin",
          runId: before.run.id,
          expectedRunRevision: before.run.revision,
          reason: "Cancel after the provider closed stdin.",
        },
        humanContext,
      );

      await expect(execution).rejects.toMatchObject({ outcome: "Unknown" });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(faults.errors).toEqual([]);

      now = new Date(now.getTime() + 31_000);
      const unrelated = await startMention(
        kernel,
        "unrelated-after-stdin-cancel",
        "Orbit, complete unrelated work after cancellation.",
      );
      await createRuntime(kernel, new DeterministicFakeAdapter(), {
        clock: () => now,
      }).drainUntilIdle();
      const projection = await kernel.query(
        {
          type: "GetThreadProjection",
          threadRootId: unrelated.entityId,
        },
        humanContext,
      );
      expect(projection.runs[0]?.state).toBe("Completed");
    } finally {
      faults.stop();
      kernel.close();
    }
  });

  it("stops ACP ingestion when cancellation races with streamed updates", async () => {
    const kernel = openKernel(":memory:");
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await prepareAcpRun(kernel, "cancellation-update-race");
      const runtime = createRuntime(
        kernel,
        createFixtureAcpAdapter("slow-split", 2),
        { cancellationPollMs: 1 },
      );
      const execution = runtime.runOnce();
      const before = await waitForRunActivity(kernel);
      await kernel.execute(
        {
          type: "CancelRun",
          idempotencyKey: "cancel-acp-update-race",
          runId: before.run.id,
          expectedRunRevision: before.run.revision,
          reason: "Revoke while ACP output is still arriving.",
        },
        humanContext,
      );

      await expect(execution).rejects.toMatchObject({ outcome: "Unknown" });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
      const after = await getOnlyRun(kernel);
      expect(after.run.state).toBe("Cancelled");
      expect(after.providerAttempts.at(-1)?.status).toBe("Unknown");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      kernel.close();
    }
  });

  it("propagates timeout failures without converting them to success", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return;
      }
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        );
      });
    });
    try {
      await mentionAgent(kernel, "timeout");
      const runtime = createRuntime(kernel, adapter, {
        providerTimeoutMs: 10,
        cancellationPollMs: 5,
      });
      await expect(runtime.drainUntilIdle()).rejects.toBeInstanceOf(
        ProviderExecutionError,
      );
      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Waiting");
      expect(run.providerAttempts.at(-1)?.status).toBe("Unknown");
    } finally {
      kernel.close();
    }
  });

  it("enforces provider timeout even when the adapter ignores AbortSignal", async () => {
    const kernel = openKernel(":memory:");
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      await context.capabilities.complete();
    });
    try {
      await mentionAgent(kernel, "ignored-timeout");
      const runtime = createRuntime(kernel, adapter, {
        providerTimeoutMs: 10,
        cancellationPollMs: 5,
      });
      await expect(runtime.drainUntilIdle()).rejects.toMatchObject({
        outcome: "Unknown",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Waiting");
      expect(run.providerAttempts.at(-1)?.status).toBe("Unknown");
    } finally {
      kernel.close();
    }
  });

  it("retries failure parking after a crash before the atomic command", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    try {
      const adapter = await prepareNonIdempotentDeliveryCrash(
        kernel,
        () => now,
        "parking-before-command",
      );
      now = new Date(now.getTime() + 301_000);
      const crashingReplacement = createRuntime(kernel, adapter, {
        clock: () => now,
        hooks: {
          beforeFailureParking: async () => {
            throw new Error("simulated crash before atomic failure parking");
          },
        },
      });

      await expect(crashingReplacement.runOnce()).rejects.toThrow(
        "simulated crash before atomic failure parking",
      );
      let run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Active");
      expect(
        run.activity.items.filter(
          (item) => item.kind === "provider_attempt_failure_parked",
        ),
      ).toHaveLength(0);

      now = new Date(now.getTime() + 31_000);
      await createRuntime(kernel, adapter, {
        clock: () => now,
      }).drainUntilIdle();

      run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Waiting");
      expect(run.run.activationGeneration).toBe(1);
      expect(
        run.activity.items.filter(
          (item) => item.kind === "provider_attempt_failure_parked",
        ),
      ).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

  it("recovers after failure parking commits but before Outbox acknowledgement", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    try {
      const adapter = await prepareNonIdempotentDeliveryCrash(
        kernel,
        () => now,
        "parking-after-command",
      );
      now = new Date(now.getTime() + 301_000);
      const crashingReplacement = createRuntime(kernel, adapter, {
        clock: () => now,
        hooks: {
          afterFailureParking: async () => {
            throw new Error("simulated crash after atomic failure parking");
          },
        },
      });

      await expect(crashingReplacement.runOnce()).rejects.toThrow(
        "simulated crash after atomic failure parking",
      );
      let run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Waiting");
      expect(run.run.activationGeneration).toBe(1);
      expect(
        run.activity.items.filter(
          (item) => item.kind === "provider_attempt_failure_parked",
        ),
      ).toHaveLength(1);

      now = new Date(now.getTime() + 31_000);
      await createRuntime(kernel, adapter, {
        clock: () => now,
      }).drainUntilIdle();

      run = await getOnlyRun(kernel);
      expect(run.run.state).toBe("Waiting");
      expect(
        run.activity.items.filter(
          (item) => item.kind === "provider_attempt_failure_parked",
        ),
      ).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

  it("parks recovered non-idempotent Unknown delivery before acknowledging", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    const adapter: ProviderAdapter = {
      name: "non-idempotent-test",
      version: "1",
      capabilities: {
        acceptsInputWhileRunning: false,
        supportsCancel: true,
        supportsResume: false,
        supportsSessionContinuation: false,
        supportsGracefulPause: false,
        supportsIdempotentRequests: false,
      },
      async execute(context) {
        if (context.cause.type === "attention") {
          await context.capabilities.createRunFromAttention();
          return {};
        }
        await context.capabilities.complete();
        return {};
      },
    };
    try {
      await mentionAgent(kernel, "non-idempotent-recovery");
      const firstRuntime = createRuntime(kernel, adapter, {
        clock: () => now,
        hooks: {
          afterProviderAttemptStarted: async ({ causeType }) => {
            if (causeType === "run") {
              throw new Error("simulated non-idempotent process replacement");
            }
          },
        },
      });
      await firstRuntime.runOnce();
      await expect(firstRuntime.runOnce()).rejects.toThrow(
        "simulated non-idempotent process replacement",
      );
      now = new Date(now.getTime() + 301_000);

      const replacement = createRuntime(kernel, adapter, { clock: () => now });
      await replacement.drainUntilIdle();

      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Waiting");
      expect(run.providerAttempts.at(-1)?.status).toBe("Unknown");
      expect(run.inputs[0]?.disposition).toBe("Pending");
    } finally {
      kernel.close();
    }
  });

  it("reconciles an expired Attention attempt superseded before resolution", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    const adapter = new DeterministicFakeAdapter();
    try {
      await mentionAgent(kernel, "expired-attention-attempt");
      const firstRuntime = createRuntime(kernel, adapter, {
        clock: () => now,
        hooks: {
          afterProviderAttemptStarted: async ({ causeType }) => {
            if (causeType === "attention") {
              throw new Error("simulated pre-resolution process replacement");
            }
          },
        },
      });
      await expect(firstRuntime.runOnce()).rejects.toThrow(
        "simulated pre-resolution process replacement",
      );
      const before = await kernel.readEvents(null, 500);
      const originalAttemptId = before.find(
        (event) => event.type === "ProviderAttemptStarted",
      )?.entityId;
      now = new Date(now.getTime() + 31_000);

      const replacement = createRuntime(kernel, adapter, { clock: () => now });
      await replacement.drainUntilIdle();

      const after = await kernel.readEvents(null, 500);
      const originalFinish = after.find(
        (event) =>
          event.type === "ProviderAttemptFinished" &&
          event.entityId === originalAttemptId,
      );
      expect(originalFinish?.payload).toMatchObject({ status: "Unknown" });
    } finally {
      kernel.close();
    }
  });

  it("recovers Attention execution without scanning complete public history", async () => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openKernel(":memory:", () => now);
    try {
      await mentionAgent(kernel, "bounded-attention-recovery");
      const firstRuntime = createRuntime(
        kernel,
        new DeterministicFakeAdapter(),
        {
          clock: () => now,
          hooks: {
            afterProviderAttemptStarted: async ({ causeType }) => {
              if (causeType === "attention") {
                throw new Error("simulated Attention process loss");
              }
            },
          },
        },
      );
      await expect(firstRuntime.runOnce()).rejects.toThrow(
        "simulated Attention process loss",
      );
      const before = await kernel.readEvents(null, 500);
      const attemptId = before.find(
        (event) => event.type === "ProviderAttemptStarted",
      )!.entityId;
      for (let index = 0; index < 300; index += 1) {
        await kernel.execute(
          {
            type: "StartThread",
            idempotencyKey: `history-only-thread:${index}`,
            projectId: "project-sample",
            channelId: "channel-general",
            body: `Historical public event ${index}.`,
          },
          humanContext,
        );
      }
      now = new Date(now.getTime() + 31_000);
      const historySpy = vi
        .spyOn(kernel, "readEvents")
        .mockRejectedValue(
          new Error("Runtime must not scan public event history."),
        );
      const adapter = new DeterministicFakeAdapter(async (context) => {
        if (context.cause.type === "attention") {
          await context.capabilities.ignoreAttention(
            "Recovered bounded Attention.",
          );
          return;
        }
        throw new Error("Recovery must not create Run work.");
      });

      await createRuntime(kernel, adapter, {
        clock: () => now,
      }).runOnce();

      expect(historySpy).not.toHaveBeenCalled();
      historySpy.mockRestore();
      expect(
        await kernel.query(
          { type: "GetProviderAttempt", providerAttemptId: attemptId },
          runtimeContext,
        ),
      ).toMatchObject({ status: "Unknown" });
    } finally {
      vi.restoreAllMocks();
      kernel.close();
    }
  });

  it(
    "restarts recovery after an older Activation becomes recoverable behind the cursor",
    async () => {
      let now = new Date("2026-09-21T08:00:00.000Z");
      const kernel = openKernel(":memory:", () => now);
      let older:
        | Awaited<ReturnType<typeof prepareAttentionAttempt>>
        | undefined;
      let transitioned = false;
      let recoveryPages = 0;
      try {
        older = await prepareAttentionAttempt(
          kernel,
          "recovery-cursor-older",
          300_000,
        );
        for (let index = 0; index < 100; index += 1) {
          const execution = await prepareAttentionAttempt(
            kernel,
            `recovery-cursor-newer-${index}`,
            300_000,
          );
          await kernel.execute(
            {
              type: "FinishActivation",
              idempotencyKey:
                `recovery-cursor-newer-${index}:finish`,
              activationId: execution.activationId,
              outcome: "Completed",
            },
            runtimeContext,
          );
        }
        await clearOutbox(kernel);
        const runtime = createRuntime(
          kernel,
          new DeterministicFakeAdapter(),
          {
            clock: () => now,
            hooks: {
              afterAttentionRecoveryPage: async ({
                itemCount,
                hasMore,
              }) => {
                recoveryPages += 1;
                if (
                  transitioned ||
                  itemCount !== 100 ||
                  hasMore
                ) {
                  return;
                }
                transitioned = true;
                await kernel.execute(
                  {
                    type: "FinishActivation",
                    idempotencyKey:
                      "recovery-cursor-older:finish-after-page",
                    activationId: older!.activationId,
                    outcome: "Completed",
                  },
                  runtimeContext,
                );
              },
            },
          },
        );

        await runtime.drainUntilIdle();

        expect(transitioned).toBe(true);
        expect(recoveryPages).toBeGreaterThanOrEqual(3);
        expect(
          await kernel.query(
            {
              type: "GetProviderAttempt",
              providerAttemptId: older.attemptId,
            },
            runtimeContext,
          ),
        ).toMatchObject({ status: "Unknown" });
      } finally {
        kernel.close();
      }
    },
    30_000,
  );

  it("cancels provider execution when durable Run state is cancelled", async () => {
    const kernel = openKernel(":memory:");
    const attentionAdapter = new DeterministicFakeAdapter();
    try {
      await mentionAgent(kernel, "cancellation");
      const attentionRuntime = createRuntime(kernel, attentionAdapter, {
        outboxBatchSize: 1,
      });
      await attentionRuntime.runOnce();
      const events = await kernel.readEvents(null, 500);
      const runId = events.find((event) => event.type === "RunCreated")?.entityId;
      expect(runId).toBeTruthy();

      const blockingAdapter = new DeterministicFakeAdapter(async (context) => {
        if (context.cause.type === "attention") {
          await context.capabilities.createRunFromAttention();
          return;
        }
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      });
      const runtime = createRuntime(kernel, blockingAdapter, {
        cancellationPollMs: 5,
      });
      const execution = runtime.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await kernel.execute(
        {
          type: "CancelRun",
          idempotencyKey: "cancel-running-provider",
          runId: runId!,
          expectedRunRevision: 1,
          reason: "Human stopped the work.",
        },
        humanContext,
      );

      await expect(execution).rejects.toMatchObject({ outcome: "Unknown" });
      const run = await kernel.query(
        { type: "GetRunProjection", runId: runId! },
        humanContext,
      );
      expect(run.run.state).toBe("Cancelled");
      expect(run.providerAttempts.at(-1)?.status).toBe("Unknown");
    } finally {
      kernel.close();
    }
  });
});

function createRuntime(
  kernel: TorsorKernel,
  adapter: ProviderAdapter,
  overrides: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
): AgentRuntime {
  return new AgentRuntime({
    kernel,
    runtimePrincipalId: "principal-runtime",
    projectIds: ["project-sample"],
    adapter,
    attentionLeaseMs: 30_000,
    outboxLeaseMs: 30_000,
    providerTimeoutMs: 5_000,
    cancellationPollMs: 10,
    clock: () => new Date("2026-09-21T08:00:00.000Z"),
    ...overrides,
  });
}

function openKernel(
  databasePath: string,
  clock: () => Date = () => new Date("2026-09-21T08:00:00.000Z"),
  kernelBootstrap: KernelBootstrap = bootstrap,
): TorsorKernel {
  const instance = kernelInstance;
  kernelInstance += 1;
  let nextId = 0;
  return TorsorKernel.open({
    databasePath,
    bootstrap: kernelBootstrap,
    clock,
    idFactory: (prefix) => `${prefix}-${instance}-${++nextId}`,
  });
}

function createProjectFairnessBootstrap(projectCount: number): KernelBootstrap {
  return {
    principals: [
      { id: "principal-human", kind: "human", displayName: "Avery Stone" },
      {
        id: "principal-runtime",
        kind: "runtime",
        displayName: "Local Runtime",
      },
      ...Array.from({ length: projectCount }, (_, index) => ({
        id: `principal-fair-${index}`,
        kind: "agent" as const,
        displayName: `Fair Agent ${index}`,
      })),
    ],
    projects: Array.from({ length: projectCount }, (_, index) => ({
      id: `project-fair-${index}`,
      name: `Fair Project ${index}`,
    })),
    channels: Array.from({ length: projectCount }, (_, index) => ({
      id: `channel-fair-${index}`,
      projectId: `project-fair-${index}`,
      name: "general",
    })),
    agents: Array.from({ length: projectCount }, (_, index) => ({
      id: `agent-fair-${index}`,
      principalId: `principal-fair-${index}`,
      projectId: `project-fair-${index}`,
      name: `Fair Agent ${index}`,
      configRevision: 1,
      config: { provider: "deterministic-fake" },
    })),
  };
}

async function mentionAgent(kernel: TorsorKernel, key: string) {
  return startMention(
    kernel,
    `thread:${key}`,
    "Orbit, inspect the durable runtime sample.",
  );
}

async function startMention(
  kernel: TorsorKernel,
  idempotencyKey: string,
  body: string,
) {
  return kernel.execute(
    {
      type: "StartThread",
      idempotencyKey,
      projectId: "project-sample",
      channelId: "channel-general",
      body,
      targetAgentIds: ["agent-orbit"],
    },
    humanContext,
  );
}

async function startProjectMention(
  kernel: TorsorKernel,
  project: {
    readonly projectId: string;
    readonly channelId: string;
    readonly agentId: string;
  },
  idempotencyKey: string,
  body: string,
) {
  return kernel.execute(
    {
      type: "StartThread",
      idempotencyKey,
      projectId: project.projectId,
      channelId: project.channelId,
      body,
      targetAgentIds: [project.agentId],
    },
    humanContext,
  );
}

function createBarrier(participants: number): { wait(): Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived === participants) {
        release();
      }
      await open;
    },
  };
}

async function prepareAttentionAttempt(
  kernel: TorsorKernel,
  key: string,
  durationMs: number,
): Promise<{
  readonly activationId: string;
  readonly attemptId: string;
}> {
  const thread = await mentionAgent(kernel, key);
  const projection = await kernel.query(
    {
      type: "GetThreadProjection",
      threadRootId: thread.entityId,
    },
    runtimeContext,
  );
  const attention = projection.attentions[0]!;
  const claim = await kernel.execute(
    {
      type: "ClaimAttention",
      idempotencyKey: `${key}:claim`,
      attentionId: attention.id,
      expectedAttentionRevision: attention.revision,
      leaseDurationMs: durationMs,
    },
    runtimeContext,
  );
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `${key}:activation`,
      attentionId: attention.id,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
      durationMs,
    },
    runtimeContext,
  );
  const attempt = await kernel.execute(
    {
      type: "StartProviderAttempt",
      idempotencyKey: `${key}:attempt`,
      activationId: activation.entityId,
      adapter: "synthetic-recovery-race",
      adapterVersion: "1",
      capabilitySnapshot: { attentionDecision: true },
      runInputIds: [],
      requestIdempotencyKey: `${key}:provider-request`,
    },
    runtimeContext,
  );
  return {
    activationId: activation.entityId,
    attemptId: attempt.entityId,
  };
}

async function clearOutbox(kernel: TorsorKernel): Promise<void> {
  for (let batch = 0; ; batch += 1) {
    const claim = await kernel.execute(
      {
        type: "ClaimOutboxEvents",
        idempotencyKey: `test-clear-outbox:${batch}`,
        limit: 100,
        leaseDurationMs: 30_000,
      },
      runtimeContext,
    );
    const events = claim.outboxEvents ?? [];
    if (events.length === 0) {
      return;
    }
    await kernel.execute(
      {
        type: "AcknowledgeOutboxEvents",
        idempotencyKey: `test-clear-outbox:${batch}:ack`,
        outboxEventIds: events.map((event) => event.id),
        leaseToken: claim.leaseToken!,
      },
      runtimeContext,
    );
  }
}

async function prepareNonIdempotentDeliveryCrash(
  kernel: TorsorKernel,
  clock: () => Date,
  key: string,
): Promise<ProviderAdapter> {
  const adapter: ProviderAdapter = {
    name: "non-idempotent-crash-test",
    version: "1",
    capabilities: {
      acceptsInputWhileRunning: false,
      supportsCancel: true,
      supportsResume: false,
      supportsSessionContinuation: false,
      supportsGracefulPause: false,
      supportsIdempotentRequests: false,
    },
    async execute(context) {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        return {};
      }
      await context.capabilities.complete();
      return {};
    },
  };
  await mentionAgent(kernel, key);
  const runtime = createRuntime(kernel, adapter, {
    clock,
    hooks: {
      afterProviderAttemptStarted: async ({ causeType }) => {
        if (causeType === "run") {
          throw new Error("simulated non-idempotent process replacement");
        }
      },
    },
  });
  await runtime.runOnce();
  await expect(runtime.runOnce()).rejects.toThrow(
    "simulated non-idempotent process replacement",
  );
  return adapter;
}

function captureProcessFaults(): {
  readonly errors: unknown[];
  stop(): void;
} {
  const errors: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    errors.push(error);
  };
  const onUncaught = (error: unknown) => {
    errors.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", onUncaught);
  return {
    errors,
    stop() {
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onUncaught);
    },
  };
}

function createFixtureAcpAdapter(
  mode: string,
  parameter?: number,
  limits?: Partial<CopilotAcpLimits>,
): CopilotAcpAdapter {
  const fixture = fileURLToPath(
    new URL("./fixtures/mock-acp-server.mjs", import.meta.url),
  );
  return new CopilotAcpAdapter({
    command: process.execPath,
    commandArgs: [
      fixture,
      mode,
      ...(parameter === undefined ? [] : [String(parameter)]),
    ],
    unsafeAllowCustomCommandArgs: true,
    cwd: process.cwd(),
    ...(limits ? { limits } : {}),
  });
}

async function prepareAcpRun(
  kernel: TorsorKernel,
  key: string,
): Promise<void> {
  await mentionAgent(kernel, key);
  await createRuntime(kernel, new DeterministicFakeAdapter(), {
    outboxBatchSize: 1,
  }).runOnce();
}

async function getOnlyRun(kernel: TorsorKernel) {
  const events = await kernel.readEvents(null, 500);
  const runIds = [
    ...new Set(
      events
        .filter((event) => event.type === "RunCreated")
        .map((event) => event.entityId),
    ),
  ];
  expect(runIds).toHaveLength(1);
  return kernel.query(
    { type: "GetRunProjection", runId: runIds[0]! },
    humanContext,
  );
}

async function waitForRunActivity(kernel: TorsorKernel) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const run = await getOnlyRun(kernel);
    if (run.activity.items.length > 0) {
      return run;
    }
    if (Date.now() >= deadline) {
      throw new Error("ACP fixture did not stream activity before cancellation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
