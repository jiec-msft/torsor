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
  isTerminalRunState,
  optionalText,
  requireNonEmpty,
  text,
  type Row
} from "./values.js";

type AttentionDecisionContext = {
  agent: Row;
  attention: Row;
  activation: Row;
};

function requireAttentionDecisionContext(
  kernel: db.KernelContext,
  command: {
    attentionId: string;
    expectedAttentionRevision: number;
    handlerLeaseToken: string;
  },
  principal: Row,
  context: PrincipalContext,
): AttentionDecisionContext {
  invariants.requireKind(kernel, principal, "agent");
  const agent = invariants.requireAgentForPrincipal(kernel, text(principal.id));
  const attention = invariants.requireAttention(kernel, command.attentionId);
  if (text(agent.id) !== text(attention.target_agent_id)) {
    throw new KernelError("Forbidden", "An Agent may only resolve its own Attention.");
  }
  if (text(attention.status) !== "Open") {
    throw new KernelError("Conflict", "The Attention is already resolved.");
  }
  invariants.checkRevision(
    kernel,
    integer(attention.revision),
    command.expectedAttentionRevision,
    "Attention",
  );
  invariants.assertAttentionLease(
    kernel,
    attention,
    command.handlerLeaseToken,
  );
  if (!context.activationId) {
    throw new KernelError(
      "Unauthorized",
      "Resolving Attention requires its authenticated Activation.",
    );
  }
  const activation = invariants.requireLiveActivation(
    kernel,
    context.activationId,
  );
  if (
    optionalText(activation.attention_id) !== command.attentionId ||
    text(activation.agent_id) !== text(agent.id)
  ) {
    throw new KernelError(
      "Forbidden",
      "The Activation does not belong to this Attention and Agent.",
    );
  }
  invariants.assertActivationScopeCurrent(kernel, activation);
  return { agent, attention, activation };
}

function finishAttentionActivation(
  kernel: db.KernelContext,
  activationId: string,
  now: string,
  reason: string,
): void {
  db.run(
    kernel,
    `UPDATE activation_attempts
        SET revoked_at = ?,
            revocation_reason = ?,
            finished_at = ?,
            outcome = 'Completed',
            detail = ?
      WHERE id = ?`,
    now,
    reason,
    now,
    reason,
    activationId,
  );
}

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
  const { agent, attention, activation } = requireAttentionDecisionContext(
    kernel,
    command,
    principal,
    context,
  );
  const runId = kernel.idFactory("run");
  const now = db.now(kernel);
  const configRevision = integer(agent.current_config_revision);
  db.run(kernel, `INSERT INTO runs
        (id, project_id, home_channel_id, thread_root_id, owner_agent_id,
         agent_config_revision, state, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Active', 1, ?, ?)`, runId, text(attention.project_id), text(attention.channel_id), text(attention.thread_root_id), text(agent.id), configRevision, now, now);
  const run = invariants.requireRun(kernel, runId);
  const input = runs.createRunInput(kernel, run, text(attention.message_revision_id), text(principal.id), text(activation.id), command.attentionId);
  finishAttentionActivation(
    kernel,
    text(activation.id),
    now,
    "attention_resolved",
  );
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
              handler_lease_holder_principal_id = NULL,
              handler_lease_token = NULL,
              handler_lease_expires_at = NULL
        WHERE id = ?`, revision, text(principal.id), text(activation.id), runId, now, command.attentionId);
  const cursor = invariants.emitThreadEvent(kernel, {
    type: "RunCreated",
    projectId: text(attention.project_id),
    channelId: text(attention.channel_id),
    threadRootId: text(attention.thread_root_id),
    entityType: "Run",
    entityId: runId,
    actorPrincipalId: text(principal.id),
    activationId: text(activation.id),
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
    activationId: text(activation.id),
    causationId: text(attention.message_revision_id),
    correlationId,
    payload: {
      outcome: "RunCreated",
      revision,
      runId,
      runInputId: input.id,
    },
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

export function ignoreAttention(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "IgnoreAttention";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const { attention, activation } = requireAttentionDecisionContext(
    kernel,
    command,
    principal,
    context,
  );
  requireNonEmpty(command.reason, "reason");
  const now = db.now(kernel);
  const revision = integer(attention.revision) + 1;
  finishAttentionActivation(
    kernel,
    text(activation.id),
    now,
    "attention_ignored",
  );
  db.run(kernel, `UPDATE attentions
          SET status = 'Ignored',
              revision = ?,
              resolution_outcome = 'Ignored',
              resolved_by_principal_id = ?,
              resolved_activation_id = ?,
              resolved_run_id = NULL,
              resolved_at = ?,
              handler_lease_holder_principal_id = NULL,
              handler_lease_token = NULL,
              handler_lease_expires_at = NULL
        WHERE id = ?`, revision, text(principal.id), text(activation.id), now, command.attentionId);
  const eventSequence = invariants.emitEvent(kernel, {
    type: "AttentionIgnored",
    projectId: text(attention.project_id),
    channelId: text(attention.channel_id),
    threadRootId: text(attention.thread_root_id),
    threadCursor: null,
    entityType: "Attention",
    entityId: command.attentionId,
    actorPrincipalId: text(principal.id),
    activationId: text(activation.id),
    causationId: text(attention.message_revision_id),
    correlationId,
    payload: {
      outcome: "Ignored",
      reason: command.reason.trim(),
      revision,
    },
  });
  invariants.recordAttentionHistory(
    kernel,
    command.attentionId,
    eventSequence,
  );
  return {
    commandType: command.type,
    entityId: command.attentionId,
    revision,
    relatedIds: { activationId: text(activation.id) },
  };
}

export function resolveAttentionWithExistingRun(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "ResolveAttentionWithExistingRun";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const { agent, attention, activation } = requireAttentionDecisionContext(
    kernel,
    command,
    principal,
    context,
  );
  const run = invariants.requireRun(kernel, command.runId);
  if (text(run.owner_agent_id) !== text(agent.id)) {
    throw new KernelError(
      "Forbidden",
      "An Attention may only continue a Run owned by its target Agent.",
    );
  }
  if (
    text(run.project_id) !== text(attention.project_id) ||
    text(run.home_channel_id) !== text(attention.channel_id) ||
    text(run.thread_root_id) !== text(attention.thread_root_id)
  ) {
    throw new KernelError(
      "Forbidden",
      "The Run must belong to the Attention Project, Channel, and Thread.",
    );
  }
  if (isTerminalRunState(text(run.state))) {
    throw new KernelError(
      "TerminalRun",
      `Run ${command.runId} is terminal and cannot accept this command.`,
      { state: text(run.state) },
    );
  }
  invariants.checkRevision(
    kernel,
    integer(run.revision),
    command.expectedRunRevision,
    "Run",
  );
  const now = db.now(kernel);
  const input = runs.createRunInput(
    kernel,
    run,
    text(attention.message_revision_id),
    text(principal.id),
    text(activation.id),
    command.attentionId,
  );
  const runRevision = integer(run.revision) + 1;
  db.run(kernel, `UPDATE runs
          SET revision = ?,
              next_input_sequence = ?,
              updated_at = ?
        WHERE id = ?`, runRevision, input.sequence + 1, now, command.runId);
  finishAttentionActivation(
    kernel,
    text(activation.id),
    now,
    "attention_resolved_with_existing_run",
  );
  const attentionRevision = integer(attention.revision) + 1;
  db.run(kernel, `UPDATE attentions
          SET status = 'Resolved',
              revision = ?,
              resolution_outcome = 'ExistingRunContinued',
              resolved_by_principal_id = ?,
              resolved_activation_id = ?,
              resolved_run_id = ?,
              resolved_at = ?,
              handler_lease_holder_principal_id = NULL,
              handler_lease_token = NULL,
              handler_lease_expires_at = NULL
        WHERE id = ?`, attentionRevision, text(principal.id), text(activation.id), command.runId, now, command.attentionId);
  const cursor = invariants.emitThreadEvent(kernel, {
    type: "RunInputAdded",
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    entityType: "RunInput",
    entityId: input.id,
    actorPrincipalId: text(principal.id),
    activationId: text(activation.id),
    causationId: command.attentionId,
    correlationId,
    payload: {
      runId: command.runId,
      sequence: input.sequence,
      runRevision,
      sourceAttentionId: command.attentionId,
    },
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
    activationId: text(activation.id),
    causationId: text(attention.message_revision_id),
    correlationId,
    payload: {
      outcome: "ExistingRunContinued",
      revision: attentionRevision,
      runId: command.runId,
      runInputId: input.id,
      runRevision,
    },
  });
  invariants.recordAttentionHistory(
    kernel,
    command.attentionId,
    attentionEventSequence,
  );
  invariants.enqueueOutbox(
    kernel,
    "run-input.available",
    "Run",
    command.runId,
    {
      runInputId: input.id,
      runRevision,
      sourceAttentionId: command.attentionId,
    },
  );
  return {
    commandType: command.type,
    entityId: command.runId,
    revision: runRevision,
    threadCursor: cursor,
    relatedIds: {
      attentionId: command.attentionId,
      attentionRevision: String(attentionRevision),
      runInputId: input.id,
      activationId: text(activation.id),
    },
  };
}
