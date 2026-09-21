import * as db from "./database.js";
import { KernelError } from "./errors.js";
import * as invariants from "./invariants.js";
import * as runs from "./runs.js";
import type {
  CommandResult,
  KernelCommand,
  PrincipalContext
} from "./types.js";
import {
  integer,
  optionalText,
  text,
  type Row
} from "./values.js";

export function claimAttention(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "ClaimAttention";
}>, principal: Row, correlationId: string): CommandResult {
  invariants.requireKind(kernel, principal, "runtime");
  if (!Number.isInteger(command.leaseDurationMs) ||
    command.leaseDurationMs < 1000 ||
    command.leaseDurationMs > 300000) {
    throw new KernelError("InvalidCommand", "Attention leases must be between 1 and 300 seconds.");
  }
  const attention = invariants.requireAttention(kernel, command.attentionId);
  if (text(attention.status) !== "Open") {
    throw new KernelError("Conflict", "The Attention is already resolved.");
  }
  invariants.checkRevision(kernel, integer(attention.revision), command.expectedAttentionRevision, "Attention");
  const now = kernel.clock();
  const existingExpiry = optionalText(attention.handler_lease_expires_at);
  if (existingExpiry && new Date(existingExpiry) > now) {
    throw new KernelError("Conflict", "The Attention already has an active handler lease.");
  }
  const leaseToken = kernel.idFactory("lease");
  const revision = integer(attention.revision) + 1;
  const expiresAt = new Date(now.getTime() + command.leaseDurationMs).toISOString();
  db.run(kernel, `UPDATE activation_attempts
          SET revoked_at = COALESCE(revoked_at, ?),
              revocation_reason = COALESCE(revocation_reason, 'attention_lease_replaced')
        WHERE attention_id = ? AND revoked_at IS NULL`, now.toISOString(), command.attentionId);
  db.run(kernel, `UPDATE attentions
          SET revision = ?,
              handler_lease_holder_principal_id = ?,
              handler_lease_token = ?,
              handler_lease_expires_at = ?
        WHERE id = ?`, revision, text(principal.id), leaseToken, expiresAt, command.attentionId);
  const eventSequence = invariants.emitEvent(kernel, {
    type: "AttentionClaimed",
    projectId: text(attention.project_id),
    channelId: text(attention.channel_id),
    threadRootId: text(attention.thread_root_id),
    threadCursor: null,
    entityType: "Attention",
    entityId: command.attentionId,
    actorPrincipalId: text(principal.id),
    activationId: null,
    causationId: text(attention.message_revision_id),
    correlationId,
    payload: { revision, expiresAt },
  });
  invariants.recordAttentionHistory(kernel, command.attentionId, eventSequence);
  return {
    commandType: command.type,
    entityId: command.attentionId,
    revision,
    relatedIds: { handlerLeaseToken: leaseToken },
  };
}

export function resolveAttentionWithRun(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "ResolveAttentionWithRun";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  invariants.requireKind(kernel, principal, "agent");
  const agent = invariants.requireAgentForPrincipal(kernel, text(principal.id));
  const attention = invariants.requireAttention(kernel, command.attentionId);
  if (text(agent.id) !== text(attention.target_agent_id)) {
    throw new KernelError("Forbidden", "An Agent may only resolve its own Attention.");
  }
  if (text(attention.status) !== "Open") {
    throw new KernelError("Conflict", "The Attention is already resolved.");
  }
  invariants.checkRevision(kernel, integer(attention.revision), command.expectedAttentionRevision, "Attention");
  invariants.assertAttentionLease(kernel, attention, command.handlerLeaseToken);
  if (!context.activationId) {
    throw new KernelError("Unauthorized", "Resolving Attention requires its authenticated Activation.");
  }
  const attentionActivation = invariants.requireLiveActivation(kernel, context.activationId);
  if (optionalText(attentionActivation.attention_id) !== command.attentionId ||
    text(attentionActivation.agent_id) !== text(agent.id)) {
    throw new KernelError("Forbidden", "The Activation does not belong to this Attention and Agent.");
  }
  invariants.assertActivationScopeCurrent(kernel, attentionActivation);
  const runId = kernel.idFactory("run");
  const now = db.now(kernel);
  const configRevision = integer(agent.current_config_revision);
  db.run(kernel, `INSERT INTO runs
        (id, project_id, home_channel_id, thread_root_id, owner_agent_id,
         agent_config_revision, state, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Active', 1, ?, ?)`, runId, text(attention.project_id), text(attention.channel_id), text(attention.thread_root_id), text(agent.id), configRevision, now, now);
  const run = invariants.requireRun(kernel, runId);
  const input = runs.createRunInput(kernel, run, text(attention.message_revision_id), text(principal.id), text(attentionActivation.id), command.attentionId);
  db.run(kernel, `UPDATE activation_attempts
          SET revoked_at = COALESCE(revoked_at, ?),
              revocation_reason = COALESCE(revocation_reason, 'attention_resolved')
        WHERE id = ?`, now, text(attentionActivation.id));
  db.run(kernel, `UPDATE runs SET next_input_sequence = 2 WHERE id = ?`, runId);
  const revision = integer(attention.revision) + 1;
  db.run(kernel, `UPDATE attentions
          SET status = 'Resolved',
              revision = ?,
              resolution_outcome = 'RunCreated',
              resolved_by_principal_id = ?,
              resolved_activation_id = ?,
              resolved_run_id = ?,
              resolved_at = ?,
              handler_lease_token = NULL,
              handler_lease_expires_at = NULL
        WHERE id = ?`, revision, text(principal.id), text(attentionActivation.id), runId, now, command.attentionId);
  const cursor = invariants.emitThreadEvent(kernel, {
    type: "RunCreated",
    projectId: text(attention.project_id),
    channelId: text(attention.channel_id),
    threadRootId: text(attention.thread_root_id),
    entityType: "Run",
    entityId: runId,
    actorPrincipalId: text(principal.id),
    activationId: text(attentionActivation.id),
    causationId: command.attentionId,
    correlationId,
    payload: { state: "Active", ownerAgentId: text(agent.id) },
  });
  const attentionEventSequence = invariants.emitEvent(kernel, {
    type: "AttentionResolved",
    projectId: text(attention.project_id),
    channelId: text(attention.channel_id),
    threadRootId: text(attention.thread_root_id),
    threadCursor: null,
    entityType: "Attention",
    entityId: command.attentionId,
    actorPrincipalId: text(principal.id),
    activationId: text(attentionActivation.id),
    causationId: text(attention.message_revision_id),
    correlationId,
    payload: { outcome: "RunCreated", runId },
  });
  invariants.recordAttentionHistory(kernel, command.attentionId, attentionEventSequence);
  invariants.enqueueOutbox(kernel, "run.activation-requested", "Run", runId, { runInputId: input.id, sourceAttentionId: command.attentionId });
  return {
    commandType: command.type,
    entityId: runId,
    revision: 1,
    threadCursor: cursor,
    relatedIds: {
      attentionId: command.attentionId,
      runInputId: input.id,
    },
  };
}
