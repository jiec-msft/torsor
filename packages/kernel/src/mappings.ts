import type {
  ActivationAttemptView,
  ArtifactView,
  AttentionView,
  BootstrapAgent,
  BootstrapChannel,
  BootstrapProject,
  MessageRevisionView,
  MessageView,
  OutboxEventView,
  ProviderAttemptView,
  PublicEventEnvelope,
  RunActivityEventView,
  RunInputDisposition,
  RunInputView,
  RunState,
  RunView,
  WorktreeWriterLeaseEventView,
  WorktreeWriterLeaseView,
} from "./types.js";
import {
  integer,
  optionalText,
  parseJson,
  parseStringArray,
  text,
  type Row,
} from "./values.js";

export function mapProject(row: Row): BootstrapProject {
  return { id: text(row.id), name: text(row.name) };
}

export function mapChannel(row: Row): BootstrapChannel {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    name: text(row.name),
  };
}

export function mapAgent(row: Row): BootstrapAgent {
  return {
    id: text(row.id),
    principalId: text(row.principal_id),
    projectId: text(row.project_id),
    name: text(row.name),
    configRevision: integer(row.current_config_revision),
    config: parseJson(row.config_json),
  };
}

export function mapMessageRevision(
  row: Row,
  targetAgentIds: readonly string[],
): MessageRevisionView {
  return {
    id: text(row.id),
    revision: integer(row.revision),
    body: text(row.body),
    tombstone: integer(row.tombstone) === 1,
    targetAgentIds,
    createdAt: text(row.created_at),
  };
}

export function mapMessage(
  row: Row,
  revisions: readonly MessageRevisionView[],
  targetAgentIds: readonly string[],
): MessageView {
  return {
    id: text(row.id),
    threadRootId: text(row.thread_root_id),
    replyToMessageId: optionalText(row.reply_to_message_id),
    authorPrincipalId: text(row.author_principal_id),
    authorAgentId: optionalText(row.author_agent_id),
    causedByAttentionId: optionalText(row.caused_by_attention_id),
    causedByRunId: optionalText(row.caused_by_run_id),
    threadCursor: integer(row.thread_sequence),
    latestRevision: integer(row.latest_revision),
    revisions,
    targetAgentIds,
    createdAt: text(row.created_at),
  };
}

export function mapAttention(row: Row): AttentionView {
  return {
    cursor: integer(row.sequence),
    id: text(row.id),
    projectId: text(row.project_id),
    channelId: text(row.channel_id),
    threadRootId: text(row.thread_root_id),
    messageRevisionId: text(row.message_revision_id),
    targetAgentId: text(row.target_agent_id),
    triggerKind: text(row.trigger_kind),
    status: text(row.status) as AttentionView["status"],
    revision: integer(row.revision),
    handlerLeaseHolderPrincipalId: optionalText(
      row.handler_lease_holder_principal_id,
    ),
    handlerLeaseExpiresAt: optionalText(row.handler_lease_expires_at),
    resolutionOutcome:
      optionalText(row.resolution_outcome) as AttentionView["resolutionOutcome"],
    resolvedRunId: optionalText(row.resolved_run_id),
    createdAt: text(row.created_at),
    resolvedAt: optionalText(row.resolved_at),
  };
}

export function mapRun(row: Row): RunView {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    homeChannelId: text(row.home_channel_id),
    threadRootId: text(row.thread_root_id),
    ownerAgentId: text(row.owner_agent_id),
    agentConfigRevision: integer(row.agent_config_revision),
    causalRootId: text(row.causal_root_id),
    parentAttentionId: text(row.parent_attention_id),
    parentRunId: optionalText(row.parent_run_id),
    delegationDepth: integer(row.delegation_depth),
    state: text(row.state) as RunState,
    revision: integer(row.revision),
    activationGeneration: integer(row.activation_generation),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    terminalReason: optionalText(row.terminal_reason),
  };
}

export function mapRunInput(row: Row): RunInputView {
  return {
    id: text(row.id),
    runId: text(row.run_id),
    messageRevisionId: text(row.message_revision_id),
    sequence: integer(row.run_input_sequence),
    assignedByPrincipalId: text(row.assigned_by_principal_id),
    assignedByActivationId: optionalText(row.assigned_by_activation_id),
    sourceAttentionId: optionalText(row.source_attention_id),
    disposition: text(row.disposition) as RunInputDisposition,
    dispositionRevision: integer(row.disposition_revision),
    dispositionReason: optionalText(row.disposition_reason),
    supersededByRunInputId: optionalText(row.superseded_by_run_input_id),
    createdAt: text(row.created_at),
  };
}

export function mapActivation(
  row: Row,
  runInputIds: readonly string[],
): ActivationAttemptView {
  return {
    id: text(row.id),
    agentId: text(row.agent_id),
    runId: optionalText(row.run_id),
    attentionId: optionalText(row.attention_id),
    configRevision: integer(row.config_revision),
    runActivationGeneration:
      row.run_activation_generation === null
        ? null
        : integer(row.run_activation_generation),
    runInputIds,
    startedAt: text(row.started_at),
    expiresAt: text(row.expires_at),
    revokedAt: optionalText(row.revoked_at),
    revocationReason: optionalText(row.revocation_reason),
    finishedAt: optionalText(row.finished_at),
    outcome:
      row.outcome === null
        ? null
        : (text(row.outcome) as ActivationAttemptView["outcome"]),
    detail: optionalText(row.detail),
  };
}

export function mapProviderAttempt(row: Row): ProviderAttemptView {
  return {
    id: text(row.id),
    activationId: text(row.activation_id),
    runId: optionalText(row.run_id),
    adapter: text(row.adapter),
    adapterVersion: text(row.adapter_version),
    capabilitySnapshot: parseJson(row.capability_snapshot_json),
    runInputIds: parseStringArray(row.run_input_ids_json),
    requestIdempotencyKey: text(row.request_idempotency_key),
    status: text(row.status) as ProviderAttemptView["status"],
    detail: optionalText(row.detail),
    startedAt: text(row.started_at),
    finishedAt: optionalText(row.finished_at),
  };
}

export function mapActivity(row: Row): RunActivityEventView {
  return {
    id: text(row.id),
    runId: text(row.run_id),
    activationId: optionalText(row.activation_id),
    providerAttemptId: optionalText(row.provider_attempt_id),
    sequence: integer(row.sequence),
    kind: text(row.kind),
    payload: parseJson(row.payload_json),
    retentionClass: text(
      row.retention_class,
    ) as RunActivityEventView["retentionClass"],
    createdAt: text(row.created_at),
  };
}

export function mapOutboxEvent(row: Row): OutboxEventView {
  return {
    cursor: integer(row.sequence),
    id: text(row.id),
    topic: text(row.topic),
    aggregateType: text(row.aggregate_type),
    aggregateId: text(row.aggregate_id),
    payload: parseJson(row.payload_json),
    deliveryAttempts: integer(row.delivery_attempts),
    leaseHolderPrincipalId: optionalText(row.lease_holder_principal_id),
    leaseExpiresAt: optionalText(row.lease_expires_at),
    acknowledgedAt: optionalText(row.acknowledged_at),
    createdAt: text(row.created_at),
  };
}

export function mapArtifact(row: Row): ArtifactView {
  return {
    id: text(row.id),
    contentDigest: text(row.content_digest),
    producerRunId: text(row.producer_run_id),
    producerActivationId: text(row.producer_activation_id),
    producerThreadRootId: text(row.producer_thread_root_id),
    baseRevision: text(row.base_revision),
    mediaType: text(row.media_type),
    byteLength: integer(row.byte_length),
    visibilityChannelId: text(row.visibility_channel_id),
    metadata: row.metadata_json === null ? null : parseJson(row.metadata_json),
    createdAt: text(row.created_at),
  };
}

export function mapPublicEvent(row: Row): PublicEventEnvelope {
  return {
    eventId: text(row.event_id),
    type: text(row.type),
    projectId: text(row.project_id),
    channelId: optionalText(row.channel_id),
    threadRootId: optionalText(row.thread_root_id),
    threadCursor:
      row.thread_cursor === null ? null : integer(row.thread_cursor),
    entityType: text(row.entity_type),
    entityId: text(row.entity_id),
    actorPrincipalId: text(row.actor_principal_id),
    activationId: optionalText(row.activation_id),
    causationId: optionalText(row.causation_id),
    correlationId: text(row.correlation_id),
    payload: parseJson(row.payload_json),
    occurredAt: text(row.occurred_at),
  };
}

export function mapWorktreeWriterLease(row: Row): WorktreeWriterLeaseView {
  return {
    worktreeId: text(row.worktree_id),
    revision: integer(row.revision),
    generation: integer(row.generation),
    fencingToken: integer(row.fencing_token),
    status: text(row.status) as WorktreeWriterLeaseView["status"],
    holderPrincipalId: optionalText(row.holder_principal_id),
    acquiredAt: optionalText(row.acquired_at),
    renewedAt: optionalText(row.renewed_at),
    expiresAt: optionalText(row.expires_at),
    releasedAt: optionalText(row.released_at),
    quarantineReason: optionalText(row.quarantine_reason),
    quarantineEvidence:
      row.quarantine_evidence_json === null
        ? null
        : parseJson(row.quarantine_evidence_json),
    quarantinedAt: optionalText(row.quarantined_at),
    quarantineResolvedAt: optionalText(row.quarantine_resolved_at),
    quarantineResolution: optionalText(row.quarantine_resolution),
    updatedAt: text(row.updated_at),
  };
}

export function mapWorktreeWriterLeaseEvent(
  row: Row,
): WorktreeWriterLeaseEventView {
  return {
    cursor: integer(row.sequence),
    id: text(row.id),
    worktreeId: text(row.worktree_id),
    type: text(row.type) as WorktreeWriterLeaseEventView["type"],
    revision: integer(row.revision),
    generation: integer(row.generation),
    fencingToken: integer(row.fencing_token),
    actorPrincipalId: text(row.actor_principal_id),
    holderPrincipalId: optionalText(row.holder_principal_id),
    expiresAt: optionalText(row.expires_at),
    reason: optionalText(row.reason),
    evidence:
      row.evidence_json === null ? null : parseJson(row.evidence_json),
    correlationId: text(row.correlation_id),
    occurredAt: text(row.occurred_at),
  };
}
