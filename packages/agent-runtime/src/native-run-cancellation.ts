import { ProviderExecutionError } from "./types.js";

export interface NativeRunExecutionIdentity {
  readonly worktreeId: string;
  readonly executionId: string;
  readonly leaseGeneration: number;
  readonly fencingToken: number;
}

export class NativeRunCancellationInterruption extends ProviderExecutionError {
  #execution: NativeRunExecutionIdentity | undefined;
  #ownedStopInitiated = false;
  #providerExitPrecededStop = false;

  constructor(
    readonly runId: string,
    readonly activationId: string,
    readonly runActivationGeneration: number,
  ) {
    super("provider_cancelled", "Unknown");
    this.name = "NativeRunCancellationInterruption";
  }

  bindExecution(identity: NativeRunExecutionIdentity): void {
    if (this.#execution) {
      throw new Error("Native cancellation interruption is already bound to an execution.");
    }
    this.#execution = Object.freeze({ ...identity });
  }

  executionIdentity(): NativeRunExecutionIdentity | undefined {
    return this.#execution;
  }

  recordOwnedStopInitiated(identity: NativeRunExecutionIdentity): void {
    if (!sameExecution(this.#execution, identity)) {
      throw new Error("Native cancellation stop does not match its bound execution.");
    }
    if (this.#providerExitPrecededStop) {
      throw new Error("Native cancellation stop cannot follow an independent provider exit.");
    }
    this.#ownedStopInitiated = true;
  }

  recordProviderExitPrecededStop(identity: NativeRunExecutionIdentity): void {
    if (!sameExecution(this.#execution, identity)) {
      throw new Error("Native provider exit does not match its bound execution.");
    }
    if (this.#ownedStopInitiated) {
      throw new Error("Native provider exit cannot precede an already-owned cancellation stop.");
    }
    this.#providerExitPrecededStop = true;
  }

  ownsPhysicalStop(identity: NativeRunExecutionIdentity): boolean {
    return this.#ownedStopInitiated && sameExecution(this.#execution, identity);
  }

  providerExitPrecededStop(identity: NativeRunExecutionIdentity): boolean {
    return this.#providerExitPrecededStop && sameExecution(this.#execution, identity);
  }
}

export function isNativeRunCancellationInterruption(
  error: unknown,
): error is NativeRunCancellationInterruption {
  return error instanceof NativeRunCancellationInterruption;
}

function sameExecution(
  left: NativeRunExecutionIdentity | undefined,
  right: NativeRunExecutionIdentity,
): boolean {
  return left?.worktreeId === right.worktreeId &&
    left.executionId === right.executionId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.fencingToken === right.fencingToken;
}
