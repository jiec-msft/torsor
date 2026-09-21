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
  ProviderExecutionError,
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
        commandArgs: [fixture],
        cwd: process.cwd(),
        environment: { MOCK_ACP_PLAN: "invalid" },
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
