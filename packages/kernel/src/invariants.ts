import * as db from "./database.js";
import { KernelError } from "./errors.js";
import {
  mapPublicEvent
} from "./mappings.js";
import type {
  JsonValue,
  PrincipalContext,
  RunInputDisposition
} from "./types.js";
import {
  integer,
  isTerminalRunState,
  optionalText,
  requireNonEmpty,
  text,
  type Row
} from "./values.js";

type EventInput = {
  type: string;
  projectId: string;
  channelId: string | null;
  threadRootId: string | null;
  threadCursor: number | null;
  entityType: string;
  entityId: string;
  actorPrincipalId: string;
  activationId: string | null;
  causationId: string | null;
  correlationId: string;
  payload: JsonValue;
};

type ThreadEventInput = Omit<EventInput, "threadRootId" | "threadCursor"> & {
  threadRootId: string;
};

export function requireRunActivation(kernel: db.KernelContext, context: PrincipalContext, principal: Row, run: Row): Row {
  requireKind(kernel, principal, "agent");
  if (!context.activationId) {
    throw new KernelError("Unauthorized", "An authenticated Activation is required.");
  }
  const activation = requireLiveActivation(kernel, context.activationId);
  if (optionalText(activation.run_id) !== text(run.id) ||
    text(activation.agent_id) !== text(run.owner_agent_id)) {
    throw new KernelError("Forbidden", "The Activation does not own this Run.");
  }
  const agent = requireAgentForPrincipal(kernel, text(principal.id));
  if (text(agent.id) !== text(run.owner_agent_id)) {
    throw new KernelError("Forbidden", "The Agent does not own this Run.");
  }
  assertActivationScopeCurrent(kernel, activation);
  return activation;
}

export function authorizeActivationActor(kernel: db.KernelContext, principal: Row, context: PrincipalContext, activation: Row, allowFinished = false): void {
  if (!allowFinished && activation.finished_at !== null) {
    throw new KernelError("Conflict", "The Activation is already finished.");
  }
  if (text(principal.kind) === "runtime") {
    return;
  }
  if (text(principal.kind) !== "agent") {
    throw new KernelError("Forbidden", "This command requires runtime or Agent authority.");
  }
  const agent = requireAgentForPrincipal(kernel, text(principal.id));
  if (text(agent.id) !== text(activation.agent_id)) {
    throw new KernelError("Forbidden", "The Activation belongs to another Agent.");
  }
  if (!context.activationId) {
    throw new KernelError("Unauthorized", "An Agent command requires an authenticated Activation context.");
  }
  if (context.activationId !== text(activation.id)) {
    throw new KernelError("Forbidden", "The capability context belongs to another Activation.");
  }
}

export function requireMutableRun(kernel: db.KernelContext, runId: string, expectedRevision?: number): Row {
  const run = requireRun(kernel, runId);
  if (isTerminalRunState(text(run.state))) {
    throw new KernelError("TerminalRun", `Run ${runId} is terminal and cannot accept this command.`, { state: text(run.state) });
  }
  if (expectedRevision !== undefined) {
    checkRevision(kernel, integer(run.revision), expectedRevision, "Run");
  }
  return run;
}

export function assertAttentionLease(kernel: db.KernelContext, attention: Row, leaseToken?: string): void {
  if (!leaseToken || optionalText(attention.handler_lease_token) !== leaseToken) {
    throw new KernelError("Forbidden", "A valid Attention handler lease is required.");
  }
  const expiresAt = optionalText(attention.handler_lease_expires_at);
  if (!expiresAt || new Date(expiresAt) <= kernel.clock()) {
    throw new KernelError("Conflict", "The Attention handler lease has expired.");
  }
}

export function checkThreadCursor(kernel: db.KernelContext, thread: Row, expected?: number): void {
  if (expected !== undefined && integer(thread.cursor) !== expected) {
    const events = db.allRows(kernel, `SELECT * FROM public_events
          WHERE thread_root_id = ? AND thread_cursor > ?
          ORDER BY thread_cursor`, text(thread.root_message_id), expected).map(mapPublicEvent);
    throw new KernelError("ConditionalCheckFailed", "The Thread changed after the observed cursor.", {
      currentCursor: integer(thread.cursor),
      events: JSON.parse(JSON.stringify(events)) as JsonValue,
    });
  }
}

export function checkRevision(kernel: db.KernelContext, actual: number, expected: number, entity: string): void {
  if (actual !== expected) {
    throw new KernelError("StaleRevision", `${entity} revision ${expected} is stale; current revision is ${actual}.`, { expectedRevision: expected, actualRevision: actual });
  }
}

export function emitThreadEvent(kernel: db.KernelContext, event: ThreadEventInput): number {
  const cursor = threadCursor(kernel, event.threadRootId) + 1;
  db.run(kernel, "UPDATE threads SET cursor = ? WHERE root_message_id = ?", cursor, event.threadRootId);
  emitEvent(kernel, { ...event, threadCursor: cursor });
  return cursor;
}

export function emitEvent(kernel: db.KernelContext, event: EventInput): number {
  const result = kernel.database.prepare(`INSERT INTO public_events
        (event_id, type, project_id, channel_id, thread_root_id, thread_cursor,
         entity_type, entity_id, actor_principal_id, activation_id,
         causation_id, correlation_id, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(kernel.idFactory("event"), event.type, event.projectId, event.channelId, event.threadRootId, event.threadCursor, event.entityType, event.entityId, event.actorPrincipalId, event.activationId, event.causationId, event.correlationId, JSON.stringify(event.payload), db.now(kernel));
  return Number(result.lastInsertRowid);
}

export function recordAttentionHistory(kernel: db.KernelContext, attentionId: string, eventSequence: number): void {
  db.run(kernel, `INSERT INTO attention_history
        (attention_id, event_sequence, status, revision,
         handler_lease_holder_principal_id, handler_lease_expires_at,
         resolved_run_id, resolved_at)
       SELECT id, ?, status, revision, handler_lease_holder_principal_id,
              handler_lease_expires_at, resolved_run_id, resolved_at
         FROM attentions
        WHERE id = ?`, eventSequence, attentionId);
}

export function enqueueOutbox(kernel: db.KernelContext, topic: string, aggregateType: string, aggregateId: string, payload: JsonValue): void {
  db.run(kernel, `INSERT INTO outbox_events
        (id, topic, aggregate_type, aggregate_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`, kernel.idFactory("outbox"), topic, aggregateType, aggregateId, JSON.stringify(payload), db.now(kernel));
}

export function assertProjectChannel(kernel: db.KernelContext, projectId: string, channelId: string): void {
  const channel = db.getRow(kernel, "SELECT project_id FROM channels WHERE id = ?", channelId);
  if (!channel) {
    throw new KernelError("NotFound", `Channel ${channelId} does not exist.`);
  }
  if (text(channel.project_id) !== projectId) {
    throw new KernelError("Forbidden", "The Channel does not belong to the Project.");
  }
}

export function assertProjectAccess(kernel: db.KernelContext, principal: Row, projectId: string): void {
  if (text(principal.kind) !== "agent") {
    return;
  }
  const agent = requireAgentForPrincipal(kernel, text(principal.id));
  if (text(agent.project_id) !== projectId) {
    throw new KernelError("Forbidden", "The Agent cannot access this Project.");
  }
}

export function assertAgentQueryScope(kernel: db.KernelContext, principal: Row, context: PrincipalContext, projectId: string, threadRootId: string, runId?: string): void {
  if (text(principal.kind) !== "agent") {
    return;
  }
  if (!context.activationId) {
    throw new KernelError("Unauthorized", "An Agent query requires an authenticated Activation context.");
  }
  const agent = requireAgentForPrincipal(kernel, text(principal.id));
  const activation = requireLiveActivation(kernel, context.activationId);
  if (text(activation.agent_id) !== text(agent.id)) {
    throw new KernelError("Forbidden", "The Activation belongs to another Agent.");
  }
  assertActivationScopeCurrent(kernel, activation);
  const activationRunId = optionalText(activation.run_id);
  if (runId && activationRunId !== runId) {
    throw new KernelError("Forbidden", "The Activation cannot read this Run.");
  }
  if (activationRunId) {
    const run = requireRun(kernel, activationRunId);
    if (text(run.project_id) !== projectId ||
      text(run.thread_root_id) !== threadRootId) {
      throw new KernelError("Forbidden", "The Activation cannot read this Thread.");
    }
    return;
  }
  const attention = requireAttention(kernel, text(activation.attention_id));
  if (text(attention.project_id) !== projectId ||
    text(attention.thread_root_id) !== threadRootId) {
    throw new KernelError("Forbidden", "The Activation cannot read this Thread.");
  }
}

export function assertActivationScopeCurrent(kernel: db.KernelContext, activation: Row): void {
  if (activation.revoked_at !== null) {
    throw new KernelError("Conflict", `The Activation was revoked: ${optionalText(activation.revocation_reason) ?? "unspecified"}.`);
  }
  if (new Date(text(activation.expires_at)) <= kernel.clock()) {
    throw new KernelError("Conflict", "The Activation has expired.");
  }
  const runId = optionalText(activation.run_id);
  if (runId) {
    const run = requireRun(kernel, runId);
    if (text(run.state) !== "Active") {
      throw new KernelError(isTerminalRunState(text(run.state))
        ? "TerminalRun"
        : "Conflict", "Execution side effects require an Active Run.", { state: text(run.state) });
    }
    if (integer(activation.run_activation_generation) !==
      integer(run.activation_generation)) {
      throw new KernelError("Conflict", "The Activation was superseded by a newer Run activation generation.");
    }
    return;
  }
  const attention = requireAttention(kernel, text(activation.attention_id));
  if (text(attention.status) !== "Open") {
    throw new KernelError("Conflict", "The Activation scope ended when its Attention was resolved.");
  }
  if (optionalText(attention.handler_lease_token) !==
    optionalText(activation.attention_lease_token) ||
    !optionalText(attention.handler_lease_expires_at) ||
    new Date(text(attention.handler_lease_expires_at)) <= kernel.clock()) {
    throw new KernelError("Conflict", "The Activation scope ended when its Attention handler lease expired or changed.");
  }
}

export function isCurrentRunActivation(kernel: db.KernelContext, activation: Row, run: Row): boolean {
  return (optionalText(activation.run_id) === text(run.id) &&
    activation.finished_at === null &&
    activation.revoked_at === null &&
    new Date(text(activation.expires_at)) > kernel.clock() &&
    text(run.state) === "Active" &&
    integer(activation.run_activation_generation) ===
    integer(run.activation_generation));
}

export function revokeRunActivations(kernel: db.KernelContext, runId: string, reason: string, revokedAt: string): void {
  db.run(kernel, `UPDATE activation_attempts
          SET revoked_at = COALESCE(revoked_at, ?),
              revocation_reason = COALESCE(revocation_reason, ?)
        WHERE run_id = ? AND finished_at IS NULL AND revoked_at IS NULL`, revokedAt, reason, runId);
}

export function activationScope(kernel: db.KernelContext, activation: Row): {
  projectId: string;
  channelId: string;
  threadRootId: string;
} {
  const runId = optionalText(activation.run_id);
  if (runId) {
    const run = requireRun(kernel, runId);
    return {
      projectId: text(run.project_id),
      channelId: text(run.home_channel_id),
      threadRootId: text(run.thread_root_id),
    };
  }
  const attention = requireAttention(kernel, text(activation.attention_id));
  return {
    projectId: text(attention.project_id),
    channelId: text(attention.channel_id),
    threadRootId: text(attention.thread_root_id),
  };
}

export function resolveAttentionSnapshot(kernel: db.KernelContext, snapshotEventId: string | null | undefined): {
  sequence: number;
  eventId: string | null;
} {
  if (snapshotEventId === null) {
    return { sequence: 0, eventId: null };
  }
  if (snapshotEventId !== undefined) {
    return {
      sequence: eventSequence(kernel, snapshotEventId),
      eventId: snapshotEventId,
    };
  }
  const latest = db.getRow(kernel, "SELECT sequence, event_id FROM public_events ORDER BY sequence DESC LIMIT 1");
  return latest
    ? {
      sequence: integer(latest.sequence),
      eventId: text(latest.event_id),
    }
    : { sequence: 0, eventId: null };
}

export function eventSequence(kernel: db.KernelContext, eventId: string): number {
  const row = db.getRow(kernel, "SELECT sequence FROM public_events WHERE event_id = ?", eventId);
  if (!row) {
    throw new KernelError("NotFound", `Event ${eventId} does not exist.`);
  }
  return integer(row.sequence);
}

export function threadCursor(kernel: db.KernelContext, threadRootId: string): number {
  return integer(requireThread(kernel, threadRootId).cursor);
}

export function requirePrincipal(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM principals WHERE id = ?", id);
  if (!row) {
    throw new KernelError("Unauthorized", "The principal is not authenticated.");
  }
  return row;
}

export function requireKind(kernel: db.KernelContext, principal: Row, kind: "human" | "agent" | "runtime"): void {
  if (text(principal.kind) !== kind) {
    throw new KernelError("Forbidden", `This command requires a ${kind} principal.`);
  }
}

export function requireAgent(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM agents WHERE id = ?", id);
  if (!row) {
    throw new KernelError("NotFound", `Agent ${id} does not exist.`);
  }
  return row;
}

export function requireAgentForPrincipal(kernel: db.KernelContext, principalId: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM agents WHERE principal_id = ?", principalId);
  if (!row) {
    throw new KernelError("Forbidden", "The principal is not an Agent.");
  }
  return row;
}

export function requireThread(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM threads WHERE root_message_id = ?", id);
  if (!row) {
    throw new KernelError("NotFound", `Thread ${id} does not exist.`);
  }
  return row;
}

export function requireAttention(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM attentions WHERE id = ?", id);
  if (!row) {
    throw new KernelError("NotFound", `Attention ${id} does not exist.`);
  }
  return row;
}

export function requireRun(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM runs WHERE id = ?", id);
  if (!row) {
    throw new KernelError("NotFound", `Run ${id} does not exist.`);
  }
  return row;
}

export function requireRunInput(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM run_inputs WHERE id = ?", id);
  if (!row) {
    throw new KernelError("NotFound", `RunInput ${id} does not exist.`);
  }
  return row;
}

export function requireActivation(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM activation_attempts WHERE id = ?", id);
  if (!row) {
    throw new KernelError("NotFound", `Activation ${id} does not exist.`);
  }
  return row;
}

export function requireLiveActivation(kernel: db.KernelContext, id: string): Row {
  const activation = requireActivation(kernel, id);
  if (activation.finished_at !== null) {
    throw new KernelError("Conflict", "The Activation is already finished.");
  }
  return activation;
}

export function requireProviderAttempt(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM provider_attempts WHERE id = ?", id);
  if (!row) {
    throw new KernelError("NotFound", `ProviderAttempt ${id} does not exist.`);
  }
  return row;
}

export function requireOutboxEvent(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM outbox_events WHERE id = ?", id);
  if (!row) {
    throw new KernelError("NotFound", `OutboxEvent ${id} does not exist.`);
  }
  return row;
}

export function validateDisposition(kernel: db.KernelContext, disposition: RunInputDisposition, reason: string): void {
  if (disposition === "Pending" ||
    disposition === "Incorporated" ||
    disposition === "Withdrawn") {
    throw new KernelError("InvalidCommand", "The completion exception disposition is invalid.");
  }
  requireNonEmpty(reason, "exception reason");
}
