import { MAX_REPORT_BYTES } from "@torsor/kernel";
import type {
  AttentionView,
  BootstrapAgent,
  JsonValue,
  KernelOperationContext,
  RunProjection,
  RunView,
  TorsorKernel,
} from "@torsor/kernel";

import type {
  ActivationCapabilityBridge,
  AttentionDecision,
  CompleteRunInput,
} from "./types.js";

interface BridgeBaseOptions {
  readonly kernel: TorsorKernel;
  readonly agent: BootstrapAgent;
  readonly activationId: string;
  readonly providerAttemptId: string;
  readonly correlationId: string;
  readonly assertPublication?: () => void;
}

interface AttentionBridgeOptions extends BridgeBaseOptions {
  readonly causeType: "attention";
  readonly attention: AttentionView;
  readonly attentionRevision: number;
  readonly handlerLeaseToken: string;
  readonly eligibleRuns: readonly RunView[];
}

interface RunBridgeOptions extends BridgeBaseOptions {
  readonly causeType: "run";
  readonly projection: RunProjection;
}

type BridgeOptions = AttentionBridgeOptions | RunBridgeOptions;

export class KernelActivationCapabilityBridge
  implements ActivationCapabilityBridge
{
  readonly activationId: string;
  readonly providerAttemptId: string;
  readonly causeType: "attention" | "run";

  #attentionDecision: AttentionDecision | null = null;
  #terminalAction: "complete" | "fail" | "wait" | null = null;
  #nextCommand = 0;
  #runRevision: number | null;

  constructor(private readonly options: BridgeOptions) {
    this.activationId = options.activationId;
    this.providerAttemptId = options.providerAttemptId;
    this.causeType = options.causeType;
    this.#runRevision =
      options.causeType === "run" ? options.projection.run.revision : null;
  }

  get attentionDecision(): AttentionDecision | null {
    return this.#attentionDecision;
  }

  get terminalAction(): "complete" | "fail" | "wait" | null {
    return this.#terminalAction;
  }

  get reportArtifactsEnabled(): boolean {
    return this.causeType === "run" && this.options.kernel.reportArtifactsEnabled;
  }

  async publishReport(input: {
    readonly idempotencyKey: string;
    readonly text: string;
  }): Promise<string> {
    const run = this.#requireRun();
    if (
      Object.keys(input).some((key) => key !== "idempotencyKey" && key !== "text") ||
      typeof input.text !== "string" ||
      Buffer.byteLength(input.text, "utf8") > MAX_REPORT_BYTES
    ) {
      throw new Error("publish_report accepts only a stable key and bounded report text.");
    }
    const result = await this.options.kernel.finalizeReport(
      {
        runId: run.run.id,
        expectedRunRevision: this.#requireRunRevision(),
        idempotencyKey: input.idempotencyKey,
        content: Buffer.from(input.text, "utf8"),
      },
      this.#agentContext(),
      this.#operationContext(),
    );
    return result.entityId;
  }

  async createRunFromAttention(): Promise<string> {
    if (this.options.causeType !== "attention") {
      throw new Error("Only an Attention Activation can create its initial Run.");
    }
    this.#assertNoAttentionDecision();
    const result = await this.options.kernel.execute(
      {
        type: "ResolveAttentionWithRun",
        idempotencyKey: this.#key("create-run"),
        attentionId: this.options.attention.id,
        expectedAttentionRevision: this.options.attentionRevision,
        handlerLeaseToken: this.options.handlerLeaseToken,
      },
      this.#agentContext(),
      this.#operationContext(),
    );
    this.#attentionDecision = { type: "create", runId: result.entityId };
    return result.entityId;
  }

  async continueAttentionWithRun(runId: string): Promise<string> {
    if (this.options.causeType !== "attention") {
      throw new Error("Only an Attention Activation can continue a Run.");
    }
    this.#assertNoAttentionDecision();
    const eligible = this.options.eligibleRuns.find((run) => run.id === runId);
    if (!eligible) {
      throw new Error(`Run ${runId} is not eligible for this Attention.`);
    }
    const result = await this.options.kernel.execute(
      {
        type: "ResolveAttentionWithExistingRun",
        idempotencyKey: this.#key("continue-run"),
        attentionId: this.options.attention.id,
        expectedAttentionRevision: this.options.attentionRevision,
        handlerLeaseToken: this.options.handlerLeaseToken,
        runId,
        expectedRunRevision: eligible.revision,
      },
      this.#agentContext(),
      this.#operationContext(),
    );
    this.#attentionDecision = { type: "continue", runId };
    return result.relatedIds?.runInputId ?? result.entityId;
  }

  async ignoreAttention(reason: string): Promise<void> {
    if (this.options.causeType !== "attention") {
      throw new Error("Only an Attention Activation can ignore Attention.");
    }
    this.#assertNoAttentionDecision();
    await this.options.kernel.execute(
      {
        type: "IgnoreAttention",
        idempotencyKey: this.#key("ignore-attention"),
        attentionId: this.options.attention.id,
        expectedAttentionRevision: this.options.attentionRevision,
        handlerLeaseToken: this.options.handlerLeaseToken,
        reason,
      },
      this.#agentContext(),
      this.#operationContext(),
    );
    this.#attentionDecision = { type: "ignore", reason: reason.trim() };
  }

  async appendActivity(
    kind: string,
    payload: JsonValue,
    retentionClass: "durable" | "transient" = "durable",
  ): Promise<string> {
    const run = this.#requireRun();
    const result = await this.options.kernel.execute(
      {
        type: "AppendRunActivity",
        idempotencyKey: this.#key("append-activity"),
        runId: run.run.id,
        activationId: this.activationId,
        providerAttemptId: this.providerAttemptId,
        kind,
        payload,
        retentionClass,
      },
      this.#agentContext(),
      this.#operationContext(),
    );
    return result.entityId;
  }

  async publishReply(input: {
    readonly body: string;
    readonly targetAgentIds?: readonly string[];
    readonly expectedThreadCursor?: number;
  }): Promise<string> {
    const run = this.#requireRun();
    const result = await this.options.kernel.execute(
      {
        type: "PublishRunReply",
        idempotencyKey: this.#key("publish-reply"),
        runId: run.run.id,
        expectedRunRevision: this.#requireRunRevision(),
        body: input.body,
        ...(input.targetAgentIds
          ? { targetAgentIds: input.targetAgentIds }
          : {}),
        ...(input.expectedThreadCursor === undefined
          ? {}
          : { expectedThreadCursor: input.expectedThreadCursor }),
      },
      this.#agentContext(),
      this.#operationContext(),
    );
    return result.entityId;
  }

  async reportStatus(status: string, detail?: string): Promise<string> {
    return this.appendActivity(
      "status",
      detail === undefined ? { status } : { status, detail },
      "durable",
    );
  }

  async complete(input: CompleteRunInput = {}): Promise<void> {
    this.#assertNoTerminalAction();
    this.#terminalAction = "complete";
    const run = this.#requireRun();
    const incorporatedThroughInputSequence =
      input.incorporatedThroughInputSequence ??
      run.inputs.reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
    try {
      const result = await this.options.kernel.execute(
        {
          type: "CompleteRun",
          idempotencyKey: this.#key("complete-run"),
          runId: run.run.id,
          expectedRunRevision: this.#requireRunRevision(),
          incorporatedThroughInputSequence,
          ...(input.exceptions ? { exceptions: input.exceptions } : {}),
          ...(input.finalReply ? { finalReply: input.finalReply } : {}),
        },
        this.#agentContext(),
        this.#operationContext(),
      );
      this.#runRevision = result.revision ?? this.#runRevision;
    } catch (error) {
      this.#terminalAction = null;
      throw error;
    }
  }

  async fail(reason: string): Promise<void> {
    this.#assertNoTerminalAction();
    this.#terminalAction = "fail";
    const run = this.#requireRun();
    try {
      const result = await this.options.kernel.execute(
        {
          type: "FailRun",
          idempotencyKey: this.#key("fail-run"),
          runId: run.run.id,
          expectedRunRevision: this.#requireRunRevision(),
          reason,
        },
        this.#agentContext(),
        this.#operationContext(),
      );
      this.#runRevision = result.revision ?? this.#runRevision;
    } catch (error) {
      this.#terminalAction = null;
      throw error;
    }
  }

  async wait(reason: string): Promise<void> {
    this.#assertNoTerminalAction();
    this.#terminalAction = "wait";
    const run = this.#requireRun();
    try {
      const result = await this.options.kernel.execute(
        {
          type: "WaitRun",
          idempotencyKey: this.#key("wait-run"),
          runId: run.run.id,
          expectedRunRevision: this.#requireRunRevision(),
          reason,
        },
        this.#agentContext(),
        this.#operationContext(),
      );
      this.#runRevision = result.revision ?? this.#runRevision;
    } catch (error) {
      this.#terminalAction = null;
      throw error;
    }
  }

  #requireRun(): RunProjection {
    if (this.options.causeType !== "run") {
      throw new Error("This capability requires a Run Activation.");
    }
    return this.options.projection;
  }

  #requireRunRevision(): number {
    if (this.#runRevision === null) {
      throw new Error("This capability requires a Run revision.");
    }
    return this.#runRevision;
  }

  #assertNoTerminalAction(): void {
    if (this.#terminalAction) {
      throw new Error(
        `The Activation already reported terminal action ${this.#terminalAction}.`,
      );
    }
  }

  #assertNoAttentionDecision(): void {
    if (this.#attentionDecision) {
      throw new Error(
        `The Activation already made Attention decision ${this.#attentionDecision.type}.`,
      );
    }
  }

  #agentContext(): {
    readonly principalId: string;
    readonly activationId: string;
  } {
    this.options.assertPublication?.();
    return {
      principalId: this.options.agent.principalId,
      activationId: this.activationId,
    };
  }

  #operationContext(): KernelOperationContext {
    return { correlationId: this.options.correlationId };
  }

  #key(operation: string): string {
    const sequence = this.#nextCommand;
    this.#nextCommand += 1;
    return `${this.providerAttemptId}:${sequence}:${operation}`;
  }
}
