import type {
  ProviderAdapter,
  ProviderExecutionContext,
  ProviderExecutionResult,
} from "./types.js";

export type DeterministicFakeHandler = (
  context: ProviderExecutionContext,
) => Promise<void>;

export class DeterministicFakeAdapter implements ProviderAdapter {
  readonly name = "deterministic-fake";
  readonly version = "1";
  readonly capabilities = {
    acceptsInputWhileRunning: false,
    supportsCancel: true,
    supportsResume: false,
    supportsSessionContinuation: false,
    supportsGracefulPause: false,
    supportsIdempotentRequests: true,
  } as const;

  invocationCount = 0;

  constructor(
    private readonly handler: DeterministicFakeHandler = defaultHandler,
  ) {}

  async execute(
    context: ProviderExecutionContext,
  ): Promise<ProviderExecutionResult> {
    this.invocationCount += 1;
    context.signal.throwIfAborted();
    await this.handler(context);
    context.signal.throwIfAborted();
    return {};
  }
}

async function defaultHandler(
  context: ProviderExecutionContext,
): Promise<void> {
  if (context.cause.type === "attention") {
    await context.capabilities.createRunFromAttention();
    return;
  }
  await context.capabilities.reportStatus("working");
  await context.capabilities.appendActivity("provider_result", {
    summary: "The deterministic fake processed the durable Run inputs.",
  });
  await context.capabilities.complete({
    finalReply: {
      body: "The deterministic fake completed the requested work.",
    },
  });
}
