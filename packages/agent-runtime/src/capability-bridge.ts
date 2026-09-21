import type {
  AttentionView,
  BootstrapAgent,
  JsonValue,
  RunProjection,
  TorsorKernel,
} from "@torsor/kernel";

import type {
  ActivationCapabilityBridge,
  ArtifactInput,
  CompleteRunInput,
} from "./types.js";

interface BridgeBaseOptions {
  readonly kernel: TorsorKernel;
  readonly agent: BootstrapAgent;
  readonly activationId: string;
  readonly providerAttemptId: string;
}

interface AttentionBridgeOptions extends BridgeBaseOptions {
  readonly causeType: "attention";
  readonly attention: AttentionView;
  readonly attentionRevision: number;
  readonly handlerLeaseToken: string;
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

  #createdRunId: string | null = null;
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

  get createdRunId(): string | null {
    return this.#createdRunId;
  }

  get terminalAction(): "complete" | "fail" | "wait" | null {
    return this.#terminalAction;
  }

  async createRunFromAttention(): Promise<string> {
    if (this.options.causeType !== "attention") {
      throw new Error("Only an Attention Activation can create its initial Run.");
    }
    if (this.#createdRunId) {
      return this.#createdRunId;
    }
    const result = await this.options.kernel.execute(
      {
        type: "ResolveAttentionWithRun",
        idempotencyKey: this.#key("create-run"),
        attentionId: this.options.attention.id,
        expectedAttentionRevision: this.options.attentionRevision,
        handlerLeaseToken: this.options.handlerLeaseToken,
      },
      this.#agentContext(),
    );
    this.#createdRunId = result.entityId;
    return result.entityId;
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
    );
    return result.entityId;
  }

  async publishArtifact(input: ArtifactInput): Promise<string> {
    const run = this.#requireRun();
    const result = await this.options.kernel.execute(
      {
        type: "PublishArtifact",
        idempotencyKey: this.#key("publish-artifact"),
        runId: run.run.id,
        expectedRunRevision: this.#requireRunRevision(),
        contentDigest: input.contentDigest,
        baseRevision: input.baseRevision,
        mediaType: input.mediaType,
        storageLocation: input.storageLocation,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
      this.#agentContext(),
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

  #agentContext(): {
    readonly principalId: string;
    readonly activationId: string;
  } {
    return {
      principalId: this.options.agent.principalId,
      activationId: this.activationId,
    };
  }

  #key(operation: string): string {
    const sequence = this.#nextCommand;
    this.#nextCommand += 1;
    return `${this.providerAttemptId}:${sequence}:${operation}`;
  }
}
