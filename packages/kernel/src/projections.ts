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
  AttentionRecoverySnapshot,
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
const agentStatusQueryHookSymbol = Symbol.for(
  "torsor.kernel.agent-status-query",
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
  const snapshot = invariants.resolvePublicSnapshot(
    kernel,
    projectId,
    undefined,
  );
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

export function getThreadProjectionAt(
  kernel: db.KernelContext,
  threadRootId: string,
  snapshotEventSequence: number,
): ThreadProjection {
  const thread = invariants.requireThread(kernel, threadRootId);
  const cursorRow = db.getRow(
    kernel,
    `SELECT thread_cursor
       FROM public_events
      WHERE thread_root_id = ?
        AND sequence <= ?
        AND thread_cursor IS NOT NULL
      ORDER BY sequence DESC
      LIMIT 1`,
    threadRootId,
    snapshotEventSequence,
  );
  const messageRows = db.allRows(
    kernel,
    `SELECT message.*,
            (
              SELECT MAX(revision.revision)
                FROM message_revisions AS revision
               WHERE revision.message_id = message.id
                 AND revision.created_event_sequence <= ?
            ) AS latest_revision
       FROM messages AS message INDEXED BY messages_thread_idx
      WHERE message.thread_root_id = ?
        AND message.created_event_sequence <= ?
      ORDER BY message.thread_sequence`,
    snapshotEventSequence,
    threadRootId,
    snapshotEventSequence,
  );
  const messages = messageRows.map((message) => {
    const revisions = db.allRows(
      kernel,
      `SELECT *
         FROM message_revisions
        WHERE message_id = ?
          AND created_event_sequence <= ?
        ORDER BY revision`,
      text(message.id),
      snapshotEventSequence,
    ).map(mapMessageRevision);
    const mentions = db.allRows(
      kernel,
      `SELECT mention.target_agent_id
         FROM mentions AS mention
         JOIN message_revisions AS revision
           ON revision.id = mention.message_revision_id
        WHERE revision.message_id = ?
          AND mention.created_event_sequence <= ?
        ORDER BY mention.target_agent_id`,
      text(message.id),
      snapshotEventSequence,
    ).map((row) => text(row.target_agent_id));
    return mapMessage(message, revisions, mentions);
  });
  return {
    projectId: text(thread.project_id),
    channelId: text(thread.channel_id),
    threadRootId,
    cursor: cursorRow ? integer(cursorRow.thread_cursor) : 0,
    messages,
    attentions: db.allRows(
      kernel,
      `SELECT attention.sequence, attention.id, attention.project_id,
              attention.channel_id, attention.thread_root_id,
              attention.message_revision_id, attention.target_agent_id,
              attention.trigger_kind, history.status, history.revision,
              history.handler_lease_holder_principal_id,
              history.handler_lease_expires_at, history.resolution_outcome,
              history.resolved_run_id, attention.created_at,
              history.resolved_at
         FROM attentions AS attention
         JOIN attention_history AS history
           ON history.attention_id = attention.id
          AND history.event_sequence = (
            SELECT MAX(candidate.event_sequence)
              FROM attention_history AS candidate
             WHERE candidate.attention_id = attention.id
               AND candidate.event_sequence <= ?
          )
        WHERE attention.thread_root_id = ?
          AND attention.created_event_sequence <= ?
        ORDER BY attention.created_at, attention.id`,
      snapshotEventSequence,
      threadRootId,
      snapshotEventSequence,
    ).map(mapAttention),
    runs: db.allRows(
      kernel,
      `SELECT run.id, run.project_id, run.home_channel_id,
              run.thread_root_id, run.owner_agent_id,
              run.agent_config_revision, history.state, history.revision,
              history.activation_generation, run.created_at,
              history.updated_at, history.terminal_reason
         FROM runs AS run
         JOIN run_history AS history
           ON history.run_id = run.id
          AND history.event_sequence = (
            SELECT MAX(candidate.event_sequence)
              FROM run_history AS candidate
             WHERE candidate.run_id = run.id
               AND candidate.event_sequence <= ?
          )
        WHERE run.thread_root_id = ?
          AND run.created_event_sequence <= ?
        ORDER BY run.created_at, run.id`,
      snapshotEventSequence,
      threadRootId,
      snapshotEventSequence,
    ).map(mapRun),
    artifacts: db.allRows(
      kernel,
      `SELECT artifact.*
         FROM artifacts AS artifact
         JOIN runs AS run ON run.id = artifact.producer_run_id
        WHERE run.thread_root_id = ?
          AND artifact.created_event_sequence <= ?
        ORDER BY artifact.created_at, artifact.id`,
      threadRootId,
      snapshotEventSequence,
    ).map(mapArtifact),
  };
}

export function getRunProjectionAt(
  kernel: db.KernelContext,
  runId: string,
  snapshotEventSequence: number,
): RunProjection {
  const run = db.getRow(
    kernel,
    `SELECT current.id, current.project_id, current.home_channel_id,
            current.thread_root_id, current.owner_agent_id,
            current.agent_config_revision, history.state, history.revision,
            history.activation_generation, current.created_at,
            history.updated_at, history.terminal_reason
       FROM runs AS current
       JOIN run_history AS history
         ON history.run_id = current.id
        AND history.event_sequence = (
          SELECT MAX(candidate.event_sequence)
            FROM run_history AS candidate
           WHERE candidate.run_id = current.id
             AND candidate.event_sequence <= ?
        )
      WHERE current.id = ?
        AND current.created_event_sequence <= ?`,
    snapshotEventSequence,
    runId,
    snapshotEventSequence,
  );
  if (!run) {
    throw new KernelError(
      "NotFound",
      `Run ${runId} does not exist at the requested snapshot.`,
    );
  }
  return {
    run: mapRun(run),
    inputs: db.allRows(
      kernel,
      `SELECT input.id, input.run_id, input.message_revision_id,
              input.run_input_sequence, input.assigned_by_principal_id,
              input.assigned_by_activation_id, input.source_attention_id,
              input.created_at, history.disposition,
              history.disposition_revision, history.disposition_reason,
              history.superseded_by_run_input_id
         FROM run_inputs AS input
         JOIN run_input_history AS history
           ON history.run_input_id = input.id
          AND history.event_sequence = (
            SELECT MAX(candidate.event_sequence)
              FROM run_input_history AS candidate
             WHERE candidate.run_input_id = input.id
               AND candidate.event_sequence <= ?
          )
        WHERE input.run_id = ?
          AND input.created_event_sequence <= ?
        ORDER BY input.run_input_sequence`,
      snapshotEventSequence,
      runId,
      snapshotEventSequence,
    ).map(mapRunInput),
    activations: db.allRows(
      kernel,
      `SELECT activation.id, activation.agent_id, activation.run_id,
              activation.attention_id, activation.attention_lease_token,
              activation.run_activation_generation, activation.cause,
              activation.config_revision, activation.started_at,
              activation.expires_at, history.revoked_at,
              history.revocation_reason, history.finished_at,
              history.outcome, history.detail
         FROM activation_attempts AS activation
         JOIN activation_history AS history
           ON history.activation_id = activation.id
          AND history.event_sequence = (
            SELECT MAX(candidate.event_sequence)
              FROM activation_history AS candidate
             WHERE candidate.activation_id = activation.id
               AND candidate.event_sequence <= ?
          )
        WHERE activation.run_id = ?
          AND activation.created_event_sequence <= ?
        ORDER BY activation.started_at, activation.id`,
      snapshotEventSequence,
      runId,
      snapshotEventSequence,
    ).map((activation) =>
      mapActivation(
        activation,
        db.allRows(
          kernel,
          `SELECT run_input_id
             FROM activation_run_inputs
            WHERE activation_id = ?
            ORDER BY run_input_sequence`,
          text(activation.id),
        ).map((row) => text(row.run_input_id)),
      )
    ),
    providerAttempts: db.allRows(
      kernel,
      `SELECT attempt.id, attempt.activation_id, attempt.run_id,
              attempt.adapter, attempt.adapter_version,
              attempt.capability_snapshot_json,
              attempt.run_input_ids_json,
              attempt.request_idempotency_key,
              attempt.diagnostic_session_id, history.status,
              history.detail, attempt.started_at, history.finished_at
         FROM provider_attempts AS attempt
         JOIN provider_attempt_history AS history
           ON history.provider_attempt_id = attempt.id
          AND history.event_sequence = (
            SELECT MAX(candidate.event_sequence)
              FROM provider_attempt_history AS candidate
             WHERE candidate.provider_attempt_id = attempt.id
               AND candidate.event_sequence <= ?
          )
        WHERE attempt.run_id = ?
          AND attempt.created_event_sequence <= ?
        ORDER BY attempt.started_at, attempt.id`,
      snapshotEventSequence,
      runId,
      snapshotEventSequence,
    ).map(mapProviderAttempt),
    activity: latestActivityWindowAt(
      kernel,
      runId,
      snapshotEventSequence,
      100,
    ),
    artifacts: db.allRows(
      kernel,
      `SELECT *
         FROM artifacts
        WHERE producer_run_id = ?
          AND created_event_sequence <= ?
        ORDER BY created_at, id`,
      runId,
      snapshotEventSequence,
    ).map(mapArtifact),
  };
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
    ...parameters,
    limit + 1,
  ];
  const sql = `SELECT thread.root_message_id,
              thread.created_event_sequence,
              created.event_id AS created_event_id
         FROM threads AS thread
         JOIN public_events AS created
           ON created.sequence = thread.created_event_sequence
        WHERE ${clauses.join(" AND ")}
        ORDER BY thread.created_event_sequence, thread.root_message_id
        LIMIT ?`;
  recordQuery(projectionPageQueryHookSymbol, sql, queryParameters);
  const rows = db.allRows(kernel, sql, ...queryParameters);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map((row) =>
      getThreadProjectionAt(
        kernel,
        text(row.root_message_id),
        snapshotEventSequence,
      )
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
    ...parameters,
    limit + 1,
  ];
  const sql = `SELECT run.id,
              run.created_event_sequence,
              created.event_id AS created_event_id
         FROM runs AS run
         JOIN public_events AS created
           ON created.sequence = run.created_event_sequence
        WHERE ${clauses.join(" AND ")}
        ORDER BY run.created_event_sequence, run.id
        LIMIT ?`;
  recordQuery(projectionPageQueryHookSymbol, sql, queryParameters);
  const rows = db.allRows(kernel, sql, ...queryParameters);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map((row) =>
      getRunProjectionAt(
        kernel,
        text(row.id),
        snapshotEventSequence,
      )
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
  const agentsSql = `SELECT id
       FROM agents
      WHERE ${agentClauses.join(" AND ")}
      ORDER BY name, id`;
  recordQuery(agentStatusQueryHookSymbol, agentsSql, agentParameters);
  const agents = db.allRows(
    kernel,
    agentsSql,
    ...agentParameters,
  );
  if (agentId && agents.length === 0) {
    const existing = db.getRow(kernel, "SELECT project_id FROM agents WHERE id = ?", agentId);
    if (!existing) {
      throw new KernelError("NotFound", `Agent ${agentId} does not exist.`);
    }
    throw new KernelError("Forbidden", "The Agent does not belong to the Project.");
  }

  const nonterminalParameters: SQLInputValue[] = [
    projectId,
    ...(agentId ? [agentId] : []),
  ];
  const nonterminalIndex = agentId
    ? "runs_project_agent_state_idx"
    : "runs_project_state_agent_idx";
  const nonterminalSql = `SELECT owner_agent_id, COUNT(*) AS count
         FROM runs INDEXED BY ${nonterminalIndex}
        WHERE project_id = ?
          AND state IN ('Active', 'Waiting')
          ${agentId ? "AND owner_agent_id = ?" : ""}
        GROUP BY owner_agent_id`;
  recordQuery(
    agentStatusQueryHookSymbol,
    nonterminalSql,
    nonterminalParameters,
  );
  const nonterminalCounts = new Map(
    db.allRows(
      kernel,
      nonterminalSql,
      ...nonterminalParameters,
    ).map((row) => [text(row.owner_agent_id), integer(row.count)] as const),
  );

  const at = kernel.clock();
  const atIso = at.toISOString();
  const activationParameters: SQLInputValue[] = [
    atIso,
    projectId,
    ...(agentId ? [agentId] : []),
    atIso,
    atIso,
    projectId,
    ...(agentId ? [agentId] : []),
  ];
  const runActivationIndex = agentId
    ? "activation_live_run_agent_expiry_idx"
    : "activation_live_run_expiry_idx";
  const attentionActivationIndex = agentId
    ? "activation_live_attention_agent_expiry_idx"
    : "activation_live_attention_expiry_idx";
  const activationSql = `SELECT live.agent_id, live.scope, COUNT(*) AS count
       FROM (
       SELECT activation.agent_id, 'Run' AS scope
       FROM activation_attempts AS activation INDEXED BY ${runActivationIndex}
       JOIN runs AS run ON run.id = activation.run_id
      WHERE ${invariants.liveRunActivationPredicate("activation", "run")}
        AND run.project_id = ?
        ${agentId ? "AND activation.agent_id = ?" : ""}
      UNION ALL
     SELECT activation.agent_id, 'Attention' AS scope
       FROM activation_attempts AS activation INDEXED BY ${attentionActivationIndex}
       JOIN attentions AS attention ON attention.id = activation.attention_id
      WHERE ${invariants.liveAttentionActivationPredicate("activation", "attention")}
        AND attention.project_id = ?
        ${agentId ? "AND activation.agent_id = ?" : ""}
       ) AS live
      GROUP BY live.agent_id, live.scope`;
  recordQuery(
    agentStatusQueryHookSymbol,
    activationSql,
    activationParameters,
  );
  const activationRows = db.allRows(
    kernel,
    activationSql,
    ...activationParameters,
  );
  const liveRunCounts = new Map<string, number>();
  const liveAttentionCounts = new Map<string, number>();
  for (const activation of activationRows) {
    const counts =
      text(activation.scope) === "Run"
        ? liveRunCounts
        : liveAttentionCounts;
    const activationAgentId = text(activation.agent_id);
    counts.set(activationAgentId, integer(activation.count));
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

export function latestActivityWindowAt(
  kernel: db.KernelContext,
  runId: string,
  snapshotEventSequence: number,
  limit: number,
): ActivityWindow {
  const rows = db.allRows(
    kernel,
    `SELECT *
       FROM run_activity_events
      WHERE run_id = ?
        AND created_event_sequence <= ?
      ORDER BY sequence DESC
      LIMIT ?`,
    runId,
    snapshotEventSequence,
    limit + 1,
  );
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

export function getAttentionRecoverySnapshot(
  kernel: db.KernelContext,
): AttentionRecoverySnapshot {
  const observedAt = db.now(kernel);
  const promoted = db.allRows(
    kernel,
    `UPDATE attention_recovery_executions
        SET expired_recoverable = 1
      WHERE unfinished = 1
        AND expired_recoverable = 0
        AND expires_at <= ?
      RETURNING activation_id`,
    observedAt,
  );
  if (promoted.length > 0) {
    db.run(
      kernel,
      `UPDATE kernel_runtime_state
          SET attention_recovery_revision =
                attention_recovery_revision + 1
        WHERE singleton = 1`,
    );
  }
  return readAttentionRecoverySnapshot(kernel, observedAt);
}

function readAttentionRecoverySnapshot(
  kernel: db.KernelContext,
  observedAt: string,
): AttentionRecoverySnapshot {
  const state = db.getRow(
    kernel,
    `SELECT attention_recovery_revision
       FROM kernel_runtime_state
      WHERE singleton = 1`,
  );
  if (!state) {
    throw new Error("Kernel runtime state is missing.");
  }
  const horizon = db.getRow(
    kernel,
    `SELECT MIN(expires_at) AS next_expiry_at
       FROM attention_recovery_executions
      WHERE unfinished = 1
         AND expired_recoverable = 0
         AND expires_at > ?`,
    observedAt,
  );
  return {
    revision: integer(state.attention_recovery_revision),
    observedAt,
    nextExpiryAt: horizon
      ? optionalText(horizon.next_expiry_at)
      : null,
  };
}

export function listRecoverableAttentionExecutions(
  kernel: db.KernelContext,
  afterCursor: RecoverableAttentionExecutionCursor | undefined,
  requestedSnapshot: AttentionRecoverySnapshot | undefined,
  limit: number,
): RecoverableAttentionExecutionPage {
  const recoverySnapshot = resolveAttentionRecoverySnapshot(
    kernel,
    requestedSnapshot,
  );
  const expiredClauses = [
    "recovery.expired_recoverable = 1",
  ];
  const unsettledClauses = [
    "recovery.finished_with_unsettled_provider = 1",
  ];
  const expiredParameters: SQLInputValue[] = [];
  const unsettledParameters: SQLInputValue[] = [];
  if (afterCursor) {
    requireNonEmpty(afterCursor.startedAt, "afterCursor.startedAt");
    requireNonEmpty(afterCursor.activationId, "afterCursor.activationId");
    expiredClauses.push(
      "(recovery.started_at, recovery.activation_id) > (?, ?)",
    );
    expiredParameters.push(
      afterCursor.startedAt,
      afterCursor.activationId,
    );
    unsettledClauses.push(
      "(recovery.started_at, recovery.activation_id) > (?, ?)",
    );
    unsettledParameters.push(
      afterCursor.startedAt,
      afterCursor.activationId,
    );
  }
  expiredParameters.push(limit + 1);
  unsettledParameters.push(limit + 1);
  const expiredSql = `SELECT recovery.activation_id, recovery.started_at
       FROM attention_recovery_executions AS recovery
            INDEXED BY attention_recovery_unfinished_order_idx
      WHERE ${expiredClauses.join(" AND ")}
      ORDER BY recovery.started_at, recovery.activation_id
      LIMIT ?`;
  const unsettledSql = `SELECT recovery.activation_id, recovery.started_at
       FROM attention_recovery_executions AS recovery
            INDEXED BY attention_recovery_finished_order_idx
      WHERE ${unsettledClauses.join(" AND ")}
      ORDER BY recovery.started_at, recovery.activation_id
      LIMIT ?`;
  recordQuery(
    recoverableAttentionQueryHookSymbol,
    expiredSql,
    expiredParameters,
  );
  recordQuery(
    recoverableAttentionQueryHookSymbol,
    unsettledSql,
    unsettledParameters,
  );
  const recoveryRows = mergeRecoveryRows(
    db.allRows(kernel, expiredSql, ...expiredParameters),
    db.allRows(kernel, unsettledSql, ...unsettledParameters),
    limit + 1,
  );
  const hasMore = recoveryRows.length > limit;
  const selectedRows = recoveryRows.slice(0, limit);
  if (selectedRows.length === 0) {
    return {
      items: [],
      nextCursor: null,
      hasMore: false,
      recoverySnapshot,
    };
  }
  const activationIds = selectedRows.map((row) => text(row.activation_id));
  const placeholders = activationIds.map(() => "?").join(", ");
  const activations = db.allRows(
    kernel,
    `SELECT *
       FROM activation_attempts
      WHERE id IN (${placeholders})`,
    ...activationIds,
  );
  const activationsById = new Map(
    activations.map((activation) => [text(activation.id), activation]),
  );
  const attentionIds = [
    ...new Set(activations.map((activation) => text(activation.attention_id))),
  ];
  const attentionPlaceholders = attentionIds.map(() => "?").join(", ");
  const attentions = db.allRows(
    kernel,
    `SELECT *
       FROM attentions
      WHERE id IN (${attentionPlaceholders})`,
    ...attentionIds,
  );
  const attentionsById = new Map(
    attentions.map((attention) => [text(attention.id), attention]),
  );
  const attemptsByActivation = new Map<string, Row[]>();
  for (const attempt of db.allRows(
    kernel,
    `SELECT *
       FROM provider_attempts
      WHERE activation_id IN (${placeholders})
      ORDER BY activation_id, started_at, id`,
    ...activationIds,
  )) {
    const activationId = text(attempt.activation_id);
    const attempts = attemptsByActivation.get(activationId) ?? [];
    attempts.push(attempt);
    attemptsByActivation.set(activationId, attempts);
  }
  const items = selectedRows.map((recovery) => {
    const activationId = text(recovery.activation_id);
    const activation = activationsById.get(activationId);
    if (!activation) {
      throw new Error(`Recovery Activation ${activationId} is missing.`);
    }
    const attentionId = text(activation.attention_id);
    const attention = attentionsById.get(attentionId);
    if (!attention) {
      throw new Error(`Recovery Attention ${attentionId} is missing.`);
    }
    return {
      cursor: {
        startedAt: text(activation.started_at),
        activationId,
      },
      attention: mapAttention(attention),
      activation: mapActivation(
        activation,
        [],
      ),
      providerAttempts:
        (attemptsByActivation.get(activationId) ?? []).map(mapProviderAttempt),
    };
  });
  return {
    items,
    nextCursor: hasMore ? items.at(-1)?.cursor ?? null : null,
    hasMore,
    recoverySnapshot,
  };
}

function resolveAttentionRecoverySnapshot(
  kernel: db.KernelContext,
  requested: AttentionRecoverySnapshot | undefined,
): AttentionRecoverySnapshot {
  if (!requested) {
    return getAttentionRecoverySnapshot(kernel);
  }
  if (
    !Number.isInteger(requested.revision) ||
    requested.revision < 0 ||
    Number.isNaN(Date.parse(requested.observedAt)) ||
    (requested.nextExpiryAt !== null &&
      Number.isNaN(Date.parse(requested.nextExpiryAt)))
  ) {
    throw new KernelError(
      "InvalidCommand",
      "The Attention recovery snapshot is invalid.",
    );
  }
  const current = readAttentionRecoverySnapshot(kernel, db.now(kernel));
  const authoritativeHorizon = db.getRow(
    kernel,
    `SELECT MIN(expires_at) AS next_expiry_at
       FROM attention_recovery_executions
      WHERE unfinished = 1
         AND expired_recoverable = 0
         AND expires_at > ?`,
    requested.observedAt,
  );
  const nextExpiryAt = authoritativeHorizon
    ? optionalText(authoritativeHorizon.next_expiry_at)
    : null;
  if (
    current.revision !== requested.revision ||
    nextExpiryAt !== requested.nextExpiryAt ||
    new Date(requested.observedAt) > new Date(current.observedAt) ||
    (requested.nextExpiryAt !== null &&
      new Date(current.observedAt) >= new Date(requested.nextExpiryAt))
  ) {
    throw new KernelError(
      "StaleRevision",
      "The Attention recovery snapshot changed or crossed its expiry horizon.",
      {
        expectedRevision: requested.revision,
        actualRevision: current.revision,
        observedAt: current.observedAt,
        nextExpiryAt: requested.nextExpiryAt,
      },
    );
  }
  return requested;
}

function mergeRecoveryRows(
  expired: readonly Row[],
  unsettled: readonly Row[],
  limit: number,
): Row[] {
  const merged: Row[] = [];
  let expiredIndex = 0;
  let unsettledIndex = 0;
  while (
    merged.length < limit &&
    (expiredIndex < expired.length || unsettledIndex < unsettled.length)
  ) {
    const expiredRow = expired[expiredIndex];
    const unsettledRow = unsettled[unsettledIndex];
    if (!expiredRow) {
      merged.push(unsettledRow!);
      unsettledIndex += 1;
      continue;
    }
    if (!unsettledRow) {
      merged.push(expiredRow);
      expiredIndex += 1;
      continue;
    }
    const expiredKey = [
      text(expiredRow.started_at),
      text(expiredRow.activation_id),
    ];
    const unsettledKey = [
      text(unsettledRow.started_at),
      text(unsettledRow.activation_id),
    ];
    if (
      expiredKey[0]! < unsettledKey[0]! ||
      (expiredKey[0] === unsettledKey[0] &&
        expiredKey[1]! < unsettledKey[1]!)
    ) {
      merged.push(expiredRow);
      expiredIndex += 1;
    } else {
      merged.push(unsettledRow);
      unsettledIndex += 1;
    }
  }
  return merged;
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
