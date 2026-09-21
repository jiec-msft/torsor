import type {
  AttentionView,
  BootstrapAgent,
  CompletionException,
  JsonValue,
  ProviderAttemptStatus,
  RunProjection,
  ThreadProjection,
} from "@torsor/kernel";

export interface ProviderCapabilityProfile {
  readonly acceptsInputWhileRunning: boolean;
  readonly supportsCancel: boolean;
  readonly supportsResume: boolean;
  readonly supportsSessionContinuation: boolean;
  readonly supportsGracefulPause: boolean;
  readonly supportsIdempotentRequests: boolean;
}

export type ProviderCause =
  | {
      readonly type: "attention";
      readonly attention: AttentionView;
    }
  | {
      readonly type: "run";
      readonly run: RunProjection;
      readonly thread: ThreadProjection;
    };

export interface CompleteRunInput {
  readonly incorporatedThroughInputSequence?: number;
  readonly exceptions?: readonly CompletionException[];
  readonly finalReply?: {
    readonly body: string;
    readonly targetAgentIds?: readonly string[];
    readonly expectedThreadCursor?: number;
  };
}

export interface ArtifactInput {
  readonly contentDigest: string;
  readonly baseRevision: string;
  readonly mediaType: string;
  readonly storageLocation: string;
  readonly metadata?: JsonValue;
}

export interface ActivationCapabilityBridge {
  readonly activationId: string;
  readonly providerAttemptId: string;
  readonly causeType: ProviderCause["type"];
  readonly createdRunId: string | null;
  readonly terminalAction: "complete" | "fail" | "wait" | null;

  createRunFromAttention(): Promise<string>;
  appendActivity(
    kind: string,
    payload: JsonValue,
    retentionClass?: "durable" | "transient",
  ): Promise<string>;
  publishReply(input: {
    readonly body: string;
    readonly targetAgentIds?: readonly string[];
    readonly expectedThreadCursor?: number;
  }): Promise<string>;
  publishArtifact(input: ArtifactInput): Promise<string>;
  reportStatus(status: string, detail?: string): Promise<string>;
  complete(input?: CompleteRunInput): Promise<void>;
  fail(reason: string): Promise<void>;
  wait(reason: string): Promise<void>;
}

export interface ProviderExecutionContext {
  readonly activationId: string;
  readonly providerAttemptId: string;
  readonly requestIdempotencyKey: string;
  readonly agent: BootstrapAgent;
  readonly cause: ProviderCause;
  readonly capabilities: ActivationCapabilityBridge;
  readonly signal: AbortSignal;
}

export interface ProviderExecutionResult {
  readonly detail?: string;
  readonly diagnosticSessionId?: string;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly version: string;
  readonly capabilities: ProviderCapabilityProfile;
  execute(
    context: ProviderExecutionContext,
  ): Promise<ProviderExecutionResult>;
}

export class ProviderExecutionError extends Error {
  constructor(
    message: string,
    public readonly outcome: Extract<
      ProviderAttemptStatus,
      "Failed" | "Unknown"
    >,
  ) {
    super(message);
    this.name = "ProviderExecutionError";
  }
}

export class ProviderProtocolError extends ProviderExecutionError {
  constructor(message: string) {
    super(message, "Failed");
    this.name = "ProviderProtocolError";
  }
}
