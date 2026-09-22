import { TorsorKernel, type KernelBootstrap } from "../src/index.js";

export const bootstrap: KernelBootstrap = {
  principals: [
    { id: "principal-human", kind: "human", displayName: "Avery Stone" },
    { id: "principal-riley", kind: "human", displayName: "Riley Park" },
    { id: "principal-runtime", kind: "runtime", displayName: "Local Runtime" },
    { id: "principal-orbit", kind: "agent", displayName: "Orbit" },
    { id: "principal-keel", kind: "agent", displayName: "Keel" },
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
      configRevision: 3,
      config: { model: "deterministic-fake", mode: "read-only" },
    },
    {
      id: "agent-keel",
      principalId: "principal-keel",
      projectId: "project-sample",
      name: "Keel",
      configRevision: 1,
      config: { model: "deterministic-fake", mode: "read-only" },
    },
  ],
};

export const humanContext = { principalId: "principal-human" } as const;
export const runtimeContext = { principalId: "principal-runtime" } as const;

export function openMemoryKernel(clock?: () => Date): TorsorKernel {
  let nextId = 0;
  return TorsorKernel.open({
    databasePath: ":memory:",
    bootstrap,
    clock: clock ?? (() => new Date("2026-09-21T08:00:00.000Z")),
    idFactory: (prefix) => `${prefix}-${++nextId}`,
  });
}

export async function claimRunOutboxAuthority(
  kernel: Pick<TorsorKernel, "execute">,
  runId: string,
  key: string,
  runInputId?: string,
): Promise<{
  readonly outboxEventId: string;
  readonly outboxLeaseToken: string;
}> {
  for (let index = 0; index < 100; index += 1) {
    const claim = await kernel.execute(
      {
        type: "ClaimOutboxEvents",
        idempotencyKey: `${key}-outbox-claim-${index}`,
        limit: 1,
        leaseDurationMs: 30_000,
      },
      runtimeContext,
    );
    const event = claim.outboxEvents?.[0];
    if (!event || !claim.leaseToken) {
      throw new Error(`Expected an Outbox event for Run ${runId}.`);
    }
    if (
      event.aggregateId === runId &&
      (
        event.topic === "run.activation-requested" ||
        event.topic === "run-input.available"
      ) &&
      (
        runInputId === undefined ||
        (
          event.payload !== null &&
          typeof event.payload === "object" &&
          !Array.isArray(event.payload) &&
          event.payload.runInputId === runInputId
        )
      )
    ) {
      return {
        outboxEventId: event.id,
        outboxLeaseToken: claim.leaseToken,
      };
    }
    await kernel.execute(
      {
        type: "AcknowledgeOutboxEvents",
        idempotencyKey: `${key}-outbox-ack-${index}`,
        outboxEventIds: [event.id],
        leaseToken: claim.leaseToken,
      },
      runtimeContext,
    );
  }
  throw new Error(`Outbox authority for Run ${runId} was not found.`);
}

export async function createRun(kernel: TorsorKernel, keySuffix = "") {
  const thread = await kernel.execute(
    {
      type: "StartThread",
      idempotencyKey: `start-thread${keySuffix}`,
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Please inspect the public sample and report the findings.",
      targetAgentIds: ["agent-orbit"],
    },
    humanContext,
  );
  const attentionPage = await kernel.query(
    {
      type: "ListOpenAttentions",
      projectId: "project-sample",
      targetAgentId: "agent-orbit",
    },
    runtimeContext,
  );
  const [attention] = attentionPage.items;
  if (!attention) {
    throw new Error("Expected an Attention.");
  }
  const claim = await kernel.execute(
    {
      type: "ClaimAttention",
      idempotencyKey: `claim-attention${keySuffix}`,
      attentionId: attention.id,
      expectedAttentionRevision: attention.revision,
      leaseDurationMs: 30_000,
    },
    runtimeContext,
  );
  const attentionActivation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `start-attention-activation${keySuffix}`,
      attentionId: attention.id,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    },
    runtimeContext,
  );
  const resolved = await kernel.execute(
    {
      type: "ResolveAttentionWithRun",
      idempotencyKey: `resolve-attention${keySuffix}`,
      attentionId: attention.id,
      expectedAttentionRevision: claim.revision!,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    },
    {
      principalId: "principal-orbit",
      activationId: attentionActivation.entityId,
    },
  );
  const outboxAuthority = await claimRunOutboxAuthority(
    kernel,
    resolved.entityId,
    `start-run${keySuffix}`,
    resolved.relatedIds!.runInputId!,
  );
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `start-run-activation${keySuffix}`,
      runId: resolved.entityId,
      expectedRunRevision: 1,
      ...outboxAuthority,
    },
    runtimeContext,
  );
  return {
    threadId: thread.entityId,
    attentionId: attention.id,
    attentionActivationId: attentionActivation.entityId,
    runId: resolved.entityId,
    runInputId: resolved.relatedIds!.runInputId!,
    activationId: activation.entityId,
    ...outboxAuthority,
    agentContext: {
      principalId: "principal-orbit",
      activationId: activation.entityId,
    },
  };
}
