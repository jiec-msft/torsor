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

type ActivationScopeState =
  | Readonly<{ kind: "Run"; run: Row }>
  | Readonly<{ kind: "Attention"; attention: Row }>;

export type PrincipalReadScope = Readonly<{
  projectId: string;
  channelId: string | null;
  threadRootId: string | null;
  runId: string | null;
}>;

type ActivationValidity =
  | Readonly<{ live: true }>
  | Readonly<{
      live: false;
      reason:
        | "finished"
        | "revoked"
        | "expired"
        | "wrong_agent"
        | "run_not_active"
        | "stale_run_generation"
        | "attention_not_open"
        | "attention_lease_stale";
    }>;

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

export function claimAttentionDomain(
  kernel: db.KernelContext,
  attention: Row,
  leaseToken: string,
  leaseExpiresAt: string,
  at: Date,
): void {
  const domain = {
    agentId: text(attention.target_agent_id),
    projectId: text(attention.project_id),
    channelId: text(attention.channel_id),
    threadRootId: text(attention.thread_root_id),
  };
  const existing = db.getRow(
    kernel,
    `SELECT *
       FROM attention_domain_fences
      WHERE agent_id = ?
        AND project_id = ?
        AND channel_id = ?
        AND thread_root_id = ?`,
    domain.agentId,
    domain.projectId,
    domain.channelId,
    domain.threadRootId,
  );
  if (existing) {
    const existingExpiry = optionalText(existing.lease_expires_at);
    const hasLiveLease =
      existingExpiry !== null && new Date(existingExpiry) > at;
    const hasUnsettledProvider =
      integer(existing.unsettled_provider_attempt_count) > 0;
    if (hasLiveLease || hasUnsettledProvider) {
      throw new KernelError(
        "DomainBusy",
        "The Agent, Project, Channel, and Thread execution domain is busy.",
        {
          attentionId: text(existing.attention_id),
          hasLiveHandlerLease: hasLiveLease,
          hasUnsettledProviderAttempt: hasUnsettledProvider,
        },
      );
    }
    db.run(
      kernel,
      `UPDATE attention_domain_fences
          SET attention_id = ?,
              lease_token = ?,
              lease_expires_at = ?,
              unsettled_provider_attempt_count = 0
        WHERE agent_id = ?
          AND project_id = ?
          AND channel_id = ?
          AND thread_root_id = ?`,
      text(attention.id),
      leaseToken,
      leaseExpiresAt,
      domain.agentId,
      domain.projectId,
      domain.channelId,
      domain.threadRootId,
    );
    return;
  }
  db.run(
    kernel,
    `INSERT INTO attention_domain_fences
      (agent_id, project_id, channel_id, thread_root_id, attention_id,
       lease_token, lease_expires_at, unsettled_provider_attempt_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    domain.agentId,
    domain.projectId,
    domain.channelId,
    domain.threadRootId,
    text(attention.id),
    leaseToken,
    leaseExpiresAt,
  );
}

export function releaseAttentionDomainLease(
  kernel: db.KernelContext,
  attentionId: string,
): void {
  db.run(
    kernel,
    `UPDATE attention_domain_fences
        SET lease_token = NULL,
            lease_expires_at = NULL
      WHERE attention_id = ?`,
    attentionId,
  );
  db.run(
    kernel,
    `DELETE FROM attention_domain_fences
      WHERE attention_id = ?
        AND unsettled_provider_attempt_count = 0`,
    attentionId,
  );
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
         resolution_outcome, resolved_run_id, resolved_at)
       SELECT id, ?, status, revision, handler_lease_holder_principal_id,
              handler_lease_expires_at, resolution_outcome, resolved_run_id,
              resolved_at
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
  const scope = resolvePrincipalReadScope(
    kernel,
    principal,
    context,
    projectId,
  );
  if (scope.threadRootId === null) {
    return;
  }
  if (runId && scope.runId !== runId) {
    throw new KernelError("Forbidden", "The Activation cannot read this Run.");
  }
  if (scope.threadRootId !== threadRootId) {
    throw new KernelError("Forbidden", "The Activation cannot read this Thread.");
  }
}

export function resolvePrincipalReadScope(
  kernel: db.KernelContext,
  principal: Row,
  context: PrincipalContext,
  projectId: string,
): PrincipalReadScope {
  requireProject(kernel, projectId);
  assertProjectAccess(kernel, principal, projectId);
  if (text(principal.kind) !== "agent") {
    return {
      projectId,
      channelId: null,
      threadRootId: null,
      runId: null,
    };
  }
  if (!context.activationId) {
    throw new KernelError(
      "Unauthorized",
      "An Agent query requires an authenticated Activation context.",
    );
  }
  const agent = requireAgentForPrincipal(kernel, text(principal.id));
  const activation = requireLiveActivation(kernel, context.activationId);
  if (text(activation.agent_id) !== text(agent.id)) {
    throw new KernelError(
      "Forbidden",
      "The Activation belongs to another Agent.",
    );
  }
  assertActivationScopeCurrent(kernel, activation);
  const scope = activationScope(kernel, activation);
  if (scope.projectId !== projectId) {
    throw new KernelError("Forbidden", "The Activation cannot read this Project.");
  }
  return {
    ...scope,
    runId: optionalText(activation.run_id),
  };
}

export function assertActivationScopeCurrent(kernel: db.KernelContext, activation: Row): void {
  const scope = loadActivationScopeState(kernel, activation);
  const validity = activationValidityAt(activation, scope, kernel.clock());
  if (validity.live) {
    return;
  }
  switch (validity.reason) {
    case "finished":
      throw new KernelError("Conflict", "The Activation is already finished.");
    case "revoked":
      throw new KernelError(
        "Conflict",
        `The Activation was revoked: ${optionalText(activation.revocation_reason) ?? "unspecified"}.`,
      );
    case "expired":
      throw new KernelError("Conflict", "The Activation has expired.");
    case "wrong_agent":
      throw new KernelError(
        "Conflict",
        "The Activation Agent no longer matches its Run or Attention scope.",
      );
    case "run_not_active": {
      const run = (scope as Extract<ActivationScopeState, { kind: "Run" }>).run;
      throw new KernelError(
        isTerminalRunState(text(run.state)) ? "TerminalRun" : "Conflict",
        "Execution side effects require an Active Run.",
        { state: text(run.state) },
      );
    }
    case "stale_run_generation":
      throw new KernelError(
        "Conflict",
        "The Activation was superseded by a newer Run activation generation.",
      );
    case "attention_not_open":
      throw new KernelError(
        "Conflict",
        "The Activation scope ended when its Attention was resolved.",
      );
    case "attention_lease_stale":
      throw new KernelError(
        "Conflict",
        "The Activation scope ended when its Attention handler lease expired or changed.",
      );
  }
}

export function isCurrentRunActivation(kernel: db.KernelContext, activation: Row, run: Row): boolean {
  return optionalText(activation.run_id) === text(run.id) &&
    activationValidityAt(
      activation,
      { kind: "Run", run },
      kernel.clock(),
    ).live;
}

export function isActivationLiveAt(
  activation: Row,
  scope: Readonly<{
    runState: string | null;
    runActivationGeneration: number | null;
    scopeAgentId: string | null;
    attentionStatus: string | null;
    attentionLeaseToken: string | null;
    attentionLeaseExpiresAt: string | null;
  }>,
  at: Date,
): boolean {
  const activationScopeState: ActivationScopeState =
    optionalText(activation.run_id) !== null
      ? {
          kind: "Run",
          run: {
            state: scope.runState,
            activation_generation: scope.runActivationGeneration,
            owner_agent_id: scope.scopeAgentId,
          },
        }
      : {
          kind: "Attention",
          attention: {
            status: scope.attentionStatus,
            target_agent_id: scope.scopeAgentId,
            handler_lease_token: scope.attentionLeaseToken,
            handler_lease_expires_at: scope.attentionLeaseExpiresAt,
          },
        };
  return activationValidityAt(activation, activationScopeState, at).live;
}

export function liveRunActivationPredicate(
  activationAlias: string,
  runAlias: string,
): string {
  return `${activationAlias}.cause = 'Run'
        AND ${activationAlias}.finished_at IS NULL
        AND ${activationAlias}.revoked_at IS NULL
        AND ${activationAlias}.expires_at > ?
        AND ${runAlias}.state = 'Active'
        AND ${activationAlias}.run_activation_generation = ${runAlias}.activation_generation
        AND ${activationAlias}.agent_id = ${runAlias}.owner_agent_id`;
}

export function liveAttentionActivationPredicate(
  activationAlias: string,
  attentionAlias: string,
): string {
  return `${activationAlias}.cause = 'Attention'
        AND ${activationAlias}.finished_at IS NULL
        AND ${activationAlias}.revoked_at IS NULL
        AND ${activationAlias}.expires_at > ?
        AND ${attentionAlias}.status = 'Open'
        AND ${attentionAlias}.handler_lease_token = ${activationAlias}.attention_lease_token
        AND ${attentionAlias}.handler_lease_expires_at IS NOT NULL
        AND ${attentionAlias}.handler_lease_expires_at > ?
        AND ${activationAlias}.agent_id = ${attentionAlias}.target_agent_id`;
}

export function revokeRunActivations(kernel: db.KernelContext, runId: string, reason: string, revokedAt: string): void {
  const changed = db.allRows(kernel, `UPDATE activation_attempts
          SET revoked_at = COALESCE(revoked_at, ?),
              revocation_reason = COALESCE(revocation_reason, ?)
        WHERE run_id = ? AND finished_at IS NULL AND revoked_at IS NULL
        RETURNING id`, revokedAt, reason, runId);
  markActivationChanges(
    kernel,
    changed.map((row) => text(row.id)),
  );
}

export function markActivationChanges(
  kernel: db.KernelContext,
  activationIds: readonly string[],
): void {
  for (const activationId of activationIds) {
    db.run(
      kernel,
      `INSERT OR IGNORE INTO projection_activation_changes (activation_id)
       VALUES (?)`,
      activationId,
    );
  }
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

export function resolvePublicSnapshot(
  kernel: db.KernelContext,
  projectId: string,
  snapshotEventId: string | null | undefined,
): {
  sequence: number;
  eventId: string | null;
} {
  if (snapshotEventId === null) {
    return { sequence: 0, eventId: null };
  }
  if (snapshotEventId !== undefined) {
    const event = db.getRow(
      kernel,
      `SELECT correlation_id
         FROM public_events
        WHERE project_id = ? AND event_id = ?`,
      projectId,
      snapshotEventId,
    );
    if (!event) {
      throw invalidProjectEventCursor();
    }
    const boundary = db.getRow(
      kernel,
      `SELECT sequence, event_id
         FROM public_events
        WHERE project_id = ? AND correlation_id = ?
        ORDER BY sequence DESC
        LIMIT 1`,
      projectId,
      text(event.correlation_id),
    );
    if (!boundary) {
      throw new Error("Stored event correlation has no command boundary.");
    }
    return {
      sequence: integer(boundary.sequence),
      eventId: text(boundary.event_id),
    };
  }
  const latest = db.getRow(
    kernel,
    `SELECT sequence, event_id
       FROM public_events
      WHERE project_id = ?
      ORDER BY sequence DESC
      LIMIT 1`,
    projectId,
  );
  return latest
    ? {
      sequence: integer(latest.sequence),
      eventId: text(latest.event_id),
    }
    : { sequence: 0, eventId: null };
}

export function resolveAttentionSnapshot(kernel: db.KernelContext, snapshotEventId: string | null | undefined): {
  sequence: number;
  eventId: string | null;
} {
  if (snapshotEventId === null) {
    return { sequence: 0, eventId: null };
  }
  if (snapshotEventId !== undefined) {
    const event = db.getRow(
      kernel,
      "SELECT correlation_id FROM public_events WHERE event_id = ?",
      snapshotEventId,
    );
    if (!event) {
      throw new KernelError(
        "NotFound",
        `Event ${snapshotEventId} does not exist.`,
      );
    }
    const boundary = db.getRow(
      kernel,
      `SELECT sequence, event_id
         FROM public_events
        WHERE correlation_id = ?
        ORDER BY sequence DESC
        LIMIT 1`,
      text(event.correlation_id),
    );
    if (!boundary) {
      throw new Error("Stored event correlation has no command boundary.");
    }
    return {
      sequence: integer(boundary.sequence),
      eventId: text(boundary.event_id),
    };
  }
  const latest = db.getRow(
    kernel,
    "SELECT sequence, event_id FROM public_events ORDER BY sequence DESC LIMIT 1",
  );
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

export function projectEventSequence(
  kernel: db.KernelContext,
  projectId: string,
  eventId: string,
): number {
  const row = db.getRow(
    kernel,
    `SELECT sequence
       FROM public_events
      WHERE project_id = ? AND event_id = ?`,
    projectId,
    eventId,
  );
  if (!row) {
    throw invalidProjectEventCursor();
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

export function requireProject(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM projects WHERE id = ?", id);
  if (!row) {
    throw new KernelError("NotFound", `Project ${id} does not exist.`);
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

function loadActivationScopeState(
  kernel: db.KernelContext,
  activation: Row,
): ActivationScopeState {
  const runId = optionalText(activation.run_id);
  return runId
    ? { kind: "Run", run: requireRun(kernel, runId) }
    : {
        kind: "Attention",
        attention: requireAttention(kernel, text(activation.attention_id)),
      };
}

function activationValidityAt(
  activation: Row,
  scope: ActivationScopeState,
  at: Date,
): ActivationValidity {
  if (activation.finished_at !== null) {
    return { live: false, reason: "finished" };
  }
  if (activation.revoked_at !== null) {
    return { live: false, reason: "revoked" };
  }
  if (new Date(text(activation.expires_at)) <= at) {
    return { live: false, reason: "expired" };
  }
  if (scope.kind === "Run") {
    if (text(activation.agent_id) !== text(scope.run.owner_agent_id)) {
      return { live: false, reason: "wrong_agent" };
    }
    if (text(scope.run.state) !== "Active") {
      return { live: false, reason: "run_not_active" };
    }
    if (
      integer(activation.run_activation_generation) !==
      integer(scope.run.activation_generation)
    ) {
      return { live: false, reason: "stale_run_generation" };
    }
    return { live: true };
  }
  if (
    text(activation.agent_id) !== text(scope.attention.target_agent_id)
  ) {
    return { live: false, reason: "wrong_agent" };
  }
  if (text(scope.attention.status) !== "Open") {
    return { live: false, reason: "attention_not_open" };
  }
  const leaseExpiresAt = optionalText(
    scope.attention.handler_lease_expires_at,
  );
  if (
    optionalText(scope.attention.handler_lease_token) !==
      optionalText(activation.attention_lease_token) ||
    leaseExpiresAt === null ||
    new Date(leaseExpiresAt) <= at
  ) {
    return { live: false, reason: "attention_lease_stale" };
  }
  return { live: true };
}

function invalidProjectEventCursor(): KernelError {
  return new KernelError(
    "NotFound",
    "Event cursor does not exist in the requested Project.",
  );
}

export function validateDisposition(kernel: db.KernelContext, disposition: RunInputDisposition, reason: string): void {
  if (disposition === "Pending" ||
    disposition === "Incorporated" ||
    disposition === "Withdrawn") {
    throw new KernelError("InvalidCommand", "The completion exception disposition is invalid.");
  }
  requireNonEmpty(reason, "exception reason");
}
