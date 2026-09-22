import type { CommandResult, TorsorKernel } from "../src/index.js";
import { claimRunOutboxAuthority, humanContext, runtimeContext } from "./helpers.js";

type TestKernel = Pick<TorsorKernel, "execute" | "query" | "finalizeReport">;

export async function prepareArtifactAttention(
  kernel: TestKernel,
  message: CommandResult,
  agent: string,
  key: string,
) {
  const page = await kernel.query({
    type: "ListOpenAttentions", targetAgentId: `agent-${agent}`, limit: 100,
  }, runtimeContext);
  const attention = page.items.find((item) =>
    item.messageRevisionId === message.relatedIds!.messageRevisionId,
  );
  if (!attention) throw new Error("Expected a synthetic Attention.");
  const claim = await kernel.execute({
    type: "ClaimAttention", idempotencyKey: `${key}-claim`,
    attentionId: attention.id, expectedAttentionRevision: attention.revision,
    leaseDurationMs: 300_000,
  }, runtimeContext);
  const activation = await kernel.execute({
    type: "StartActivation", idempotencyKey: `${key}-attention`,
    attentionId: attention.id, handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    durationMs: 300_000,
  }, runtimeContext);
  return {
    context: { principalId: `principal-${agent}`, activationId: activation.entityId },
    command: {
      type: "ResolveAttentionWithRun" as const, idempotencyKey: `${key}-resolve`,
      attentionId: attention.id, expectedAttentionRevision: claim.revision!,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
    },
  };
}

export async function startArtifactRun(
  kernel: TestKernel,
  message: CommandResult,
  agent: string,
  key: string,
) {
  const decision = await prepareArtifactAttention(kernel, message, agent, key);
  const run = await kernel.execute(decision.command, decision.context);
  const authority = await claimRunOutboxAuthority(kernel, run.entityId, key);
  const activation = await kernel.execute({
    type: "StartActivation", idempotencyKey: `${key}-run-activation`,
    runId: run.entityId, expectedRunRevision: 1, ...authority,
    durationMs: 300_000,
  }, runtimeContext);
  await kernel.execute({
    type: "AcknowledgeOutboxEvents", idempotencyKey: `${key}-run-ack`,
    outboxEventIds: [authority.outboxEventId], leaseToken: authority.outboxLeaseToken,
  }, runtimeContext);
  return {
    runId: run.entityId,
    runInputId: run.relatedIds!.runInputId!,
    context: { principalId: `principal-${agent}`, activationId: activation.entityId },
  };
}

export async function seedArtifactScopes(kernel: TestKernel) {
  const root = await kernel.execute({
    type: "StartThread", idempotencyKey: "scope-root",
    projectId: "project-sample", channelId: "channel-general",
    body: "Inspect this synthetic component.", targetAgentIds: ["agent-orbit", "agent-keel"],
  }, humanContext);
  const parent = await startArtifactRun(kernel, root, "orbit", "parent");
  const sibling = await startArtifactRun(kernel, root, "keel", "sibling");
  const delegated = await kernel.execute({
    type: "PublishRunReply", idempotencyKey: "scope-delegate", runId: parent.runId,
    expectedRunRevision: 1, body: "Inspect a related synthetic component.",
    targetAgentIds: ["agent-keel"],
  }, parent.context);
  const child = await startArtifactRun(kernel, delegated, "keel", "child");
  const independent = await kernel.execute({
    type: "ReplyToThread", idempotencyKey: "scope-independent", threadRootId: root.entityId,
    body: "An independent synthetic request.", targetAgentIds: ["agent-orbit"],
  }, humanContext);
  const unrelated = await startArtifactRun(kernel, independent, "orbit", "unrelated");
  return { threadId: root.entityId, parent, sibling, child, unrelated };
}
