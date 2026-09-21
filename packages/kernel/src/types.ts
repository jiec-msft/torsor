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

export interface KernelOpenOptions {
  readonly databasePath: string;
  readonly bootstrap?: KernelBootstrap;
  readonly clock?: () => Date;
  readonly idFactory?: (prefix: string) => string;
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

export interface StartActivationCommand extends IdempotentCommand {
  readonly type: "StartActivation";
  readonly runId?: string;
  readonly attentionId?: string;
  readonly handlerLeaseToken?: string;
  readonly expectedRunRevision?: number;
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

export interface FailProviderAttemptCommand extends IdempotentCommand {
  readonly type: "FailProviderAttempt";
  readonly providerAttemptId: string;
  readonly error: string;
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
  readonly baseRevision: string;
  readonly mediaType: string;
  readonly storageLocation: string;
  readonly metadata?: JsonValue;
}

export interface CompletionException {
  readonly runInputId: string;
  readonly disposition: Exclude<RunInputDisposition, "Pending" | "Incorporated">;
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

export type KernelCommand =
  | StartThreadCommand
  | ReplyToThreadCommand
  | SendToRunCommand
  | CancelRunCommand
  | ClaimAttentionCommand
  | ResolveAttentionWithRunCommand
  | StartActivationCommand
  | FinishActivationCommand
  | StartProviderAttemptCommand
  | FinishProviderAttemptCommand
  | FailProviderAttemptCommand
  | AppendRunActivityCommand
  | PublishRunReplyCommand
  | PublishArtifactCommand
  | CompleteRunCommand
  | WaitRunCommand
  | FailRunCommand
  | RecordLateOutputCommand;

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

export interface ListActivityQuery {
  readonly type: "ListActivity";
  readonly runId: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface ListOpenAttentionsQuery {
  readonly type: "ListOpenAttentions";
  readonly projectId?: string;
  readonly targetAgentId?: string;
  readonly limit?: number;
}

export type KernelQuery =
  | GetBootstrapQuery
  | GetThreadProjectionQuery
  | GetRunProjectionQuery
  | ListActivityQuery
  | ListOpenAttentionsQuery;

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
  readonly id: string;
  readonly messageRevisionId: string;
  readonly targetAgentId: string;
  readonly triggerKind: string;
  readonly status: AttentionStatus;
  readonly revision: number;
  readonly handlerLeaseHolderPrincipalId: string | null;
  readonly handlerLeaseExpiresAt: string | null;
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
  readonly state: RunState;
  readonly revision: number;
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
  readonly runInputIds: readonly string[];
  readonly startedAt: string;
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

export interface ArtifactView {
  readonly id: string;
  readonly contentDigest: string;
  readonly producerRunId: string;
  readonly producerActivationId: string;
  readonly baseRevision: string;
  readonly mediaType: string;
  readonly storageLocation: string;
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
  readonly openAttentions: readonly AttentionView[];
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
  readonly activity: readonly RunActivityEventView[];
  readonly artifacts: readonly ArtifactView[];
}

export interface QueryResultMap {
  readonly GetBootstrap: BootstrapProjection;
  readonly GetThreadProjection: ThreadProjection;
  readonly GetRunProjection: RunProjection;
  readonly ListActivity: readonly RunActivityEventView[];
  readonly ListOpenAttentions: readonly AttentionView[];
}

export type QueryResult<Q extends KernelQuery> = QueryResultMap[Q["type"]];

export interface CommandResult {
  readonly commandType: KernelCommand["type"];
  readonly entityId: string;
  readonly revision?: number;
  readonly threadCursor?: number;
  readonly relatedIds?: Readonly<Record<string, string>>;
}
