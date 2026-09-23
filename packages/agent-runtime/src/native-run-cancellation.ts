import { ProviderExecutionError } from "./types.js";

export class NativeRunCancellationInterruption extends ProviderExecutionError {
  constructor(
    readonly runId: string,
    readonly activationId: string,
    readonly runActivationGeneration: number,
  ) {
    super("provider_cancelled", "Unknown");
    this.name = "NativeRunCancellationInterruption";
  }
}

export function isNativeRunCancellationInterruption(
  error: unknown,
): error is NativeRunCancellationInterruption {
  return error instanceof NativeRunCancellationInterruption;
}
