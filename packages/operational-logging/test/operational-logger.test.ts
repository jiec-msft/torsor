import { describe, expect, it } from "vitest";

import {
  OperationalLogBackpressureError,
  OperationalLogSinkError,
  OperationalLogValidationError,
  OperationalLogger,
  createOpaqueId,
  type OperationalEventInput,
  type OperationalLogSink,
} from "../src/index.js";

const fixedTime = new Date("2026-09-23T06:05:53.573Z");

describe("privacy-safe operational NDJSON", () => {
  it("serializes a correlated failed Provider attempt deterministically", async () => {
    const lines: string[] = [];
    const logger = loggerFor(lines);

    await logger.emit({
      event: "runtime.provider_attempt",
      outcome: "failed",
      durationMs: 321,
      requestId: createOpaqueId("request-01"),
      correlationId: createOpaqueId("correlation-01"),
      runId: createOpaqueId("run-01"),
      activationId: createOpaqueId("activation-01"),
      providerAttemptId: createOpaqueId("attempt-01"),
      errorCode: "provider_protocol_error",
    });

    expect(lines).toEqual([
      '{"schemaVersion":1,"timestamp":"2026-09-23T06:05:53.573Z","level":"error","component":"runtime","event":"runtime.provider_attempt","outcome":"failed","durationMs":321,"requestId":"request-01","correlationId":"correlation-01","runId":"run-01","activationId":"activation-01","providerAttemptId":"attempt-01","errorCode":"provider_protocol_error"}\n',
    ]);
  });

  it("derives safe levels and components instead of accepting caller overrides", async () => {
    const lines: string[] = [];
    const logger = loggerFor(lines);

    await logger.emit({
      event: "writer_authority.loss",
      outcome: "lost",
      correlationId: createOpaqueId("correlation-02"),
      worktreeId: createOpaqueId("worktree-02"),
      writerLeaseId: createOpaqueId("lease-02"),
      errorCode: "writer_authority_lost",
    });

    expect(JSON.parse(lines[0]!)).toEqual({
      schemaVersion: 1,
      timestamp: "2026-09-23T06:05:53.573Z",
      level: "warn",
      component: "writer_authority",
      event: "writer_authority.loss",
      outcome: "lost",
      correlationId: "correlation-02",
      worktreeId: "worktree-02",
      writerLeaseId: "lease-02",
      errorCode: "writer_authority_lost",
    });
  });

  it("binds request and correlation IDs across observable downstream events", async () => {
    const lines: string[] = [];
    const logger = loggerFor(lines);
    const requestId = createOpaqueId("request-02");
    const correlationId = createOpaqueId("correlation-02");
    const correlated = logger.withContext({ requestId, correlationId });

    await correlated.emit({
      event: "http.request",
      outcome: "succeeded",
      durationMs: 12,
      httpStatus: 202,
    });
    await correlated.emit({
      event: "runtime.activation",
      outcome: "started",
      runId: createOpaqueId("run-02"),
      activationId: createOpaqueId("activation-02"),
    });

    expect(lines.map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      return {
        event: event.event,
        requestId: event.requestId,
        correlationId: event.correlationId,
      };
    })).toEqual([
      {
        event: "http.request",
        requestId: "request-02",
        correlationId: "correlation-02",
      },
      {
        event: "runtime.activation",
        requestId: "request-02",
        correlationId: "correlation-02",
      },
    ]);
  });

  it.each([
    "prompt",
    "modelResponse",
    "toolArguments",
    "toolResult",
    "environment",
    "credential",
    "cookie",
    "authorization",
    "path",
    "cwd",
    "stdout",
    "stderr",
    "message",
    "error",
    "stack",
    "cause",
    "metadata",
  ])("rejects the excluded %s canary before it reaches the sink", (field) => {
    const lines: string[] = [];
    const logger = loggerFor(lines);
    const canary = "SYNTHETIC_PRIVATE_CANARY";
    const forged = {
      event: "host.start",
      outcome: "succeeded",
      [field]: canary,
    } as unknown as OperationalEventInput;

    expect(() => logger.emit(forged)).toThrow(OperationalLogValidationError);
    expect(lines.join("")).not.toContain(canary);
  });

  it("rejects unsafe IDs, invalid outcome/error combinations, and non-HTTP status", () => {
    const logger = loggerFor([]);

    expect(() => createOpaqueId("C:\\private\\workspace")).toThrow(
      OperationalLogValidationError,
    );
    expect(() => createOpaqueId("x".repeat(129))).toThrow(
      OperationalLogValidationError,
    );
    expect(() =>
      logger.emit({
        event: "host.start",
        outcome: "failed",
      } as OperationalEventInput),
    ).toThrow(OperationalLogValidationError);
    expect(() =>
      logger.emit({
        event: "host.start",
        outcome: "succeeded",
        errorCode: "host_start_failed",
      }),
    ).toThrow(OperationalLogValidationError);
    expect(() =>
      logger.emit({
        event: "host.start",
        outcome: "succeeded",
        httpStatus: 200,
      }),
    ).toThrow(OperationalLogValidationError);
    expect(() =>
      logger.emit({
        event: "host.start",
        outcome: "failed",
        errorCode: "SYNTHETIC_PRIVATE_ERROR_TEXT",
      } as unknown as OperationalEventInput),
    ).toThrow(OperationalLogValidationError);
    expect(() =>
      logger.emit({
        event: "host.start",
        outcome: "succeeded",
        durationMs: Number.NaN,
      }),
    ).toThrow(OperationalLogValidationError);
  });

  it("fails instead of truncating an oversized event", () => {
    const logger = new OperationalLogger({
      sink: { write: () => undefined },
      clock: () => fixedTime,
      maximumEventBytes: 256,
    });

    expect(() =>
      logger.emit({
        event: "runtime.provider_attempt",
        outcome: "failed",
        requestId: createOpaqueId(`r${"x".repeat(127)}`),
        correlationId: createOpaqueId(`c${"x".repeat(127)}`),
        errorCode: "provider_execution_failed",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "event_too_large",
      }),
    );
  });

  it("reports a sink failure without retaining its private exception and accepts later events", async () => {
    const canary = "SYNTHETIC_PRIVATE_SINK_EXCEPTION";
    const lines: string[] = [];
    let writes = 0;
    const logger = new OperationalLogger({
      sink: {
        write: (line) => {
          writes += 1;
          if (writes === 1) {
            throw new Error(canary, {
              cause: new Error("SYNTHETIC_PRIVATE_NESTED_CAUSE"),
            });
          }
          lines.push(line);
        },
      },
      clock: () => fixedTime,
    });

    const failure = await logger.emit({
      event: "host.start",
      outcome: "started",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OperationalLogSinkError);
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(String(failure)).not.toContain(canary);

    await logger.emit({
      event: "host.start",
      outcome: "succeeded",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"outcome":"succeeded"');
  });

  it("serializes writes and rejects new events at the bounded backpressure limit", async () => {
    const lines: string[] = [];
    const releases: Array<() => void> = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const sink: OperationalLogSink = {
      write: async (line) => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        lines.push(line);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeWrites -= 1;
      },
    };
    const logger = new OperationalLogger({
      sink,
      clock: () => fixedTime,
      maximumPendingWrites: 2,
    });

    const first = logger.emit({
      event: "recovery.pass",
      outcome: "started",
      correlationId: createOpaqueId("correlation-03"),
    });
    const second = logger.emit({
      event: "recovery.pass",
      outcome: "succeeded",
      correlationId: createOpaqueId("correlation-03"),
    });
    expect(() =>
      logger.emit({
        event: "recovery.pass",
        outcome: "succeeded",
      }),
    ).toThrow(OperationalLogBackpressureError);

    await waitFor(() => releases.length === 1);
    releases.shift()!();
    await first;
    await waitFor(() => releases.length === 1);
    releases.shift()!();
    await second;

    expect(maximumActiveWrites).toBe(1);
    expect(lines.map((line) => JSON.parse(line).outcome)).toEqual([
      "started",
      "succeeded",
    ]);
  });

  it("rejects an invalid clock without invoking the sink", () => {
    let writes = 0;
    const logger = new OperationalLogger({
      sink: { write: () => { writes += 1; } },
      clock: () => new Date(Number.NaN),
    });

    expect(() =>
      logger.emit({
        event: "host.start",
        outcome: "started",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_clock",
      }),
    );
    expect(writes).toBe(0);
  });
});

function loggerFor(lines: string[]): OperationalLogger {
  return new OperationalLogger({
    sink: { write: (line) => { lines.push(line); } },
    clock: () => fixedTime,
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("Synthetic test sink did not reach the expected state.");
}

if (false) {
  const logger = loggerFor([]);
  // @ts-expect-error Arbitrary messages are outside the closed schema.
  void logger.emit({ event: "host.start", outcome: "succeeded", message: "private" });
  // @ts-expect-error Raw exceptions are outside the closed schema.
  void logger.emit({ event: "host.start", outcome: "failed", error: new Error("private") });
  // @ts-expect-error Identifiers must be created by createOpaqueId.
  void logger.emit({ event: "host.start", outcome: "succeeded", requestId: "request-04" });
  // @ts-expect-error Error codes are allowlisted.
  void logger.emit({ event: "host.start", outcome: "failed", errorCode: "private_error" });
  const contextual = logger.withContext({ requestId: createOpaqueId("request-05") });
  // @ts-expect-error Bound request IDs cannot be overridden by an event.
  void contextual.emit({ event: "host.start", outcome: "succeeded", requestId: createOpaqueId("request-06") });
}
