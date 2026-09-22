import * as db from "./database.js";
import { KernelError } from "./errors.js";
import * as invariants from "./invariants.js";
import type {
  CommandResult,
  KernelCommand,
  PrincipalContext
} from "./types.js";
import {
  requireNonEmpty,
  text,
  unique,
  type Row
} from "./values.js";

export function startThread(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "StartThread";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  invariants.requireKind(kernel, principal, "human");
  invariants.assertProjectChannel(kernel, command.projectId, command.channelId);
  const created = createMessage(kernel, {
    projectId: command.projectId,
    channelId: command.channelId,
    author: principal,
    activationId: null,
    body: command.body,
    targetAgentIds: command.targetAgentIds,
    correlationId,
  });
  return {
    commandType: command.type,
    entityId: created.messageId,
    revision: 1,
    threadCursor: created.threadCursor,
    relatedIds: { messageRevisionId: created.messageRevisionId },
  };
}

export function replyToThread(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "ReplyToThread";
}>, principal: Row, context: PrincipalContext, correlationId: string): CommandResult {
  invariants.requireKind(kernel, principal, "human");
  const thread = invariants.requireThread(kernel, command.threadRootId);
  invariants.checkThreadCursor(kernel, thread, principal, context, command.expectedThreadCursor);
  const created = createMessage(kernel, {
    projectId: text(thread.project_id),
    channelId: text(thread.channel_id),
    threadRootId: command.threadRootId,
    replyToMessageId: command.threadRootId,
    author: principal,
    activationId: null,
    body: command.body,
    targetAgentIds: command.targetAgentIds,
    correlationId,
  });
  return {
    commandType: command.type,
    entityId: created.messageId,
    revision: 1,
    threadCursor: created.threadCursor,
    relatedIds: { messageRevisionId: created.messageRevisionId },
  };
}

export function createMessage(kernel: db.KernelContext, input: {
  projectId: string;
  channelId: string;
  threadRootId?: string;
  replyToMessageId?: string;
  author: Row;
  activationId: string | null;
  authorAgentId?: string;
  causedByAttentionId?: string;
  causedByRunId?: string;
  body: string;
  targetAgentIds?: readonly string[] | undefined;
  suppressedAttentionAgentIds?: readonly string[] | undefined;
  correlationId: string;
}): {
  messageId: string;
  messageRevisionId: string;
  threadCursor: number;
} {
  requireNonEmpty(input.body, "body");
  invariants.assertProjectChannel(kernel, input.projectId, input.channelId);
  const messageId = kernel.idFactory("message");
  const threadRootId = input.threadRootId ?? messageId;
  const revisionId = kernel.idFactory("message_revision");
  const now = db.now(kernel);
  if (!input.threadRootId) {
    db.run(kernel, "INSERT INTO threads (root_message_id, project_id, channel_id, cursor) VALUES (?, ?, ?, 0)", threadRootId, input.projectId, input.channelId);
  }
  else {
    const thread = invariants.requireThread(kernel, input.threadRootId);
    if (text(thread.project_id) !== input.projectId ||
      text(thread.channel_id) !== input.channelId) {
      throw new KernelError("Forbidden", "A Message cannot cross its Thread Channel.");
    }
  }
  const threadSequence = invariants.threadCursor(kernel, threadRootId) + 1;
  db.run(kernel, `INSERT INTO messages
        (id, project_id, channel_id, thread_root_id, reply_to_message_id,
         author_principal_id, author_agent_id, caused_by_attention_id,
         caused_by_run_id, thread_sequence, latest_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, messageId, input.projectId, input.channelId, threadRootId, input.replyToMessageId ?? null, text(input.author.id), input.authorAgentId ?? null, input.causedByAttentionId ?? null, input.causedByRunId ?? null, threadSequence, now);
  db.run(kernel, `INSERT INTO message_revisions
        (id, message_id, revision, body, tombstone, created_at)
       VALUES (?, ?, 1, ?, 0, ?)`, revisionId, messageId, input.body.trim(), now);
  const targetAgentIds = unique(input.targetAgentIds ?? []);
  for (const targetAgentId of targetAgentIds) {
    const agent = invariants.requireAgent(kernel, targetAgentId);
    if (text(agent.project_id) !== input.projectId) {
      throw new KernelError("Forbidden", "Mentioned Agents must belong to the Message Project.");
    }
    db.run(kernel, `INSERT INTO mentions (id, message_revision_id, target_agent_id, created_at)
         VALUES (?, ?, ?, ?)`, kernel.idFactory("mention"), revisionId, targetAgentId, now);
    if (targetAgentId !== input.authorAgentId &&
      !input.suppressedAttentionAgentIds?.includes(targetAgentId)) {
      const attentionId = kernel.idFactory("attention");
      db.run(kernel, `INSERT INTO attentions
            (id, project_id, channel_id, thread_root_id, message_revision_id,
             target_agent_id, trigger_kind, status, revision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'Mention', 'Open', 1, ?)`, attentionId, input.projectId, input.channelId, threadRootId, revisionId, targetAgentId, now);
      const createdEventSequence = invariants.emitEvent(kernel, {
        type: "AttentionOpened",
        projectId: input.projectId,
        channelId: input.channelId,
        threadRootId,
        threadCursor: null,
        entityType: "Attention",
        entityId: attentionId,
        actorPrincipalId: text(input.author.id),
        activationId: input.activationId,
        causationId: revisionId,
        correlationId: input.correlationId,
        payload: { targetAgentId, triggerKind: "Mention" },
      });
      db.run(kernel, "UPDATE attentions SET created_event_sequence = ? WHERE id = ?", createdEventSequence, attentionId);
      invariants.recordAttentionHistory(kernel, attentionId, createdEventSequence);
    }
  }
  const threadCursor = invariants.emitThreadEvent(kernel, {
    type: "MessagePublished",
    projectId: input.projectId,
    channelId: input.channelId,
    threadRootId,
    entityType: "Message",
    entityId: messageId,
    actorPrincipalId: text(input.author.id),
    activationId: input.activationId,
    causationId: input.causedByRunId ?? input.causedByAttentionId ?? null,
    correlationId: input.correlationId,
    payload: {
      messageRevisionId: revisionId,
      targetAgentIds,
      authorAgentId: input.authorAgentId ?? null,
    },
  });
  invariants.enqueueOutbox(kernel, "message.published", "Message", messageId, { messageRevisionId: revisionId, threadRootId });
  return { messageId, messageRevisionId: revisionId, threadCursor };
}
