import type { SQLInputValue } from "node:sqlite";

import * as db from "./database.js";
import { KernelError } from "./errors.js";
import * as invariants from "./invariants.js";
import {
  mapActivation,
  mapActivity,
  mapAgent,
  mapArtifact,
  mapAttention,
  mapChannel,
  mapMessage,
  mapMessageRevision,
  mapOutboxEvent,
  mapProject,
  mapProviderAttempt,
  mapPublicEvent,
  mapRun,
  mapRunInput
} from "./mappings.js";
import type {
  ActivityPage,
  ActivityWindow,
  AuthorizedPublicEventPage,
  AttentionPage,
  BootstrapProjection,
  OutboxPage,
  PrincipalContext,
  ProjectAgentStatusProjection,
  ProviderAttemptView,
  RecoverableAttentionExecutionCursor,
  RecoverableAttentionExecutionPage,
  RunProjection,
  RunProjectionPage,
  ThreadProjection,
  ThreadProjectionPage
} from "./types.js";
import {
  integer,
  optionalText,
  requireNonEmpty,
  text,
  type Row
} from "./values.js";

const recoverableAttentionQueryHookSymbol = Symbol.for(
  "torsor.kernel.recoverable-attention-query",
);
const publicEventQueryHookSymbol = Symbol.for(
  "torsor.kernel.authorized-public-event-query",
);
const projectionPageQueryHookSymbol = Symbol.for(
  "torsor.kernel.projection-page-query",
);
const projectionMaterializationQueryHookSymbol = Symbol.for(
  "torsor.kernel.projection-materialization-query",
);

export function getBootstrap(kernel: db.KernelContext, projectId: string, attentionTargetAgentId?: string): BootstrapProjection {
  const project = db.getRow(kernel, "SELECT * FROM projects WHERE id = ?", projectId);
  if (!project) {
    throw new KernelError("NotFound", `Project ${projectId} does not exist.`);
  }
  const channels = db.allRows(kernel, "SELECT * FROM channels WHERE project_id = ? ORDER BY name, id", projectId).map(mapChannel);
  const agents = db.allRows(kernel, `SELECT a.*, c.config_json
         FROM agents a
         JOIN agent_config_revisions c
           ON c.agent_id = a.id AND c.revision = a.current_config_revision
        WHERE a.project_id = ?
        ORDER BY a.name, a.id`, projectId).map(mapAgent);
  const snapshot = invariants.resolveAttentionSnapshot(kernel, undefined);
  return {
    project: mapProject(project),
    channels,
    agents,
    openAttentions: listOpenAttentions(kernel, projectId, attentionTargetAgentId, 0, snapshot.sequence, snapshot.eventId, 100),
    latestEventId: snapshot.eventId,
  };
}

export function getThreadProjection(kernel: db.KernelContext, threadRootId: string): ThreadProjection {
  const thread = invariants.requireThread(kernel, threadRootId);
  const messageRows = db.allRows(kernel, "SELECT * FROM messages WHERE thread_root_id = ? ORDER BY thread_sequence", threadRootId);
  const messages = messageRows.map((message) => {
    const revisions = db.allRows(kernel, "SELECT * FROM message_revisions WHERE message_id = ? ORDER BY revision", text(message.id)).map(mapMessageRevision);
    const mentions = db.allRows(kernel, `SELECT m.target_agent_id
           FROM mentions m
           JOIN message_revisions r ON r.id = m.message_revision_id
          WHERE r.message_id = ?
          ORDER BY m.target_agent_id`, text(message.id)).map((row) => text(row.target_agent_id));
    return mapMessage(message, revisions, mentions);
  });
  return {
    projectId: text(thread.project_id),
    channelId: text(thread.channel_id),
    threadRootId,
    cursor: integer(thread.cursor),
    messages,
    attentions: db.allRows(kernel, "SELECT * FROM attentions WHERE thread_root_id = ? ORDER BY created_at, id", threadRootId).map(mapAttention),
    runs: db.allRows(kernel, "SELECT * FROM runs WHERE thread_root_id = ? ORDER BY created_at, id", threadRootId).map(mapRun),
    artifacts: db.allRows(kernel, `SELECT ar.*
           FROM artifacts ar
           JOIN runs r ON r.id = ar.producer_run_id
          WHERE r.thread_root_id = ?
          ORDER BY ar.created_at, ar.id`, threadRootId).map(mapArtifact),
  };
}

export function getRunProjection(kernel: db.KernelContext, runId: string): RunProjection {
  const run = invariants.requireRun(kernel, runId);
  return {
    run: mapRun(run),
    inputs: db.allRows(kernel, "SELECT * FROM run_inputs WHERE run_id = ? ORDER BY run_input_sequence", runId).map(mapRunInput),
    activations: db.allRows(kernel, "SELECT * FROM activation_attempts WHERE run_id = ? ORDER BY started_at, id", runId).map((activation) => mapActivation(activation, db.allRows(kernel, `SELECT run_input_id
               FROM activation_run_inputs
              WHERE activation_id = ?
              ORDER BY run_input_sequence`, text(activation.id)).map((row) => text(row.run_input_id)))),
    providerAttempts: db.allRows(kernel, "SELECT * FROM provider_attempts WHERE run_id = ? ORDER BY started_at, id", runId).map(mapProviderAttempt),
    activity: latestActivityWindow(kernel, runId, 100),
    artifacts: db.allRows(kernel, "SELECT * FROM artifacts WHERE producer_run_id = ? ORDER BY created_at, id", runId).map(mapArtifact),
  };
}

export function recordProjectionHistories(
  kernel: db.KernelContext,
  correlationId: string,
): void {
  const boundarySql = `SELECT MAX(sequence) AS sequence
       FROM public_events
      WHERE correlation_id = ?`;
  recordQuery(
    projectionMaterializationQueryHookSymbol,
    boundarySql,
    [correlationId],
  );
  const boundary = db.getRow(
    kernel,
    boundarySql,
    correlationId,
  );
  if (!boundary || boundary.sequence === null) {
    return;
  }
  const eventSequence = integer(boundary.sequence);
  const threadSql = `SELECT DISTINCT thread_root_id
       FROM public_events AS event
      WHERE event.correlation_id = ?
        AND event.thread_root_id IS NOT NULL
        AND (
          event.type IN (
            'MessagePublished',
            'AttentionOpened',
            'AttentionClaimed',
            'AttentionResolved',
            'AttentionIgnored',
            'RunCreated',
            'RunInputAdded',
            'RunInputWithdrawn',
            'ArtifactPublished',
            'RunActivated',
            'RunWaiting',
            'RunCompleted',
            'RunFailed',
            'RunCancelled'
          )
          OR (
            event.type = 'ActivationStarted'
            AND EXISTS (
              SELECT 1
                FROM activation_attempts AS activation
               WHERE activation.id = event.entity_id
                 AND activation.run_id IS NOT NULL
            )
          )
        )`;
  recordQuery(
    projectionMaterializationQueryHookSymbol,
    threadSql,
    [correlationId],
  );
  const threadRows = db.allRows(
    kernel,
    threadSql,
    correlationId,
  );
  for (const row of threadRows) {
    const threadRootId = text(row.thread_root_id);
    db.run(
      kernel,
      `UPDATE threads
          SET created_event_sequence = COALESCE(created_event_sequence, ?)
        WHERE root_message_id = ?`,
      eventSequence,
      threadRootId,
    );
    db.run(
      kernel,
      `INSERT INTO thread_projection_history
        (thread_root_id, event_sequence, projection_json)
       VALUES (?, ?, ?)`,
      threadRootId,
      eventSequence,
      JSON.stringify(getThreadProjection(kernel, threadRootId)),
    );
  }

  const runSql = `SELECT event.entity_id AS run_id
       FROM public_events AS event
      WHERE event.correlation_id = ?
        AND event.entity_type = 'Run'
      UNION
     SELECT input.run_id
       FROM public_events AS event
       JOIN run_inputs AS input ON input.id = event.entity_id
      WHERE event.correlation_id = ?
        AND event.entity_type = 'RunInput'
      UNION
     SELECT artifact.producer_run_id AS run_id
       FROM public_events AS event
       JOIN artifacts AS artifact ON artifact.id = event.entity_id
      WHERE event.correlation_id = ?
        AND event.entity_type = 'Artifact'
      UNION
     SELECT activation.run_id
       FROM public_events AS event
       JOIN activation_attempts AS activation ON activation.id = event.entity_id
      WHERE event.correlation_id = ?
        AND event.entity_type = 'ActivationAttempt'
        AND activation.run_id IS NOT NULL
      UNION
     SELECT attempt.run_id
       FROM public_events AS event
       JOIN provider_attempts AS attempt ON attempt.id = event.entity_id
      WHERE event.correlation_id = ?
        AND event.entity_type = 'ProviderAttempt'
        AND attempt.run_id IS NOT NULL
      UNION
     SELECT activity.run_id
       FROM public_events AS event
       JOIN run_activity_events AS activity ON activity.id = event.entity_id
      WHERE event.correlation_id = ?
         AND event.entity_type = 'RunActivityEvent'`;
  const runParameters = [
    correlationId,
    correlationId,
    correlationId,
    correlationId,
    correlationId,
    correlationId,
  ] satisfies SQLInputValue[];
  recordQuery(
    projectionMaterializationQueryHookSymbol,
    runSql,
    runParameters,
  );
  const runRows = db.allRows(
    kernel,
    runSql,
    ...runParameters,
  );
  for (const row of runRows) {
    const runId = text(row.run_id);
    db.run(
      kernel,
      `UPDATE runs
          SET created_event_sequence = COALESCE(created_event_sequence, ?)
        WHERE id = ?`,
      eventSequence,
      runId,
    );
    db.run(
      kernel,
      `INSERT INTO run_projection_history
        (run_id, event_sequence, projection_json)
       VALUES (?, ?, ?)`,
      runId,
      eventSequence,
      JSON.stringify(getRunProjection(kernel, runId)),
    );
  }
}

export function listThreadProjections(
  kernel: db.KernelContext,
  projectId: string,
  channelId: string | undefined,
  afterEventSequence: number,
  snapshotEventSequence: number,
  snapshotEventId: string | null,
  limit: number,
  scope: invariants.PrincipalReadScope,
): ThreadProjectionPage {
  const clauses = [
    "thread.project_id = ?",
    "thread.created_event_sequence > ?",
    "thread.created_event_sequence <= ?",
  ];
  const parameters: SQLInputValue[] = [
    projectId,
    afterEventSequence,
    snapshotEventSequence,
  ];
  if (channelId) {
    clauses.push("thread.channel_id = ?");
    parameters.push(channelId);
  }
  if (scope.threadRootId) {
    clauses.push("thread.root_message_id = ?");
    parameters.push(scope.threadRootId);
  }
  const queryParameters: SQLInputValue[] = [
    snapshotEventSequence,
    ...parameters,
    limit + 1,
  ];
  const sql = `SELECT thread.created_event_sequence,
              created.event_id AS created_event_id,
              history.projection_json
         FROM threads AS thread
         JOIN public_events AS created
           ON created.sequence = thread.created_event_sequence
         JOIN thread_projection_history AS history
           ON history.thread_root_id = thread.root_message_id
          AND history.event_sequence = (
            SELECT MAX(candidate.event_sequence)
              FROM thread_projection_history AS candidate
             WHERE candidate.thread_root_id = thread.root_message_id
               AND candidate.event_sequence <= ?
          )
        WHERE ${clauses.join(" AND ")}
        ORDER BY thread.created_event_sequence, thread.root_message_id
        LIMIT ?`;
  recordQuery(projectionPageQueryHookSymbol, sql, queryParameters);
  const rows = db.allRows(kernel, sql, ...queryParameters);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map((row) =>
      parseStoredProjection<ThreadProjection>(row.projection_json)
    ),
    nextAfterEventId: hasMore
      ? optionalText(pageRows.at(-1)?.created_event_id)
      : null,
    hasMore,
    snapshotEventId,
  };
}

export function listRunProjections(
  kernel: db.KernelContext,
  projectId: string,
  channelId: string | undefined,
  afterEventSequence: number,
  snapshotEventSequence: number,
  snapshotEventId: string | null,
  limit: number,
  scope: invariants.PrincipalReadScope,
): RunProjectionPage {
  const clauses = [
    "run.project_id = ?",
    "run.created_event_sequence > ?",
    "run.created_event_sequence <= ?",
  ];
  const parameters: SQLInputValue[] = [
    projectId,
    afterEventSequence,
    snapshotEventSequence,
  ];
  if (channelId) {
    clauses.push("run.home_channel_id = ?");
    parameters.push(channelId);
  }
  if (scope.runId) {
    clauses.push("run.id = ?");
    parameters.push(scope.runId);
  } else if (scope.threadRootId) {
    clauses.push("1 = 0");
  }
  const queryParameters: SQLInputValue[] = [
    snapshotEventSequence,
    ...parameters,
    limit + 1,
  ];
  const sql = `SELECT run.created_event_sequence,
              created.event_id AS created_event_id,
              history.projection_json
         FROM runs AS run
         JOIN public_events AS created
           ON created.sequence = run.created_event_sequence
         JOIN run_projection_history AS history
           ON history.run_id = run.id
          AND history.event_sequence = (
            SELECT MAX(candidate.event_sequence)
              FROM run_projection_history AS candidate
             WHERE candidate.run_id = run.id
               AND candidate.event_sequence <= ?
          )
        WHERE ${clauses.join(" AND ")}
        ORDER BY run.created_event_sequence, run.id
        LIMIT ?`;
  recordQuery(projectionPageQueryHookSymbol, sql, queryParameters);
  const rows = db.allRows(kernel, sql, ...queryParameters);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map((row) =>
      parseStoredProjection<RunProjection>(row.projection_json)
    ),
    nextAfterEventId: hasMore
      ? optionalText(pageRows.at(-1)?.created_event_id)
      : null,
    hasMore,
    snapshotEventId,
  };
}

export function readAuthorizedPublicEvents(
  kernel: db.KernelContext,
  projectId: string,
  afterEventId: string | null,
  afterEventSequence: number,
  limit: number,
  scope: invariants.PrincipalReadScope,
): AuthorizedPublicEventPage {
  const parameters: SQLInputValue[] = [
    projectId,
    afterEventSequence,
    limit + 1,
  ];
  const sql = `SELECT *
       FROM public_events
      WHERE project_id = ?
        AND sequence > ?
      ORDER BY sequence
      LIMIT ?`;
  recordQuery(publicEventQueryHookSymbol, sql, parameters);
  const rows = db.allRows(kernel, sql, ...parameters);
  const hasMore = rows.length > limit;
  const scannedRows = rows.slice(0, limit);
  const events = scannedRows
    .filter((row) =>
      scope.threadRootId === null ||
      (optionalText(row.channel_id) === scope.channelId &&
        optionalText(row.thread_root_id) === scope.threadRootId)
    )
    .map(mapPublicEvent);
  return {
    events,
    scannedThroughEventId:
      optionalText(scannedRows.at(-1)?.event_id) ?? afterEventId,
    hasMore,
  };
}

export function getProjectAgentStatus(
  kernel: db.KernelContext,
  projectId: string,
  agentId?: string,
): ProjectAgentStatusProjection {
  const agentClauses = ["project_id = ?"];
  const agentParameters: SQLInputValue[] = [projectId];
  if (agentId) {
    agentClauses.push("id = ?");
    agentParameters.push(agentId);
  }
  const agents = db.allRows(
    kernel,
    `SELECT id
       FROM agents
      WHERE ${agentClauses.join(" AND ")}
      ORDER BY name, id`,
    ...agentParameters,
  );
  if (agentId && agents.length === 0) {
    const existing = db.getRow(kernel, "SELECT project_id FROM agents WHERE id = ?", agentId);
    if (!existing) {
      throw new KernelError("NotFound", `Agent ${agentId} does not exist.`);
    }
    throw new KernelError("Forbidden", "The Agent does not belong to the Project.");
  }

  const nonterminalCounts = new Map(
    db.allRows(
      kernel,
      `SELECT owner_agent_id, COUNT(*) AS count
         FROM runs
        WHERE project_id = ?
          AND state IN ('Active', 'Waiting')
          ${agentId ? "AND owner_agent_id = ?" : ""}
        GROUP BY owner_agent_id`,
      projectId,
      ...(agentId ? [agentId] : []),
    ).map((row) => [text(row.owner_agent_id), integer(row.count)] as const),
  );

  const at = kernel.clock();
  const atIso = at.toISOString();
  const activationRows = db.allRows(
    kernel,
    `SELECT activation.*,
            run.state AS scope_run_state,
            run.activation_generation AS scope_run_activation_generation,
            run.owner_agent_id AS scope_agent_id,
            NULL AS scope_attention_status,
            NULL AS scope_attention_lease_token,
            NULL AS scope_attention_lease_expires_at
       FROM activation_attempts AS activation
       JOIN runs AS run ON run.id = activation.run_id
      WHERE run.project_id = ?
        AND activation.cause = 'Run'
        AND activation.finished_at IS NULL
        AND activation.revoked_at IS NULL
        AND activation.expires_at > ?
        ${agentId ? "AND activation.agent_id = ?" : ""}
      UNION ALL
     SELECT activation.*,
            NULL AS scope_run_state,
            NULL AS scope_run_activation_generation,
            attention.target_agent_id AS scope_agent_id,
            attention.status AS scope_attention_status,
            attention.handler_lease_token AS scope_attention_lease_token,
            attention.handler_lease_expires_at AS scope_attention_lease_expires_at
       FROM activation_attempts AS activation
       JOIN attentions AS attention ON attention.id = activation.attention_id
      WHERE attention.project_id = ?
        AND activation.cause = 'Attention'
        AND activation.finished_at IS NULL
        AND activation.revoked_at IS NULL
        AND activation.expires_at > ?
        ${agentId ? "AND activation.agent_id = ?" : ""}`,
    projectId,
    atIso,
    ...(agentId ? [agentId] : []),
    projectId,
    atIso,
    ...(agentId ? [agentId] : []),
  );
  const liveRunCounts = new Map<string, number>();
  const liveAttentionCounts = new Map<string, number>();
  for (const activation of activationRows) {
    if (
      !invariants.isActivationLiveAt(
        activation,
        {
          runState: optionalText(activation.scope_run_state),
          runActivationGeneration:
            activation.scope_run_activation_generation === null
              ? null
              : integer(activation.scope_run_activation_generation),
          scopeAgentId: optionalText(activation.scope_agent_id),
          attentionStatus: optionalText(activation.scope_attention_status),
          attentionLeaseToken: optionalText(
            activation.scope_attention_lease_token,
          ),
          attentionLeaseExpiresAt: optionalText(
            activation.scope_attention_lease_expires_at,
          ),
        },
        at,
      )
    ) {
      continue;
    }
    const counts =
      text(activation.cause) === "Run"
        ? liveRunCounts
        : liveAttentionCounts;
    const activationAgentId = text(activation.agent_id);
    counts.set(activationAgentId, (counts.get(activationAgentId) ?? 0) + 1);
  }

  return {
    projectId,
    agents: agents.map((agent) => {
      const id = text(agent.id);
      const liveRunActivationCount = liveRunCounts.get(id) ?? 0;
      const liveAttentionActivationCount =
        liveAttentionCounts.get(id) ?? 0;
      const liveActivationCount =
        liveRunActivationCount + liveAttentionActivationCount;
      const nonterminalRunCount = nonterminalCounts.get(id) ?? 0;
      return {
        agentId: id,
        liveRunActivationCount,
        liveAttentionActivationCount,
        liveActivationCount,
        nonterminalRunCount,
        status: liveActivationCount > 0
          ? "active"
          : nonterminalRunCount > 0
            ? "waiting"
            : "idle",
      };
    }),
  };
}

export function listActivity(kernel: db.KernelContext, runId: string, afterSequence: number, limit: number): ActivityPage {
  const rows = db.allRows(kernel, `SELECT * FROM run_activity_events
        WHERE run_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?`, runId, afterSequence, limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapActivity);
  return {
    items,
    nextCursor: hasMore ? items.at(-1)?.sequence ?? null : null,
    hasMore,
  };
}

export function latestActivityWindow(kernel: db.KernelContext, runId: string, limit: number): ActivityWindow {
  const rows = db.allRows(kernel, `SELECT * FROM run_activity_events
        WHERE run_id = ?
        ORDER BY sequence DESC
        LIMIT ?`, runId, limit + 1);
  const hasEarlier = rows.length > limit;
  const items = rows.slice(0, limit).reverse().map(mapActivity);
  return {
    items,
    hasEarlier,
    earliestSequence: items[0]?.sequence ?? null,
    latestSequence: items.at(-1)?.sequence ?? null,
  };
}

export function listOpenAttentions(kernel: db.KernelContext, projectId: string | undefined, targetAgentId: string | undefined, afterCursor: number, snapshotEventSequence: number, snapshotEventId: string | null, limit: number): AttentionPage {
  const clauses = [
    "history.status = 'Open'",
    "attention.sequence > ?",
    "attention.created_event_sequence IS NOT NULL",
    "attention.created_event_sequence <= ?",
  ];
  const parameters: SQLInputValue[] = [
    afterCursor,
    snapshotEventSequence,
  ];
  if (projectId) {
    clauses.push("attention.project_id = ?");
    parameters.push(projectId);
  }
  if (targetAgentId) {
    clauses.push("attention.target_agent_id = ?");
    parameters.push(targetAgentId);
  }
  parameters.push(limit + 1);
  const rows = db.allRows(kernel, `SELECT attention.sequence, attention.id,
              attention.project_id, attention.channel_id,
              attention.thread_root_id, attention.message_revision_id,
              attention.target_agent_id, attention.trigger_kind,
              history.status, history.revision,
              history.handler_lease_holder_principal_id,
              history.handler_lease_expires_at, NULL AS resolution_outcome,
              history.resolved_run_id,
              attention.created_at, history.resolved_at
         FROM attentions AS attention
         JOIN attention_history AS history
           ON history.attention_id = attention.id
          AND history.event_sequence = (
            SELECT MAX(candidate.event_sequence)
              FROM attention_history AS candidate
             WHERE candidate.attention_id = attention.id
               AND candidate.event_sequence <= ?
          )
        WHERE ${clauses.join(" AND ")}
        ORDER BY attention.sequence
        LIMIT ?`, snapshotEventSequence, ...parameters);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapAttention);
  return {
    items,
    nextCursor: hasMore ? items.at(-1)?.cursor ?? null : null,
    hasMore,
    snapshotEventId,
  };
}

export function listOutboxEvents(kernel: db.KernelContext, afterCursor: number, limit: number, includeAcknowledged: boolean): OutboxPage {
  const rows = db.allRows(kernel, `SELECT * FROM outbox_events
        WHERE sequence > ?
          AND (? = 1 OR acknowledged_at IS NULL)
        ORDER BY sequence
        LIMIT ?`, afterCursor, includeAcknowledged ? 1 : 0, limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapOutboxEvent);
  return {
    items,
    nextCursor: hasMore ? items.at(-1)?.cursor ?? null : null,
    hasMore,
  };
}

export function getProviderAttempt(
  kernel: db.KernelContext,
  providerAttemptId: string,
  principal: Row,
  context: PrincipalContext,
): ProviderAttemptView {
  const attempt = invariants.requireProviderAttempt(kernel, providerAttemptId);
  const activation = invariants.requireActivation(
    kernel,
    text(attempt.activation_id),
  );
  if (text(principal.kind) === "runtime") {
    return mapProviderAttempt(attempt);
  }
  if (text(principal.kind) !== "agent") {
    throw new KernelError(
      "Forbidden",
      "ProviderAttempt queries require runtime or scoped Agent authority.",
    );
  }
  invariants.authorizeActivationActor(
    kernel,
    principal,
    context,
    activation,
  );
  invariants.assertActivationScopeCurrent(kernel, activation);
  return mapProviderAttempt(attempt);
}

export function listRecoverableAttentionExecutions(
  kernel: db.KernelContext,
  afterCursor: RecoverableAttentionExecutionCursor | undefined,
  limit: number,
): RecoverableAttentionExecutionPage {
  const expiredClauses = [
    "expired.cause = 'Attention'",
    "expired.finished_at IS NULL",
    "expired.expires_at <= ?",
  ];
  const unsettledClauses = [
    "activation.cause = 'Attention'",
    "activation.finished_at IS NOT NULL",
  ];
  const parameters: SQLInputValue[] = [db.now(kernel)];
  if (afterCursor) {
    requireNonEmpty(afterCursor.startedAt, "afterCursor.startedAt");
    requireNonEmpty(afterCursor.activationId, "afterCursor.activationId");
    expiredClauses.push("(expired.started_at, expired.id) > (?, ?)");
    parameters.push(
      afterCursor.startedAt,
      afterCursor.activationId,
    );
    unsettledClauses.push(
      "(activation.started_at, activation.id) > (?, ?)",
    );
    parameters.push(
      afterCursor.startedAt,
      afterCursor.activationId,
    );
  }
  parameters.push(limit + 1);
  const sql = `SELECT expired.*
       FROM activation_attempts AS expired
      WHERE ${expiredClauses.join(" AND ")}
      UNION ALL
     SELECT DISTINCT activation.*
       FROM provider_attempts AS unsettled
       JOIN activation_attempts AS activation
         ON activation.id = unsettled.activation_id
      WHERE unsettled.status IN ('Started', 'Acknowledged')
        AND ${unsettledClauses.join(" AND ")}
      ORDER BY started_at, id
      LIMIT ?`;
  const queryHook = Reflect.get(
    globalThis,
    recoverableAttentionQueryHookSymbol,
  );
  if (typeof queryHook === "function") {
    queryHook({ sql, parameters: [...parameters] });
  }
  const rows = db.allRows(
    kernel,
    sql,
    ...parameters,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((activation) => {
    const activationId = text(activation.id);
    const attention = invariants.requireAttention(
      kernel,
      text(activation.attention_id),
    );
    return {
      cursor: {
        startedAt: text(activation.started_at),
        activationId,
      },
      attention: mapAttention(attention),
      activation: mapActivation(
        activation,
        db.allRows(
          kernel,
          `SELECT run_input_id
             FROM activation_run_inputs
            WHERE activation_id = ?
            ORDER BY run_input_sequence`,
          activationId,
        ).map((row) => text(row.run_input_id)),
      ),
      providerAttempts: db.allRows(
        kernel,
        `SELECT *
           FROM provider_attempts
          WHERE activation_id = ?
          ORDER BY started_at, id`,
        activationId,
      ).map(mapProviderAttempt),
    };
  });
  return {
    items,
    nextCursor: hasMore ? items.at(-1)?.cursor ?? null : null,
    hasMore,
  };
}

function parseStoredProjection<T>(value: unknown): T {
  return JSON.parse(text(value)) as T;
}

function recordQuery(
  hookSymbol: symbol,
  sql: string,
  parameters: readonly SQLInputValue[],
): void {
  const hook = Reflect.get(globalThis, hookSymbol);
  if (typeof hook === "function") {
    hook({ sql, parameters: [...parameters] });
  }
}
