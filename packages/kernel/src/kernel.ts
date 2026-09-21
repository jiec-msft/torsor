import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { CURRENT_SCHEMA_VERSION, schemaSql } from "./schema.js";
import type {
  ActivityPage,
  ActivityWindow,
  ActivationAttemptView,
  ArtifactView,
  AttentionPage,
  AttentionView,
  BootstrapAgent,
  BootstrapChannel,
  BootstrapPrincipal,
  BootstrapProjection,
  BootstrapProject,
  CommandResult,
  JsonValue,
  KernelBootstrap,
  KernelCommand,
  KernelOpenOptions,
  KernelQuery,
  MessageRevisionView,
  MessageView,
  OutboxEventView,
  OutboxPage,
  PrincipalContext,
  ProviderAttemptView,
  PublicEventEnvelope,
  QueryResult,
  RunActivityEventView,
  RunInputDisposition,
  RunInputView,
  RunProjection,
  RunState,
  RunView,
  ThreadProjection,
} from "./types.js";

type Row = Record<string, unknown>;
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

const terminalRunStates: readonly RunState[] = [
  "Completed",
  "Failed",
  "Cancelled",
];
const schemaInitializationHookSymbol = Symbol.for(
  "torsor.kernel.schema-initialization-operation",
);
const sqliteBusyTimeoutOverrideSymbol = Symbol.for(
  "torsor.kernel.test-sqlite-busy-timeout-ms",
);
const commandBeforeCommitHookSymbol = Symbol.for(
  "torsor.kernel.command-before-commit",
);

// Internal test seam for asserting lock/read order without exposing SQLite publicly.
function recordSchemaInitializationOperation(
  operation: Readonly<{ kind: "exec" | "read"; sql: string }>,
): void {
  const hook = Reflect.get(globalThis, schemaInitializationHookSymbol);
  if (typeof hook === "function") {
    hook(operation);
  }
}

function recordCommandBeforeCommit(commandType: KernelCommand["type"]): void {
  const hook = Reflect.get(globalThis, commandBeforeCommitHookSymbol);
  if (typeof hook === "function") {
    hook({ commandType });
  }
}

function sqliteBusyTimeoutMs(): number {
  if (process.env.NODE_ENV !== "test") {
    return 5_000;
  }
  const override = Reflect.get(globalThis, sqliteBusyTimeoutOverrideSymbol);
  return typeof override === "number" &&
    Number.isInteger(override) &&
    override >= 0
    ? override
    : 5_000;
}

export class KernelError extends Error {
  constructor(
    public readonly code:
      | "NotFound"
      | "Unauthorized"
      | "Forbidden"
      | "InvalidCommand"
      | "Conflict"
      | "StaleRevision"
      | "ConditionalCheckFailed"
      | "TerminalRun"
      | "PendingRunInputs",
    message: string,
    public readonly details?: JsonValue,
  ) {
    super(message);
    this.name = "KernelError";
  }
}

export class TorsorKernel {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #activationDurationMs: number;
  #closed = false;

  private constructor(options: KernelOpenOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.#activationDurationMs = boundedDuration(
      options.activationDurationMs ?? 300_000,
      "activationDurationMs",
    );
    this.#database = new DatabaseSync(options.databasePath);
    try {
      this.#database.exec(
        `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${sqliteBusyTimeoutMs()};`,
      );
      this.#initializeSchema();
      if (options.databasePath !== ":memory:") {
        this.#database.exec("PRAGMA journal_mode = WAL;");
      }
      this.#applyBootstrap(options.bootstrap);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  static open(options: KernelOpenOptions): TorsorKernel {
    return new TorsorKernel(options);
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  async execute<C extends KernelCommand>(
    command: C,
    principalContext: PrincipalContext,
  ): Promise<CommandResult> {
    this.#assertOpen();
    const principal = this.#requirePrincipal(principalContext.principalId);
    const effectiveContext =
      text(principal.kind) === "human"
        ? { principalId: principalContext.principalId }
        : principalContext;
    if (
      command.type === "ClaimAttention" ||
      command.type === "StartActivation"
    ) {
      this.#requireKind(principal, "runtime");
    }
    const payloadHash = hashPayload(command);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const cached = this.#getRow(
        `SELECT payload_hash, result_json
           FROM idempotency_records
          WHERE principal_id = ? AND command_name = ? AND idempotency_key = ?`,
        text(principal.id),
        command.type,
        command.idempotencyKey,
      );
      if (cached) {
        if (text(cached.payload_hash) !== payloadHash) {
          throw new KernelError(
            "Conflict",
            "The idempotency key was already used with a different payload.",
          );
        }
        const result = JSON.parse(text(cached.result_json)) as CommandResult;
        if (command.type === "ClaimOutboxEvents") {
          const refreshed = this.#resolveCachedOutboxClaim(
            command,
            result,
            principal,
          );
          if (JSON.stringify(refreshed) !== JSON.stringify(result)) {
            this.#run(
              `UPDATE idempotency_records
                  SET result_json = ?
                WHERE principal_id = ? AND command_name = ? AND idempotency_key = ?`,
              JSON.stringify(refreshed),
              text(principal.id),
              command.type,
              command.idempotencyKey,
            );
          }
          this.#database.exec("COMMIT");
          return refreshed;
        }
        this.#database.exec("COMMIT");
        return result;
      }

      const correlationId = this.#idFactory("corr");
      const result = this.#dispatchCommand(
        command,
        effectiveContext,
        principal,
        correlationId,
      );
      this.#run(
        `INSERT INTO idempotency_records
          (principal_id, command_name, idempotency_key, payload_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        text(principal.id),
        command.type,
        command.idempotencyKey,
        payloadHash,
        JSON.stringify(result),
        this.#now(),
      );
      recordCommandBeforeCommit(command.type);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw this.#translateError(error);
    }
  }

  async query<Q extends KernelQuery>(
    query: Q,
    principalContext: PrincipalContext,
  ): Promise<QueryResult<Q>> {
    this.#assertOpen();
    const principal = this.#requirePrincipal(principalContext.principalId);
    this.#database.exec("BEGIN");
    try {
      let result: unknown;
      switch (query.type) {
        case "GetBootstrap": {
          this.#assertProjectAccess(principal, query.projectId);
          const agent =
            text(principal.kind) === "agent"
              ? this.#requireAgentForPrincipal(text(principal.id))
              : null;
          result = this.#getBootstrap(query.projectId, agent ? text(agent.id) : undefined);
          break;
        }
        case "GetThreadProjection": {
          const thread = this.#requireThread(query.threadRootId);
          this.#assertProjectAccess(principal, text(thread.project_id));
          this.#assertAgentQueryScope(
            principal,
            principalContext,
            text(thread.project_id),
            query.threadRootId,
          );
          result = this.#getThreadProjection(query.threadRootId);
          break;
        }
        case "GetRunProjection": {
          const run = this.#requireRun(query.runId);
          this.#assertProjectAccess(principal, text(run.project_id));
          this.#assertAgentQueryScope(
            principal,
            principalContext,
            text(run.project_id),
            text(run.thread_root_id),
            query.runId,
          );
          result = this.#getRunProjection(query.runId);
          break;
        }
        case "ListActivity": {
          const run = this.#requireRun(query.runId);
          this.#assertProjectAccess(principal, text(run.project_id));
          this.#assertAgentQueryScope(
            principal,
            principalContext,
            text(run.project_id),
            text(run.thread_root_id),
            query.runId,
          );
          result = this.#listActivity(
            query.runId,
            query.afterSequence ?? 0,
            boundedLimit(query.limit),
          );
          break;
        }
        case "ListOpenAttentions":
          {
          const snapshot = this.#resolveAttentionSnapshot(
            query.snapshotEventId,
          );
          if (text(principal.kind) === "agent") {
            const agent = this.#requireAgentForPrincipal(text(principal.id));
            if (
              query.projectId &&
              query.projectId !== text(agent.project_id)
            ) {
              throw new KernelError(
                "Forbidden",
                "The Agent cannot access this Project.",
              );
            }
            if (
              query.targetAgentId &&
              query.targetAgentId !== text(agent.id)
            ) {
              throw new KernelError(
                "Forbidden",
                "An Agent may only list its own Attention.",
              );
            }
            result = this.#listOpenAttentions(
              text(agent.project_id),
              text(agent.id),
              query.afterCursor ?? 0,
              snapshot.sequence,
              snapshot.eventId,
              boundedLimit(query.limit),
            );
            break;
          }
          if (query.projectId) {
            this.#assertProjectAccess(principal, query.projectId);
          }
          result = this.#listOpenAttentions(
            query.projectId,
            query.targetAgentId,
            query.afterCursor ?? 0,
            snapshot.sequence,
            snapshot.eventId,
            boundedLimit(query.limit),
          );
          break;
          }
        case "ListOutboxEvents":
          this.#requireKind(principal, "runtime");
          result = this.#listOutboxEvents(
            query.afterCursor ?? 0,
            boundedLimit(query.limit),
            query.includeAcknowledged ?? false,
          );
          break;
        default:
          result = assertNever(query);
      }
      this.#database.exec("COMMIT");
      return result as QueryResult<Q>;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw this.#translateError(error);
    }
  }

  /**
   * Trusted-internal event feed. Callers must apply transport authorization
   * before exposing these envelopes outside the local server/runtime boundary.
   */
  async readEvents(
    afterEventId: string | null,
    limit: number,
  ): Promise<readonly PublicEventEnvelope[]> {
    this.#assertOpen();
    const afterSequence = afterEventId
      ? this.#eventSequence(afterEventId)
      : 0;
    return this.#allRows(
      `SELECT * FROM public_events
        WHERE sequence > ?
        ORDER BY sequence
        LIMIT ?`,
      afterSequence,
      boundedLimit(limit),
    ).map(mapPublicEvent);
  }

  #dispatchCommand(
    command: KernelCommand,
    context: PrincipalContext,
    principal: Row,
    correlationId: string,
  ): CommandResult {
    switch (command.type) {
      case "StartThread":
        return this.#startThread(command, principal, context, correlationId);
      case "ReplyToThread":
        return this.#replyToThread(command, principal, context, correlationId);
      case "SendToRun":
        return this.#sendToRun(command, principal, context, correlationId);
      case "CancelRun":
        return this.#cancelRun(command, principal, context, correlationId);
      case "WithdrawRunInput":
        return this.#withdrawRunInput(
          command,
          principal,
          context,
          correlationId,
        );
      case "ClaimAttention":
        return this.#claimAttention(command, principal, correlationId);
      case "ResolveAttentionWithRun":
        return this.#resolveAttentionWithRun(
          command,
          principal,
          context,
          correlationId,
        );
      case "StartActivation":
        return this.#startActivation(command, principal, correlationId);
      case "FinishActivation":
        return this.#finishActivation(command, principal, context, correlationId);
      case "StartProviderAttempt":
        return this.#startProviderAttempt(
          command,
          principal,
          context,
          correlationId,
        );
      case "FinishProviderAttempt":
        return this.#finishProviderAttempt(
          command,
          principal,
          context,
          correlationId,
        );
      case "FailProviderAttempt":
        return this.#failProviderAttempt(
          command,
          principal,
          context,
          correlationId,
        );
      case "ClaimOutboxEvents":
        return this.#claimOutboxEvents(command, principal, correlationId);
      case "AcknowledgeOutboxEvents":
        return this.#acknowledgeOutboxEvents(command, principal, correlationId);
      case "AppendRunActivity":
        return this.#appendRunActivity(
          command,
          principal,
          context,
          correlationId,
        );
      case "PublishRunReply":
        return this.#publishRunReply(
          command,
          principal,
          context,
          correlationId,
        );
      case "PublishArtifact":
        return this.#publishArtifact(
          command,
          principal,
          context,
          correlationId,
        );
      case "CompleteRun":
        return this.#completeRun(command, principal, context, correlationId);
      case "WaitRun":
        return this.#waitRun(command, principal, context, correlationId);
      case "FailRun":
        return this.#failRun(command, principal, context, correlationId);
      case "RecordLateOutput":
        return this.#recordLateOutput(
          command,
          principal,
          context,
          correlationId,
        );
      default:
        return assertNever(command);
    }
  }

  #startThread(
    command: Extract<KernelCommand, { type: "StartThread" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    this.#requireKind(principal, "human");
    this.#assertProjectChannel(command.projectId, command.channelId);
    const created = this.#createMessage({
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

  #replyToThread(
    command: Extract<KernelCommand, { type: "ReplyToThread" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    this.#requireKind(principal, "human");
    const thread = this.#requireThread(command.threadRootId);
    this.#checkThreadCursor(thread, command.expectedThreadCursor);
    const created = this.#createMessage({
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

  #sendToRun(
    command: Extract<KernelCommand, { type: "SendToRun" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    this.#requireKind(principal, "human");
    if (command.expectedRunRevision === undefined) {
      throw new KernelError(
        "InvalidCommand",
        "SendToRun requires an expected Run revision.",
      );
    }
    const run = this.#requireMutableRun(
      command.runId,
      command.expectedRunRevision,
    );
    const created = this.#createMessage({
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
    const input = this.#createRunInput(
      run,
      created.messageRevisionId,
      text(principal.id),
      null,
      null,
    );
    const revision = integer(run.revision) + 1;
    this.#run(
      `UPDATE runs
          SET revision = ?, next_input_sequence = ?, updated_at = ?
        WHERE id = ?`,
      revision,
      input.sequence + 1,
      this.#now(),
      command.runId,
    );
    this.#emitThreadEvent({
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
    this.#enqueueOutbox(
      "run-input.available",
      "Run",
      command.runId,
      { runInputId: input.id, runRevision: revision },
    );
    return {
      commandType: command.type,
      entityId: created.messageId,
      revision,
      threadCursor: this.#threadCursor(text(run.thread_root_id)),
      relatedIds: {
        messageRevisionId: created.messageRevisionId,
        runInputId: input.id,
        runId: command.runId,
      },
    };
  }

  #cancelRun(
    command: Extract<KernelCommand, { type: "CancelRun" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    this.#requireKind(principal, "human");
    const run = this.#requireMutableRun(
      command.runId,
      command.expectedRunRevision,
    );
    return this.#terminateRun(
      run,
      "Cancelled",
      command.reason,
      principal,
      null,
      correlationId,
      command.type,
    );
  }

  #withdrawRunInput(
    command: Extract<KernelCommand, { type: "WithdrawRunInput" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const input = this.#requireRunInput(command.runInputId);
    const run = this.#requireMutableRun(
      text(input.run_id),
      command.expectedRunRevision,
    );
    this.#checkRevision(
      integer(input.disposition_revision),
      command.expectedDispositionRevision,
      "RunInput disposition",
    );
    if (text(input.disposition) !== "Pending") {
      throw new KernelError(
        "Conflict",
        "Only a Pending RunInput can be withdrawn.",
      );
    }
    if (text(input.assigned_by_principal_id) !== text(principal.id)) {
      throw new KernelError(
        "Forbidden",
        "Only the assigning principal can withdraw this RunInput.",
      );
    }
    let activationId: string | null = null;
    if (text(principal.kind) === "agent") {
      activationId = text(
        this.#requireRunActivation(context, principal, run).id,
      );
    } else if (text(principal.kind) !== "human") {
      throw new KernelError(
        "Forbidden",
        "Only the assigning Human or Agent can withdraw this RunInput.",
      );
    }
    requireNonEmpty(command.reason, "reason");
    const runRevision = integer(run.revision) + 1;
    const dispositionRevision = integer(input.disposition_revision) + 1;
    this.#run(
      `UPDATE run_inputs
          SET disposition = 'Withdrawn',
              disposition_revision = ?,
              disposition_reason = ?,
              superseded_by_run_input_id = NULL
        WHERE id = ?`,
      dispositionRevision,
      command.reason,
      command.runInputId,
    );
    this.#run(
      "UPDATE runs SET revision = ?, updated_at = ? WHERE id = ?",
      runRevision,
      this.#now(),
      text(run.id),
    );
    const cursor = this.#emitThreadEvent({
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
    this.#enqueueOutbox(
      "run-input.withdrawn",
      "RunInput",
      command.runInputId,
      { runId: text(run.id), runRevision, dispositionRevision },
    );
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

  #claimAttention(
    command: Extract<KernelCommand, { type: "ClaimAttention" }>,
    principal: Row,
    correlationId: string,
  ): CommandResult {
    this.#requireKind(principal, "runtime");
    if (
      !Number.isInteger(command.leaseDurationMs) ||
      command.leaseDurationMs < 1_000 ||
      command.leaseDurationMs > 300_000
    ) {
      throw new KernelError(
        "InvalidCommand",
        "Attention leases must be between 1 and 300 seconds.",
      );
    }
    const attention = this.#requireAttention(command.attentionId);
    if (text(attention.status) !== "Open") {
      throw new KernelError("Conflict", "The Attention is already resolved.");
    }
    this.#checkRevision(
      integer(attention.revision),
      command.expectedAttentionRevision,
      "Attention",
    );
    const now = this.#clock();
    const existingExpiry = optionalText(attention.handler_lease_expires_at);
    if (existingExpiry && new Date(existingExpiry) > now) {
      throw new KernelError("Conflict", "The Attention already has an active handler lease.");
    }
    const leaseToken = this.#idFactory("lease");
    const revision = integer(attention.revision) + 1;
    const expiresAt = new Date(now.getTime() + command.leaseDurationMs).toISOString();
    this.#run(
      `UPDATE activation_attempts
          SET revoked_at = COALESCE(revoked_at, ?),
              revocation_reason = COALESCE(revocation_reason, 'attention_lease_replaced')
        WHERE attention_id = ? AND revoked_at IS NULL`,
      now.toISOString(),
      command.attentionId,
    );
    this.#run(
      `UPDATE attentions
          SET revision = ?,
              handler_lease_holder_principal_id = ?,
              handler_lease_token = ?,
              handler_lease_expires_at = ?
        WHERE id = ?`,
      revision,
      text(principal.id),
      leaseToken,
      expiresAt,
      command.attentionId,
    );
    const eventSequence = this.#emitEvent({
      type: "AttentionClaimed",
      projectId: text(attention.project_id),
      channelId: text(attention.channel_id),
      threadRootId: text(attention.thread_root_id),
      threadCursor: null,
      entityType: "Attention",
      entityId: command.attentionId,
      actorPrincipalId: text(principal.id),
      activationId: null,
      causationId: text(attention.message_revision_id),
      correlationId,
      payload: { revision, expiresAt },
    });
    this.#recordAttentionHistory(command.attentionId, eventSequence);
    return {
      commandType: command.type,
      entityId: command.attentionId,
      revision,
      relatedIds: { handlerLeaseToken: leaseToken },
    };
  }

  #resolveAttentionWithRun(
    command: Extract<KernelCommand, { type: "ResolveAttentionWithRun" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    this.#requireKind(principal, "agent");
    const agent = this.#requireAgentForPrincipal(text(principal.id));
    const attention = this.#requireAttention(command.attentionId);
    if (text(agent.id) !== text(attention.target_agent_id)) {
      throw new KernelError("Forbidden", "An Agent may only resolve its own Attention.");
    }
    if (text(attention.status) !== "Open") {
      throw new KernelError("Conflict", "The Attention is already resolved.");
    }
    this.#checkRevision(
      integer(attention.revision),
      command.expectedAttentionRevision,
      "Attention",
    );
    this.#assertAttentionLease(attention, command.handlerLeaseToken);
    if (!context.activationId) {
      throw new KernelError(
        "Unauthorized",
        "Resolving Attention requires its authenticated Activation.",
      );
    }
    const attentionActivation = this.#requireLiveActivation(context.activationId);
    if (
      optionalText(attentionActivation.attention_id) !== command.attentionId ||
      text(attentionActivation.agent_id) !== text(agent.id)
    ) {
      throw new KernelError(
        "Forbidden",
        "The Activation does not belong to this Attention and Agent.",
      );
    }
    this.#assertActivationScopeCurrent(attentionActivation);
    const runId = this.#idFactory("run");
    const now = this.#now();
    const configRevision = integer(agent.current_config_revision);
    this.#run(
      `INSERT INTO runs
        (id, project_id, home_channel_id, thread_root_id, owner_agent_id,
         agent_config_revision, state, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Active', 1, ?, ?)`,
      runId,
      text(attention.project_id),
      text(attention.channel_id),
      text(attention.thread_root_id),
      text(agent.id),
      configRevision,
      now,
      now,
    );
    const run = this.#requireRun(runId);
    const input = this.#createRunInput(
      run,
      text(attention.message_revision_id),
      text(principal.id),
      text(attentionActivation.id),
      command.attentionId,
    );
    this.#run(
      `UPDATE activation_attempts
          SET revoked_at = COALESCE(revoked_at, ?),
              revocation_reason = COALESCE(revocation_reason, 'attention_resolved')
        WHERE id = ?`,
      now,
      text(attentionActivation.id),
    );
    this.#run(
      `UPDATE runs SET next_input_sequence = 2 WHERE id = ?`,
      runId,
    );
    const revision = integer(attention.revision) + 1;
    this.#run(
      `UPDATE attentions
          SET status = 'Resolved',
              revision = ?,
              resolution_outcome = 'RunCreated',
              resolved_by_principal_id = ?,
              resolved_activation_id = ?,
              resolved_run_id = ?,
              resolved_at = ?,
              handler_lease_token = NULL,
              handler_lease_expires_at = NULL
        WHERE id = ?`,
      revision,
      text(principal.id),
      text(attentionActivation.id),
      runId,
      now,
      command.attentionId,
    );
    const cursor = this.#emitThreadEvent({
      type: "RunCreated",
      projectId: text(attention.project_id),
      channelId: text(attention.channel_id),
      threadRootId: text(attention.thread_root_id),
      entityType: "Run",
      entityId: runId,
      actorPrincipalId: text(principal.id),
      activationId: text(attentionActivation.id),
      causationId: command.attentionId,
      correlationId,
      payload: { state: "Active", ownerAgentId: text(agent.id) },
    });
    const attentionEventSequence = this.#emitEvent({
      type: "AttentionResolved",
      projectId: text(attention.project_id),
      channelId: text(attention.channel_id),
      threadRootId: text(attention.thread_root_id),
      threadCursor: null,
      entityType: "Attention",
      entityId: command.attentionId,
      actorPrincipalId: text(principal.id),
      activationId: text(attentionActivation.id),
      causationId: text(attention.message_revision_id),
      correlationId,
      payload: { outcome: "RunCreated", runId },
    });
    this.#recordAttentionHistory(command.attentionId, attentionEventSequence);
    this.#enqueueOutbox(
      "run.activation-requested",
      "Run",
      runId,
      { runInputId: input.id, sourceAttentionId: command.attentionId },
    );
    return {
      commandType: command.type,
      entityId: runId,
      revision: 1,
      threadCursor: cursor,
      relatedIds: {
        attentionId: command.attentionId,
        runInputId: input.id,
      },
    };
  }

  #startActivation(
    command: Extract<KernelCommand, { type: "StartActivation" }>,
    principal: Row,
    correlationId: string,
  ): CommandResult {
    this.#requireKind(principal, "runtime");
    if ((command.runId ? 1 : 0) + (command.attentionId ? 1 : 0) !== 1) {
      throw new KernelError(
        "InvalidCommand",
        "StartActivation requires exactly one Run or Attention cause.",
      );
    }
    let agent: Row;
    let runId: string | null = null;
    let attentionId: string | null = null;
    let attentionLeaseToken: string | null = null;
    let runActivationGeneration: number | null = null;
    let resultRunRevision: number | undefined;
    let configRevision: number;
    let projectId: string;
    let channelId: string;
    let threadRootId: string;
    const durationMs = boundedDuration(
      command.durationMs ?? this.#activationDurationMs,
      "durationMs",
    );
    const now = this.#clock();
    let expiresAt = new Date(now.getTime() + durationMs).toISOString();
    if (command.runId) {
      if (command.expectedRunRevision === undefined) {
        throw new KernelError(
          "InvalidCommand",
          "Run Activation requires an expected Run revision.",
        );
      }
      const run = this.#requireMutableRun(
        command.runId,
        command.expectedRunRevision,
      );
      runId = command.runId;
      agent = this.#requireAgent(text(run.owner_agent_id));
      configRevision = integer(run.agent_config_revision);
      projectId = text(run.project_id);
      channelId = text(run.home_channel_id);
      threadRootId = text(run.thread_root_id);
      runActivationGeneration = integer(run.activation_generation) + 1;
      this.#revokeRunActivations(
        command.runId,
        "superseded_activation",
        now.toISOString(),
      );
      if (text(run.state) === "Waiting") {
        const revision = integer(run.revision) + 1;
        this.#run(
          `UPDATE runs
              SET state = 'Active',
                  revision = ?,
                  activation_generation = ?,
                  updated_at = ?
            WHERE id = ?`,
          revision,
          runActivationGeneration,
          now.toISOString(),
          command.runId,
        );
        resultRunRevision = revision;
        this.#emitThreadEvent({
          type: "RunActivated",
          projectId,
          channelId,
          threadRootId,
          entityType: "Run",
          entityId: command.runId,
          actorPrincipalId: text(principal.id),
          activationId: null,
          causationId: command.runId,
          correlationId,
          payload: { revision },
        });
        this.#enqueueOutbox(
          "run.activated",
          "Run",
          command.runId,
          { revision },
        );
      } else {
        this.#run(
          `UPDATE runs
              SET activation_generation = ?, updated_at = ?
            WHERE id = ?`,
          runActivationGeneration,
          now.toISOString(),
          command.runId,
        );
        resultRunRevision = integer(run.revision);
      }
    } else {
      const attention = this.#requireAttention(command.attentionId!);
      if (text(attention.status) !== "Open") {
        throw new KernelError("Conflict", "The Attention is already resolved.");
      }
      this.#assertAttentionLease(attention, command.handlerLeaseToken);
      attentionId = command.attentionId!;
      attentionLeaseToken = command.handlerLeaseToken!;
      const leaseExpiry = new Date(text(attention.handler_lease_expires_at));
      if (leaseExpiry.toISOString() < expiresAt) {
        expiresAt = leaseExpiry.toISOString();
      }
      const existing = this.#getRow(
        `SELECT id
           FROM activation_attempts
          WHERE attention_id = ? AND attention_lease_token = ?`,
        attentionId,
        attentionLeaseToken,
      );
      if (existing) {
        return {
          commandType: command.type,
          entityId: text(existing.id),
          relatedIds: {
            agentId: text(attention.target_agent_id),
            attentionId,
          },
        };
      }
      agent = this.#requireAgent(text(attention.target_agent_id));
      configRevision = integer(agent.current_config_revision);
      projectId = text(attention.project_id);
      channelId = text(attention.channel_id);
      threadRootId = text(attention.thread_root_id);
    }
    const activationId = this.#idFactory("activation");
    this.#run(
      `INSERT INTO activation_attempts
        (id, agent_id, run_id, attention_id, attention_lease_token,
         run_activation_generation, cause, config_revision, started_at,
         expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      activationId,
      text(agent.id),
      runId,
      attentionId,
      attentionLeaseToken,
      runActivationGeneration,
      runId ? "Run" : "Attention",
      configRevision,
      now.toISOString(),
      expiresAt,
    );
    if (runId) {
      const inputs = this.#allRows(
        `SELECT id, run_input_sequence
           FROM run_inputs
          WHERE run_id = ?
          ORDER BY run_input_sequence`,
        runId,
      );
      for (const input of inputs) {
        this.#run(
          `INSERT INTO activation_run_inputs
            (activation_id, run_input_id, run_input_sequence)
           VALUES (?, ?, ?)`,
          activationId,
          text(input.id),
          integer(input.run_input_sequence),
        );
      }
    }
    this.#emitEvent({
      type: "ActivationStarted",
      projectId,
      channelId,
      threadRootId,
      threadCursor: null,
      entityType: "ActivationAttempt",
      entityId: activationId,
      actorPrincipalId: text(principal.id),
      activationId,
      causationId: runId ?? attentionId,
      correlationId,
      payload: {
        runId,
        attentionId,
        agentId: text(agent.id),
        configRevision,
        runActivationGeneration,
        expiresAt,
      },
    });
    return {
      commandType: command.type,
      entityId: activationId,
      ...(resultRunRevision === undefined
        ? {}
        : { revision: resultRunRevision }),
      relatedIds: {
        agentId: text(agent.id),
        ...(runId ? { runId } : { attentionId: attentionId! }),
      },
    };
  }

  #finishActivation(
    command: Extract<KernelCommand, { type: "FinishActivation" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const activation = this.#requireActivation(command.activationId);
    this.#authorizeActivationActor(principal, context, activation);
    if (text(principal.kind) === "agent") {
      this.#assertActivationScopeCurrent(activation);
    }
    if (activation.finished_at !== null) {
      throw new KernelError("Conflict", "The Activation is already finished.");
    }
    const now = this.#now();
    this.#run(
      `UPDATE activation_attempts
          SET finished_at = ?, outcome = ?, detail = ?
        WHERE id = ?`,
      now,
      command.outcome,
      command.detail ?? null,
      command.activationId,
    );
    const scope = this.#activationScope(activation);
    this.#emitEvent({
      type: "ActivationFinished",
      ...scope,
      threadCursor: null,
      entityType: "ActivationAttempt",
      entityId: command.activationId,
      actorPrincipalId: text(principal.id),
      activationId: command.activationId,
      causationId:
        optionalText(activation.run_id) ?? optionalText(activation.attention_id),
      correlationId,
      payload: { outcome: command.outcome },
    });
    return {
      commandType: command.type,
      entityId: command.activationId,
      relatedIds: { outcome: command.outcome },
    };
  }

  #startProviderAttempt(
    command: Extract<KernelCommand, { type: "StartProviderAttempt" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const activation = this.#requireLiveActivation(command.activationId);
    this.#authorizeActivationActor(principal, context, activation);
    this.#assertActivationScopeCurrent(activation);
    const runId = optionalText(activation.run_id);
    const runInputIds = unique(command.runInputIds);
    for (const inputId of runInputIds) {
      const input = this.#getRow(
        "SELECT run_id, disposition FROM run_inputs WHERE id = ?",
        inputId,
      );
      if (!input) {
        throw new KernelError("NotFound", `RunInput ${inputId} does not exist.`);
      }
      if (!runId || text(input.run_id) !== runId) {
        throw new KernelError("Forbidden", "Provider input must belong to the Activation Run.");
      }
      if (text(input.disposition) !== "Pending") {
        throw new KernelError(
          "Conflict",
          "Provider input must still be Pending when delivery starts.",
        );
      }
      const supplied = this.#getRow(
        `SELECT 1 AS present
           FROM activation_run_inputs
          WHERE activation_id = ? AND run_input_id = ?`,
        command.activationId,
        inputId,
      );
      if (!supplied) {
        throw new KernelError(
          "Forbidden",
          "Provider input was not supplied to this Activation.",
        );
      }
    }
    const providerAttemptId = this.#idFactory("provider");
    this.#run(
      `INSERT INTO provider_attempts
        (id, activation_id, run_id, adapter, adapter_version,
         capability_snapshot_json, run_input_ids_json, request_idempotency_key,
         diagnostic_session_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Started', ?)`,
      providerAttemptId,
      command.activationId,
      runId,
      command.adapter,
      command.adapterVersion,
      JSON.stringify(command.capabilitySnapshot),
      JSON.stringify(runInputIds),
      command.requestIdempotencyKey,
      command.diagnosticSessionId ?? null,
      this.#now(),
    );
    const scope = this.#activationScope(activation);
    this.#emitEvent({
      type: "ProviderAttemptStarted",
      ...scope,
      threadCursor: null,
      entityType: "ProviderAttempt",
      entityId: providerAttemptId,
      actorPrincipalId: text(principal.id),
      activationId: command.activationId,
      causationId: command.activationId,
      correlationId,
      payload: {
        adapter: command.adapter,
        adapterVersion: command.adapterVersion,
        runInputIds: unique(command.runInputIds),
      },
    });
    return {
      commandType: command.type,
      entityId: providerAttemptId,
      relatedIds: { activationId: command.activationId },
    };
  }

  #finishProviderAttempt(
    command: Extract<KernelCommand, { type: "FinishProviderAttempt" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    if (
      !["Acknowledged", "Completed", "Unknown"].includes(
        command.status as string,
      )
    ) {
      throw new KernelError(
        "InvalidCommand",
        "FinishProviderAttempt status must be Acknowledged, Completed, or Unknown.",
      );
    }
    return this.#setProviderAttemptStatus(
      command.providerAttemptId,
      command.status,
      command.detail ?? null,
      command.type,
      principal,
      context,
      correlationId,
    );
  }

  #failProviderAttempt(
    command: Extract<KernelCommand, { type: "FailProviderAttempt" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    return this.#setProviderAttemptStatus(
      command.providerAttemptId,
      "Failed",
      command.error,
      command.type,
      principal,
      context,
      correlationId,
    );
  }

  #setProviderAttemptStatus(
    providerAttemptId: string,
    status: "Acknowledged" | "Completed" | "Failed" | "Unknown",
    detail: string | null,
    commandType: "FinishProviderAttempt" | "FailProviderAttempt",
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const attempt = this.#requireProviderAttempt(providerAttemptId);
    const activation = this.#requireActivation(text(attempt.activation_id));
    if (text(principal.kind) === "agent") {
      if (activation.finished_at !== null) {
        throw new KernelError(
          "Forbidden",
          "Only runtime reconciliation can settle a ProviderAttempt after its Activation ends.",
        );
      }
      this.#assertActivationScopeCurrent(activation);
    }
    this.#authorizeActivationActor(principal, context, activation, true);
    if (!["Started", "Acknowledged"].includes(text(attempt.status))) {
      throw new KernelError("Conflict", "The ProviderAttempt is already finished.");
    }
    if (text(attempt.status) === "Acknowledged" && status === "Acknowledged") {
      throw new KernelError("Conflict", "The ProviderAttempt is already acknowledged.");
    }
    if (status === "Unknown") {
      requireNonEmpty(detail ?? "", "Unknown reason");
    }
    const finishedAt = status === "Acknowledged" ? null : this.#now();
    this.#run(
      `UPDATE provider_attempts
          SET status = ?, detail = ?, finished_at = ?
        WHERE id = ?`,
      status,
      detail,
      finishedAt,
      providerAttemptId,
    );
    const scope = this.#activationScope(activation);
    this.#emitEvent({
      type:
        status === "Acknowledged"
          ? "ProviderAttemptAcknowledged"
          : "ProviderAttemptFinished",
      ...scope,
      threadCursor: null,
      entityType: "ProviderAttempt",
      entityId: providerAttemptId,
      actorPrincipalId: text(principal.id),
      activationId: text(attempt.activation_id),
      causationId: text(attempt.activation_id),
      correlationId,
      payload: { status, detail },
    });
    return {
      commandType,
      entityId: providerAttemptId,
      relatedIds: { status },
    };
  }

  #appendRunActivity(
    command: Extract<KernelCommand, { type: "AppendRunActivity" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const provenance = this.#validateActivityProvenance(
      command.runId,
      command.activationId,
      command.providerAttemptId,
      principal,
      context,
    );
    const activity = this.#insertActivity(
      command.runId,
      provenance.activationId,
      command.providerAttemptId ?? null,
      command.kind,
      command.payload,
      command.retentionClass,
    );
    const run = this.#requireRun(command.runId);
    this.#emitEvent({
      type: "RunActivityAppended",
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
      payload: { runId: command.runId, sequence: activity.sequence, kind: command.kind },
    });
    return {
      commandType: command.type,
      entityId: activity.id,
      revision: activity.sequence,
      relatedIds: { runId: command.runId },
    };
  }

  #claimOutboxEvents(
    command: Extract<KernelCommand, { type: "ClaimOutboxEvents" }>,
    principal: Row,
    _correlationId: string,
  ): CommandResult {
    this.#requireKind(principal, "runtime");
    const limit = boundedLimit(command.limit);
    const leaseDurationMs = boundedDuration(
      command.leaseDurationMs,
      "leaseDurationMs",
    );
    const now = this.#clock();
    const leaseToken = this.#idFactory("outbox_lease");
    const leaseExpiresAt = new Date(
      now.getTime() + leaseDurationMs,
    ).toISOString();
    const candidates = this.#allRows(
      `SELECT id, lease_expires_at
         FROM outbox_events
        WHERE acknowledged_at IS NULL
        ORDER BY sequence
        LIMIT ?`,
      limit,
    );
    const claimable: Row[] = [];
    for (const candidate of candidates) {
      const currentExpiry = optionalText(candidate.lease_expires_at);
      if (currentExpiry && new Date(currentExpiry) > now) {
        break;
      }
      claimable.push(candidate);
    }
    for (const candidate of claimable) {
      this.#run(
        `UPDATE outbox_events
            SET lease_holder_principal_id = ?,
                lease_token = ?,
                lease_expires_at = ?,
                delivery_attempts = delivery_attempts + 1
          WHERE id = ?`,
        text(principal.id),
        leaseToken,
        leaseExpiresAt,
        text(candidate.id),
      );
    }
    const outboxEvents = claimable.map((candidate) =>
      mapOutboxEvent(this.#requireOutboxEvent(text(candidate.id))),
    );
    return {
      commandType: command.type,
      entityId: leaseToken,
      leaseToken,
      outboxEvents,
    };
  }

  #acknowledgeOutboxEvents(
    command: Extract<KernelCommand, { type: "AcknowledgeOutboxEvents" }>,
    principal: Row,
    correlationId: string,
  ): CommandResult {
    this.#requireKind(principal, "runtime");
    if (command.outboxEventIds.length === 0) {
      throw new KernelError(
        "InvalidCommand",
        "At least one OutboxEvent is required.",
      );
    }
    const ids = unique(command.outboxEventIds);
    if (ids.length !== command.outboxEventIds.length) {
      throw new KernelError(
        "InvalidCommand",
        "Outbox acknowledgement must not contain duplicate event IDs.",
      );
    }
    requireNonEmpty(command.leaseToken, "leaseToken");
    const now = this.#now();
    const leasedRows = this.#allRows(
      `SELECT id, sequence
         FROM outbox_events
        WHERE acknowledged_at IS NULL
          AND lease_holder_principal_id = ?
          AND lease_token = ?
        ORDER BY sequence`,
      text(principal.id),
      command.leaseToken,
    );
    const leasedIds = leasedRows.map((row) => text(row.id));
    if (
      leasedIds.length !== ids.length ||
      leasedIds.some((id, index) => id !== ids[index])
    ) {
      throw new KernelError(
        "InvalidCommand",
        "Outbox acknowledgement must include the entire leased batch in cursor order.",
      );
    }
    const pendingPrefix = this.#allRows(
      `SELECT id, sequence
         FROM outbox_events
        WHERE acknowledged_at IS NULL
        ORDER BY sequence
        LIMIT ?`,
      leasedRows.length,
    );
    if (
      pendingPrefix.length !== leasedRows.length ||
      pendingPrefix.some(
        (row, index) =>
          text(row.id) !== text(leasedRows[index]!.id) ||
          integer(row.sequence) !== integer(leasedRows[index]!.sequence),
      )
    ) {
      throw new KernelError(
        "Conflict",
        "Outbox acknowledgement must exactly advance the oldest pending prefix.",
      );
    }
    const events = ids.map((id) => this.#requireOutboxEvent(id));
    for (const event of events) {
      const id = text(event.id);
      if (event.acknowledged_at !== null) {
        throw new KernelError("Conflict", `OutboxEvent ${id} is already acknowledged.`);
      }
      if (
        optionalText(event.lease_holder_principal_id) !== text(principal.id) ||
        optionalText(event.lease_token) !== command.leaseToken ||
        !optionalText(event.lease_expires_at) ||
        new Date(text(event.lease_expires_at)) <= this.#clock()
      ) {
        throw new KernelError(
          "Conflict",
          `OutboxEvent ${id} is not held by the current live lease.`,
        );
      }
    }
    for (const event of events) {
      this.#run(
        `UPDATE outbox_events
            SET acknowledged_at = ?,
                acknowledged_by_principal_id = ?,
                lease_holder_principal_id = NULL,
                lease_token = NULL,
                lease_expires_at = NULL
          WHERE id = ?`,
        now,
        text(principal.id),
        text(event.id),
      );
    }
    return {
      commandType: command.type,
      entityId: command.leaseToken,
      relatedIds: {
        acknowledgedCount: String(ids.length),
        correlationId,
      },
    };
  }

  #resolveCachedOutboxClaim(
    command: Extract<KernelCommand, { type: "ClaimOutboxEvents" }>,
    result: CommandResult,
    principal: Row,
  ): CommandResult {
    if (
      !result.leaseToken ||
      !result.outboxEvents ||
      result.outboxEvents.length === 0
    ) {
      return result;
    }
    const now = this.#clock();
    const originalIds = result.outboxEvents.map((event) => event.id);
    const rows = originalIds.map((id) =>
      this.#getRow("SELECT * FROM outbox_events WHERE id = ?", id),
    );
    if (
      rows.some(
        (row) =>
          row === undefined ||
          row.acknowledged_at !== null,
      )
    ) {
      return result;
    }
    const typedRows = rows as Row[];
    const originalLeaseIsLive = typedRows.every(
      (row) =>
        optionalText(row.lease_holder_principal_id) === text(principal.id) &&
        optionalText(row.lease_token) === result.leaseToken &&
        optionalText(row.lease_expires_at) !== null &&
        new Date(text(row.lease_expires_at)) > now,
    );
    if (originalLeaseIsLive) {
      return result;
    }
    const anotherLiveLease = typedRows.some((row) => {
      const expiry = optionalText(row.lease_expires_at);
      return expiry !== null && new Date(expiry) > now;
    });
    if (anotherLiveLease) {
      return result;
    }
    const frontier = this.#allRows(
      `SELECT id
         FROM outbox_events
        WHERE acknowledged_at IS NULL
        ORDER BY sequence
        LIMIT ?`,
      originalIds.length,
    ).map((row) => text(row.id));
    if (
      frontier.length !== originalIds.length ||
      frontier.some((id, index) => id !== originalIds[index])
    ) {
      return result;
    }
    const leaseDurationMs = boundedDuration(
      command.leaseDurationMs,
      "leaseDurationMs",
    );
    const leaseToken = this.#idFactory("outbox_lease");
    const leaseExpiresAt = new Date(
      now.getTime() + leaseDurationMs,
    ).toISOString();
    for (const id of originalIds) {
      this.#run(
        `UPDATE outbox_events
            SET lease_holder_principal_id = ?,
                lease_token = ?,
                lease_expires_at = ?,
                delivery_attempts = delivery_attempts + 1
          WHERE id = ?`,
        text(principal.id),
        leaseToken,
        leaseExpiresAt,
        id,
      );
    }
    return {
      ...result,
      entityId: leaseToken,
      leaseToken,
      outboxEvents: originalIds.map((id) =>
        mapOutboxEvent(this.#requireOutboxEvent(id)),
      ),
    };
  }

  #publishRunReply(
    command: Extract<KernelCommand, { type: "PublishRunReply" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const run = this.#requireMutableRun(
      command.runId,
      command.expectedRunRevision,
    );
    const activation = this.#requireRunActivation(context, principal, run);
    const thread = this.#requireThread(text(run.thread_root_id));
    this.#checkThreadCursor(thread, command.expectedThreadCursor);
    const created = this.#createMessage({
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

  #publishArtifact(
    command: Extract<KernelCommand, { type: "PublishArtifact" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const run = this.#requireMutableRun(
      command.runId,
      command.expectedRunRevision,
    );
    const activation = this.#requireRunActivation(context, principal, run);
    requireNonEmpty(command.contentDigest, "contentDigest");
    requireNonEmpty(command.baseRevision, "baseRevision");
    requireNonEmpty(command.mediaType, "mediaType");
    requireNonEmpty(command.storageLocation, "storageLocation");
    const artifactId = this.#idFactory("artifact");
    this.#run(
      `INSERT INTO artifacts
        (id, content_digest, producer_run_id, producer_activation_id,
         base_revision, media_type, storage_location, visibility_channel_id,
         metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      artifactId,
      command.contentDigest,
      command.runId,
      text(activation.id),
      command.baseRevision,
      command.mediaType,
      command.storageLocation,
      text(run.home_channel_id),
      command.metadata === undefined ? null : JSON.stringify(command.metadata),
      this.#now(),
    );
    const cursor = this.#emitThreadEvent({
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
        baseRevision: command.baseRevision,
      },
    });
    this.#enqueueOutbox(
      "artifact.published",
      "Artifact",
      artifactId,
      { runId: command.runId, contentDigest: command.contentDigest },
    );
    return {
      commandType: command.type,
      entityId: artifactId,
      revision: integer(run.revision),
      threadCursor: cursor,
      relatedIds: { activationId: text(activation.id), runId: command.runId },
    };
  }

  #completeRun(
    command: Extract<KernelCommand, { type: "CompleteRun" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const run = this.#requireMutableRun(
      command.runId,
      command.expectedRunRevision,
    );
    const activation = this.#requireRunActivation(context, principal, run);
    if (
      !Number.isInteger(command.incorporatedThroughInputSequence) ||
      command.incorporatedThroughInputSequence < 0
    ) {
      throw new KernelError("InvalidCommand", "The incorporated input sequence is invalid.");
    }
    const exceptions = new Map(
      (command.exceptions ?? []).map((exception) => [
        exception.runInputId,
        exception,
      ]),
    );
    if (exceptions.size !== (command.exceptions ?? []).length) {
      throw new KernelError("InvalidCommand", "Completion exceptions must be unique.");
    }
    const inputs = this.#allRows(
      "SELECT * FROM run_inputs WHERE run_id = ? ORDER BY run_input_sequence",
      command.runId,
    );
    const inputById = new Map(inputs.map((input) => [text(input.id), input]));
    const suppliedInputIds = new Set(
      this.#allRows(
        "SELECT run_input_id FROM activation_run_inputs WHERE activation_id = ?",
        text(activation.id),
      ).map((row) => text(row.run_input_id)),
    );
    const supersession = new Map<string, string>();
    for (const input of inputs) {
      if (
        text(input.disposition) === "Superseded" &&
        optionalText(input.superseded_by_run_input_id)
      ) {
        supersession.set(
          text(input.id),
          text(input.superseded_by_run_input_id),
        );
      }
    }
    for (const [inputId, exception] of exceptions) {
      const input = inputById.get(inputId);
      if (!input) {
        throw new KernelError(
          "InvalidCommand",
          `RunInput ${inputId} does not belong to the Run.`,
        );
      }
      if (integer(input.run_input_sequence) > command.incorporatedThroughInputSequence) {
        throw new KernelError(
          "InvalidCommand",
          "A completion exception cannot exceed the incorporated sequence.",
        );
      }
      this.#validateDisposition(exception.disposition, exception.reason);
      if (exception.disposition !== "Superseded") {
        if (exception.supersededByRunInputId) {
          throw new KernelError(
            "InvalidCommand",
            "Only a Superseded disposition can reference another RunInput.",
          );
        }
        supersession.delete(inputId);
        continue;
      }
      const targetId = exception.supersededByRunInputId;
      const target = targetId ? inputById.get(targetId) : undefined;
      if (!targetId || !target || targetId === inputId) {
        throw new KernelError(
          "InvalidCommand",
          "Superseded input must reference a different RunInput in the same Run.",
        );
      }
      supersession.set(inputId, targetId);
    }
    for (const start of supersession.keys()) {
      const visited = new Set<string>();
      let current: string | undefined = start;
      while (current && supersession.has(current)) {
        if (visited.has(current)) {
          throw new KernelError(
            "InvalidCommand",
            "RunInput supersession cannot contain a cycle.",
          );
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
        throw new KernelError(
          "Forbidden",
          "The Activation cannot dispose a RunInput it was not supplied.",
          { runInputId: text(input.id), sequence },
        );
      }
      if (exception) {
        this.#run(
          `UPDATE run_inputs
              SET disposition = ?,
                  disposition_revision = disposition_revision + 1,
                  disposition_reason = ?,
                  superseded_by_run_input_id = ?
            WHERE id = ?`,
          exception.disposition,
          exception.reason,
          exception.disposition === "Superseded"
            ? exception.supersededByRunInputId!
            : null,
          text(input.id),
        );
      } else {
        this.#run(
          `UPDATE run_inputs
              SET disposition = 'Incorporated',
                  disposition_revision = disposition_revision + 1,
                  disposition_reason = NULL
            WHERE id = ?`,
          text(input.id),
        );
      }
    }
    const pending = this.#getRow(
      `SELECT COUNT(*) AS count FROM run_inputs
        WHERE run_id = ? AND disposition = 'Pending'`,
      command.runId,
    );
    if (pending && integer(pending.count) > 0) {
      throw new KernelError(
        "PendingRunInputs",
        "A Run cannot complete while it has Pending RunInput.",
        { pendingCount: integer(pending.count) },
      );
    }
    let finalMessageId: string | null = null;
    if (command.finalReply) {
      const thread = this.#requireThread(text(run.thread_root_id));
      this.#checkThreadCursor(thread, command.finalReply.expectedThreadCursor);
      const created = this.#createMessage({
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
    this.#run(
      `UPDATE runs
          SET state = 'Completed', revision = ?, updated_at = ?, terminal_reason = NULL
        WHERE id = ?`,
      revision,
      this.#now(),
      command.runId,
    );
    this.#revokeRunActivations(
      command.runId,
      "run_completed",
      this.#now(),
    );
    const cursor = this.#emitThreadEvent({
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
    this.#enqueueOutbox(
      "run.completed",
      "Run",
      command.runId,
      { revision, finalMessageId },
    );
    return {
      commandType: command.type,
      entityId: command.runId,
      revision,
      threadCursor: cursor,
      ...(finalMessageId ? { relatedIds: { finalMessageId } } : {}),
    };
  }

  #waitRun(
    command: Extract<KernelCommand, { type: "WaitRun" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const run = this.#requireMutableRun(
      command.runId,
      command.expectedRunRevision,
    );
    const activation = this.#requireRunActivation(context, principal, run);
    if (text(run.state) !== "Active") {
      throw new KernelError("Conflict", "Only an Active Run can enter Waiting.");
    }
    requireNonEmpty(command.reason, "reason");
    const revision = integer(run.revision) + 1;
    this.#run(
      "UPDATE runs SET state = 'Waiting', revision = ?, updated_at = ? WHERE id = ?",
      revision,
      this.#now(),
      command.runId,
    );
    this.#revokeRunActivations(
      command.runId,
      "run_waiting",
      this.#now(),
    );
    const cursor = this.#emitThreadEvent({
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
    this.#enqueueOutbox(
      "run.waiting",
      "Run",
      command.runId,
      { revision, reason: command.reason },
    );
    return {
      commandType: command.type,
      entityId: command.runId,
      revision,
      threadCursor: cursor,
    };
  }

  #failRun(
    command: Extract<KernelCommand, { type: "FailRun" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const run = this.#requireMutableRun(
      command.runId,
      command.expectedRunRevision,
    );
    const activation = this.#requireRunActivation(context, principal, run);
    return this.#terminateRun(
      run,
      "Failed",
      command.reason,
      principal,
      text(activation.id),
      correlationId,
      command.type,
    );
  }

  #recordLateOutput(
    command: Extract<KernelCommand, { type: "RecordLateOutput" }>,
    principal: Row,
    context: PrincipalContext,
    correlationId: string,
  ): CommandResult {
    const run = this.#requireRun(command.runId);
    const provenance = this.#validateActivityProvenance(
      command.runId,
      command.activationId,
      command.providerAttemptId,
      principal,
      context,
      true,
    );
    const activation = this.#requireActivation(provenance.activationId);
    if (
      !terminalRunStates.includes(text(run.state) as RunState) &&
      this.#isCurrentRunActivation(activation, run)
    ) {
      throw new KernelError(
        "Conflict",
        "Output from the current Activation is not late output.",
      );
    }
    const activity = this.#insertActivity(
      command.runId,
      provenance.activationId,
      command.providerAttemptId ?? null,
      "late_output",
      command.payload,
      "durable",
    );
    this.#emitEvent({
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

  #terminateRun(
    run: Row,
    state: "Failed" | "Cancelled",
    reason: string,
    principal: Row,
    activationId: string | null,
    correlationId: string,
    commandType: "FailRun" | "CancelRun",
  ): CommandResult {
    requireNonEmpty(reason, "reason");
    const runId = text(run.id);
    const revision = integer(run.revision) + 1;
    this.#run(
      `UPDATE run_inputs
          SET disposition = 'Abandoned',
              disposition_revision = disposition_revision + 1,
              disposition_reason = ?
        WHERE run_id = ? AND disposition = 'Pending'`,
      state === "Failed" ? "run_failed" : "run_cancelled",
      runId,
    );
    this.#run(
      `UPDATE runs
          SET state = ?, revision = ?, updated_at = ?, terminal_reason = ?
        WHERE id = ?`,
      state,
      revision,
      this.#now(),
      reason,
      runId,
    );
    this.#revokeRunActivations(
      runId,
      state === "Failed" ? "run_failed" : "run_cancelled",
      this.#now(),
    );
    const cursor = this.#emitThreadEvent({
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
    this.#enqueueOutbox(
      `run.${state.toLowerCase()}`,
      "Run",
      runId,
      { revision, reason },
    );
    return {
      commandType,
      entityId: runId,
      revision,
      threadCursor: cursor,
    };
  }

  #createMessage(input: {
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
    this.#assertProjectChannel(input.projectId, input.channelId);
    const messageId = this.#idFactory("message");
    const threadRootId = input.threadRootId ?? messageId;
    const revisionId = this.#idFactory("message_revision");
    const now = this.#now();
    if (!input.threadRootId) {
      this.#run(
        "INSERT INTO threads (root_message_id, project_id, channel_id, cursor) VALUES (?, ?, ?, 0)",
        threadRootId,
        input.projectId,
        input.channelId,
      );
    } else {
      const thread = this.#requireThread(input.threadRootId);
      if (
        text(thread.project_id) !== input.projectId ||
        text(thread.channel_id) !== input.channelId
      ) {
        throw new KernelError("Forbidden", "A Message cannot cross its Thread Channel.");
      }
    }
    const threadSequence = this.#threadCursor(threadRootId) + 1;
    this.#run(
      `INSERT INTO messages
        (id, project_id, channel_id, thread_root_id, reply_to_message_id,
         author_principal_id, author_agent_id, caused_by_attention_id,
         caused_by_run_id, thread_sequence, latest_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      messageId,
      input.projectId,
      input.channelId,
      threadRootId,
      input.replyToMessageId ?? null,
      text(input.author.id),
      input.authorAgentId ?? null,
      input.causedByAttentionId ?? null,
      input.causedByRunId ?? null,
      threadSequence,
      now,
    );
    this.#run(
      `INSERT INTO message_revisions
        (id, message_id, revision, body, tombstone, created_at)
       VALUES (?, ?, 1, ?, 0, ?)`,
      revisionId,
      messageId,
      input.body.trim(),
      now,
    );
    const targetAgentIds = unique(input.targetAgentIds ?? []);
    for (const targetAgentId of targetAgentIds) {
      const agent = this.#requireAgent(targetAgentId);
      if (text(agent.project_id) !== input.projectId) {
        throw new KernelError(
          "Forbidden",
          "Mentioned Agents must belong to the Message Project.",
        );
      }
      this.#run(
        `INSERT INTO mentions (id, message_revision_id, target_agent_id, created_at)
         VALUES (?, ?, ?, ?)`,
        this.#idFactory("mention"),
        revisionId,
        targetAgentId,
        now,
      );
      if (
        targetAgentId !== input.authorAgentId &&
        !input.suppressedAttentionAgentIds?.includes(targetAgentId)
      ) {
        const attentionId = this.#idFactory("attention");
        this.#run(
          `INSERT INTO attentions
            (id, project_id, channel_id, thread_root_id, message_revision_id,
             target_agent_id, trigger_kind, status, revision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'Mention', 'Open', 1, ?)`,
          attentionId,
          input.projectId,
          input.channelId,
          threadRootId,
          revisionId,
          targetAgentId,
          now,
        );
        const createdEventSequence = this.#emitEvent({
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
        this.#run(
          "UPDATE attentions SET created_event_sequence = ? WHERE id = ?",
          createdEventSequence,
          attentionId,
        );
        this.#recordAttentionHistory(attentionId, createdEventSequence);
      }
    }
    const threadCursor = this.#emitThreadEvent({
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
    this.#enqueueOutbox(
      "message.published",
      "Message",
      messageId,
      { messageRevisionId: revisionId, threadRootId },
    );
    return { messageId, messageRevisionId: revisionId, threadCursor };
  }

  #createRunInput(
    run: Row,
    messageRevisionId: string,
    assignedByPrincipalId: string,
    assignedByActivationId: string | null,
    sourceAttentionId: string | null,
  ): { id: string; sequence: number } {
    const sequence = integer(run.next_input_sequence);
    const id = this.#idFactory("run_input");
    this.#run(
      `INSERT INTO run_inputs
        (id, run_id, message_revision_id, run_input_sequence,
         assigned_by_principal_id, assigned_by_activation_id,
         source_attention_id, created_at, disposition, disposition_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 1)`,
      id,
      text(run.id),
      messageRevisionId,
      sequence,
      assignedByPrincipalId,
      assignedByActivationId,
      sourceAttentionId,
      this.#now(),
    );
    return { id, sequence };
  }

  #insertActivity(
    runId: string,
    activationId: string,
    providerAttemptId: string | null,
    kind: string,
    payload: JsonValue,
    retentionClass: "durable" | "transient",
  ): { id: string; sequence: number } {
    requireNonEmpty(kind, "kind");
    const run = this.#requireRun(runId);
    const sequence = integer(run.next_activity_sequence);
    const id = this.#idFactory("activity");
    this.#run(
      `INSERT INTO run_activity_events
        (id, run_id, activation_id, provider_attempt_id, sequence, kind,
         payload_json, retention_class, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      runId,
      activationId,
      providerAttemptId,
      sequence,
      kind,
      JSON.stringify(payload),
      retentionClass,
      this.#now(),
    );
    this.#run(
      "UPDATE runs SET next_activity_sequence = ? WHERE id = ?",
      sequence + 1,
      runId,
    );
    return { id, sequence };
  }

  #validateActivityProvenance(
    runId: string,
    activationId: string | undefined,
    providerAttemptId: string | undefined,
    principal: Row,
    context: PrincipalContext,
    allowFinished = false,
  ): { activationId: string } {
    if (!activationId && !providerAttemptId) {
      throw new KernelError(
        "InvalidCommand",
        "Run activity requires Activation or ProviderAttempt provenance.",
      );
    }
    let resolvedActivationId = activationId;
    if (providerAttemptId) {
      const providerAttempt = this.#requireProviderAttempt(providerAttemptId);
      if (optionalText(providerAttempt.run_id) !== runId) {
        throw new KernelError("Forbidden", "ProviderAttempt belongs to another Run.");
      }
      const providerActivationId = text(providerAttempt.activation_id);
      if (activationId && activationId !== providerActivationId) {
        throw new KernelError("InvalidCommand", "Activity provenance is inconsistent.");
      }
      resolvedActivationId = providerActivationId;
    }
    const activation = allowFinished
      ? this.#requireActivation(resolvedActivationId!)
      : this.#requireLiveActivation(resolvedActivationId!);
    if (optionalText(activation.run_id) !== runId) {
      throw new KernelError("Forbidden", "Activation belongs to another Run.");
    }
    this.#authorizeActivationActor(principal, context, activation, allowFinished);
    if (!allowFinished) {
      this.#assertActivationScopeCurrent(activation);
    }
    return { activationId: resolvedActivationId! };
  }

  #requireRunActivation(
    context: PrincipalContext,
    principal: Row,
    run: Row,
  ): Row {
    this.#requireKind(principal, "agent");
    if (!context.activationId) {
      throw new KernelError("Unauthorized", "An authenticated Activation is required.");
    }
    const activation = this.#requireLiveActivation(context.activationId);
    if (
      optionalText(activation.run_id) !== text(run.id) ||
      text(activation.agent_id) !== text(run.owner_agent_id)
    ) {
      throw new KernelError("Forbidden", "The Activation does not own this Run.");
    }
    const agent = this.#requireAgentForPrincipal(text(principal.id));
    if (text(agent.id) !== text(run.owner_agent_id)) {
      throw new KernelError("Forbidden", "The Agent does not own this Run.");
    }
    this.#assertActivationScopeCurrent(activation);
    return activation;
  }

  #authorizeActivationActor(
    principal: Row,
    context: PrincipalContext,
    activation: Row,
    allowFinished = false,
  ): void {
    if (!allowFinished && activation.finished_at !== null) {
      throw new KernelError("Conflict", "The Activation is already finished.");
    }
    if (text(principal.kind) === "runtime") {
      return;
    }
    if (text(principal.kind) !== "agent") {
      throw new KernelError("Forbidden", "This command requires runtime or Agent authority.");
    }
    const agent = this.#requireAgentForPrincipal(text(principal.id));
    if (text(agent.id) !== text(activation.agent_id)) {
      throw new KernelError("Forbidden", "The Activation belongs to another Agent.");
    }
    if (!context.activationId) {
      throw new KernelError(
        "Unauthorized",
        "An Agent command requires an authenticated Activation context.",
      );
    }
    if (context.activationId !== text(activation.id)) {
      throw new KernelError("Forbidden", "The capability context belongs to another Activation.");
    }
  }

  #requireMutableRun(runId: string, expectedRevision?: number): Row {
    const run = this.#requireRun(runId);
    if (terminalRunStates.includes(text(run.state) as RunState)) {
      throw new KernelError(
        "TerminalRun",
        `Run ${runId} is terminal and cannot accept this command.`,
        { state: text(run.state) },
      );
    }
    if (expectedRevision !== undefined) {
      this.#checkRevision(integer(run.revision), expectedRevision, "Run");
    }
    return run;
  }

  #assertAttentionLease(attention: Row, leaseToken?: string): void {
    if (!leaseToken || optionalText(attention.handler_lease_token) !== leaseToken) {
      throw new KernelError("Forbidden", "A valid Attention handler lease is required.");
    }
    const expiresAt = optionalText(attention.handler_lease_expires_at);
    if (!expiresAt || new Date(expiresAt) <= this.#clock()) {
      throw new KernelError("Conflict", "The Attention handler lease has expired.");
    }
  }

  #checkThreadCursor(thread: Row, expected?: number): void {
    if (expected !== undefined && integer(thread.cursor) !== expected) {
      const events = this.#allRows(
        `SELECT * FROM public_events
          WHERE thread_root_id = ? AND thread_cursor > ?
          ORDER BY thread_cursor`,
        text(thread.root_message_id),
        expected,
      ).map(mapPublicEvent);
      throw new KernelError(
        "ConditionalCheckFailed",
        "The Thread changed after the observed cursor.",
        {
          currentCursor: integer(thread.cursor),
          events: JSON.parse(JSON.stringify(events)) as JsonValue,
        },
      );
    }
  }

  #checkRevision(actual: number, expected: number, entity: string): void {
    if (actual !== expected) {
      throw new KernelError(
        "StaleRevision",
        `${entity} revision ${expected} is stale; current revision is ${actual}.`,
        { expectedRevision: expected, actualRevision: actual },
      );
    }
  }

  #emitThreadEvent(event: ThreadEventInput): number {
    const cursor = this.#threadCursor(event.threadRootId) + 1;
    this.#run(
      "UPDATE threads SET cursor = ? WHERE root_message_id = ?",
      cursor,
      event.threadRootId,
    );
    this.#emitEvent({ ...event, threadCursor: cursor });
    return cursor;
  }

  #emitEvent(event: EventInput): number {
    const result = this.#database.prepare(
      `INSERT INTO public_events
        (event_id, type, project_id, channel_id, thread_root_id, thread_cursor,
         entity_type, entity_id, actor_principal_id, activation_id,
         causation_id, correlation_id, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.#idFactory("event"),
      event.type,
      event.projectId,
      event.channelId,
      event.threadRootId,
      event.threadCursor,
      event.entityType,
      event.entityId,
      event.actorPrincipalId,
      event.activationId,
      event.causationId,
      event.correlationId,
      JSON.stringify(event.payload),
      this.#now(),
    );
    return Number(result.lastInsertRowid);
  }

  #recordAttentionHistory(
    attentionId: string,
    eventSequence: number,
  ): void {
    this.#run(
      `INSERT INTO attention_history
        (attention_id, event_sequence, status, revision,
         handler_lease_holder_principal_id, handler_lease_expires_at,
         resolved_run_id, resolved_at)
       SELECT id, ?, status, revision, handler_lease_holder_principal_id,
              handler_lease_expires_at, resolved_run_id, resolved_at
         FROM attentions
        WHERE id = ?`,
      eventSequence,
      attentionId,
    );
  }

  #enqueueOutbox(
    topic: string,
    aggregateType: string,
    aggregateId: string,
    payload: JsonValue,
  ): void {
    this.#run(
      `INSERT INTO outbox_events
        (id, topic, aggregate_type, aggregate_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      this.#idFactory("outbox"),
      topic,
      aggregateType,
      aggregateId,
      JSON.stringify(payload),
      this.#now(),
    );
  }

  #getBootstrap(
    projectId: string,
    attentionTargetAgentId?: string,
  ): BootstrapProjection {
    const project = this.#getRow("SELECT * FROM projects WHERE id = ?", projectId);
    if (!project) {
      throw new KernelError("NotFound", `Project ${projectId} does not exist.`);
    }
    const channels = this.#allRows(
      "SELECT * FROM channels WHERE project_id = ? ORDER BY name, id",
      projectId,
    ).map(mapChannel);
    const agents = this.#allRows(
      `SELECT a.*, c.config_json
         FROM agents a
         JOIN agent_config_revisions c
           ON c.agent_id = a.id AND c.revision = a.current_config_revision
        WHERE a.project_id = ?
        ORDER BY a.name, a.id`,
      projectId,
    ).map(mapAgent);
    const snapshot = this.#resolveAttentionSnapshot(undefined);
    return {
      project: mapProject(project),
      channels,
      agents,
      openAttentions: this.#listOpenAttentions(
        projectId,
        attentionTargetAgentId,
        0,
        snapshot.sequence,
        snapshot.eventId,
        100,
      ),
      latestEventId: snapshot.eventId,
    };
  }

  #getThreadProjection(threadRootId: string): ThreadProjection {
    const thread = this.#requireThread(threadRootId);
    const messageRows = this.#allRows(
      "SELECT * FROM messages WHERE thread_root_id = ? ORDER BY thread_sequence",
      threadRootId,
    );
    const messages = messageRows.map((message) => {
      const revisions = this.#allRows(
        "SELECT * FROM message_revisions WHERE message_id = ? ORDER BY revision",
        text(message.id),
      ).map(mapMessageRevision);
      const mentions = this.#allRows(
        `SELECT m.target_agent_id
           FROM mentions m
           JOIN message_revisions r ON r.id = m.message_revision_id
          WHERE r.message_id = ?
          ORDER BY m.target_agent_id`,
        text(message.id),
      ).map((row) => text(row.target_agent_id));
      return mapMessage(message, revisions, mentions);
    });
    return {
      projectId: text(thread.project_id),
      channelId: text(thread.channel_id),
      threadRootId,
      cursor: integer(thread.cursor),
      messages,
      attentions: this.#allRows(
        "SELECT * FROM attentions WHERE thread_root_id = ? ORDER BY created_at, id",
        threadRootId,
      ).map(mapAttention),
      runs: this.#allRows(
        "SELECT * FROM runs WHERE thread_root_id = ? ORDER BY created_at, id",
        threadRootId,
      ).map(mapRun),
      artifacts: this.#allRows(
        `SELECT ar.*
           FROM artifacts ar
           JOIN runs r ON r.id = ar.producer_run_id
          WHERE r.thread_root_id = ?
          ORDER BY ar.created_at, ar.id`,
        threadRootId,
      ).map(mapArtifact),
    };
  }

  #getRunProjection(runId: string): RunProjection {
    const run = this.#requireRun(runId);
    return {
      run: mapRun(run),
      inputs: this.#allRows(
        "SELECT * FROM run_inputs WHERE run_id = ? ORDER BY run_input_sequence",
        runId,
      ).map(mapRunInput),
      activations: this.#allRows(
        "SELECT * FROM activation_attempts WHERE run_id = ? ORDER BY started_at, id",
        runId,
      ).map((activation) =>
        mapActivation(
          activation,
          this.#allRows(
            `SELECT run_input_id
               FROM activation_run_inputs
              WHERE activation_id = ?
              ORDER BY run_input_sequence`,
            text(activation.id),
          ).map((row) => text(row.run_input_id)),
        ),
      ),
      providerAttempts: this.#allRows(
        "SELECT * FROM provider_attempts WHERE run_id = ? ORDER BY started_at, id",
        runId,
      ).map(mapProviderAttempt),
      activity: this.#latestActivityWindow(runId, 100),
      artifacts: this.#allRows(
        "SELECT * FROM artifacts WHERE producer_run_id = ? ORDER BY created_at, id",
        runId,
      ).map(mapArtifact),
    };
  }

  #listActivity(
    runId: string,
    afterSequence: number,
    limit: number,
  ): ActivityPage {
    const rows = this.#allRows(
      `SELECT * FROM run_activity_events
        WHERE run_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?`,
      runId,
      afterSequence,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapActivity);
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.sequence ?? null : null,
      hasMore,
    };
  }

  #latestActivityWindow(runId: string, limit: number): ActivityWindow {
    const rows = this.#allRows(
      `SELECT * FROM run_activity_events
        WHERE run_id = ?
        ORDER BY sequence DESC
        LIMIT ?`,
      runId,
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

  #listOpenAttentions(
    projectId: string | undefined,
    targetAgentId: string | undefined,
    afterCursor: number,
    snapshotEventSequence: number,
    snapshotEventId: string | null,
    limit: number,
  ): AttentionPage {
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
    const rows = this.#allRows(
      `SELECT attention.sequence, attention.id, attention.message_revision_id,
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
        LIMIT ?`,
      snapshotEventSequence,
      ...parameters,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapAttention);
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.cursor ?? null : null,
      hasMore,
      snapshotEventId,
    };
  }

  #listOutboxEvents(
    afterCursor: number,
    limit: number,
    includeAcknowledged: boolean,
  ): OutboxPage {
    const rows = this.#allRows(
      `SELECT * FROM outbox_events
        WHERE sequence > ?
          AND (? = 1 OR acknowledged_at IS NULL)
        ORDER BY sequence
        LIMIT ?`,
      afterCursor,
      includeAcknowledged ? 1 : 0,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapOutboxEvent);
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.cursor ?? null : null,
      hasMore,
    };
  }

  #initializeSchema(): void {
    this.#initializeSchemaExec("BEGIN IMMEDIATE");
    try {
      const versionRow = this.#initializeSchemaGet("PRAGMA user_version");
      const version = versionRow ? integer(versionRow.user_version) : 0;
      if (version === CURRENT_SCHEMA_VERSION) {
        this.#database.exec(schemaSql);
        this.#database.exec("COMMIT");
        return;
      }
      if (version !== 0) {
        throw new KernelError(
          "Conflict",
          `Incompatible development database schema version ${version}; expected ${CURRENT_SCHEMA_VERSION}. Stop old Torsor processes and recreate the disposable local database.`,
        );
      }
      const existing = this.#initializeSchemaGet(
        `SELECT name
           FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'
          LIMIT 1`,
      );
      if (existing) {
        throw new KernelError(
          "Conflict",
          "The database uses an incompatible unversioned development schema. Stop old Torsor processes and recreate the disposable local database.",
        );
      }
      this.#database.exec(schemaSql);
      this.#database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw this.#translateError(error);
    }
  }

  #initializeSchemaExec(sql: string): void {
    recordSchemaInitializationOperation({ kind: "exec", sql });
    this.#database.exec(sql);
  }

  #initializeSchemaGet(sql: string): Row | undefined {
    recordSchemaInitializationOperation({ kind: "read", sql });
    return this.#database.prepare(sql).get() as Row | undefined;
  }

  #applyBootstrap(bootstrap?: KernelBootstrap): void {
    if (!bootstrap) {
      return;
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const principal of bootstrap.principals ?? []) {
        this.#run(
          "INSERT OR IGNORE INTO principals (id, kind, display_name) VALUES (?, ?, ?)",
          principal.id,
          principal.kind,
          principal.displayName,
        );
      }
      for (const project of bootstrap.projects ?? []) {
        this.#run(
          "INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)",
          project.id,
          project.name,
        );
      }
      for (const channel of bootstrap.channels ?? []) {
        this.#run(
          "INSERT OR IGNORE INTO channels (id, project_id, name) VALUES (?, ?, ?)",
          channel.id,
          channel.projectId,
          channel.name,
        );
      }
      for (const agent of bootstrap.agents ?? []) {
        this.#run(
          `INSERT OR IGNORE INTO agents
            (id, principal_id, project_id, name, current_config_revision)
           VALUES (?, ?, ?, ?, ?)`,
          agent.id,
          agent.principalId,
          agent.projectId,
          agent.name,
          agent.configRevision,
        );
        this.#run(
          `INSERT OR IGNORE INTO agent_config_revisions
            (agent_id, revision, config_json, created_at)
           VALUES (?, ?, ?, ?)`,
          agent.id,
          agent.configRevision,
          JSON.stringify(agent.config),
          this.#now(),
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw this.#translateError(error);
    }
  }

  #assertProjectChannel(projectId: string, channelId: string): void {
    const channel = this.#getRow(
      "SELECT project_id FROM channels WHERE id = ?",
      channelId,
    );
    if (!channel) {
      throw new KernelError("NotFound", `Channel ${channelId} does not exist.`);
    }
    if (text(channel.project_id) !== projectId) {
      throw new KernelError("Forbidden", "The Channel does not belong to the Project.");
    }
  }

  #assertProjectAccess(principal: Row, projectId: string): void {
    if (text(principal.kind) !== "agent") {
      return;
    }
    const agent = this.#requireAgentForPrincipal(text(principal.id));
    if (text(agent.project_id) !== projectId) {
      throw new KernelError("Forbidden", "The Agent cannot access this Project.");
    }
  }

  #assertAgentQueryScope(
    principal: Row,
    context: PrincipalContext,
    projectId: string,
    threadRootId: string,
    runId?: string,
  ): void {
    if (text(principal.kind) !== "agent") {
      return;
    }
    if (!context.activationId) {
      throw new KernelError(
        "Unauthorized",
        "An Agent query requires an authenticated Activation context.",
      );
    }
    const agent = this.#requireAgentForPrincipal(text(principal.id));
    const activation = this.#requireLiveActivation(context.activationId);
    if (text(activation.agent_id) !== text(agent.id)) {
      throw new KernelError("Forbidden", "The Activation belongs to another Agent.");
    }
    this.#assertActivationScopeCurrent(activation);
    const activationRunId = optionalText(activation.run_id);
    if (runId && activationRunId !== runId) {
      throw new KernelError("Forbidden", "The Activation cannot read this Run.");
    }
    if (activationRunId) {
      const run = this.#requireRun(activationRunId);
      if (
        text(run.project_id) !== projectId ||
        text(run.thread_root_id) !== threadRootId
      ) {
        throw new KernelError("Forbidden", "The Activation cannot read this Thread.");
      }
      return;
    }
    const attention = this.#requireAttention(text(activation.attention_id));
    if (
      text(attention.project_id) !== projectId ||
      text(attention.thread_root_id) !== threadRootId
    ) {
      throw new KernelError("Forbidden", "The Activation cannot read this Thread.");
    }
  }

  #assertActivationScopeCurrent(activation: Row): void {
    if (activation.revoked_at !== null) {
      throw new KernelError(
        "Conflict",
        `The Activation was revoked: ${optionalText(activation.revocation_reason) ?? "unspecified"}.`,
      );
    }
    if (new Date(text(activation.expires_at)) <= this.#clock()) {
      throw new KernelError("Conflict", "The Activation has expired.");
    }
    const runId = optionalText(activation.run_id);
    if (runId) {
      const run = this.#requireRun(runId);
      if (text(run.state) !== "Active") {
        throw new KernelError(
          terminalRunStates.includes(text(run.state) as RunState)
            ? "TerminalRun"
            : "Conflict",
          "Execution side effects require an Active Run.",
          { state: text(run.state) },
        );
      }
      if (
        integer(activation.run_activation_generation) !==
        integer(run.activation_generation)
      ) {
        throw new KernelError(
          "Conflict",
          "The Activation was superseded by a newer Run activation generation.",
        );
      }
      return;
    }
    const attention = this.#requireAttention(text(activation.attention_id));
    if (text(attention.status) !== "Open") {
      throw new KernelError(
        "Conflict",
        "The Activation scope ended when its Attention was resolved.",
      );
    }
    if (
      optionalText(attention.handler_lease_token) !==
        optionalText(activation.attention_lease_token) ||
      !optionalText(attention.handler_lease_expires_at) ||
      new Date(text(attention.handler_lease_expires_at)) <= this.#clock()
    ) {
      throw new KernelError(
        "Conflict",
        "The Activation scope ended when its Attention handler lease expired or changed.",
      );
    }
  }

  #isCurrentRunActivation(activation: Row, run: Row): boolean {
    return (
      optionalText(activation.run_id) === text(run.id) &&
      activation.finished_at === null &&
      activation.revoked_at === null &&
      new Date(text(activation.expires_at)) > this.#clock() &&
      text(run.state) === "Active" &&
      integer(activation.run_activation_generation) ===
        integer(run.activation_generation)
    );
  }

  #revokeRunActivations(
    runId: string,
    reason: string,
    revokedAt: string,
  ): void {
    this.#run(
      `UPDATE activation_attempts
          SET revoked_at = COALESCE(revoked_at, ?),
              revocation_reason = COALESCE(revocation_reason, ?)
        WHERE run_id = ? AND finished_at IS NULL AND revoked_at IS NULL`,
      revokedAt,
      reason,
      runId,
    );
  }

  #activationScope(activation: Row): {
    projectId: string;
    channelId: string;
    threadRootId: string;
  } {
    const runId = optionalText(activation.run_id);
    if (runId) {
      const run = this.#requireRun(runId);
      return {
        projectId: text(run.project_id),
        channelId: text(run.home_channel_id),
        threadRootId: text(run.thread_root_id),
      };
    }
    const attention = this.#requireAttention(text(activation.attention_id));
    return {
      projectId: text(attention.project_id),
      channelId: text(attention.channel_id),
      threadRootId: text(attention.thread_root_id),
    };
  }

  #resolveAttentionSnapshot(
    snapshotEventId: string | null | undefined,
  ): { sequence: number; eventId: string | null } {
    if (snapshotEventId === null) {
      return { sequence: 0, eventId: null };
    }
    if (snapshotEventId !== undefined) {
      return {
        sequence: this.#eventSequence(snapshotEventId),
        eventId: snapshotEventId,
      };
    }
    const latest = this.#getRow(
      "SELECT sequence, event_id FROM public_events ORDER BY sequence DESC LIMIT 1",
    );
    return latest
      ? {
          sequence: integer(latest.sequence),
          eventId: text(latest.event_id),
        }
      : { sequence: 0, eventId: null };
  }

  #eventSequence(eventId: string): number {
    const row = this.#getRow(
      "SELECT sequence FROM public_events WHERE event_id = ?",
      eventId,
    );
    if (!row) {
      throw new KernelError("NotFound", `Event ${eventId} does not exist.`);
    }
    return integer(row.sequence);
  }

  #threadCursor(threadRootId: string): number {
    return integer(this.#requireThread(threadRootId).cursor);
  }

  #requirePrincipal(id: string): Row {
    const row = this.#getRow("SELECT * FROM principals WHERE id = ?", id);
    if (!row) {
      throw new KernelError("Unauthorized", "The principal is not authenticated.");
    }
    return row;
  }

  #requireKind(principal: Row, kind: "human" | "agent" | "runtime"): void {
    if (text(principal.kind) !== kind) {
      throw new KernelError("Forbidden", `This command requires a ${kind} principal.`);
    }
  }

  #requireAgent(id: string): Row {
    const row = this.#getRow("SELECT * FROM agents WHERE id = ?", id);
    if (!row) {
      throw new KernelError("NotFound", `Agent ${id} does not exist.`);
    }
    return row;
  }

  #requireAgentForPrincipal(principalId: string): Row {
    const row = this.#getRow(
      "SELECT * FROM agents WHERE principal_id = ?",
      principalId,
    );
    if (!row) {
      throw new KernelError("Forbidden", "The principal is not an Agent.");
    }
    return row;
  }

  #requireThread(id: string): Row {
    const row = this.#getRow("SELECT * FROM threads WHERE root_message_id = ?", id);
    if (!row) {
      throw new KernelError("NotFound", `Thread ${id} does not exist.`);
    }
    return row;
  }

  #requireAttention(id: string): Row {
    const row = this.#getRow("SELECT * FROM attentions WHERE id = ?", id);
    if (!row) {
      throw new KernelError("NotFound", `Attention ${id} does not exist.`);
    }
    return row;
  }

  #requireRun(id: string): Row {
    const row = this.#getRow("SELECT * FROM runs WHERE id = ?", id);
    if (!row) {
      throw new KernelError("NotFound", `Run ${id} does not exist.`);
    }
    return row;
  }

  #requireRunInput(id: string): Row {
    const row = this.#getRow("SELECT * FROM run_inputs WHERE id = ?", id);
    if (!row) {
      throw new KernelError("NotFound", `RunInput ${id} does not exist.`);
    }
    return row;
  }

  #requireActivation(id: string): Row {
    const row = this.#getRow(
      "SELECT * FROM activation_attempts WHERE id = ?",
      id,
    );
    if (!row) {
      throw new KernelError("NotFound", `Activation ${id} does not exist.`);
    }
    return row;
  }

  #requireLiveActivation(id: string): Row {
    const activation = this.#requireActivation(id);
    if (activation.finished_at !== null) {
      throw new KernelError("Conflict", "The Activation is already finished.");
    }
    return activation;
  }

  #requireProviderAttempt(id: string): Row {
    const row = this.#getRow(
      "SELECT * FROM provider_attempts WHERE id = ?",
      id,
    );
    if (!row) {
      throw new KernelError("NotFound", `ProviderAttempt ${id} does not exist.`);
    }
    return row;
  }

  #requireOutboxEvent(id: string): Row {
    const row = this.#getRow("SELECT * FROM outbox_events WHERE id = ?", id);
    if (!row) {
      throw new KernelError("NotFound", `OutboxEvent ${id} does not exist.`);
    }
    return row;
  }

  #validateDisposition(disposition: RunInputDisposition, reason: string): void {
    if (
      disposition === "Pending" ||
      disposition === "Incorporated" ||
      disposition === "Withdrawn"
    ) {
      throw new KernelError("InvalidCommand", "The completion exception disposition is invalid.");
    }
    requireNonEmpty(reason, "exception reason");
  }

  #getRow(sql: string, ...parameters: SQLInputValue[]): Row | undefined {
    return this.#database.prepare(sql).get(...parameters) as Row | undefined;
  }

  #allRows(sql: string, ...parameters: SQLInputValue[]): Row[] {
    return this.#database.prepare(sql).all(...parameters) as Row[];
  }

  #run(sql: string, ...parameters: SQLInputValue[]): void {
    this.#database.prepare(sql).run(...parameters);
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new KernelError("Conflict", "The kernel is closed.");
    }
  }

  #translateError(error: unknown): Error {
    if (error instanceof KernelError) {
      return error;
    }
    if (
      error instanceof Error &&
      (error.message.includes("UNIQUE constraint failed") ||
        error.message.includes("FOREIGN KEY constraint failed"))
    ) {
      return new KernelError("Conflict", "The command conflicts with durable state.");
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

function mapProject(row: Row): BootstrapProject {
  return { id: text(row.id), name: text(row.name) };
}

function mapChannel(row: Row): BootstrapChannel {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    name: text(row.name),
  };
}

function mapAgent(row: Row): BootstrapAgent {
  return {
    id: text(row.id),
    principalId: text(row.principal_id),
    projectId: text(row.project_id),
    name: text(row.name),
    configRevision: integer(row.current_config_revision),
    config: parseJson(row.config_json),
  };
}

function mapMessageRevision(row: Row): MessageRevisionView {
  return {
    id: text(row.id),
    revision: integer(row.revision),
    body: text(row.body),
    createdAt: text(row.created_at),
  };
}

function mapMessage(
  row: Row,
  revisions: readonly MessageRevisionView[],
  targetAgentIds: readonly string[],
): MessageView {
  return {
    id: text(row.id),
    threadRootId: text(row.thread_root_id),
    replyToMessageId: optionalText(row.reply_to_message_id),
    authorPrincipalId: text(row.author_principal_id),
    authorAgentId: optionalText(row.author_agent_id),
    causedByAttentionId: optionalText(row.caused_by_attention_id),
    causedByRunId: optionalText(row.caused_by_run_id),
    threadCursor: integer(row.thread_sequence),
    latestRevision: integer(row.latest_revision),
    revisions,
    targetAgentIds,
    createdAt: text(row.created_at),
  };
}

function mapAttention(row: Row): AttentionView {
  return {
    cursor: integer(row.sequence),
    id: text(row.id),
    messageRevisionId: text(row.message_revision_id),
    targetAgentId: text(row.target_agent_id),
    triggerKind: text(row.trigger_kind),
    status: text(row.status) as AttentionView["status"],
    revision: integer(row.revision),
    handlerLeaseHolderPrincipalId: optionalText(
      row.handler_lease_holder_principal_id,
    ),
    handlerLeaseExpiresAt: optionalText(row.handler_lease_expires_at),
    resolvedRunId: optionalText(row.resolved_run_id),
    createdAt: text(row.created_at),
    resolvedAt: optionalText(row.resolved_at),
  };
}

function mapRun(row: Row): RunView {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    homeChannelId: text(row.home_channel_id),
    threadRootId: text(row.thread_root_id),
    ownerAgentId: text(row.owner_agent_id),
    agentConfigRevision: integer(row.agent_config_revision),
    state: text(row.state) as RunState,
    revision: integer(row.revision),
    activationGeneration: integer(row.activation_generation),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    terminalReason: optionalText(row.terminal_reason),
  };
}

function mapRunInput(row: Row): RunInputView {
  return {
    id: text(row.id),
    runId: text(row.run_id),
    messageRevisionId: text(row.message_revision_id),
    sequence: integer(row.run_input_sequence),
    assignedByPrincipalId: text(row.assigned_by_principal_id),
    assignedByActivationId: optionalText(row.assigned_by_activation_id),
    sourceAttentionId: optionalText(row.source_attention_id),
    disposition: text(row.disposition) as RunInputDisposition,
    dispositionRevision: integer(row.disposition_revision),
    dispositionReason: optionalText(row.disposition_reason),
    supersededByRunInputId: optionalText(row.superseded_by_run_input_id),
    createdAt: text(row.created_at),
  };
}

function mapActivation(
  row: Row,
  runInputIds: readonly string[],
): ActivationAttemptView {
  return {
    id: text(row.id),
    agentId: text(row.agent_id),
    runId: optionalText(row.run_id),
    attentionId: optionalText(row.attention_id),
    configRevision: integer(row.config_revision),
    runActivationGeneration:
      row.run_activation_generation === null
        ? null
        : integer(row.run_activation_generation),
    runInputIds,
    startedAt: text(row.started_at),
    expiresAt: text(row.expires_at),
    revokedAt: optionalText(row.revoked_at),
    revocationReason: optionalText(row.revocation_reason),
    finishedAt: optionalText(row.finished_at),
    outcome:
      row.outcome === null
        ? null
        : (text(row.outcome) as ActivationAttemptView["outcome"]),
    detail: optionalText(row.detail),
  };
}

function mapProviderAttempt(row: Row): ProviderAttemptView {
  return {
    id: text(row.id),
    activationId: text(row.activation_id),
    runId: optionalText(row.run_id),
    adapter: text(row.adapter),
    adapterVersion: text(row.adapter_version),
    capabilitySnapshot: parseJson(row.capability_snapshot_json),
    runInputIds: parseStringArray(row.run_input_ids_json),
    requestIdempotencyKey: text(row.request_idempotency_key),
    diagnosticSessionId: optionalText(row.diagnostic_session_id),
    status: text(row.status) as ProviderAttemptView["status"],
    detail: optionalText(row.detail),
    startedAt: text(row.started_at),
    finishedAt: optionalText(row.finished_at),
  };
}

function mapActivity(row: Row): RunActivityEventView {
  return {
    id: text(row.id),
    runId: text(row.run_id),
    activationId: optionalText(row.activation_id),
    providerAttemptId: optionalText(row.provider_attempt_id),
    sequence: integer(row.sequence),
    kind: text(row.kind),
    payload: parseJson(row.payload_json),
    retentionClass: text(
      row.retention_class,
    ) as RunActivityEventView["retentionClass"],
    createdAt: text(row.created_at),
  };
}

function mapOutboxEvent(row: Row): OutboxEventView {
  return {
    cursor: integer(row.sequence),
    id: text(row.id),
    topic: text(row.topic),
    aggregateType: text(row.aggregate_type),
    aggregateId: text(row.aggregate_id),
    payload: parseJson(row.payload_json),
    deliveryAttempts: integer(row.delivery_attempts),
    leaseHolderPrincipalId: optionalText(row.lease_holder_principal_id),
    leaseExpiresAt: optionalText(row.lease_expires_at),
    acknowledgedAt: optionalText(row.acknowledged_at),
    createdAt: text(row.created_at),
  };
}

function mapArtifact(row: Row): ArtifactView {
  return {
    id: text(row.id),
    contentDigest: text(row.content_digest),
    producerRunId: text(row.producer_run_id),
    producerActivationId: text(row.producer_activation_id),
    baseRevision: text(row.base_revision),
    mediaType: text(row.media_type),
    storageLocation: text(row.storage_location),
    visibilityChannelId: text(row.visibility_channel_id),
    metadata: row.metadata_json === null ? null : parseJson(row.metadata_json),
    createdAt: text(row.created_at),
  };
}

function mapPublicEvent(row: Row): PublicEventEnvelope {
  return {
    eventId: text(row.event_id),
    type: text(row.type),
    projectId: text(row.project_id),
    channelId: optionalText(row.channel_id),
    threadRootId: optionalText(row.thread_root_id),
    threadCursor:
      row.thread_cursor === null ? null : integer(row.thread_cursor),
    entityType: text(row.entity_type),
    entityId: text(row.entity_id),
    actorPrincipalId: text(row.actor_principal_id),
    activationId: optionalText(row.activation_id),
    causationId: optionalText(row.causation_id),
    correlationId: text(row.correlation_id),
    payload: parseJson(row.payload_json),
    occurredAt: text(row.occurred_at),
  };
}

function hashPayload(command: KernelCommand): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function parseJson(value: unknown): JsonValue {
  return JSON.parse(text(value)) as JsonValue;
}

function parseStringArray(value: unknown): readonly string[] {
  const parsed = JSON.parse(text(value));
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Stored string array is invalid.");
  }
  return parsed;
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Stored text value is invalid.");
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Stored integer value is invalid.");
  }
  return value;
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new KernelError("InvalidCommand", `${field} must not be empty.`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function boundedLimit(limit = 100): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new KernelError("InvalidCommand", "Limit must be between 1 and 500.");
  }
  return limit;
}

function boundedDuration(durationMs: number, field: string): number {
  if (
    !Number.isInteger(durationMs) ||
    durationMs < 1_000 ||
    durationMs > 300_000
  ) {
    throw new KernelError(
      "InvalidCommand",
      `${field} must be between 1 and 300 seconds.`,
    );
  }
  return durationMs;
}

function assertNever(value: never): never {
  throw new KernelError(
    "InvalidCommand",
    `Unsupported command or query: ${JSON.stringify(value)}`,
  );
}
