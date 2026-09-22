import type { SQLInputValue } from "node:sqlite";
import * as db from "./database.js";
import type { PrincipalReadScope } from "./invariants.js";
import { optionalText, text, type Row } from "./values.js";

export function visibleArtifactRows(
  kernel: db.KernelContext,
  scope: PrincipalReadScope | null,
  filter: Readonly<{
    id?: string;
    threadRootId?: string;
    runId?: string;
    snapshotEventSequence?: number;
  }>,
): Row[] {
  const clauses = [
    "artifact.visibility_channel_id = run.home_channel_id",
    "artifact.producer_thread_root_id = run.thread_root_id",
    "channel.project_id = run.project_id",
  ];
  const parameters: SQLInputValue[] = [];
  if (scope?.threadRootId != null) {
    clauses.push(
      "run.project_id = ?", "run.home_channel_id = ?",
      "run.thread_root_id = ?", "artifact.producer_run_id = ?",
    );
    // An Attention scope binds NULL: it has no Run and cannot see any Artifact.
    parameters.push(scope.projectId, scope.channelId, scope.threadRootId, scope.runId);
  }
  if (filter.id !== undefined) {
    clauses.push("artifact.id = ?");
    parameters.push(filter.id);
  }
  if (filter.threadRootId !== undefined) {
    clauses.push("run.thread_root_id = ?");
    parameters.push(filter.threadRootId);
  }
  if (filter.runId !== undefined) {
    clauses.push("artifact.producer_run_id = ?");
    parameters.push(filter.runId);
  }
  if (filter.snapshotEventSequence !== undefined) {
    clauses.push("artifact.created_event_sequence <= ?");
    parameters.push(filter.snapshotEventSequence);
  }
  return db.allRows(kernel, `SELECT artifact.*
    FROM artifacts AS artifact
    JOIN runs AS run ON run.id = artifact.producer_run_id
    JOIN channels AS channel ON channel.id = run.home_channel_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY artifact.created_at, artifact.id`, ...parameters);
}

export function filterVisiblePublicEvents(
  kernel: db.KernelContext,
  rows: readonly Row[],
  scope: PrincipalReadScope,
): Row[] {
  return rows.filter((row) => {
    if (
      text(row.project_id) !== scope.projectId ||
      (scope.channelId !== null && optionalText(row.channel_id) !== scope.channelId) ||
      (scope.threadRootId !== null && optionalText(row.thread_root_id) !== scope.threadRootId)
    ) return false;
    if (row.entity_type === "Artifact" || row.type === "ArtifactPublished") {
      // Resolve provenance from the descriptor, never from an event payload.
      return visibleArtifactRows(kernel, scope, { id: text(row.entity_id) }).length === 1;
    }
    return true;
  });
}
