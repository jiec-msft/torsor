const eventComponents = {
  "host.start": "host",
  "host.stop": "host",
  "http.request": "http",
  "runtime.activation": "runtime",
  "runtime.provider_attempt": "runtime",
  "provider_process.spawn": "provider_process",
  "provider_process.stop": "provider_process",
  "writer_authority.acquire": "writer_authority",
  "writer_authority.loss": "writer_authority",
  "recovery.pass": "recovery",
} as const;

const operationalErrorCodes = new Set([
  "host_start_failed",
  "host_stop_failed",
  "http_request_failed",
  "runtime_activation_failed",
  "writer_authority_lost",
  "recovery_failed",
  "provider_cancelled",
  "provider_cleanup_failed",
  "provider_execution_failed",
  "provider_io_error",
  "provider_not_started",
  "provider_output_limit",
  "provider_policy_violation",
  "provider_process_exited",
  "provider_process_start_failed",
  "provider_protocol_error",
  "provider_recovered_failed",
  "provider_recovered_unknown",
  "provider_runtime_monitor_failed",
  "provider_stderr_limit",
  "provider_timeout",
  "provider_worktree_execution_failed",
  "provider_worktree_authority_lost",
  "provider_recovered_worktree_authority_lost",
] as const);

const allowedInputKeys = new Set([
  "event",
  "outcome",
  "durationMs",
  "httpStatus",
  "requestId",
  "correlationId",
  "runId",
  "activationId",
  "providerAttemptId",
  "worktreeId",
  "writerLeaseId",
  "errorCode",
]);

const allowedContextualInputKeys = new Set([
  "event",
  "outcome",
  "durationMs",
  "httpStatus",
  "runId",
  "activationId",
  "providerAttemptId",
  "worktreeId",
  "writerLeaseId",
  "errorCode",
]);

const allowedContextKeys = new Set([
  "requestId",
  "correlationId",
]);

const errorOutcomes = new Set<OperationalOutcome>([
  "cancelled",
  "failed",
  "lost",
  "unknown",
]);

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const defaultMaximumEventBytes = 2_048;
const defaultMaximumPendingWrites = 64;

declare const opaqueIdBrand: unique symbol;

export type OpaqueId = string & { readonly [opaqueIdBrand]: true };
export type OperationalEventName = keyof typeof eventComponents;
export type OperationalComponent = (typeof eventComponents)[OperationalEventName];
export type OperationalOutcome =
  | "started"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "unknown"
  | "lost";
export type OperationalLogLevel = "info" | "warn" | "error";
export type OperationalErrorCode =
  | "host_start_failed"
  | "host_stop_failed"
  | "http_request_failed"
  | "runtime_activation_failed"
  | "writer_authority_lost"
  | "recovery_failed"
  | "provider_cancelled"
  | "provider_cleanup_failed"
  | "provider_execution_failed"
  | "provider_io_error"
  | "provider_not_started"
  | "provider_output_limit"
  | "provider_policy_violation"
  | "provider_process_exited"
  | "provider_process_start_failed"
  | "provider_protocol_error"
  | "provider_recovered_failed"
  | "provider_recovered_unknown"
  | "provider_runtime_monitor_failed"
  | "provider_stderr_limit"
  | "provider_timeout"
  | "provider_worktree_execution_failed"
  | "provider_worktree_authority_lost"
  | "provider_recovered_worktree_authority_lost";

export interface OperationalEventInput {
  readonly event: OperationalEventName;
  readonly outcome: OperationalOutcome;
  readonly durationMs?: number;
  readonly httpStatus?: number;
  readonly requestId?: OpaqueId;
  readonly correlationId?: OpaqueId;
  readonly runId?: OpaqueId;
  readonly activationId?: OpaqueId;
  readonly providerAttemptId?: OpaqueId;
  readonly worktreeId?: OpaqueId;
  readonly writerLeaseId?: OpaqueId;
  readonly errorCode?: OperationalErrorCode;
}

export type ContextualOperationalEventInput = Omit<
  OperationalEventInput,
  "requestId" | "correlationId"
>;

export type OperationalLogContext =
  | {
      readonly requestId: OpaqueId;
      readonly correlationId?: OpaqueId;
    }
  | {
      readonly requestId?: OpaqueId;
      readonly correlationId: OpaqueId;
    };

export interface ContextualOperationalLogger {
  emit(input: ContextualOperationalEventInput): Promise<void>;
}

export interface OperationalLogSink {
  write(line: string): void | Promise<void>;
}

export interface OperationalLoggerOptions {
  readonly sink: OperationalLogSink;
  readonly clock?: () => Date;
  readonly maximumEventBytes?: number;
  readonly maximumPendingWrites?: number;
}

export class OperationalLogValidationError extends Error {
  readonly code:
    | "invalid_event"
    | "invalid_clock"
    | "event_too_large";

  constructor(
    code: OperationalLogValidationError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "OperationalLogValidationError";
  }
}

export class OperationalLogBackpressureError extends Error {
  readonly code = "log_backpressure";

  constructor() {
    super("The operational log write queue is full.");
    this.name = "OperationalLogBackpressureError";
  }
}

export class OperationalLogSinkError extends Error {
  readonly code = "log_sink_failed";

  constructor() {
    super("The operational log sink could not persist the event.");
    this.name = "OperationalLogSinkError";
  }
}

export function createOpaqueId(value: string): OpaqueId {
  if (!opaqueIdPattern.test(value)) {
    throw new OperationalLogValidationError(
      "invalid_event",
      "Operational log identifiers must use the safe opaque ID format.",
    );
  }
  return value as OpaqueId;
}

export class OperationalLogger {
  readonly #sink: OperationalLogSink;
  readonly #clock: () => Date;
  readonly #maximumEventBytes: number;
  readonly #maximumPendingWrites: number;
  #pendingWrites = 0;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: OperationalLoggerOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.sink !== "object" ||
      options.sink === null ||
      typeof options.sink.write !== "function"
    ) {
      throw new TypeError("OperationalLogger requires an explicit sink.");
    }
    this.#sink = options.sink;
    this.#clock = options.clock ?? (() => new Date());
    this.#maximumEventBytes = boundedInteger(
      options.maximumEventBytes ?? defaultMaximumEventBytes,
      256,
      65_536,
      "maximumEventBytes",
    );
    this.#maximumPendingWrites = boundedInteger(
      options.maximumPendingWrites ?? defaultMaximumPendingWrites,
      1,
      1_024,
      "maximumPendingWrites",
    );
  }

  emit(input: OperationalEventInput): Promise<void> {
    const line = this.#serialize(input);
    if (this.#pendingWrites >= this.#maximumPendingWrites) {
      throw new OperationalLogBackpressureError();
    }

    this.#pendingWrites += 1;
    const operation = this.#writeTail.then(async () => {
      try {
        await this.#sink.write(line);
      } catch {
        throw new OperationalLogSinkError();
      }
    });
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.finally(() => {
      this.#pendingWrites -= 1;
    });
  }

  withContext(context: OperationalLogContext): ContextualOperationalLogger {
    assertClosedShape(context, allowedContextKeys);
    validateOptionalOpaqueId(context.requestId);
    validateOptionalOpaqueId(context.correlationId);
    if (context.requestId === undefined && context.correlationId === undefined) {
      throw invalidEvent();
    }
    const safeContext = Object.freeze({ ...context });
    return Object.freeze({
      emit: (input: ContextualOperationalEventInput) => {
        assertClosedShape(input, allowedContextualInputKeys);
        return this.emit({ ...safeContext, ...input });
      },
    });
  }

  #serialize(input: OperationalEventInput): string {
    assertClosedInput(input);
    const timestamp = this.#timestamp();
    const component = eventComponents[input.event];
    const level = levelForOutcome(input.outcome);
    validateOptionalInteger(input.durationMs, 0, 86_400_000);
    validateOptionalInteger(input.httpStatus, 100, 599);
    if (input.httpStatus !== undefined && input.event !== "http.request") {
      throw invalidEvent();
    }
    validateOptionalOpaqueId(input.requestId);
    validateOptionalOpaqueId(input.correlationId);
    validateOptionalOpaqueId(input.runId);
    validateOptionalOpaqueId(input.activationId);
    validateOptionalOpaqueId(input.providerAttemptId);
    validateOptionalOpaqueId(input.worktreeId);
    validateOptionalOpaqueId(input.writerLeaseId);
    validateErrorCode(input.outcome, input.errorCode);

    const event = {
      schemaVersion: 1,
      timestamp,
      level,
      component,
      event: input.event,
      outcome: input.outcome,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.correlationId === undefined
        ? {}
        : { correlationId: input.correlationId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.activationId === undefined
        ? {}
        : { activationId: input.activationId }),
      ...(input.providerAttemptId === undefined
        ? {}
        : { providerAttemptId: input.providerAttemptId }),
      ...(input.worktreeId === undefined
        ? {}
        : { worktreeId: input.worktreeId }),
      ...(input.writerLeaseId === undefined
        ? {}
        : { writerLeaseId: input.writerLeaseId }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    };
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.#maximumEventBytes) {
      throw new OperationalLogValidationError(
        "event_too_large",
        "The operational log event exceeds the configured byte limit.",
      );
    }
    return line;
  }

  #timestamp(): string {
    let value: Date;
    try {
      value = this.#clock();
    } catch {
      throw new OperationalLogValidationError(
        "invalid_clock",
        "The operational log clock did not return a valid timestamp.",
      );
    }
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new OperationalLogValidationError(
        "invalid_clock",
        "The operational log clock did not return a valid timestamp.",
      );
    }
    return value.toISOString();
  }
}

function assertClosedInput(input: OperationalEventInput): void {
  assertClosedShape(input, allowedInputKeys);
  if (
    typeof input.event !== "string" ||
    !Object.prototype.hasOwnProperty.call(eventComponents, input.event) ||
    !isOperationalOutcome(input.outcome)
  ) {
    throw invalidEvent();
  }
}

function assertClosedShape(
  input: object,
  allowedKeys: ReadonlySet<string>,
): void {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw invalidEvent();
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw invalidEvent();
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalidEvent();
    }
  }
}

function validateOptionalInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < minimum || value > maximum)
  ) {
    throw invalidEvent();
  }
}

function validateOptionalOpaqueId(value: OpaqueId | undefined): void {
  if (value !== undefined && !opaqueIdPattern.test(value)) {
    throw invalidEvent();
  }
}

function validateErrorCode(
  outcome: OperationalOutcome,
  errorCode: OperationalErrorCode | undefined,
): void {
  if (errorOutcomes.has(outcome)) {
    if (!errorCode || !operationalErrorCodes.has(errorCode)) {
      throw invalidEvent();
    }
    return;
  }
  if (errorCode !== undefined) {
    throw invalidEvent();
  }
}

function isOperationalOutcome(value: unknown): value is OperationalOutcome {
  return (
    value === "started" ||
    value === "succeeded" ||
    value === "cancelled" ||
    value === "failed" ||
    value === "unknown" ||
    value === "lost"
  );
}

function levelForOutcome(outcome: OperationalOutcome): OperationalLogLevel {
  switch (outcome) {
    case "started":
    case "succeeded":
      return "info";
    case "cancelled":
    case "unknown":
    case "lost":
      return "warn";
    case "failed":
      return "error";
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function invalidEvent(): OperationalLogValidationError {
  return new OperationalLogValidationError(
    "invalid_event",
    "The operational log event does not match the closed schema.",
  );
}
