import type {
  AttentionView,
  BootstrapAgent,
  CompletionException,
  JsonValue,
  MessageRevisionView,
  MessageView,
  ProviderAttemptStatus,
  RunProjection,
  RunView,
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
      readonly thread: ThreadProjection;
      readonly triggeringMessage: MessageView;
      readonly triggeringRevision: MessageRevisionView;
      readonly eligibleRuns: readonly RunView[];
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

export type AttentionDecision =
  | { readonly type: "ignore"; readonly reason: string }
  | { readonly type: "continue"; readonly runId: string }
  | { readonly type: "create"; readonly runId: string };

export interface ActivationCapabilityBridge {
  readonly activationId: string;
  readonly providerAttemptId: string;
  readonly causeType: ProviderCause["type"];
  readonly attentionDecision: AttentionDecision | null;
  readonly terminalAction: "complete" | "fail" | "wait" | null;
  readonly reportArtifactsEnabled: boolean;

  createRunFromAttention(): Promise<string>;
  continueAttentionWithRun(runId: string): Promise<string>;
  ignoreAttention(reason: string): Promise<void>;
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
  reportStatus(status: string, detail?: string): Promise<string>;
  publishReport(input: { readonly idempotencyKey: string; readonly text: string }): Promise<string>;
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
