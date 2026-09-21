import * as db from "./database.js";
import { KernelError } from "./errors.js";
import * as invariants from "./invariants.js";
import type {
  CommandResult,
  JsonValue,
  KernelCommand,
  PrincipalContext
} from "./types.js";
import {
  boundedDuration,
  integer,
  optionalText,
  requireNonEmpty,
  text,
  unique,
  type Row
} from "./values.js";

export function startActivation(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "StartActivation";
}>, principal: Row, correlationId: string): CommandResult {
  invariants.requireKind(kernel, principal, "runtime");
  if ((command.runId ? 1 : 0) + (command.attentionId ? 1 : 0) !== 1) {
    throw new KernelError("InvalidCommand", "StartActivation requires exactly one Run or Attention cause.");
  }
  let agent: Row;
  let runId: string | null = null;
  let attentionId: string | null = null;
  let attentionLeaseToken: string | null = null;
  let runActivationGeneration: number | null = null;
  let resultRunRevision: number | undefined;
  let configRevision: number;
  let projectId: string;
  let channelId: string;
  let threadRootId: string;
  const durationMs = boundedDuration(command.durationMs ?? kernel.activationDurationMs, "durationMs");
  const now = kernel.clock();
  let expiresAt = new Date(now.getTime() + durationMs).toISOString();
  if (command.runId) {
    if (command.expectedRunRevision === undefined) {
      throw new KernelError("InvalidCommand", "Run Activation requires an expected Run revision.");
    }
    const run = invariants.requireMutableRun(kernel, command.runId, command.expectedRunRevision);
    runId = command.runId;
    agent = invariants.requireAgent(kernel, text(run.owner_agent_id));
    configRevision = integer(run.agent_config_revision);
    projectId = text(run.project_id);
    channelId = text(run.home_channel_id);
    threadRootId = text(run.thread_root_id);
    runActivationGeneration = integer(run.activation_generation) + 1;
    invariants.revokeRunActivations(kernel, command.runId, "superseded_activation", now.toISOString());
    if (text(run.state) === "Waiting") {
      const revision = integer(run.revision) + 1;
      db.run(kernel, `UPDATE runs
              SET state = 'Active',
                  revision = ?,
                  activation_generation = ?,
                  updated_at = ?
            WHERE id = ?`, revision, runActivationGeneration, now.toISOString(), command.runId);
      resultRunRevision = revision;
      invariants.emitThreadEvent(kernel, {
        type: "RunActivated",
        projectId,
        channelId,
        threadRootId,
        entityType: "Run",
        entityId: command.runId,
        actorPrincipalId: text(principal.id),
        activationId: null,
        causationId: command.runId,
        correlationId,
        payload: { revision },
      });
      invariants.enqueueOutbox(kernel, "run.activated", "Run", command.runId, { revision });
    }
    else {
      db.run(kernel, `UPDATE runs
              SET activation_generation = ?, updated_at = ?
            WHERE id = ?`, runActivationGeneration, now.toISOString(), command.runId);
      resultRunRevision = integer(run.revision);
    }
  }
  else {
    const attention = invariants.requireAttention(kernel, command.attentionId!);
    if (text(attention.status) !== "Open") {
      throw new KernelError("Conflict", "The Attention is already resolved.");
    }
    invariants.assertAttentionLease(kernel, attention, command.handlerLeaseToken);
    attentionId = command.attentionId!;
    attentionLeaseToken = command.handlerLeaseToken!;
    const leaseExpiry = new Date(text(attention.handler_lease_expires_at));
    if (leaseExpiry.toISOString() < expiresAt) {
      expiresAt = leaseExpiry.toISOString();
    }
    const existing = db.getRow(kernel, `SELECT id
           FROM activation_attempts
          WHERE attention_id = ? AND attention_lease_token = ?`, attentionId, attentionLeaseToken);
    if (existing) {
      return {
        commandType: command.type,
        entityId: text(existing.id),
        relatedIds: {
          agentId: text(attention.target_agent_id),
          attentionId,
        },
      };
    }
    agent = invariants.requireAgent(kernel, text(attention.target_agent_id));
    configRevision = integer(agent.current_config_revision);
    projectId = text(attention.project_id);
    channelId = text(attention.channel_id);
    threadRootId = text(attention.thread_root_id);
  }
  const activationId = kernel.idFactory("activation");
  db.run(kernel, `INSERT INTO activation_attempts
        (id, agent_id, run_id, attention_id, attention_lease_token,
         run_activation_generation, cause, config_revision, started_at,
         expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, activationId, text(agent.id), runId, attentionId, attentionLeaseToken, runActivationGeneration, runId ? "Run" : "Attention", configRevision, now.toISOString(), expiresAt);
  if (runId) {
    const inputs = db.allRows(kernel, `SELECT id, run_input_sequence
           FROM run_inputs
          WHERE run_id = ?
          ORDER BY run_input_sequence`, runId);
    for (const input of inputs) {
      db.run(kernel, `INSERT INTO activation_run_inputs
            (activation_id, run_input_id, run_input_sequence)
           VALUES (?, ?, ?)`, activationId, text(input.id), integer(input.run_input_sequence));
    }
  }
  invariants.emitEvent(kernel, {
    type: "ActivationStarted",
    projectId,
    channelId,
    threadRootId,
    threadCursor: null,
    entityType: "ActivationAttempt",
    entityId: activationId,
    actorPrincipalId: text(principal.id),
    activationId,
    causationId: runId ?? attentionId,
    correlationId,
    payload: {
      runId,
      attentionId,
      agentId: text(agent.id),
      configRevision,
      runActivationGeneration,
      expiresAt,
    },
  });
  return {
    commandType: command.type,
    entityId: activationId,
    ...(resultRunRevision === undefined
      ? {}
      : { revision: resultRunRevision }),
    relatedIds: {
      agentId: text(agent.id),
      ...(runId ? { runId } : { attentionId: attentionId! }),
    },
  };
}

export function finishActivation(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "FinishActivation";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const activation = invariants.requireActivation(kernel, command.activationId);
  invariants.authorizeActivationActor(kernel, principal, context, activation);
  if (text(principal.kind) === "agent") {
    invariants.assertActivationScopeCurrent(kernel, activation);
  }
  if (activation.finished_at !== null) {
    throw new KernelError("Conflict", "The Activation is already finished.");
  }
  const now = db.now(kernel);
  db.run(kernel, `UPDATE activation_attempts
          SET finished_at = ?, outcome = ?, detail = ?
        WHERE id = ?`, now, command.outcome, command.detail ?? null, command.activationId);
  const scope = invariants.activationScope(kernel, activation);
  invariants.emitEvent(kernel, {
    type: "ActivationFinished",
    ...scope,
    threadCursor: null,
    entityType: "ActivationAttempt",
    entityId: command.activationId,
    actorPrincipalId: text(principal.id),
    activationId: command.activationId,
    causationId: optionalText(activation.run_id) ?? optionalText(activation.attention_id),
    correlationId,
    payload: { outcome: command.outcome },
  });
  return {
    commandType: command.type,
    entityId: command.activationId,
    relatedIds: { outcome: command.outcome },
  };
}

export function startProviderAttempt(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "StartProviderAttempt";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const activation = invariants.requireLiveActivation(kernel, command.activationId);
  invariants.authorizeActivationActor(kernel, principal, context, activation);
  invariants.assertActivationScopeCurrent(kernel, activation);
  const runId = optionalText(activation.run_id);
  const runInputIds = unique(command.runInputIds);
  for (const inputId of runInputIds) {
    const input = db.getRow(kernel, "SELECT run_id, disposition FROM run_inputs WHERE id = ?", inputId);
    if (!input) {
      throw new KernelError("NotFound", `RunInput ${inputId} does not exist.`);
    }
    if (!runId || text(input.run_id) !== runId) {
      throw new KernelError("Forbidden", "Provider input must belong to the Activation Run.");
    }
    if (text(input.disposition) !== "Pending") {
      throw new KernelError("Conflict", "Provider input must still be Pending when delivery starts.");
    }
    const supplied = db.getRow(kernel, `SELECT 1 AS present
           FROM activation_run_inputs
          WHERE activation_id = ? AND run_input_id = ?`, command.activationId, inputId);
    if (!supplied) {
      throw new KernelError("Forbidden", "Provider input was not supplied to this Activation.");
    }
  }
  const providerAttemptId = kernel.idFactory("provider");
  db.run(kernel, `INSERT INTO provider_attempts
        (id, activation_id, run_id, adapter, adapter_version,
         capability_snapshot_json, run_input_ids_json, request_idempotency_key,
         diagnostic_session_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Started', ?)`, providerAttemptId, command.activationId, runId, command.adapter, command.adapterVersion, JSON.stringify(command.capabilitySnapshot), JSON.stringify(runInputIds), command.requestIdempotencyKey, command.diagnosticSessionId ?? null, db.now(kernel));
  const scope = invariants.activationScope(kernel, activation);
  invariants.emitEvent(kernel, {
    type: "ProviderAttemptStarted",
    ...scope,
    threadCursor: null,
    entityType: "ProviderAttempt",
    entityId: providerAttemptId,
    actorPrincipalId: text(principal.id),
    activationId: command.activationId,
    causationId: command.activationId,
    correlationId,
    payload: {
      adapter: command.adapter,
      adapterVersion: command.adapterVersion,
      runInputIds: unique(command.runInputIds),
    },
  });
  return {
    commandType: command.type,
    entityId: providerAttemptId,
    relatedIds: { activationId: command.activationId },
  };
}

export function finishProviderAttempt(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "FinishProviderAttempt";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  if (!["Acknowledged", "Completed", "Unknown"].includes(command.status as string)) {
    throw new KernelError("InvalidCommand", "FinishProviderAttempt status must be Acknowledged, Completed, or Unknown.");
  }
  return setProviderAttemptStatus(kernel, command.providerAttemptId, command.status, command.detail ?? null, command.type, principal, context, correlationId);
}

export function failProviderAttempt(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "FailProviderAttempt";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  return setProviderAttemptStatus(kernel, command.providerAttemptId, "Failed", command.error, command.type, principal, context, correlationId);
}

export function setProviderAttemptStatus(kernel: db.KernelContext, providerAttemptId: string, status: "Acknowledged" | "Completed" | "Failed" | "Unknown", detail: string | null, commandType: "FinishProviderAttempt" | "FailProviderAttempt", principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const attempt = invariants.requireProviderAttempt(kernel, providerAttemptId);
  const activation = invariants.requireActivation(kernel, text(attempt.activation_id));
  if (text(principal.kind) === "agent") {
    if (activation.finished_at !== null) {
      throw new KernelError("Forbidden", "Only runtime reconciliation can settle a ProviderAttempt after its Activation ends.");
    }
    invariants.assertActivationScopeCurrent(kernel, activation);
  }
  invariants.authorizeActivationActor(kernel, principal, context, activation, true);
  if (!["Started", "Acknowledged"].includes(text(attempt.status))) {
    throw new KernelError("Conflict", "The ProviderAttempt is already finished.");
  }
  if (text(attempt.status) === "Acknowledged" && status === "Acknowledged") {
    throw new KernelError("Conflict", "The ProviderAttempt is already acknowledged.");
  }
  if (status === "Unknown") {
    requireNonEmpty(detail ?? "", "Unknown reason");
  }
  const finishedAt = status === "Acknowledged" ? null : db.now(kernel);
  db.run(kernel, `UPDATE provider_attempts
          SET status = ?, detail = ?, finished_at = ?
        WHERE id = ?`, status, detail, finishedAt, providerAttemptId);
  const scope = invariants.activationScope(kernel, activation);
  invariants.emitEvent(kernel, {
    type: status === "Acknowledged"
      ? "ProviderAttemptAcknowledged"
      : "ProviderAttemptFinished",
    ...scope,
    threadCursor: null,
    entityType: "ProviderAttempt",
    entityId: providerAttemptId,
    actorPrincipalId: text(principal.id),
    activationId: text(attempt.activation_id),
    causationId: text(attempt.activation_id),
    correlationId,
    payload: { status, detail },
  });
  return {
    commandType,
    entityId: providerAttemptId,
    relatedIds: { status },
  };
}

export function appendRunActivity(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "AppendRunActivity";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const provenance = validateActivityProvenance(kernel, command.runId, command.activationId, command.providerAttemptId, principal, context);
  const activity = insertActivity(kernel, command.runId, provenance.activationId, command.providerAttemptId ?? null, command.kind, command.payload, command.retentionClass);
  const run = invariants.requireRun(kernel, command.runId);
  invariants.emitEvent(kernel, {
    type: "RunActivityAppended",
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    threadCursor: null,
    entityType: "RunActivityEvent",
    entityId: activity.id,
    actorPrincipalId: text(principal.id),
    activationId: provenance.activationId,
    causationId: command.providerAttemptId ?? provenance.activationId,
    correlationId,
    payload: { runId: command.runId, sequence: activity.sequence, kind: command.kind },
  });
  return {
    commandType: command.type,
    entityId: activity.id,
    revision: activity.sequence,
    relatedIds: { runId: command.runId },
  };
}

export function insertActivity(kernel: db.KernelContext, runId: string, activationId: string, providerAttemptId: string | null, kind: string, payload: JsonValue, retentionClass: "durable" | "transient"): {
  id: string;
  sequence: number;
} {
  requireNonEmpty(kind, "kind");
  const run = invariants.requireRun(kernel, runId);
  const sequence = integer(run.next_activity_sequence);
  const id = kernel.idFactory("activity");
  db.run(kernel, `INSERT INTO run_activity_events
        (id, run_id, activation_id, provider_attempt_id, sequence, kind,
         payload_json, retention_class, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, runId, activationId, providerAttemptId, sequence, kind, JSON.stringify(payload), retentionClass, db.now(kernel));
  db.run(kernel, "UPDATE runs SET next_activity_sequence = ? WHERE id = ?", sequence + 1, runId);
  return { id, sequence };
}

export function validateActivityProvenance(kernel: db.KernelContext, runId: string, activationId: string | undefined, providerAttemptId: string | undefined, principal: Row, context: PrincipalContext, allowFinished = false): {
  activationId: string;
} {
  if (!activationId && !providerAttemptId) {
    throw new KernelError("InvalidCommand", "Run activity requires Activation or ProviderAttempt provenance.");
  }
  let resolvedActivationId = activationId;
  if (providerAttemptId) {
    const providerAttempt = invariants.requireProviderAttempt(kernel, providerAttemptId);
    if (optionalText(providerAttempt.run_id) !== runId) {
      throw new KernelError("Forbidden", "ProviderAttempt belongs to another Run.");
    }
    const providerActivationId = text(providerAttempt.activation_id);
    if (activationId && activationId !== providerActivationId) {
      throw new KernelError("InvalidCommand", "Activity provenance is inconsistent.");
    }
    resolvedActivationId = providerActivationId;
  }
  const activation = allowFinished
    ? invariants.requireActivation(kernel, resolvedActivationId!) : invariants.requireLiveActivation(kernel, resolvedActivationId!);
  if (optionalText(activation.run_id) !== runId) {
    throw new KernelError("Forbidden", "Activation belongs to another Run.");
  }
  invariants.authorizeActivationActor(kernel, principal, context, activation, allowFinished);
  if (!allowFinished) {
    invariants.assertActivationScopeCurrent(kernel, activation);
  }
  return { activationId: resolvedActivationId! };
}
