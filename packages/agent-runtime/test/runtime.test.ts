import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KernelError,
  TorsorKernel,
  type KernelBootstrap,
} from "@torsor/kernel";
import { describe, expect, it } from "vitest";

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
  ],
  projects: [
    { id: "project-sample", name: "Sample Project" },
    { id: "project-secondary", name: "Secondary Project" },
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

      expect(seenBodies).toEqual(
        Array.from(
          { length: 10 },
          (_, index) => `Independent request ${index}.`,
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

  it("reconciles an unfinished ProviderAttempt after an Attention decision", async () => {
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
      now = new Date(now.getTime() + 31_000);

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
    let createdRun!: () => void;
    let releaseAttention!: () => void;
    const runCreated = new Promise<void>((resolve) => {
      createdRun = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseAttention = resolve;
    });
    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
        createdRun();
        await release;
        return;
      }
      await context.capabilities.complete();
    });
    try {
      await mentionAgent(kernel, "live-attention-recovery");
      const firstRuntime = createRuntime(kernel, adapter);
      const liveExecution = firstRuntime.runOnce();
      await runCreated;

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
): TorsorKernel {
  const instance = kernelInstance;
  kernelInstance += 1;
  let nextId = 0;
  return TorsorKernel.open({
    databasePath,
    bootstrap,
    clock,
    idFactory: (prefix) => `${prefix}-${instance}-${++nextId}`,
  });
}

async function mentionAgent(kernel: TorsorKernel, key: string) {
  return kernel.execute(
    {
      type: "StartThread",
      idempotencyKey: `thread:${key}`,
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Orbit, inspect the durable runtime sample.",
      targetAgentIds: ["agent-orbit"],
    },
    humanContext,
  );
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
