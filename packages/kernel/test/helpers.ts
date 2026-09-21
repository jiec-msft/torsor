import { TorsorKernel, type KernelBootstrap } from "../src/index.js";

export const bootstrap: KernelBootstrap = {
  principals: [
    { id: "principal-human", kind: "human", displayName: "Avery Stone" },
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

export async function createRun(kernel: TorsorKernel) {
  const thread = await kernel.execute(
    {
      type: "StartThread",
      idempotencyKey: "start-thread",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Please inspect the public sample and report the findings.",
      targetAgentIds: ["agent-orbit"],
    },
    humanContext,
  );
  const [attention] = await kernel.query(
    {
      type: "ListOpenAttentions",
      projectId: "project-sample",
      targetAgentId: "agent-orbit",
    },
    runtimeContext,
  );
  if (!attention) {
    throw new Error("Expected an Attention.");
  }
  const claim = await kernel.execute(
    {
      type: "ClaimAttention",
      idempotencyKey: "claim-attention",
      attentionId: attention.id,
      expectedAttentionRevision: attention.revision,
      leaseDurationMs: 30_000,
    },
    runtimeContext,
  );
  const attentionActivation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: "start-attention-activation",
      attentionId: attention.id,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    },
    runtimeContext,
  );
  const resolved = await kernel.execute(
    {
      type: "ResolveAttentionWithRun",
      idempotencyKey: "resolve-attention",
      attentionId: attention.id,
      expectedAttentionRevision: claim.revision!,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    },
    {
      principalId: "principal-orbit",
      activationId: attentionActivation.entityId,
    },
  );
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: "start-run-activation",
      runId: resolved.entityId,
      expectedRunRevision: 1,
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
    agentContext: {
      principalId: "principal-orbit",
      activationId: activation.entityId,
    },
  };
}
