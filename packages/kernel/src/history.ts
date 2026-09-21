import * as db from "./database.js";
import {
  integer,
  optionalText,
  text,
  type Row,
} from "./values.js";

const projectionMaterializationQueryHookSymbol = Symbol.for(
  "torsor.kernel.projection-materialization-query",
);
const activationVersionCandidatesHookSymbol = Symbol.for(
  "torsor.kernel.activation-version-candidates",
);

export function recordProjectionVersions(
  kernel: db.KernelContext,
  correlationId: string,
): void {
  const boundarySql = `SELECT MAX(sequence) AS sequence
       FROM public_events
      WHERE correlation_id = ?`;
  recordQuery(boundarySql, [correlationId]);
  const boundary = db.getRow(kernel, boundarySql, correlationId);
  if (!boundary || boundary.sequence === null) {
    return;
  }
  const eventSequence = integer(boundary.sequence);

  markImmutableComponents(kernel, correlationId, eventSequence);
  const affectedRunIds = affectedRuns(kernel, correlationId);
  for (const runId of affectedRunIds) {
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
      `UPDATE run_inputs INDEXED BY run_inputs_unmarked_idx
          SET created_event_sequence = COALESCE(created_event_sequence, ?)
        WHERE run_id = ? AND created_event_sequence IS NULL`,
      eventSequence,
      runId,
    );
    db.run(
      kernel,
      `UPDATE run_activity_events INDEXED BY run_activity_unmarked_idx
          SET created_event_sequence = COALESCE(created_event_sequence, ?)
        WHERE run_id = ? AND created_event_sequence IS NULL`,
      eventSequence,
      runId,
    );
    recordRunVersion(kernel, runId, eventSequence);
  }

  for (const runInputId of affectedRunInputs(
    kernel,
    correlationId,
    affectedRunIds,
  )) {
    recordRunInputVersion(kernel, runInputId, eventSequence);
  }
  for (const activationId of affectedActivations(
    kernel,
    correlationId,
    affectedRunIds,
  )) {
    recordActivationVersion(kernel, activationId, eventSequence);
  }
  for (const providerAttemptId of eventEntityIds(
    kernel,
    correlationId,
    "ProviderAttempt",
  )) {
    recordProviderAttemptVersion(
      kernel,
      providerAttemptId,
      eventSequence,
    );
  }
  db.run(kernel, "DELETE FROM projection_activation_changes");
}

function markImmutableComponents(
  kernel: db.KernelContext,
  correlationId: string,
  eventSequence: number,
): void {
  db.run(
    kernel,
    `UPDATE threads
        SET created_event_sequence = COALESCE(created_event_sequence, ?)
      WHERE root_message_id IN (
        SELECT DISTINCT thread_root_id
          FROM public_events
         WHERE correlation_id = ?
           AND thread_root_id IS NOT NULL
      )`,
    eventSequence,
    correlationId,
  );
  db.run(
    kernel,
    `UPDATE messages
        SET created_event_sequence = COALESCE(created_event_sequence, ?)
      WHERE id IN (
        SELECT entity_id
          FROM public_events
         WHERE correlation_id = ? AND entity_type = 'Message'
      )`,
    eventSequence,
    correlationId,
  );
  db.run(
    kernel,
    `UPDATE message_revisions
        SET created_event_sequence = COALESCE(created_event_sequence, ?)
      WHERE message_id IN (
        SELECT entity_id
          FROM public_events
         WHERE correlation_id = ? AND entity_type = 'Message'
      )`,
    eventSequence,
    correlationId,
  );
  db.run(
    kernel,
    `UPDATE mentions
        SET created_event_sequence = COALESCE(created_event_sequence, ?)
      WHERE message_revision_id IN (
        SELECT revision.id
          FROM message_revisions AS revision
          JOIN public_events AS event ON event.entity_id = revision.message_id
         WHERE event.correlation_id = ? AND event.entity_type = 'Message'
      )`,
    eventSequence,
    correlationId,
  );
  markEventEntities(
    kernel,
    correlationId,
    eventSequence,
    "run_inputs",
    "RunInput",
  );
  markEventEntities(
    kernel,
    correlationId,
    eventSequence,
    "activation_attempts",
    "ActivationAttempt",
  );
  markEventEntities(
    kernel,
    correlationId,
    eventSequence,
    "provider_attempts",
    "ProviderAttempt",
  );
  markEventEntities(
    kernel,
    correlationId,
    eventSequence,
    "run_activity_events",
    "RunActivityEvent",
  );
  markEventEntities(
    kernel,
    correlationId,
    eventSequence,
    "artifacts",
    "Artifact",
  );
}

function markEventEntities(
  kernel: db.KernelContext,
  correlationId: string,
  eventSequence: number,
  table: string,
  entityType: string,
): void {
  db.run(
    kernel,
    `UPDATE ${table}
        SET created_event_sequence = COALESCE(created_event_sequence, ?)
      WHERE id IN (
        SELECT entity_id
          FROM public_events
         WHERE correlation_id = ? AND entity_type = ?
      )`,
    eventSequence,
    correlationId,
    entityType,
  );
}

function affectedRuns(
  kernel: db.KernelContext,
  correlationId: string,
): string[] {
  const sql = `SELECT event.entity_id AS run_id
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
  const parameters = Array.from({ length: 6 }, () => correlationId);
  recordQuery(sql, parameters);
  return db.allRows(kernel, sql, ...parameters).map((row) => text(row.run_id));
}

function affectedRunInputs(
  kernel: db.KernelContext,
  correlationId: string,
  affectedRunIds: readonly string[],
): string[] {
  const ids = new Set(
    eventEntityIds(kernel, correlationId, "RunInput"),
  );
  if (
    affectedRunIds.length > 0 &&
    correlationHasEvent(
      kernel,
      correlationId,
      ["RunCompleted", "RunFailed", "RunCancelled"],
    )
  ) {
    const placeholders = affectedRunIds.map(() => "?").join(", ");
    for (const row of db.allRows(
      kernel,
      `SELECT id FROM run_inputs WHERE run_id IN (${placeholders})`,
      ...affectedRunIds,
    )) {
      ids.add(text(row.id));
    }
  }
  for (const runId of affectedRunIds) {
    for (const row of db.allRows(
      kernel,
      `SELECT id
         FROM run_inputs
        WHERE run_id = ? AND created_event_sequence = ?`,
      runId,
      currentBoundarySequence(kernel, correlationId),
    )) {
      ids.add(text(row.id));
    }
  }
  return [...ids];
}

function affectedActivations(
  kernel: db.KernelContext,
  correlationId: string,
  _affectedRunIds: readonly string[],
): string[] {
  const ids = new Set(
    eventEntityIds(kernel, correlationId, "ActivationAttempt"),
  );
  for (const row of db.allRows(
    kernel,
    "SELECT activation_id FROM projection_activation_changes",
  )) {
    ids.add(text(row.activation_id));
  }
  const activationIds = [...ids];
  const hook = Reflect.get(globalThis, activationVersionCandidatesHookSymbol);
  if (typeof hook === "function") {
    hook({ activationIds: [...activationIds] });
  }
  return activationIds;
}

function eventEntityIds(
  kernel: db.KernelContext,
  correlationId: string,
  entityType: string,
): string[] {
  return db.allRows(
    kernel,
    `SELECT DISTINCT entity_id
       FROM public_events
      WHERE correlation_id = ? AND entity_type = ?`,
    correlationId,
    entityType,
  ).map((row) => text(row.entity_id));
}

function correlationHasEvent(
  kernel: db.KernelContext,
  correlationId: string,
  eventTypes: readonly string[],
): boolean {
  const placeholders = eventTypes.map(() => "?").join(", ");
  return Boolean(
    db.getRow(
      kernel,
      `SELECT 1
         FROM public_events
        WHERE correlation_id = ? AND type IN (${placeholders})
        LIMIT 1`,
      correlationId,
      ...eventTypes,
    ),
  );
}

function currentBoundarySequence(
  kernel: db.KernelContext,
  correlationId: string,
): number {
  const row = db.getRow(
    kernel,
    "SELECT MAX(sequence) AS sequence FROM public_events WHERE correlation_id = ?",
    correlationId,
  );
  return integer(row?.sequence);
}

function recordRunVersion(
  kernel: db.KernelContext,
  runId: string,
  eventSequence: number,
): void {
  const current = db.getRow(kernel, "SELECT * FROM runs WHERE id = ?", runId)!;
  const previous = latestHistory(kernel, "run_history", "run_id", runId);
  if (
    previous &&
    text(previous.state) === text(current.state) &&
    integer(previous.revision) === integer(current.revision) &&
    integer(previous.activation_generation) ===
      integer(current.activation_generation) &&
    text(previous.updated_at) === text(current.updated_at) &&
    optionalText(previous.terminal_reason) ===
      optionalText(current.terminal_reason)
  ) {
    return;
  }
  db.run(
    kernel,
    `INSERT INTO run_history
      (run_id, event_sequence, state, revision, activation_generation,
       updated_at, terminal_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    runId,
    eventSequence,
    text(current.state),
    integer(current.revision),
    integer(current.activation_generation),
    text(current.updated_at),
    optionalText(current.terminal_reason),
  );
}

function recordRunInputVersion(
  kernel: db.KernelContext,
  runInputId: string,
  eventSequence: number,
): void {
  const current = db.getRow(
    kernel,
    "SELECT * FROM run_inputs WHERE id = ?",
    runInputId,
  )!;
  const previous = latestHistory(
    kernel,
    "run_input_history",
    "run_input_id",
    runInputId,
  );
  if (
    previous &&
    text(previous.disposition) === text(current.disposition) &&
    integer(previous.disposition_revision) ===
      integer(current.disposition_revision) &&
    optionalText(previous.disposition_reason) ===
      optionalText(current.disposition_reason) &&
    optionalText(previous.superseded_by_run_input_id) ===
      optionalText(current.superseded_by_run_input_id)
  ) {
    return;
  }
  db.run(
    kernel,
    `INSERT INTO run_input_history
      (run_input_id, event_sequence, disposition, disposition_revision,
       disposition_reason, superseded_by_run_input_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    runInputId,
    eventSequence,
    text(current.disposition),
    integer(current.disposition_revision),
    optionalText(current.disposition_reason),
    optionalText(current.superseded_by_run_input_id),
  );
}

function recordActivationVersion(
  kernel: db.KernelContext,
  activationId: string,
  eventSequence: number,
): void {
  const current = db.getRow(
    kernel,
    "SELECT * FROM activation_attempts WHERE id = ?",
    activationId,
  )!;
  const previous = latestHistory(
    kernel,
    "activation_history",
    "activation_id",
    activationId,
  );
  if (
    previous &&
    optionalText(previous.revoked_at) === optionalText(current.revoked_at) &&
    optionalText(previous.revocation_reason) ===
      optionalText(current.revocation_reason) &&
    optionalText(previous.finished_at) === optionalText(current.finished_at) &&
    optionalText(previous.outcome) === optionalText(current.outcome) &&
    optionalText(previous.detail) === optionalText(current.detail)
  ) {
    return;
  }
  db.run(
    kernel,
    `INSERT INTO activation_history
      (activation_id, event_sequence, revoked_at, revocation_reason,
       finished_at, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    activationId,
    eventSequence,
    optionalText(current.revoked_at),
    optionalText(current.revocation_reason),
    optionalText(current.finished_at),
    optionalText(current.outcome),
    optionalText(current.detail),
  );
}

function recordProviderAttemptVersion(
  kernel: db.KernelContext,
  providerAttemptId: string,
  eventSequence: number,
): void {
  const current = db.getRow(
    kernel,
    "SELECT * FROM provider_attempts WHERE id = ?",
    providerAttemptId,
  )!;
  const previous = latestHistory(
    kernel,
    "provider_attempt_history",
    "provider_attempt_id",
    providerAttemptId,
  );
  if (
    previous &&
    text(previous.status) === text(current.status) &&
    optionalText(previous.detail) === optionalText(current.detail) &&
    optionalText(previous.finished_at) === optionalText(current.finished_at)
  ) {
    return;
  }
  db.run(
    kernel,
    `INSERT INTO provider_attempt_history
      (provider_attempt_id, event_sequence, status, detail, finished_at)
     VALUES (?, ?, ?, ?, ?)`,
    providerAttemptId,
    eventSequence,
    text(current.status),
    optionalText(current.detail),
    optionalText(current.finished_at),
  );
}

function latestHistory(
  kernel: db.KernelContext,
  table: string,
  idColumn: string,
  id: string,
): Row | undefined {
  return db.getRow(
    kernel,
    `SELECT *
       FROM ${table}
      WHERE ${idColumn} = ?
      ORDER BY event_sequence DESC
      LIMIT 1`,
    id,
  );
}

function recordQuery(
  sql: string,
  parameters: readonly (string | number)[],
): void {
  const hook = Reflect.get(
    globalThis,
    projectionMaterializationQueryHookSymbol,
  );
  if (typeof hook === "function") {
    hook({ sql, parameters: [...parameters] });
  }
}
