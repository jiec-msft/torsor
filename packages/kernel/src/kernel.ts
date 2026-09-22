import {
  artifactDigest,
  verifyArtifactContent,
  type ArtifactStorage,
} from "./artifact-storage.js";
import {
  authorizeReport,
  collectReport,
  getArtifact,
  publishArtifact,
  validateReportInput,
} from "./artifacts.js";
import {
  claimAttention,
  ignoreAttention,
  resolveCachedAttentionClaim,
  resolveAttentionWithExistingRun,
  resolveAttentionWithRun,
} from "./attentions.js";
import { replyToThread, startThread } from "./collaboration.js";
import { rejectCausalOverrides } from "./causal-limits.js";
import {
  allRows,
  getRow,
  now,
  openKernelContext,
  run,
  translateError,
  type KernelContext,
} from "./database.js";
import { DurableKernelError, KernelError } from "./errors.js";
import {
  appendRunActivity,
  failProviderAttempt,
  finishActivation,
  finishProviderAttempt,
  parkRunAfterProviderAttemptFailure,
  resolveCachedActivation,
  resolveCachedProviderAttempt,
  startActivation,
  startProviderAttempt,
} from "./execution.js";
import {
  assertAgentQueryScope,
  assertProjectChannel,
  assertProjectAccess,
  eventSequence,
  projectEventSequence,
  requireAgentForPrincipal,
  requireKind,
  requirePrincipal,
  requireProject,
  requireRun,
  requireThread,
  resolveAttentionSnapshot,
  resolvePrincipalReadScope,
  resolvePublicSnapshot,
} from "./invariants.js";
import { recordProjectionVersions } from "./history.js";
import {
  acknowledgeOutboxEvents,
  claimOutboxEvents,
  resolveCachedOutboxClaim,
} from "./outbox.js";
import {
  getBootstrap,
  getAttentionRecoverySnapshot,
  getProjectAgentStatus,
  getProviderAttempt,
  getRunProjection,
  getThreadProjection,
  listActivity,
  listOpenAttentions,
  listOutboxEvents,
  listRecoverableAttentionExecutions,
  listRunProjections,
  listThreadProjections,
  readAuthorizedPublicEvents,
} from "./projections.js";
import {
  cancelRun,
  completeRun,
  failRun,
  publishRunReply,
  recordLateOutput,
  sendToRun,
  waitRun,
  withdrawRunInput,
} from "./runs.js";
import { mapPublicEvent } from "./mappings.js";
import {
  assertWriterCommandAuthority, assertWriterContextAuthority,
  assertWorktreeMutation, assertWorktreePublication, getPhysicalWorktree, physicalWorktreeCommand,
  resolveCachedWorktreeExecution,
} from "./physical-worktrees.js";
import {
  acquireWorktreeWriterLease,
  getWorktreeWriterLease,
  listWorktreeWriterLeaseEvents,
  quarantineWorktreeWriterLease,
  releaseWorktreeWriterLease,
  renewWorktreeWriterLease,
  resolveCachedWorktreeWriterLeaseQuarantine,
  resolveCachedWorktreeWriterLeaseAuthority,
  resolveWorktreeWriterLeaseQuarantine,
} from "./worktree-writer-leases.js";
import type {
  ArtifactContent,
  CommandResult,
  FinalizeReportInput,
  KernelCommand,
  KernelOpenOptions,
  KernelQuery,
  PrincipalContext,
  PublicEventEnvelope,
  QueryResult,
  WorktreeMutationAuthority,
  WorktreeExecutionReceipt,
} from "./types.js";
import {
  assertNever,
  boundedLimit,
  hashPayload,
  integer,
  text,
  type Row,
} from "./values.js";

const commandBeforeCommitHookSymbol = Symbol.for(
  "torsor.kernel.command-before-commit",
);

function recordCommandBeforeCommit(commandType: KernelCommand["type"]): void {
  const hook = Reflect.get(globalThis, commandBeforeCommitHookSymbol);
  if (typeof hook === "function") {
    hook({ commandType });
  }
}

export { KernelError } from "./errors.js";

export class TorsorKernel {
  readonly #context: KernelContext;
  readonly #artifactStorage: ArtifactStorage | undefined;
  readonly #localWorktreeExecutions = new Map<string, WorktreeExecutionReceipt & {
    readonly principalId: string; readonly activationId: string;
  }>();
  #closed = false;
  #supervisesWorktrees = false;

  private constructor(options: KernelOpenOptions) {
    this.#context = openKernelContext(options);
    this.#artifactStorage = options.artifactStorage;
  }

  static open(options: KernelOpenOptions): TorsorKernel {
    return new TorsorKernel(options);
  }

  close(): void {
    if (!this.#closed) {
      this.#context.database.close();
      this.#closed = true;
    }
  }

  /**
   * Trusted executor only. The durable execution intent must already exist.
   * Never await or perform unbounded work while holding this local write lock.
   */
  performWorktreeMutation(
    authority: WorktreeMutationAuthority,
    context: PrincipalContext,
    effect: () => undefined,
  ): void {
    this.#supervisesWorktrees = true;
    this.#writerCheck(() => {
      const principal = requirePrincipal(this.#context, context.principalId);
      assertWorktreeMutation(this.#context, authority, principal);
      const result = effect();
      if (result !== undefined) {
        throw new Error("Worktree mutations must be synchronous and return undefined.");
      }
    });
  }

  /** A rollback-only observation, never authorization for a later external effect. */
  checkWorktreeAuthority(authority: WorktreeMutationAuthority, context: PrincipalContext): void {
    this.#withDatabaseAccess(() => {
      this.#context.database.exec("BEGIN");
      try {
        assertWorktreeMutation(this.#context, authority, requirePrincipal(this.#context, context.principalId));
      } finally {
        // Validation can tentatively record expiry/revocation; only the stop path persists it.
        this.#context.database.exec("ROLLBACK");
      }
    });
  }

  async execute<C extends KernelCommand>(
    command: C,
    principalContext: PrincipalContext,
  ): Promise<CommandResult> {
    if (command.type === "PublishArtifact") {
      throw new KernelError("Forbidden", "Artifact descriptors require trusted byte finalization.");
    }
    const localBinding = command.type === "StartWorktreeExecution"
      ? { principalId: principalContext.principalId, activationId: command.activationId, executorId: command.executorId }
      : undefined;
    const result = await this.#execute(command, principalContext);
    if (localBinding && result.executionToken) {
      this.#localWorktreeExecutions.set(result.entityId, {
        ...localBinding, executionId: result.entityId, executionToken: result.executionToken,
      });
    }
    return result;
  }

  revokeLocalWorktreeAuthority(receipt: WorktreeExecutionReceipt, context: PrincipalContext): void {
    const binding = this.#localWorktreeExecutions.get(receipt.executionId);
    if (!binding || binding.principalId !== context.principalId ||
        binding.executorId !== receipt.executorId || binding.executionToken !== receipt.executionToken) {
      throw new KernelError("Forbidden", "Original local execution receipt is required.");
    }
    // Denial only: never consult a contended database before stopping an owned child.
    this.#context.localWorktreeRevocations.add(binding.activationId);
  }

  checkWorktreePublication(authority: WorktreeMutationAuthority, context: PrincipalContext): void {
    this.#writerCheck(() => assertWorktreePublication(
      this.#context, authority, requirePrincipal(this.#context, context.principalId),
    ));
  }

  #writerCheck(check: () => void): void {
    this.#withDatabaseAccess(() => {
      this.#context.database.exec("BEGIN IMMEDIATE");
      try {
        check();
        this.#context.database.exec("COMMIT");
      } catch (error) {
        this.#context.database.exec(error instanceof DurableKernelError ? "COMMIT" : "ROLLBACK");
        throw translateError(error);
      }
    });
  }

  #withDatabaseAccess<T>(operation: () => T): T {
    this.#assertOpen();
    if (!this.#supervisesWorktrees) return operation();
    const timeout = integer(getRow(this.#context, "PRAGMA busy_timeout")!.timeout);
    this.#context.database.exec("PRAGMA busy_timeout = 0");
    try {
      // These scopes never cross await: DatabaseSync must not starve owned-child timers.
      return operation();
    } finally {
      this.#context.database.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
  }

  get reportArtifactsEnabled(): boolean {
    return this.#artifactStorage !== undefined;
  }

  async finalizeReport(
    input: FinalizeReportInput,
    context: PrincipalContext,
  ): Promise<CommandResult> {
    this.#assertOpen();
    validateReportInput(input);
    const storage = this.#requireArtifactStorage();
    // Capture caller-owned context and fields before awaiting an untrusted stream.
    const actor = { ...context };
    const { runId, expectedRunRevision, idempotencyKey } = input;
    const checkWriter = () => assertWriterContextAuthority(
      this.#context, requirePrincipal(this.#context, actor.principalId), actor,
    );
    this.#writerCheck(checkWriter);
    this.#withDatabaseAccess(() => authorizeReport(this.#context, runId, actor));
    const content = await collectReport(input.content);
    const contentDigest = artifactDigest(content);
    this.#writerCheck(checkWriter);
    this.#withDatabaseAccess(() => authorizeReport(this.#context, runId, actor));
    await storage.put(contentDigest, content);
    return this.#execute(
      {
        type: "PublishArtifact",
        idempotencyKey: JSON.stringify([runId, idempotencyKey]),
        runId,
        expectedRunRevision,
        contentDigest,
        byteLength: content.byteLength,
      },
      actor,
    );
  }

  async readArtifact(
    artifactId: string,
    context: PrincipalContext,
  ): Promise<ArtifactContent> {
    const actor = { ...context };
    const artifact = await this.query({ type: "GetArtifact", artifactId }, actor);
    const content = Buffer.from(await this.#requireArtifactStorage().read(
      artifact.contentDigest,
      artifact.byteLength,
    ));
    verifyArtifactContent(content, artifact.contentDigest, artifact.byteLength);
    await this.query({ type: "GetArtifact", artifactId }, actor);
    return { artifact, content };
  }

  #requireArtifactStorage(): ArtifactStorage {
    if (!this.#artifactStorage) {
      throw new KernelError("InvalidCommand", "Report Artifact storage is not configured.");
    }
    return this.#artifactStorage;
  }

  async #execute(
    command: KernelCommand,
    principalContext: PrincipalContext,
  ): Promise<CommandResult> {
    return this.#withDatabaseAccess(() => this.#executeTransaction(command, principalContext));
  }

  #executeTransaction(command: KernelCommand, principalContext: PrincipalContext): CommandResult {
    this.#assertOpen();
    const principal = requirePrincipal(
      this.#context,
      principalContext.principalId,
    );
    const effectiveContext =
      text(principal.kind) === "human"
        ? { principalId: principalContext.principalId }
        : principalContext;
    if (
      command.type === "ClaimAttention" ||
      command.type === "StartActivation" ||
      command.type === "ParkRunAfterProviderAttemptFailure"
    ) {
      requireKind(this.#context, principal, "runtime");
    }
    rejectCausalOverrides(command);
    const payloadHash = hashPayload(command);
    this.#context.database.exec("BEGIN IMMEDIATE");
    try {
      assertWriterCommandAuthority(this.#context, command, principal, effectiveContext);
      const cached = getRow(
        this.#context,
        `SELECT payload_hash, result_json
           FROM idempotency_records
          WHERE principal_id = ? AND command_name = ? AND idempotency_key = ?`,
        text(principal.id),
        command.type,
        command.idempotencyKey,
      );
      if (cached) {
        if (command.type === "PublishArtifact") {
          authorizeReport(this.#context, command.runId, effectiveContext);
        }
        if (text(cached.payload_hash) !== payloadHash) {
          throw new KernelError(
            "Conflict",
            "The idempotency key was already used with a different payload.",
          );
        }
        const result = JSON.parse(text(cached.result_json)) as CommandResult;
        if (command.type === "StartWorktreeExecution") {
          const current = resolveCachedWorktreeExecution(this.#context, command, result, principal);
          this.#context.database.exec("COMMIT");
          return current;
        }
        if (command.type === "PublishArtifact") {
          getArtifact(this.#context, result.entityId, effectiveContext);
        }
        if (command.type === "ClaimAttention") {
          const current = resolveCachedAttentionClaim(
            this.#context,
            result,
            principal,
          );
          if (JSON.stringify(current) !== JSON.stringify(result)) {
            run(
              this.#context,
              `UPDATE idempotency_records
                  SET result_json = ?
                WHERE principal_id = ? AND command_name = ? AND idempotency_key = ?`,
              JSON.stringify(current),
              text(principal.id),
              command.type,
              command.idempotencyKey,
            );
          }
          this.#context.database.exec("COMMIT");
          return current;
        }
        if (command.type === "ClaimOutboxEvents") {
          const refreshed = resolveCachedOutboxClaim(
            this.#context,
            command,
            result,
            principal,
          );
          if (JSON.stringify(refreshed) !== JSON.stringify(result)) {
            run(
              this.#context,
              `UPDATE idempotency_records
                  SET result_json = ?
                WHERE principal_id = ? AND command_name = ? AND idempotency_key = ?`,
              JSON.stringify(refreshed),
              text(principal.id),
              command.type,
              command.idempotencyKey,
            );
          }
          this.#context.database.exec("COMMIT");
          return refreshed;
        }
        if (command.type === "StartActivation") {
          const refreshed = resolveCachedActivation(
            this.#context,
            command,
            result,
            principal,
          );
          if (JSON.stringify(refreshed) !== JSON.stringify(result)) {
            run(
              this.#context,
              `UPDATE idempotency_records
                  SET result_json = ?
                WHERE principal_id = ? AND command_name = ? AND idempotency_key = ?`,
              JSON.stringify(refreshed),
              text(principal.id),
              command.type,
              command.idempotencyKey,
            );
          }
          this.#context.database.exec("COMMIT");
          return refreshed;
        }
        if (command.type === "StartProviderAttempt") {
          const refreshed = resolveCachedProviderAttempt(
            this.#context,
            command,
            result,
            principal,
            effectiveContext,
          );
          if (JSON.stringify(refreshed) !== JSON.stringify(result)) {
            run(
              this.#context,
              `UPDATE idempotency_records
                  SET result_json = ?
                WHERE principal_id = ? AND command_name = ? AND idempotency_key = ?`,
              JSON.stringify(refreshed),
              text(principal.id),
              command.type,
              command.idempotencyKey,
            );
          }
          this.#context.database.exec("COMMIT");
          return refreshed;
        }
        if (
          command.type === "AcquireWorktreeWriterLease" ||
          command.type === "RenewWorktreeWriterLease"
        ) {
          const refreshed = resolveCachedWorktreeWriterLeaseAuthority(
            this.#context,
            command,
            result,
            principal,
          );
          if (JSON.stringify(refreshed) !== JSON.stringify(result)) {
            run(
              this.#context,
              `UPDATE idempotency_records
                  SET result_json = ?
                WHERE principal_id = ? AND command_name = ? AND idempotency_key = ?`,
              JSON.stringify(refreshed),
              text(principal.id),
              command.type,
              command.idempotencyKey,
            );
          }
          this.#context.database.exec("COMMIT");
          return refreshed;
        }
        if (command.type === "QuarantineWorktreeWriterLease") {
          const refreshed = resolveCachedWorktreeWriterLeaseQuarantine(
            this.#context,
            command,
            result,
            principal,
          );
          if (JSON.stringify(refreshed) !== JSON.stringify(result)) {
            run(
              this.#context,
              `UPDATE idempotency_records
                  SET result_json = ?
                WHERE principal_id = ? AND command_name = ? AND idempotency_key = ?`,
              JSON.stringify(refreshed),
              text(principal.id),
              command.type,
              command.idempotencyKey,
            );
          }
          this.#context.database.exec("COMMIT");
          return refreshed;
        }
        this.#context.database.exec("COMMIT");
        return result;
      }

      const correlationId = this.#context.idFactory("corr");
      const result = this.#dispatchCommand(
        command,
        effectiveContext,
        principal,
        correlationId,
      );
      recordProjectionVersions(this.#context, correlationId);
      run(
        this.#context,
        `INSERT INTO idempotency_records
          (principal_id, command_name, idempotency_key, payload_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        text(principal.id),
        command.type,
        command.idempotencyKey,
        payloadHash,
        JSON.stringify(result),
        now(this.#context),
      );
      recordCommandBeforeCommit(command.type);
      this.#context.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (error instanceof DurableKernelError) {
        this.#context.database.exec("COMMIT");
        throw error;
      }
      this.#context.database.exec("ROLLBACK");
      throw translateError(error);
    }
  }

  async query<Q extends KernelQuery>(
    query: Q,
    principalContext: PrincipalContext,
  ): Promise<QueryResult<Q>> {
    return this.#withDatabaseAccess(() => this.#queryTransaction(query, principalContext));
  }

  #queryTransaction<Q extends KernelQuery>(query: Q, principalContext: PrincipalContext): QueryResult<Q> {
    this.#assertOpen();
    const principal = requirePrincipal(
      this.#context,
      principalContext.principalId,
    );
    const advancesRecoveryClock =
      query.type === "GetAttentionRecoverySnapshot" ||
      query.type === "GetWorktreeWriterLease" ||
      (
        query.type === "ListRecoverableAttentionExecutions" &&
        query.recoveryRevision === undefined
      );
    this.#context.database.exec(
      advancesRecoveryClock ? "BEGIN IMMEDIATE" : "BEGIN",
    );
    try {
      let result: unknown;
      switch (query.type) {
        case "GetWorktreeStorageIdentity":
          requireKind(this.#context, principal, "runtime");
          result = { identity: text(getRow(this.#context, "SELECT identity FROM worktree_storage_identity")!.identity) };
          break;
        case "ListPhysicalWorktrees": {
          requireKind(this.#context, principal, "runtime");
          const limit = boundedLimit(query.limit);
          const rows = allRows(this.#context,
            "SELECT worktree_id FROM physical_worktrees WHERE worktree_id > ? ORDER BY worktree_id LIMIT ?",
            query.afterWorktreeId ?? "", limit + 1);
          result = {
            items: rows.slice(0, limit).map((row) => getPhysicalWorktree(this.#context, text(row.worktree_id), principal)),
            hasMore: rows.length > limit,
          };
          break;
        }
        case "GetPhysicalWorktree":
          result = getPhysicalWorktree(this.#context, query.worktreeId, principal);
          break;
        case "GetArtifact": {
          result = getArtifact(this.#context, query.artifactId, principalContext);
          break;
        }
        case "GetBootstrap": {
          assertProjectAccess(this.#context, principal, query.projectId);
          const agent =
            text(principal.kind) === "agent"
              ? requireAgentForPrincipal(this.#context, text(principal.id))
              : null;
          result = getBootstrap(
            this.#context,
            query.projectId,
            agent ? text(agent.id) : undefined,
          );
          break;
        }
        case "GetThreadProjection": {
          const thread = requireThread(this.#context, query.threadRootId);
          assertProjectAccess(this.#context, principal, text(thread.project_id));
          const scope = assertAgentQueryScope(
            this.#context,
            principal,
            principalContext,
            text(thread.project_id),
            query.threadRootId,
          );
          result = getThreadProjection(this.#context, query.threadRootId, scope);
          break;
        }
        case "GetRunProjection": {
          const run = requireRun(this.#context, query.runId);
          assertProjectAccess(this.#context, principal, text(run.project_id));
          assertAgentQueryScope(
            this.#context,
            principal,
            principalContext,
            text(run.project_id),
            text(run.thread_root_id),
            query.runId,
          );
          result = getRunProjection(this.#context, query.runId);
          break;
        }
        case "ListActivity": {
          const run = requireRun(this.#context, query.runId);
          assertProjectAccess(this.#context, principal, text(run.project_id));
          assertAgentQueryScope(
            this.#context,
            principal,
            principalContext,
            text(run.project_id),
            text(run.thread_root_id),
            query.runId,
          );
          result = listActivity(
            this.#context,
            query.runId,
            query.afterSequence,
            boundedLimit(query.limit),
            query.beforeSequence,
          );
          break;
        }
        case "ListOpenAttentions":
          {
            if (text(principal.kind) === "agent") {
              const agent = requireAgentForPrincipal(
                this.#context,
                text(principal.id),
              );
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
              const snapshot = resolvePublicSnapshot(
                this.#context,
                text(agent.project_id),
                query.snapshotEventId,
              );
              result = listOpenAttentions(
                this.#context,
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
              assertProjectAccess(this.#context, principal, query.projectId);
            }
            const snapshot = query.projectId
              ? resolvePublicSnapshot(
                  this.#context,
                  query.projectId,
                  query.snapshotEventId,
                )
              : resolveAttentionSnapshot(
                  this.#context,
                  query.snapshotEventId,
                );
            result = listOpenAttentions(
              this.#context,
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
          requireKind(this.#context, principal, "runtime");
          result = listOutboxEvents(
            this.#context,
            query.afterCursor ?? 0,
            boundedLimit(query.limit),
            query.includeAcknowledged ?? false,
          );
          break;
        case "GetProviderAttempt":
          result = getProviderAttempt(
            this.#context,
            query.providerAttemptId,
            principal,
            principalContext,
          );
          break;
        case "GetAttentionRecoverySnapshot":
          requireKind(this.#context, principal, "runtime");
          result = getAttentionRecoverySnapshot(this.#context);
          break;
        case "ListRecoverableAttentionExecutions":
          requireKind(this.#context, principal, "runtime");
          result = listRecoverableAttentionExecutions(
            this.#context,
            query.afterCursor,
            query.recoveryRevision,
            boundedLimit(query.limit),
          );
          break;
        case "ListThreadProjections": {
          if (query.channelId) {
            assertProjectChannel(
              this.#context,
              query.projectId,
              query.channelId,
            );
          }
          const scope = resolvePrincipalReadScope(
            this.#context,
            principal,
            principalContext,
            query.projectId,
          );
          if (
            query.channelId &&
            scope.channelId &&
            query.channelId !== scope.channelId
          ) {
            throw new KernelError(
              "Forbidden",
              "The Activation cannot read this Channel.",
            );
          }
          const snapshot = resolvePublicSnapshot(
            this.#context,
            query.projectId,
            query.snapshotEventId,
          );
          const after = resolvePublicSnapshot(
            this.#context,
            query.projectId,
            query.afterEventId ?? null,
          );
          if (after.sequence > snapshot.sequence) {
            throw new KernelError(
              "InvalidCommand",
              "The page cursor is after the requested snapshot.",
            );
          }
          result = listThreadProjections(
            this.#context,
            query.projectId,
            query.channelId,
            after.sequence,
            snapshot.sequence,
            snapshot.eventId,
            boundedLimit(query.limit),
            scope,
          );
          break;
        }
        case "ListRunProjections": {
          if (query.channelId) {
            assertProjectChannel(
              this.#context,
              query.projectId,
              query.channelId,
            );
          }
          const scope = resolvePrincipalReadScope(
            this.#context,
            principal,
            principalContext,
            query.projectId,
          );
          if (
            query.channelId &&
            scope.channelId &&
            query.channelId !== scope.channelId
          ) {
            throw new KernelError(
              "Forbidden",
              "The Activation cannot read this Channel.",
            );
          }
          const snapshot = resolvePublicSnapshot(
            this.#context,
            query.projectId,
            query.snapshotEventId,
          );
          const after = resolvePublicSnapshot(
            this.#context,
            query.projectId,
            query.afterEventId ?? null,
          );
          if (after.sequence > snapshot.sequence) {
            throw new KernelError(
              "InvalidCommand",
              "The page cursor is after the requested snapshot.",
            );
          }
          result = listRunProjections(
            this.#context,
            query.projectId,
            query.channelId,
            after.sequence,
            snapshot.sequence,
            snapshot.eventId,
            boundedLimit(query.limit),
            scope,
          );
          break;
        }
        case "ReadPublicEvents": {
          const scope = resolvePrincipalReadScope(
            this.#context,
            principal,
            principalContext,
            query.projectId,
          );
          const afterEventId = query.afterEventId ?? null;
          result = readAuthorizedPublicEvents(
            this.#context,
            query.projectId,
            afterEventId,
            afterEventId
              ? projectEventSequence(
                  this.#context,
                  query.projectId,
                  afterEventId,
                )
              : 0,
            boundedLimit(query.limit),
            scope,
          );
          break;
        }
        case "GetProjectAgentStatus":
          requireProject(this.#context, query.projectId);
          assertProjectAccess(this.#context, principal, query.projectId);
          result = getProjectAgentStatus(
            this.#context,
            query.projectId,
            query.agentId,
          );
          break;
        case "GetWorktreeWriterLease":
          result = getWorktreeWriterLease(
            this.#context,
            query.worktreeId,
            principal,
          );
          break;
        case "ListWorktreeWriterLeaseEvents":
          result = listWorktreeWriterLeaseEvents(
            this.#context,
            query.worktreeId,
            query.afterCursor ?? 0,
            boundedLimit(query.limit),
            principal,
          );
          break;
        default:
          result = assertNever(query);
      }
      this.#context.database.exec("COMMIT");
      return result as QueryResult<Q>;
    } catch (error) {
      this.#context.database.exec("ROLLBACK");
      throw translateError(error);
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
    return this.#withDatabaseAccess(() => this.#readEvents(afterEventId, limit));
  }

  #readEvents(afterEventId: string | null, limit: number): readonly PublicEventEnvelope[] {
    this.#assertOpen();
    const afterSequence = afterEventId
      ? eventSequence(this.#context, afterEventId)
      : 0;
    return allRows(
      this.#context,
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
        return startThread(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "ReplyToThread":
        return replyToThread(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "SendToRun":
        return sendToRun(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "CancelRun":
        return cancelRun(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "WithdrawRunInput":
        return withdrawRunInput(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "ClaimAttention":
        return claimAttention(
          this.#context,
          command,
          principal,
          correlationId,
        );
      case "ResolveAttentionWithRun":
        return resolveAttentionWithRun(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "IgnoreAttention":
        return ignoreAttention(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "ResolveAttentionWithExistingRun":
        return resolveAttentionWithExistingRun(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "StartActivation":
        return startActivation(
          this.#context,
          command,
          principal,
          correlationId,
        );
      case "FinishActivation":
        return finishActivation(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "StartProviderAttempt":
        return startProviderAttempt(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "FinishProviderAttempt":
        return finishProviderAttempt(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "FailProviderAttempt":
        return failProviderAttempt(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "ParkRunAfterProviderAttemptFailure":
        return parkRunAfterProviderAttemptFailure(
          this.#context,
          command,
          principal,
          correlationId,
        );
      case "ClaimOutboxEvents":
        return claimOutboxEvents(
          this.#context,
          command,
          principal,
          correlationId,
        );
      case "AcknowledgeOutboxEvents":
        return acknowledgeOutboxEvents(
          this.#context,
          command,
          principal,
          correlationId,
        );
      case "AppendRunActivity":
        return appendRunActivity(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "PublishRunReply":
        return publishRunReply(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "PublishArtifact":
        return publishArtifact(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "CompleteRun":
        return completeRun(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "WaitRun":
        return waitRun(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "FailRun":
        return failRun(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "RecordLateOutput":
        return recordLateOutput(
          this.#context,
          command,
          principal,
          context,
          correlationId,
        );
      case "AcquireWorktreeWriterLease":
        return acquireWorktreeWriterLease(
          this.#context,
          command,
          principal,
          correlationId,
        );
      case "RegisterPhysicalWorktree":
      case "StartWorktreeExecution":
      case "RecordWorktreeExecution":
      case "RevokeWorktreeExecutionAuthority":
      case "RecoverWorktreeExecution":
        return physicalWorktreeCommand(this.#context, command, principal, correlationId);
      case "RenewWorktreeWriterLease":
        return renewWorktreeWriterLease(
          this.#context,
          command,
          principal,
          correlationId,
        );
      case "ReleaseWorktreeWriterLease":
        return releaseWorktreeWriterLease(
          this.#context,
          command,
          principal,
          correlationId,
        );
      case "QuarantineWorktreeWriterLease":
        return quarantineWorktreeWriterLease(
          this.#context,
          command,
          principal,
          correlationId,
        );
      case "ResolveWorktreeWriterLeaseQuarantine":
        return resolveWorktreeWriterLeaseQuarantine(
          this.#context,
          command,
          principal,
          correlationId,
        );
      default:
        return assertNever(command);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new KernelError("Conflict", "The kernel is closed.");
    }
  }
}
