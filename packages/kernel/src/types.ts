import type { ArtifactStorage } from "./artifact-storage.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PrincipalKind = "human" | "agent" | "runtime";
export type RunState =
  | "Active"
  | "Waiting"
  | "Completed"
  | "Failed"
  | "Cancelled";
export type AttentionStatus = "Open" | "Resolved" | "Ignored";
export type AttentionResolutionOutcome =
  | "RunCreated"
  | "ExistingRunContinued"
  | "Ignored";
export type RunInputDisposition =
  | "Pending"
  | "Incorporated"
  | "Declined"
  | "Superseded"
  | "Withdrawn"
  | "Abandoned";
export type ProviderAttemptStatus =
  | "Started"
  | "Acknowledged"
  | "Completed"
  | "Failed"
  | "Unknown";
export type ActivationOutcome =
  | "Completed"
  | "Failed"
  | "Cancelled"
  | "Expired";
export type WorktreeWriterLeaseStatus =
  | "Active"
  | "Released"
  | "Expired"
  | "Quarantined";
export type WorktreeWriterLeaseEventType =
  | "WorktreeWriterLeaseAcquired"
  | "WorktreeWriterLeaseRenewed"
  | "WorktreeWriterLeaseReleased"
  | "WorktreeWriterLeaseExpired"
  | "WorktreeWriterLeaseQuarantined"
  | "WorktreeWriterLeaseQuarantineResolved";

export interface PrincipalContext {
  readonly principalId: string;
  readonly activationId?: string;
}

export interface BootstrapPrincipal {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly displayName: string;
}

export interface BootstrapProject {
  readonly id: string;
  readonly name: string;
}

export interface BootstrapChannel {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
}

export interface BootstrapAgent {
  readonly id: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly name: string;
  readonly configRevision: number;
  readonly config: JsonValue;
}

export interface KernelBootstrap {
  readonly principals?: readonly BootstrapPrincipal[];
  readonly projects?: readonly BootstrapProject[];
  readonly channels?: readonly BootstrapChannel[];
  readonly agents?: readonly BootstrapAgent[];
}

export interface CausalLimits {
  readonly maxDepth: number;
  readonly maxNonTerminalRunsPerRoot: number;
}

export interface KernelOpenOptions {
  readonly databasePath: string;
  readonly artifactStorage?: ArtifactStorage;
  /** Applied atomically only when initializing an empty version-0 database. */
  readonly bootstrap?: KernelBootstrap;
  readonly clock?: () => Date;
  readonly idFactory?: (prefix: string) => string;
  readonly activationDurationMs?: number;
  readonly causalLimits?: CausalLimits;
}

interface IdempotentCommand {
  readonly idempotencyKey: string;
}

interface MessageContent {
  readonly body: string;
  readonly targetAgentIds?: readonly string[];
}

export interface StartThreadCommand extends IdempotentCommand, MessageContent {
  readonly type: "StartThread";
  readonly projectId: string;
  readonly channelId: string;
}

export interface ReplyToThreadCommand extends IdempotentCommand, MessageContent {
  readonly type: "ReplyToThread";
  readonly threadRootId: string;
  readonly expectedThreadCursor?: number;
}

export interface SendToRunCommand extends IdempotentCommand, MessageContent {
  readonly type: "SendToRun";
  readonly runId: string;
  readonly expectedRunRevision: number;
}

export interface CancelRunCommand extends IdempotentCommand {
  readonly type: "CancelRun";
  readonly runId: string;
  readonly expectedRunRevision: number;
  readonly reason: string;
}

export interface WithdrawRunInputCommand extends IdempotentCommand {
  readonly type: "WithdrawRunInput";
  readonly runInputId: string;
  readonly expectedRunRevision: number;
  readonly expectedDispositionRevision: number;
  readonly reason: string;
}

export interface ClaimAttentionCommand extends IdempotentCommand {
  readonly type: "ClaimAttention";
  readonly attentionId: string;
  readonly expectedAttentionRevision: number;
  readonly leaseDurationMs: number;
}

export interface ResolveAttentionWithRunCommand extends IdempotentCommand {
  readonly type: "ResolveAttentionWithRun";
  readonly attentionId: string;
  readonly expectedAttentionRevision: number;
  readonly handlerLeaseToken: string;
}

export interface IgnoreAttentionCommand extends IdempotentCommand {
  readonly type: "IgnoreAttention";
  readonly attentionId: string;
  readonly expectedAttentionRevision: number;
  readonly handlerLeaseToken: string;
  readonly reason: string;
}

export interface ResolveAttentionWithExistingRunCommand
  extends IdempotentCommand {
  readonly type: "ResolveAttentionWithExistingRun";
  readonly attentionId: string;
  readonly expectedAttentionRevision: number;
  readonly handlerLeaseToken: string;
  readonly runId: string;
  readonly expectedRunRevision: number;
}

export interface StartActivationCommand extends IdempotentCommand {
  readonly type: "StartActivation";
  readonly runId?: string;
  readonly attentionId?: string;
  readonly handlerLeaseToken?: string;
  readonly expectedRunRevision?: number;
  readonly outboxEventId?: string;
  readonly outboxLeaseToken?: string;
  readonly durationMs?: number;
}

export interface FinishActivationCommand extends IdempotentCommand {
  readonly type: "FinishActivation";
  readonly activationId: string;
  readonly outcome: ActivationOutcome;
  readonly detail?: string;
}

export interface StartProviderAttemptCommand extends IdempotentCommand {
  readonly type: "StartProviderAttempt";
  readonly activationId: string;
  readonly outboxEventId?: string;
  readonly outboxLeaseToken?: string;
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly capabilitySnapshot: JsonValue;
  readonly runInputIds: readonly string[];
  readonly requestIdempotencyKey: string;
  readonly diagnosticSessionId?: string;
}

export interface FinishProviderAttemptCommand extends IdempotentCommand {
  readonly type: "FinishProviderAttempt";
  readonly providerAttemptId: string;
  readonly status: Exclude<ProviderAttemptStatus, "Started" | "Failed">;
  readonly detail?: string;
}

export interface ClaimOutboxEventsCommand extends IdempotentCommand {
  readonly type: "ClaimOutboxEvents";
  readonly limit?: number;
  readonly leaseDurationMs: number;
}

export interface AcknowledgeOutboxEventsCommand extends IdempotentCommand {
  readonly type: "AcknowledgeOutboxEvents";
  readonly outboxEventIds: readonly string[];
  readonly leaseToken: string;
}

export interface FailProviderAttemptCommand extends IdempotentCommand {
  readonly type: "FailProviderAttempt";
  readonly providerAttemptId: string;
  readonly error: string;
}

export interface ParkRunAfterProviderAttemptFailureCommand
  extends IdempotentCommand {
  readonly type: "ParkRunAfterProviderAttemptFailure";
  readonly runId: string;
  readonly providerAttemptId: string;
  readonly expectedRunRevision: number;
  readonly expectedActivationGeneration: number;
  readonly reason: string;
}

export interface AppendRunActivityCommand extends IdempotentCommand {
  readonly type: "AppendRunActivity";
  readonly runId: string;
  readonly activationId?: string;
  readonly providerAttemptId?: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly retentionClass: "durable" | "transient";
}

export interface PublishRunReplyCommand
  extends IdempotentCommand,
    MessageContent {
  readonly type: "PublishRunReply";
  readonly runId: string;
  readonly expectedRunRevision: number;
  readonly expectedThreadCursor?: number;
}

export interface PublishArtifactCommand extends IdempotentCommand {
  readonly type: "PublishArtifact";
  readonly runId: string;
  readonly expectedRunRevision: number;
  readonly contentDigest: string;
  readonly byteLength: number;
}

export interface FinalizeReportInput extends IdempotentCommand {
  readonly runId: string;
  readonly expectedRunRevision: number;
  readonly content: Uint8Array | AsyncIterable<Uint8Array>;
}

export interface ArtifactContent {
  readonly artifact: ArtifactView;
  readonly content: Uint8Array;
}

export interface CompletionException {
  readonly runInputId: string;
  readonly disposition: Exclude<
    RunInputDisposition,
    "Pending" | "Incorporated" | "Withdrawn"
  >;
  readonly reason: string;
  readonly supersededByRunInputId?: string;
}

export interface CompleteRunCommand extends IdempotentCommand {
  readonly type: "CompleteRun";
  readonly runId: string;
  readonly expectedRunRevision: number;
  readonly incorporatedThroughInputSequence: number;
  readonly exceptions?: readonly CompletionException[];
  readonly finalReply?: MessageContent & {
    readonly expectedThreadCursor?: number;
  };
}

export interface WaitRunCommand extends IdempotentCommand {
  readonly type: "WaitRun";
  readonly runId: string;
  readonly expectedRunRevision: number;
  readonly reason: string;
}

export interface FailRunCommand extends IdempotentCommand {
  readonly type: "FailRun";
  readonly runId: string;
  readonly expectedRunRevision: number;
  readonly reason: string;
}

export interface RecordLateOutputCommand extends IdempotentCommand {
  readonly type: "RecordLateOutput";
  readonly runId: string;
  readonly activationId?: string;
  readonly providerAttemptId?: string;
  readonly payload: JsonValue;
}

export interface AcquireWorktreeWriterLeaseCommand extends IdempotentCommand {
  readonly type: "AcquireWorktreeWriterLease";
  readonly worktreeId: string;
  readonly leaseDurationMs: number;
}

export interface WorktreeLeaseAuthority {
  readonly worktreeId: string;
  readonly generation: number;
  readonly fencingToken: number;
  readonly leaseToken: string;
}

interface WorktreeWriterLeaseAuthorityCommand extends IdempotentCommand, WorktreeLeaseAuthority {}

export interface PhysicalWorktreeBinding {
  readonly worktreeId: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly baseRevision: string;
  readonly directoryPath: string;
  readonly directoryIdentity: string;
}

export interface RegisterPhysicalWorktreeCommand extends IdempotentCommand, PhysicalWorktreeBinding {
  readonly type: "RegisterPhysicalWorktree";
}

export interface StartWorktreeExecutionCommand extends WorktreeWriterLeaseAuthorityCommand {
  readonly type: "StartWorktreeExecution";
  readonly activationId: string;
  readonly executorId: string;
}

export interface WorktreeExecutionReceipt {
  readonly executionId: string;
  readonly executorId: string;
  readonly executionToken: string;
}

export interface WorktreeMutationAuthority extends WorktreeLeaseAuthority, WorktreeExecutionReceipt {}

export type WorktreeExecutionState =
  | "Starting" | "Running" | "StopRequested"
  | "StopConfirmed" | "ForceTerminated" | "Uncertain";

export interface RecordWorktreeExecutionCommand extends IdempotentCommand, WorktreeExecutionReceipt {
  readonly type: "RecordWorktreeExecution";
  readonly state: Exclude<WorktreeExecutionState, "Starting">;
  readonly pid?: number;
  readonly evidence: string;
  readonly preservePublicationAuthority?: boolean;
}

export interface RevokeWorktreeExecutionAuthorityCommand extends IdempotentCommand, WorktreeExecutionReceipt {
  readonly type: "RevokeWorktreeExecutionAuthority";
  readonly reason: string;
}

export interface RecoverWorktreeExecutionCommand extends IdempotentCommand {
  readonly type: "RecoverWorktreeExecution";
  readonly executionId: string;
  readonly reason: string;
}

export interface WorktreeExecutionView {
  readonly id: string;
  readonly activationId: string;
  readonly executorId: string;
  readonly runtimePrincipalId: string;
  readonly generation: number;
  readonly fencingToken: number;
  readonly state: WorktreeExecutionState;
  readonly pid: number | null;
  readonly authorityRevokedAt: string | null;
  readonly authorityRevocationReason: string | null;
  readonly events: readonly {
    readonly state: WorktreeExecutionState;
    readonly evidence: string;
    readonly occurredAt: string;
  }[];
}

export interface PhysicalWorktreeView extends PhysicalWorktreeBinding {
  readonly state: "Ready" | "Quarantined";
  readonly latestExecution: WorktreeExecutionView | null;
}

export interface RenewWorktreeWriterLeaseCommand
  extends WorktreeWriterLeaseAuthorityCommand {
  readonly type: "RenewWorktreeWriterLease";
  readonly leaseDurationMs: number;
}

export interface ReleaseWorktreeWriterLeaseCommand
  extends WorktreeWriterLeaseAuthorityCommand {
  readonly type: "ReleaseWorktreeWriterLease";
}

export interface QuarantineWorktreeWriterLeaseCommand
  extends IdempotentCommand {
  readonly type: "QuarantineWorktreeWriterLease";
  readonly worktreeId: string;
  readonly expectedGeneration?: number;
  readonly expectedFencingToken?: number;
  readonly leaseToken?: string;
  readonly reason: string;
  readonly evidence?: JsonValue;
}

export interface ResolveWorktreeWriterLeaseQuarantineCommand
  extends IdempotentCommand {
  readonly type: "ResolveWorktreeWriterLeaseQuarantine";
  readonly worktreeId: string;
  readonly expectedRevision: number;
  readonly expectedFencingToken: number;
  readonly quarantineToken: string;
  readonly resolution: string;
}

export type KernelCommand =
  | StartThreadCommand
  | ReplyToThreadCommand
  | SendToRunCommand
  | CancelRunCommand
  | WithdrawRunInputCommand
  | ClaimAttentionCommand
  | ResolveAttentionWithRunCommand
  | IgnoreAttentionCommand
  | ResolveAttentionWithExistingRunCommand
  | StartActivationCommand
  | FinishActivationCommand
  | StartProviderAttemptCommand
  | FinishProviderAttemptCommand
  | FailProviderAttemptCommand
  | ParkRunAfterProviderAttemptFailureCommand
  | ClaimOutboxEventsCommand
  | AcknowledgeOutboxEventsCommand
  | AppendRunActivityCommand
  | PublishRunReplyCommand
  | PublishArtifactCommand
  | CompleteRunCommand
  | WaitRunCommand
  | FailRunCommand
  | RecordLateOutputCommand
  | RegisterPhysicalWorktreeCommand
  | StartWorktreeExecutionCommand
  | RecordWorktreeExecutionCommand
  | RevokeWorktreeExecutionAuthorityCommand
  | RecoverWorktreeExecutionCommand
  | AcquireWorktreeWriterLeaseCommand
  | RenewWorktreeWriterLeaseCommand
  | ReleaseWorktreeWriterLeaseCommand
  | QuarantineWorktreeWriterLeaseCommand
  | ResolveWorktreeWriterLeaseQuarantineCommand;

export interface GetBootstrapQuery {
  readonly type: "GetBootstrap";
  readonly projectId: string;
}

export interface GetThreadProjectionQuery {
  readonly type: "GetThreadProjection";
  readonly threadRootId: string;
}

export interface GetRunProjectionQuery {
  readonly type: "GetRunProjection";
  readonly runId: string;
}

export interface GetArtifactQuery {
  readonly type: "GetArtifact";
  readonly artifactId: string;
}

export interface ListActivityQuery {
  readonly type: "ListActivity";
  readonly runId: string;
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly limit?: number;
}

export interface ListOpenAttentionsQuery {
  readonly type: "ListOpenAttentions";
  readonly projectId?: string;
  readonly targetAgentId?: string;
  readonly afterCursor?: number;
  readonly snapshotEventId?: string | null;
  readonly limit?: number;
}

export interface ListOutboxEventsQuery {
  readonly type: "ListOutboxEvents";
  readonly afterCursor?: number;
  readonly limit?: number;
  readonly includeAcknowledged?: boolean;
}

export interface GetProviderAttemptQuery {
  readonly type: "GetProviderAttempt";
  readonly providerAttemptId: string;
}

export interface RecoverableAttentionExecutionCursor {
  readonly startedAt: string;
  readonly activationId: string;
}

export interface AttentionRecoverySnapshot {
  readonly revision: number;
  readonly observedAt: string;
  readonly nextExpiryAt: string | null;
}

export interface GetAttentionRecoverySnapshotQuery {
  readonly type: "GetAttentionRecoverySnapshot";
}

export interface ListRecoverableAttentionExecutionsQuery {
  readonly type: "ListRecoverableAttentionExecutions";
  readonly afterCursor?: RecoverableAttentionExecutionCursor;
  readonly recoveryRevision?: number;
  readonly limit?: number;
}

export interface ListThreadProjectionsQuery {
  readonly type: "ListThreadProjections";
  readonly projectId: string;
  readonly channelId?: string;
  readonly afterEventId?: string | null;
  readonly snapshotEventId?: string | null;
  readonly limit?: number;
}

export interface ListRunProjectionsQuery {
  readonly type: "ListRunProjections";
  readonly projectId: string;
  readonly channelId?: string;
  readonly afterEventId?: string | null;
  readonly snapshotEventId?: string | null;
  readonly limit?: number;
}

export interface ReadPublicEventsQuery {
  readonly type: "ReadPublicEvents";
  readonly projectId: string;
  readonly afterEventId?: string | null;
  readonly limit?: number;
}

export interface GetProjectAgentStatusQuery {
  readonly type: "GetProjectAgentStatus";
  readonly projectId: string;
  readonly agentId?: string;
}

export interface GetWorktreeWriterLeaseQuery {
  readonly type: "GetWorktreeWriterLease";
  readonly worktreeId: string;
}

export interface ListWorktreeWriterLeaseEventsQuery {
  readonly type: "ListWorktreeWriterLeaseEvents";
  readonly worktreeId: string;
  readonly afterCursor?: number;
  readonly limit?: number;
}

export type KernelQuery =
  | { readonly type: "GetWorktreeStorageIdentity" }
  | { readonly type: "ListPhysicalWorktrees"; readonly afterWorktreeId?: string; readonly limit?: number }
  | { readonly type: "GetPhysicalWorktree"; readonly worktreeId: string }
  | GetArtifactQuery
  | GetBootstrapQuery
  | GetThreadProjectionQuery
  | GetRunProjectionQuery
  | ListActivityQuery
  | ListOpenAttentionsQuery
  | ListOutboxEventsQuery
  | GetProviderAttemptQuery
  | GetAttentionRecoverySnapshotQuery
  | ListRecoverableAttentionExecutionsQuery
  | ListThreadProjectionsQuery
  | ListRunProjectionsQuery
  | ReadPublicEventsQuery
  | GetProjectAgentStatusQuery
  | GetWorktreeWriterLeaseQuery
  | ListWorktreeWriterLeaseEventsQuery;

export interface MessageRevisionView {
  readonly id: string;
  readonly revision: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface MessageView {
  readonly id: string;
  readonly threadRootId: string;
  readonly replyToMessageId: string | null;
  readonly authorPrincipalId: string;
  readonly authorAgentId: string | null;
  readonly causedByAttentionId: string | null;
  readonly causedByRunId: string | null;
  readonly threadCursor: number;
  readonly latestRevision: number;
  readonly revisions: readonly MessageRevisionView[];
  readonly targetAgentIds: readonly string[];
  readonly createdAt: string;
}

export interface AttentionView {
  readonly cursor: number;
  readonly id: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly threadRootId: string;
  readonly messageRevisionId: string;
  readonly targetAgentId: string;
  readonly triggerKind: string;
  readonly status: AttentionStatus;
  readonly revision: number;
  readonly handlerLeaseHolderPrincipalId: string | null;
  readonly handlerLeaseExpiresAt: string | null;
  readonly resolutionOutcome: AttentionResolutionOutcome | null;
  readonly resolvedRunId: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface RunInputView {
  readonly id: string;
  readonly runId: string;
  readonly messageRevisionId: string;
  readonly sequence: number;
  readonly assignedByPrincipalId: string;
  readonly assignedByActivationId: string | null;
  readonly sourceAttentionId: string | null;
  readonly disposition: RunInputDisposition;
  readonly dispositionRevision: number;
  readonly dispositionReason: string | null;
  readonly supersededByRunInputId: string | null;
  readonly createdAt: string;
}

export interface RunView {
  readonly id: string;
  readonly projectId: string;
  readonly homeChannelId: string;
  readonly threadRootId: string;
  readonly ownerAgentId: string;
  readonly agentConfigRevision: number;
  readonly causalRootId: string;
  readonly parentAttentionId: string;
  readonly parentRunId: string | null;
  readonly delegationDepth: number;
  readonly state: RunState;
  readonly revision: number;
  readonly activationGeneration: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalReason: string | null;
}

export interface ActivationAttemptView {
  readonly id: string;
  readonly agentId: string;
  readonly runId: string | null;
  readonly attentionId: string | null;
  readonly configRevision: number;
  readonly runActivationGeneration: number | null;
  readonly runInputIds: readonly string[];
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly finishedAt: string | null;
  readonly outcome: ActivationOutcome | null;
  readonly detail: string | null;
}

export interface ProviderAttemptView {
  readonly id: string;
  readonly activationId: string;
  readonly runId: string | null;
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly capabilitySnapshot: JsonValue;
  readonly runInputIds: readonly string[];
  readonly requestIdempotencyKey: string;
  readonly diagnosticSessionId: string | null;
  readonly status: ProviderAttemptStatus;
  readonly detail: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface RunActivityEventView {
  readonly id: string;
  readonly runId: string;
  readonly activationId: string | null;
  readonly providerAttemptId: string | null;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly retentionClass: "durable" | "transient";
  readonly createdAt: string;
}

export interface AttentionPage {
  readonly items: readonly AttentionView[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
  readonly snapshotEventId: string | null;
}

export interface ActivityPage {
  readonly items: readonly RunActivityEventView[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
}

export interface ActivityWindow {
  readonly items: readonly RunActivityEventView[];
  readonly hasEarlier: boolean;
  readonly earliestSequence: number | null;
  readonly latestSequence: number | null;
}

export interface OutboxEventView {
  readonly cursor: number;
  readonly id: string;
  readonly topic: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: JsonValue;
  readonly deliveryAttempts: number;
  readonly leaseHolderPrincipalId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly createdAt: string;
}

export interface OutboxPage {
  readonly items: readonly OutboxEventView[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
}

export interface RecoverableAttentionExecutionView {
  readonly cursor: RecoverableAttentionExecutionCursor;
  readonly attention: AttentionView;
  readonly activation: ActivationAttemptView;
  readonly providerAttempts: readonly ProviderAttemptView[];
}

export interface RecoverableAttentionExecutionPage {
  readonly items: readonly RecoverableAttentionExecutionView[];
  readonly nextCursor: RecoverableAttentionExecutionCursor | null;
  readonly hasMore: boolean;
  readonly recoverySnapshot: AttentionRecoverySnapshot;
}

export interface ArtifactView {
  readonly id: string;
  readonly contentDigest: string;
  readonly producerRunId: string;
  readonly producerActivationId: string;
  readonly producerThreadRootId: string;
  readonly baseRevision: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly visibilityChannelId: string;
  readonly metadata: JsonValue | null;
  readonly createdAt: string;
}

export interface PublicEventEnvelope {
  readonly eventId: string;
  readonly type: string;
  readonly projectId: string;
  readonly channelId: string | null;
  readonly threadRootId: string | null;
  readonly threadCursor: number | null;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorPrincipalId: string;
  readonly activationId: string | null;
  readonly causationId: string | null;
  readonly correlationId: string;
  readonly payload: JsonValue;
  readonly occurredAt: string;
}

export interface BootstrapProjection {
  readonly project: BootstrapProject;
  readonly channels: readonly BootstrapChannel[];
  readonly agents: readonly BootstrapAgent[];
  readonly openAttentions: AttentionPage;
  readonly latestEventId: string | null;
}

export interface ThreadProjection {
  readonly projectId: string;
  readonly channelId: string;
  readonly threadRootId: string;
  readonly cursor: number;
  readonly messages: readonly MessageView[];
  readonly attentions: readonly AttentionView[];
  readonly runs: readonly RunView[];
  readonly artifacts: readonly ArtifactView[];
}

export interface RunProjection {
  readonly run: RunView;
  readonly inputs: readonly RunInputView[];
  readonly activations: readonly ActivationAttemptView[];
  readonly providerAttempts: readonly ProviderAttemptView[];
  readonly activity: ActivityWindow;
  readonly artifacts: readonly ArtifactView[];
}

export interface ThreadProjectionPage {
  readonly items: readonly ThreadProjection[];
  readonly nextAfterEventId: string | null;
  readonly hasMore: boolean;
  readonly snapshotEventId: string | null;
}

export interface RunProjectionPage {
  readonly items: readonly RunProjection[];
  readonly nextAfterEventId: string | null;
  readonly hasMore: boolean;
  readonly snapshotEventId: string | null;
}

export interface AuthorizedPublicEventPage {
  readonly events: readonly PublicEventEnvelope[];
  readonly scannedThroughEventId: string | null;
  readonly hasMore: boolean;
}

export type ProjectAgentDerivedStatus = "active" | "waiting" | "idle";

export interface ProjectAgentStatusView {
  readonly agentId: string;
  readonly liveRunActivationCount: number;
  readonly liveAttentionActivationCount: number;
  readonly liveActivationCount: number;
  readonly nonterminalRunCount: number;
  readonly status: ProjectAgentDerivedStatus;
}

export interface ProjectAgentStatusProjection {
  readonly projectId: string;
  readonly agents: readonly ProjectAgentStatusView[];
}

export interface WorktreeWriterLeaseView {
  readonly worktreeId: string;
  readonly revision: number;
  readonly generation: number;
  readonly fencingToken: number;
  readonly status: WorktreeWriterLeaseStatus;
  readonly holderPrincipalId: string | null;
  readonly acquiredAt: string | null;
  readonly renewedAt: string | null;
  readonly expiresAt: string | null;
  readonly releasedAt: string | null;
  readonly quarantineReason: string | null;
  readonly quarantineEvidence: JsonValue | null;
  readonly quarantinedAt: string | null;
  readonly quarantineResolvedAt: string | null;
  readonly quarantineResolution: string | null;
  readonly updatedAt: string;
}

export interface WorktreeWriterLeaseEventView {
  readonly cursor: number;
  readonly id: string;
  readonly worktreeId: string;
  readonly type: WorktreeWriterLeaseEventType;
  readonly revision: number;
  readonly generation: number;
  readonly fencingToken: number;
  readonly actorPrincipalId: string;
  readonly holderPrincipalId: string | null;
  readonly expiresAt: string | null;
  readonly reason: string | null;
  readonly evidence: JsonValue | null;
  readonly correlationId: string;
  readonly occurredAt: string;
}

export interface WorktreeWriterLeaseEventPage {
  readonly items: readonly WorktreeWriterLeaseEventView[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
}

export interface QueryResultMap {
  readonly GetWorktreeStorageIdentity: { readonly identity: string };
  readonly ListPhysicalWorktrees: { readonly items: readonly PhysicalWorktreeView[]; readonly hasMore: boolean };
  readonly GetPhysicalWorktree: PhysicalWorktreeView;
  readonly GetArtifact: ArtifactView;
  readonly GetBootstrap: BootstrapProjection;
  readonly GetThreadProjection: ThreadProjection;
  readonly GetRunProjection: RunProjection;
  readonly ListActivity: ActivityPage;
  readonly ListOpenAttentions: AttentionPage;
  readonly ListOutboxEvents: OutboxPage;
  readonly GetProviderAttempt: ProviderAttemptView;
  readonly GetAttentionRecoverySnapshot: AttentionRecoverySnapshot;
  readonly ListRecoverableAttentionExecutions: RecoverableAttentionExecutionPage;
  readonly ListThreadProjections: ThreadProjectionPage;
  readonly ListRunProjections: RunProjectionPage;
  readonly ReadPublicEvents: AuthorizedPublicEventPage;
  readonly GetProjectAgentStatus: ProjectAgentStatusProjection;
  readonly GetWorktreeWriterLease: WorktreeWriterLeaseView;
  readonly ListWorktreeWriterLeaseEvents: WorktreeWriterLeaseEventPage;
}

export type QueryResult<Q extends KernelQuery> = QueryResultMap[Q["type"]];

export interface CommandResult {
  readonly commandType: KernelCommand["type"];
  readonly entityId: string;
  readonly revision?: number;
  readonly threadCursor?: number;
  readonly relatedIds?: Readonly<Record<string, string>>;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: string;
  readonly authorityObservedAt?: string;
  readonly outboxEvents?: readonly OutboxEventView[];
  readonly leaseGeneration?: number;
  readonly fencingToken?: number;
  readonly quarantineToken?: string;
  readonly executionToken?: string;
  readonly worktreeWriterLease?: WorktreeWriterLeaseView;
}
