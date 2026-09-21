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
  mapRun,
  mapRunInput
} from "./mappings.js";
import type {
  ActivityPage,
  ActivityWindow,
  AttentionPage,
  BootstrapProjection,
  OutboxPage,
  RunProjection,
  ThreadProjection
} from "./types.js";
import {
  integer,
  text
} from "./values.js";

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
  const rows = db.allRows(kernel, `SELECT attention.sequence, attention.id, attention.message_revision_id,
              attention.target_agent_id, attention.trigger_kind,
              history.status, history.revision,
              history.handler_lease_holder_principal_id,
              history.handler_lease_expires_at, history.resolved_run_id,
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
