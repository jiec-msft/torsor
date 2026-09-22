import { MAX_REPORT_BYTES, MAX_REPORT_CHUNKS } from "./artifact-storage.js";
import { visibleArtifactRows } from "./artifact-visibility.js";
import * as db from "./database.js";
import { KernelError } from "./errors.js";
import * as invariants from "./invariants.js";
import { mapArtifact } from "./mappings.js";
import type {
  ArtifactView,
  CommandResult,
  FinalizeReportInput,
  PrincipalContext,
  PublishArtifactCommand,
} from "./types.js";
import { integer, requireNonEmpty, text, type Row } from "./values.js";

export function validateReportInput(input: FinalizeReportInput): void {
  const allowed = new Set([
    "runId", "expectedRunRevision", "idempotencyKey", "content",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new KernelError("InvalidCommand", "Report finalization accepts bytes, not a supplied descriptor.");
  }
  requireNonEmpty(input.runId, "runId");
  requireNonEmpty(input.idempotencyKey, "idempotencyKey");
  if (
    input.idempotencyKey.length > 256 ||
    !Number.isSafeInteger(input.expectedRunRevision) ||
    input.expectedRunRevision < 1
  ) {
    throw new KernelError("InvalidCommand", "Report key or expected Run revision is invalid.");
  }
}

export async function collectReport(
  content: FinalizeReportInput["content"],
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const append = (chunk: Uint8Array) => {
    if (
      !(chunk instanceof Uint8Array) ||
      chunks.length >= MAX_REPORT_CHUNKS ||
      size + chunk.byteLength > MAX_REPORT_BYTES
    ) {
      throw new KernelError("InvalidCommand", "Report exceeds the byte/chunk bound or contains a non-byte chunk.");
    }
    const copy = Buffer.from(chunk);
    chunks.push(copy);
    size += copy.byteLength;
  };
  if (content instanceof Uint8Array) {
    append(content);
  } else if (content && typeof content[Symbol.asyncIterator] === "function") {
    for await (const chunk of content) append(chunk);
  } else {
    throw new KernelError("InvalidCommand", "Report content must be bytes or an asynchronous byte stream.");
  }
  return Buffer.concat(chunks, size);
}

export function authorizeReport(
  kernel: db.KernelContext,
  runId: string,
  context: PrincipalContext,
): Row {
  const principal = invariants.requirePrincipal(kernel, context.principalId);
  const run = invariants.requireRun(kernel, runId);
  const activation = invariants.requireRunActivation(kernel, context, principal, run);
  authorizeRunRead(kernel, run, principal, context);
  return activation;
}

function authorizeRunRead(
  kernel: db.KernelContext,
  run: Row,
  principal: Row,
  context: PrincipalContext,
): void {
  const projectId = text(run.project_id);
  invariants.assertProjectChannel(kernel, projectId, text(run.home_channel_id));
  const scope = invariants.resolvePrincipalReadScope(kernel, principal, context, projectId);
  if (
    (scope.channelId !== null && scope.channelId !== text(run.home_channel_id)) ||
    (scope.threadRootId !== null && scope.threadRootId !== text(run.thread_root_id)) ||
    (text(principal.kind) === "agent" && scope.runId !== text(run.id))
  ) {
    throw new KernelError("Forbidden", "The current scope cannot read this Artifact Run.");
  }
}

export function getArtifact(
  kernel: db.KernelContext,
  artifactId: string,
  context: PrincipalContext,
): ArtifactView {
  const principal = invariants.requirePrincipal(kernel, context.principalId);
  const scope = text(principal.kind) === "agent"
    ? invariants.resolvePrincipalReadScope(
      kernel, principal, context,
      text(invariants.requireAgentForPrincipal(kernel, context.principalId).project_id),
    )
    : null;
  requireNonEmpty(artifactId, "artifactId");
  const [row] = visibleArtifactRows(kernel, scope, { id: artifactId });
  if (!row) {
    throw new KernelError("NotFound", "The Artifact was not found.");
  }
  return mapArtifact(row);
}

export function publishArtifact(
  kernel: db.KernelContext,
  command: PublishArtifactCommand,
  principal: Row,
  context: PrincipalContext,
  correlationId: string,
): CommandResult {
  const run = invariants.requireMutableRun(kernel, command.runId, command.expectedRunRevision);
  const activation = authorizeReport(kernel, command.runId, context);
  const artifactId = kernel.idFactory("artifact");
  const baseRevision = `run:${command.runId}@${command.expectedRunRevision}`;
  db.run(
    kernel,
    `INSERT INTO artifacts
    (id, content_digest, producer_run_id, producer_activation_id, producer_thread_root_id,
     base_revision, media_type, byte_length, visibility_channel_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    artifactId,
    command.contentDigest,
    command.runId,
    text(activation.id),
    text(run.thread_root_id),
    baseRevision,
    "text/plain; charset=utf-8",
    command.byteLength,
    text(run.home_channel_id),
    db.now(kernel),
  );
  const cursor = invariants.emitThreadEvent(kernel, {
    type: "ArtifactPublished",
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    entityType: "Artifact",
    entityId: artifactId,
    actorPrincipalId: text(principal.id),
    activationId: text(activation.id),
    causationId: command.runId,
    correlationId,
    payload: {
      runId: command.runId,
      contentDigest: command.contentDigest,
      baseRevision,
      byteLength: command.byteLength,
    },
  });
  invariants.enqueueOutbox(kernel, "artifact.published", "Artifact", artifactId, {
    runId: command.runId,
    contentDigest: command.contentDigest,
  });
  return {
    commandType: command.type,
    entityId: artifactId,
    revision: integer(run.revision),
    threadCursor: cursor,
    relatedIds: { activationId: text(activation.id), runId: command.runId },
  };
}
