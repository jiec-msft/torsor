export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface Project {
  readonly id: string;
  readonly name: string;
}

export interface Channel {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
}

export interface Agent {
  readonly id: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly name: string;
  readonly configRevision: number;
  readonly config: JsonValue;
}

export interface AgentStatus extends Agent {
  readonly liveRunActivationCount?: number;
  readonly liveAttentionActivationCount?: number;
  readonly liveActivationCount?: number;
  readonly nonterminalRunCount?: number;
  readonly status?: "active" | "waiting" | "idle";
}

export interface MessageRevision {
  readonly id: string;
  readonly revision: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Message {
  readonly id: string;
  readonly threadRootId: string;
  readonly replyToMessageId: string | null;
  readonly authorPrincipalId: string;
  readonly authorAgentId: string | null;
  readonly causedByAttentionId: string | null;
  readonly causedByRunId: string | null;
  readonly threadCursor: number;
  readonly latestRevision: number;
  readonly revisions: readonly MessageRevision[];
  readonly targetAgentIds: readonly string[];
  readonly createdAt: string;
}

export interface Attention {
  readonly cursor: number;
  readonly id: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly threadRootId: string;
  readonly messageRevisionId: string;
  readonly targetAgentId: string;
  readonly triggerKind: string;
  readonly status: "Open" | "Resolved" | "Ignored";
  readonly revision: number;
  readonly handlerLeaseHolderPrincipalId: string | null;
  readonly handlerLeaseExpiresAt: string | null;
  readonly resolutionOutcome: string | null;
  readonly resolvedRunId: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface Run {
  readonly id: string;
  readonly projectId: string;
  readonly homeChannelId: string;
  readonly threadRootId: string;
  readonly ownerAgentId: string;
  readonly agentConfigRevision: number;
  readonly state: "Active" | "Waiting" | "Completed" | "Failed" | "Cancelled";
  readonly revision: number;
  readonly activationGeneration: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalReason: string | null;
}

export interface RunInput {
  readonly id: string;
  readonly runId: string;
  readonly messageRevisionId: string;
  readonly sequence: number;
  readonly assignedByPrincipalId: string;
  readonly assignedByActivationId: string | null;
  readonly sourceAttentionId: string | null;
  readonly disposition:
    | "Pending"
    | "Incorporated"
    | "Declined"
    | "Superseded"
    | "Withdrawn"
    | "Abandoned";
  readonly dispositionRevision: number;
  readonly dispositionReason: string | null;
  readonly supersededByRunInputId: string | null;
  readonly createdAt: string;
}

export interface Activation {
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
  readonly outcome: string | null;
  readonly detail: string | null;
}

export interface ProviderAttempt {
  readonly id: string;
  readonly activationId: string;
  readonly runId: string | null;
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly capabilitySnapshot: JsonValue;
  readonly runInputIds: readonly string[];
  readonly requestIdempotencyKey: string;
  readonly status:
    | "Started"
    | "Acknowledged"
    | "Completed"
    | "Failed"
    | "Unknown";
  readonly detail: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface ActivityEvent {
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

export interface ThreadProjection {
  readonly projectId: string;
  readonly channelId: string;
  readonly threadRootId: string;
  readonly cursor: number;
  readonly messages: readonly Message[];
  readonly attentions: readonly Attention[];
  readonly runs: readonly Run[];
  readonly artifacts: readonly unknown[];
}

export interface RunProjection {
  readonly run: Run;
  readonly inputs: readonly RunInput[];
  readonly activations: readonly Activation[];
  readonly providerAttempts: readonly ProviderAttempt[];
  readonly activity: {
    readonly items: readonly ActivityEvent[];
    readonly hasEarlier: boolean;
    readonly earliestSequence: number | null;
    readonly latestSequence: number | null;
  };
  readonly artifacts: readonly unknown[];
}

export interface Bootstrap {
  readonly project: Project;
  readonly channels: readonly Channel[];
  readonly agents: readonly Agent[];
  readonly openAttentions: AttentionPage;
  readonly latestEventId: string | null;
}

export interface AttentionPage {
  readonly items: readonly Attention[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
  readonly snapshotEventId: string | null;
}

export interface PublicEvent {
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

export function latestMessageBody(message: Message | undefined): string {
  if (!message) {
    return "";
  }
  return (
    message.revisions.find(
      (revision) => revision.revision === message.latestRevision,
    )?.body ??
    message.revisions.at(-1)?.body ??
    ""
  );
}
