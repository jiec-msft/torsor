
import * as collaboration from "./collaboration.js";
import * as db from "./database.js";
import { KernelError } from "./errors.js";
import * as execution from "./execution.js";
import * as invariants from "./invariants.js";
import type {
  CommandResult,
  KernelCommand,
  PrincipalContext
} from "./types.js";
import {
  integer,
  isTerminalRunState,
  optionalText,
  requireNonEmpty,
  text,
  type Row
} from "./values.js";

export function sendToRun(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "SendToRun";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  invariants.requireKind(kernel, principal, "human");
  if (command.expectedRunRevision === undefined) {
    throw new KernelError("InvalidCommand", "SendToRun requires an expected Run revision.");
  }
  const run = invariants.requireMutableRun(kernel, command.runId, command.expectedRunRevision);
  const created = collaboration.createMessage(kernel, {
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    replyToMessageId: text(run.thread_root_id),
    author: principal,
    activationId: null,
    body: command.body,
    targetAgentIds: command.targetAgentIds,
    suppressedAttentionAgentIds: [text(run.owner_agent_id)],
    correlationId,
  });
  const input = createRunInput(kernel, run, created.messageRevisionId, text(principal.id), null, null);
  const revision = integer(run.revision) + 1;
  db.run(kernel, `UPDATE runs
          SET revision = ?, next_input_sequence = ?, updated_at = ?
        WHERE id = ?`, revision, input.sequence + 1, db.now(kernel), command.runId);
  invariants.emitThreadEvent(kernel, {
    type: "RunInputAdded",
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    entityType: "RunInput",
    entityId: input.id,
    actorPrincipalId: text(principal.id),
    activationId: null,
    causationId: created.messageRevisionId,
    correlationId,
    payload: { runId: command.runId, sequence: input.sequence },
  });
  invariants.enqueueOutbox(kernel, "run-input.available", "Run", command.runId, { runInputId: input.id, runRevision: revision });
  return {
    commandType: command.type,
    entityId: created.messageId,
    revision,
    threadCursor: invariants.threadCursor(kernel, text(run.thread_root_id)),
    relatedIds: {
      messageRevisionId: created.messageRevisionId,
      runInputId: input.id,
      runId: command.runId,
    },
  };
}

export function cancelRun(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "CancelRun";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  invariants.requireKind(kernel, principal, "human");
  const run = invariants.requireMutableRun(kernel, command.runId, command.expectedRunRevision);
  return terminateRun(kernel, run, "Cancelled", command.reason, principal, null, correlationId, command.type);
}

export function withdrawRunInput(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "WithdrawRunInput";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const input = invariants.requireRunInput(kernel, command.runInputId);
  const run = invariants.requireMutableRun(kernel, text(input.run_id), command.expectedRunRevision);
  invariants.checkRevision(kernel, integer(input.disposition_revision), command.expectedDispositionRevision, "RunInput disposition");
  if (text(input.disposition) !== "Pending") {
    throw new KernelError("Conflict", "Only a Pending RunInput can be withdrawn.");
  }
  if (text(input.assigned_by_principal_id) !== text(principal.id)) {
    throw new KernelError("Forbidden", "Only the assigning principal can withdraw this RunInput.");
  }
  let activationId: string | null = null;
  if (text(principal.kind) === "agent") {
    activationId = text(invariants.requireRunActivation(kernel, context, principal, run).id);
  }
  else if (text(principal.kind) !== "human") {
    throw new KernelError("Forbidden", "Only the assigning Human or Agent can withdraw this RunInput.");
  }
  requireNonEmpty(command.reason, "reason");
  const runRevision = integer(run.revision) + 1;
  const dispositionRevision = integer(input.disposition_revision) + 1;
  db.run(kernel, `UPDATE run_inputs
          SET disposition = 'Withdrawn',
              disposition_revision = ?,
              disposition_reason = ?,
              superseded_by_run_input_id = NULL
        WHERE id = ?`, dispositionRevision, command.reason, command.runInputId);
  db.run(kernel, "UPDATE runs SET revision = ?, updated_at = ? WHERE id = ?", runRevision, db.now(kernel), text(run.id));
  const cursor = invariants.emitThreadEvent(kernel, {
    type: "RunInputWithdrawn",
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    entityType: "RunInput",
    entityId: command.runInputId,
    actorPrincipalId: text(principal.id),
    activationId,
    causationId: command.runInputId,
    correlationId,
    payload: {
      runId: text(run.id),
      runRevision,
      dispositionRevision,
      reason: command.reason,
    },
  });
  invariants.enqueueOutbox(kernel, "run-input.withdrawn", "RunInput", command.runInputId, { runId: text(run.id), runRevision, dispositionRevision });
  return {
    commandType: command.type,
    entityId: command.runInputId,
    revision: dispositionRevision,
    threadCursor: cursor,
    relatedIds: {
      runId: text(run.id),
      runRevision: String(runRevision),
    },
  };
}

export function publishRunReply(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "PublishRunReply";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const run = invariants.requireMutableRun(kernel, command.runId, command.expectedRunRevision);
  const activation = invariants.requireRunActivation(kernel, context, principal, run);
  const thread = invariants.requireThread(kernel, text(run.thread_root_id));
  invariants.checkThreadCursor(kernel, thread, command.expectedThreadCursor);
  const created = collaboration.createMessage(kernel, {
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    replyToMessageId: text(run.thread_root_id),
    author: principal,
    activationId: text(activation.id),
    authorAgentId: text(run.owner_agent_id),
    causedByRunId: command.runId,
    body: command.body,
    targetAgentIds: command.targetAgentIds,
    correlationId,
  });
  return {
    commandType: command.type,
    entityId: created.messageId,
    revision: integer(run.revision),
    threadCursor: created.threadCursor,
    relatedIds: {
      messageRevisionId: created.messageRevisionId,
      activationId: text(activation.id),
    },
  };
}

export function completeRun(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "CompleteRun";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const run = invariants.requireMutableRun(kernel, command.runId, command.expectedRunRevision);
  const activation = invariants.requireRunActivation(kernel, context, principal, run);
  if (!Number.isInteger(command.incorporatedThroughInputSequence) ||
    command.incorporatedThroughInputSequence < 0) {
    throw new KernelError("InvalidCommand", "The incorporated input sequence is invalid.");
  }
  const exceptions = new Map((command.exceptions ?? []).map((exception) => [
    exception.runInputId,
    exception,
  ]));
  if (exceptions.size !== (command.exceptions ?? []).length) {
    throw new KernelError("InvalidCommand", "Completion exceptions must be unique.");
  }
  const inputs = db.allRows(kernel, "SELECT * FROM run_inputs WHERE run_id = ? ORDER BY run_input_sequence", command.runId);
  const inputById = new Map(inputs.map((input) => [text(input.id), input]));
  const suppliedInputIds = new Set(db.allRows(kernel, "SELECT run_input_id FROM activation_run_inputs WHERE activation_id = ?", text(activation.id)).map((row) => text(row.run_input_id)));
  const supersession = new Map<string, string>();
  for (const input of inputs) {
    if (text(input.disposition) === "Superseded" &&
      optionalText(input.superseded_by_run_input_id)) {
      supersession.set(text(input.id), text(input.superseded_by_run_input_id));
    }
  }
  for (const [inputId, exception] of exceptions) {
    const input = inputById.get(inputId);
    if (!input) {
      throw new KernelError("InvalidCommand", `RunInput ${inputId} does not belong to the Run.`);
    }
    if (integer(input.run_input_sequence) > command.incorporatedThroughInputSequence) {
      throw new KernelError("InvalidCommand", "A completion exception cannot exceed the incorporated sequence.");
    }
    invariants.validateDisposition(kernel, exception.disposition, exception.reason);
    if (exception.disposition !== "Superseded") {
      if (exception.supersededByRunInputId) {
        throw new KernelError("InvalidCommand", "Only a Superseded disposition can reference another RunInput.");
      }
      supersession.delete(inputId);
      continue;
    }
    const targetId = exception.supersededByRunInputId;
    const target = targetId ? inputById.get(targetId) : undefined;
    if (!targetId || !target || targetId === inputId) {
      throw new KernelError("InvalidCommand", "Superseded input must reference a different RunInput in the same Run.");
    }
    supersession.set(inputId, targetId);
  }
  for (const start of supersession.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current && supersession.has(current)) {
      if (visited.has(current)) {
        throw new KernelError("InvalidCommand", "RunInput supersession cannot contain a cycle.");
      }
      visited.add(current);
      current = supersession.get(current);
    }
  }
  for (const input of inputs) {
    const sequence = integer(input.run_input_sequence);
    const exception = exceptions.get(text(input.id));
    if (text(input.disposition) !== "Pending" || sequence > command.incorporatedThroughInputSequence) {
      continue;
    }
    if (!suppliedInputIds.has(text(input.id))) {
      throw new KernelError("Forbidden", "The Activation cannot dispose a RunInput it was not supplied.", { runInputId: text(input.id), sequence });
    }
    if (exception) {
      db.run(kernel, `UPDATE run_inputs
              SET disposition = ?,
                  disposition_revision = disposition_revision + 1,
                  disposition_reason = ?,
                  superseded_by_run_input_id = ?
            WHERE id = ?`, exception.disposition, exception.reason, exception.disposition === "Superseded"
        ? exception.supersededByRunInputId!
        : null, text(input.id));
    }
    else {
      db.run(kernel, `UPDATE run_inputs
              SET disposition = 'Incorporated',
                  disposition_revision = disposition_revision + 1,
                  disposition_reason = NULL
            WHERE id = ?`, text(input.id));
    }
  }
  const pending = db.getRow(kernel, `SELECT COUNT(*) AS count FROM run_inputs
        WHERE run_id = ? AND disposition = 'Pending'`, command.runId);
  if (pending && integer(pending.count) > 0) {
    throw new KernelError("PendingRunInputs", "A Run cannot complete while it has Pending RunInput.", { pendingCount: integer(pending.count) });
  }
  let finalMessageId: string | null = null;
  if (command.finalReply) {
    const thread = invariants.requireThread(kernel, text(run.thread_root_id));
    invariants.checkThreadCursor(kernel, thread, command.finalReply.expectedThreadCursor);
    const created = collaboration.createMessage(kernel, {
      projectId: text(run.project_id),
      channelId: text(run.home_channel_id),
      threadRootId: text(run.thread_root_id),
      replyToMessageId: text(run.thread_root_id),
      author: principal,
      activationId: text(activation.id),
      authorAgentId: text(run.owner_agent_id),
      causedByRunId: command.runId,
      body: command.finalReply.body,
      targetAgentIds: command.finalReply.targetAgentIds,
      correlationId,
    });
    finalMessageId = created.messageId;
  }
  const revision = integer(run.revision) + 1;
  db.run(kernel, `UPDATE runs
          SET state = 'Completed', revision = ?, updated_at = ?, terminal_reason = NULL
        WHERE id = ?`, revision, db.now(kernel), command.runId);
  invariants.revokeRunActivations(kernel, command.runId, "run_completed", db.now(kernel));
  const cursor = invariants.emitThreadEvent(kernel, {
    type: "RunCompleted",
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    entityType: "Run",
    entityId: command.runId,
    actorPrincipalId: text(principal.id),
    activationId: text(activation.id),
    causationId: text(activation.id),
    correlationId,
    payload: { revision, finalMessageId },
  });
  invariants.enqueueOutbox(kernel, "run.completed", "Run", command.runId, { revision, finalMessageId });
  return {
    commandType: command.type,
    entityId: command.runId,
    revision,
    threadCursor: cursor,
    ...(finalMessageId ? { relatedIds: { finalMessageId } } : {}),
  };
}

export function waitRun(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "WaitRun";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const run = invariants.requireMutableRun(kernel, command.runId, command.expectedRunRevision);
  const activation = invariants.requireRunActivation(kernel, context, principal, run);
  if (text(run.state) !== "Active") {
    throw new KernelError("Conflict", "Only an Active Run can enter Waiting.");
  }
  requireNonEmpty(command.reason, "reason");
  const revision = integer(run.revision) + 1;
  db.run(kernel, "UPDATE runs SET state = 'Waiting', revision = ?, updated_at = ? WHERE id = ?", revision, db.now(kernel), command.runId);
  invariants.revokeRunActivations(kernel, command.runId, "run_waiting", db.now(kernel));
  const cursor = invariants.emitThreadEvent(kernel, {
    type: "RunWaiting",
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    entityType: "Run",
    entityId: command.runId,
    actorPrincipalId: text(principal.id),
    activationId: text(activation.id),
    causationId: text(activation.id),
    correlationId,
    payload: { revision, reason: command.reason },
  });
  invariants.enqueueOutbox(kernel, "run.waiting", "Run", command.runId, { revision, reason: command.reason });
  return {
    commandType: command.type,
    entityId: command.runId,
    revision,
    threadCursor: cursor,
  };
}

export function failRun(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "FailRun";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const run = invariants.requireMutableRun(kernel, command.runId, command.expectedRunRevision);
  const activation = invariants.requireRunActivation(kernel, context, principal, run);
  return terminateRun(kernel, run, "Failed", command.reason, principal, text(activation.id), correlationId, command.type);
}

export function recordLateOutput(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "RecordLateOutput";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  const run = invariants.requireRun(kernel, command.runId);
  const provenance = execution.validateActivityProvenance(kernel, command.runId, command.activationId, command.providerAttemptId, principal, context, true);
  const activation = invariants.requireActivation(kernel, provenance.activationId);
  if (!isTerminalRunState(text(run.state)) && invariants.isCurrentRunActivation(kernel, activation, run)) {
    throw new KernelError("Conflict", "Output from the current Activation is not late output.");
  }
  const activity = execution.insertActivity(kernel, command.runId, provenance.activationId, command.providerAttemptId ?? null, "late_output", command.payload, "durable");
  invariants.emitEvent(kernel, {
    type: "LateOutputRecorded",
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
    payload: {
      runId: command.runId,
      sequence: activity.sequence,
      runState: text(run.state),
    },
  });
  return {
    commandType: command.type,
    entityId: activity.id,
    revision: activity.sequence,
    relatedIds: { runId: command.runId },
  };
}

export function terminateRun(kernel: db.KernelContext, run: Row, state: "Failed" | "Cancelled", reason: string, principal: Row, activationId: string | null, correlationId: string, commandType: "FailRun" | "CancelRun"): CommandResult {
  requireNonEmpty(reason, "reason");
  const runId = text(run.id);
  const revision = integer(run.revision) + 1;
  db.run(kernel, `UPDATE run_inputs
          SET disposition = 'Abandoned',
              disposition_revision = disposition_revision + 1,
              disposition_reason = ?
        WHERE run_id = ? AND disposition = 'Pending'`, state === "Failed" ? "run_failed" : "run_cancelled", runId);
  db.run(kernel, `UPDATE runs
          SET state = ?, revision = ?, updated_at = ?, terminal_reason = ?
        WHERE id = ?`, state, revision, db.now(kernel), reason, runId);
  invariants.revokeRunActivations(kernel, runId, state === "Failed" ? "run_failed" : "run_cancelled", db.now(kernel));
  const cursor = invariants.emitThreadEvent(kernel, {
    type: `Run${state}`,
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    entityType: "Run",
    entityId: runId,
    actorPrincipalId: text(principal.id),
    activationId,
    causationId: activationId ?? runId,
    correlationId,
    payload: { revision, reason },
  });
  invariants.enqueueOutbox(kernel, `run.${state.toLowerCase()}`, "Run", runId, { revision, reason });
  return {
    commandType,
    entityId: runId,
    revision,
    threadCursor: cursor,
  };
}

export function createRunInput(kernel: db.KernelContext, run: Row, messageRevisionId: string, assignedByPrincipalId: string, assignedByActivationId: string | null, sourceAttentionId: string | null): {
  id: string;
  sequence: number;
} {
  const sequence = integer(run.next_input_sequence);
  const id = kernel.idFactory("run_input");
  db.run(kernel, `INSERT INTO run_inputs
        (id, run_id, message_revision_id, run_input_sequence,
         assigned_by_principal_id, assigned_by_activation_id,
         source_attention_id, created_at, disposition, disposition_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 1)`, id, text(run.id), messageRevisionId, sequence, assignedByPrincipalId, assignedByActivationId, sourceAttentionId, db.now(kernel));
  return { id, sequence };
}
