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

export type ProviderExecutionResult = Readonly<Record<never, never>>;

export interface ProviderAdapter {
  readonly name: string;
  readonly version: string;
  readonly capabilities: ProviderCapabilityProfile;
  execute(
    context: ProviderExecutionContext,
  ): Promise<ProviderExecutionResult>;
}

const providerDiagnosticSummaries = {
  provider_cancelled: "Provider execution was cancelled.",
  provider_cleanup_failed: "Provider process cleanup did not complete.",
  provider_execution_failed: "Provider execution failed.",
  provider_io_error: "Provider process I/O failed.",
  provider_not_started:
    "Provider execution did not start because authority expired.",
  provider_output_limit: "Provider output exceeded a configured safety limit.",
  provider_policy_violation: "Provider violated the configured capability policy.",
  provider_process_exited: "Provider process exited before completion.",
  provider_process_start_failed: "Provider process could not be started.",
  provider_protocol_error: "Provider protocol validation failed.",
  provider_recovered_failed: "Runtime recovered a failed provider attempt.",
  provider_recovered_unknown:
    "Runtime recovered an unfinished provider attempt.",
  provider_runtime_monitor_failed:
    "Runtime could not confirm provider execution authority.",
  provider_stderr_limit:
    "Provider diagnostic output exceeded a configured safety limit.",
  provider_timeout: "Provider execution exceeded its allowed time.",
} as const;

export type ProviderDiagnosticCode = keyof typeof providerDiagnosticSummaries;

export class ProviderExecutionError extends Error {
  readonly diagnosticCode: ProviderDiagnosticCode;
  readonly outcome: Extract<ProviderAttemptStatus, "Failed" | "Unknown">;

  constructor(
    diagnosticCode: ProviderDiagnosticCode,
    outcome: Extract<
      ProviderAttemptStatus,
      "Failed" | "Unknown"
    >,
  ) {
    const safeCode = isProviderDiagnosticCode(diagnosticCode)
      ? diagnosticCode
      : "provider_execution_failed";
    const safeOutcome = outcome === "Unknown" ? "Unknown" : "Failed";
    super(providerPublicDiagnostic(safeCode));
    this.diagnosticCode = safeCode;
    this.outcome = safeOutcome;
    this.name = "ProviderExecutionError";
  }
}

export class ProviderProtocolError extends ProviderExecutionError {
  constructor(
    _privateDetail?: string,
    diagnosticCode: Extract<
      ProviderDiagnosticCode,
      | "provider_output_limit"
      | "provider_policy_violation"
      | "provider_protocol_error"
    > = "provider_protocol_error",
  ) {
    super(diagnosticCode, "Failed");
    this.name = "ProviderProtocolError";
  }
}

export function normalizeProviderExecutionError(
  error: unknown,
  fallbackOutcome: Extract<
    ProviderAttemptStatus,
    "Failed" | "Unknown"
  > = "Failed",
): ProviderExecutionError {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && !visited.has(current); depth += 1) {
    if (current instanceof ProviderExecutionError) {
      return new ProviderExecutionError(
        current.diagnosticCode,
        current.outcome,
      );
    }
    visited.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return new ProviderExecutionError(
    "provider_execution_failed",
    fallbackOutcome,
  );
}

export function providerPublicDiagnostic(
  code: ProviderDiagnosticCode,
): string {
  const safeCode = isProviderDiagnosticCode(code)
    ? code
    : "provider_execution_failed";
  const detail = `${safeCode}: ${providerDiagnosticSummaries[safeCode]}`;
  if (detail.length > 160) {
    throw new Error(`Provider diagnostic ${safeCode} exceeds 160 characters.`);
  }
  return detail;
}

function isProviderDiagnosticCode(
  value: unknown,
): value is ProviderDiagnosticCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(providerDiagnosticSummaries, value)
  );
}
