import type { JsonValue } from "./types.js";

export class KernelError extends Error {
  constructor(
    public readonly code:
      | "NotFound"
      | "Unauthorized"
      | "Forbidden"
      | "InvalidCommand"
      | "Conflict"
      | "DomainBusy"
      | "CausalLimitExceeded"
      | "StaleRevision"
      | "ConditionalCheckFailed"
      | "TerminalRun"
      | "PendingRunInputs",
    message: string,
    public readonly details?: JsonValue,
  ) {
    super(message);
    this.name = "KernelError";
  }
}

export class DurableKernelError extends KernelError {}
