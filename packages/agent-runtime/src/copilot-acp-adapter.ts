import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonValue } from "@torsor/kernel";

import {
  normalizeProviderExecutionError,
  ProviderExecutionError,
  ProviderProtocolError,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderExecutionResult,
} from "./types.js";

export interface CopilotAcpLimits {
  readonly maxFrameBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxStreamBytes: number;
  readonly maxStderrBytes: number;
  readonly maxActivityBytes: number;
  readonly maxPendingPersistenceOperations: number;
  readonly maxJsonDepth: number;
  readonly maxActionCount: number;
  readonly maxTargetCount: number;
  readonly maxFieldLength: number;
}

export interface CopilotAcpLaunchConfiguration {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CopilotAcpAdapterOptions {
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly unsafeAllowCustomCommandArgs?: boolean;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly shutdownGraceMs?: number;
  readonly limits?: Partial<CopilotAcpLimits>;
}

interface RpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: unknown;
}

type CopilotAction =
  | { readonly type: "publish_report"; readonly idempotencyKey: string; readonly text: string }
  | { readonly type: "create_run" }
  | { readonly type: "continue_run"; readonly runId: string }
  | { readonly type: "ignore_attention"; readonly reason: string }
  | {
      readonly type: "append_activity";
      readonly kind: string;
      readonly payload: JsonValue;
      readonly retentionClass?: "durable" | "transient";
    }
  | {
      readonly type: "publish_reply";
      readonly body: string;
      readonly targetAgentIds?: readonly string[];
      readonly expectedThreadCursor?: number;
    }
  | {
      readonly type: "report_status";
      readonly status: string;
      readonly detail?: string;
    }
  | {
      readonly type: "complete";
      readonly incorporatedThroughInputSequence?: number;
      readonly finalReply?: {
        readonly body: string;
        readonly targetAgentIds?: readonly string[];
        readonly expectedThreadCursor?: number;
      };
    }
  | { readonly type: "fail"; readonly reason: string }
  | { readonly type: "wait"; readonly reason: string };

const defaultLimits: CopilotAcpLimits = {
  maxFrameBytes: 256 * 1024,
  maxStdoutBytes: 1024 * 1024,
  maxStreamBytes: 512 * 1024,
  maxStderrBytes: 16 * 1024,
  maxActivityBytes: 256 * 1024,
  maxPendingPersistenceOperations: 16,
  maxJsonDepth: 16,
  maxActionCount: 32,
  maxTargetCount: 16,
  maxFieldLength: 16 * 1024,
};

const secureCopilotArgs = [
  "--acp",
  "--stdio",
  "--no-auto-update",
  "--no-remote",
  "--no-remote-export",
  "--no-ask-user",
  "--no-custom-instructions",
  "--no-bash-env",
  "--disallow-temp-dir",
  "--disable-builtin-mcps",
  "--available-tools=torsor-runtime-action-channel",
  "--deny-tool=shell",
  "--deny-tool=write",
  "--deny-tool=url",
] as const;

export class CopilotAcpAdapter implements ProviderAdapter {
  readonly name = "github-copilot-cli-acp";
  readonly version = "4";
  readonly capabilities = {
    acceptsInputWhileRunning: false,
    supportsCancel: true,
    supportsResume: false,
    supportsSessionContinuation: true,
    supportsGracefulPause: false,
    supportsIdempotentRequests: false,
  } as const;

  readonly #launch: CopilotAcpLaunchConfiguration;
  readonly #shutdownGraceMs: number;
  readonly #limits: CopilotAcpLimits;

  constructor(options: CopilotAcpAdapterOptions = {}) {
    if (options.commandArgs && !options.unsafeAllowCustomCommandArgs) {
      throw new Error(
        "Custom ACP command arguments require unsafeAllowCustomCommandArgs=true.",
      );
    }
    this.#launch = {
      command: options.command ?? "copilot",
      args: options.commandArgs
        ? [...options.commandArgs]
        : [...secureCopilotArgs],
      cwd: options.cwd ?? process.cwd(),
      environment: buildSanitizedEnvironment(options.environment ?? {}),
    };
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    this.#limits = validateLimits({
      ...defaultLimits,
      ...options.limits,
    });
  }

  getLaunchConfiguration(): CopilotAcpLaunchConfiguration {
    return {
      command: this.#launch.command,
      args: [...this.#launch.args],
      cwd: this.#launch.cwd,
      environment: { ...this.#launch.environment },
    };
  }

  async execute(
    context: ProviderExecutionContext,
  ): Promise<ProviderExecutionResult> {
    const processHandle = spawn(
      this.#launch.command,
      [...this.#launch.args],
      {
        cwd: this.#launch.cwd,
        env: { ...this.#launch.environment },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const connection = new NdjsonRpcConnection(
      processHandle,
      this.#limits.maxFrameBytes,
      this.#limits.maxStdoutBytes,
    );
    let sessionId: string | null = null;
    let acceptUpdates = true;
    let streamBytes = 0;
    let activityBytes = 0;
    let primaryError: unknown;
    let executionResult: ProviderExecutionResult | undefined;
    const outputChunks: string[] = [];
    let stderrBytes = 0;
    const persistence = new PersistenceQueue(
      this.#limits.maxPendingPersistenceOperations,
      (error) => {
        acceptUpdates = false;
        connection.fail(error);
        processHandle.kill();
      },
    );

    processHandle.stderr.setEncoding("utf8");
    processHandle.stderr.on("data", (chunk: string) => {
      const bytes = Buffer.byteLength(chunk);
      if (bytes > this.#limits.maxStderrBytes - stderrBytes) {
        stderrBytes = this.#limits.maxStderrBytes;
        connection.fail(
          new ProviderExecutionError("provider_stderr_limit", "Failed"),
        );
        processHandle.kill();
        return;
      }
      stderrBytes += bytes;
    });

    connection.onRequest = async (request) => {
      if (request.method === "session/request_permission") {
        return { outcome: { outcome: "cancelled" } };
      }
      throw new ProviderProtocolError(
        `Copilot requested unsupported ACP client method ${request.method}.`,
      );
    };
    connection.onNotification = (notification) => {
      if (!acceptUpdates || notification.method !== "session/update") {
        return;
      }
      const params = getRecord(notification.params, "session/update params");
      const update = getRecord(params.update, "session/update update");
      assertJsonDepth(update, this.#limits.maxJsonDepth, "session update");
      const updateType = getOptionalString(update.sessionUpdate);
      if (
        updateType === "tool_call" ||
        updateType === "tool_call_update"
      ) {
        throw new ProviderProtocolError(
          "Copilot emitted tool activity despite the deny-by-default tool policy.",
          "provider_policy_violation",
        );
      }
      if (updateType !== "agent_message_chunk") {
        return;
      }
      const content = getRecord(update.content, "agent message content");
      if (content.type !== "text" || typeof content.text !== "string") {
        return;
      }
      const chunkBytes = Buffer.byteLength(content.text);
      streamBytes = addWithinLimit(
        streamBytes,
        chunkBytes,
        this.#limits.maxStreamBytes,
        "ACP output stream",
      );
      outputChunks.push(content.text);
      if (context.cause.type !== "run") {
        return;
      }
      const payload = {
        text: content.text,
        ...(typeof update.messageId === "string"
          ? {
              messageId: requireBoundedString(
                update.messageId,
                "messageId",
                this.#limits.maxFieldLength,
              ),
            }
          : {}),
      };
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
      activityBytes = addWithinLimit(
        activityBytes,
        payloadBytes,
        this.#limits.maxActivityBytes,
        "persisted ACP activity",
      );
      persistence.enqueue(
        () => context.capabilities.appendActivity(
          "agent_message_chunk",
          payload,
          "transient",
        ),
      );
    };

    const abort = () => {
      acceptUpdates = false;
      const reason = abortReason(context.signal);
      if (sessionId) {
        try {
          connection.notify("session/cancel", { sessionId });
        } catch {
          // The abort reason remains authoritative if the notification cannot be sent.
        }
      }
      connection.fail(reason);
      processHandle.kill();
    };
    context.signal.addEventListener("abort", abort, { once: true });

    try {
      const initialize = getRecord(
        await connection.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: "torsor-agent-runtime",
            title: "Torsor Agent Runtime",
            version: "0.1.0",
          },
        }),
        "initialize result",
      );
      if (initialize.protocolVersion !== 1) {
        throw new ProviderProtocolError(
          `Copilot ACP selected unsupported protocol version ${String(initialize.protocolVersion)}.`,
        );
      }
      const session = getRecord(
        await connection.request("session/new", {
          cwd: this.#launch.cwd,
          mcpServers: [],
        }),
        "session/new result",
      );
      sessionId = requireBoundedString(
        session.sessionId,
        "sessionId",
        this.#limits.maxFieldLength,
      );
      const promptResult = getRecord(
        await connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: buildPrompt(context) }],
        }),
        "session/prompt result",
      );
      connection.allowProcessExit();
      await stopProcess(
        processHandle,
        this.#shutdownGraceMs,
        () => connection.endInput(),
      );
      acceptUpdates = false;
      await persistence.drain();
      connection.seal();
      const stopReason = requireBoundedString(
        promptResult.stopReason,
        "stopReason",
        64,
      );
      if (stopReason !== "end_turn") {
        throw new ProviderExecutionError(
          stopReason === "cancelled"
            ? "provider_cancelled"
            : "provider_execution_failed",
          stopReason === "cancelled" ? "Unknown" : "Failed",
        );
      }
      const actions = parseActions(outputChunks.join(""), this.#limits);
      validateActionPlan(actions, context.cause.type);
      if (actions.some((action) => action.type === "publish_report") && !context.capabilities.reportArtifactsEnabled) {
        throw new ProviderProtocolError("Report Artifact storage is not configured.");
      }
      await applyActions(actions, context);
      executionResult = {};
    } catch (error) {
      primaryError = error;
    } finally {
      acceptUpdates = false;
      try {
        await persistence.drain();
      } catch (error) {
        primaryError ??= error;
      }
      context.signal.removeEventListener("abort", abort);
      try {
        await stopProcess(
          processHandle,
          this.#shutdownGraceMs,
          () => connection.endInput(),
        );
      } catch (error) {
        primaryError ??= error;
      }
      connection.close();
    }

    if (primaryError !== undefined) {
      throw normalizeExecutionError(
        primaryError,
        context.signal,
      );
    }
    if (!executionResult) {
      throw new ProviderExecutionError(
        "provider_execution_failed",
        "Unknown",
      );
    }
    return executionResult;
  }
}

class PersistenceQueue {
  readonly #pending = new Set<Promise<void>>();
  #firstError: Error | null = null;

  constructor(
    private readonly limit: number,
    private readonly onFirstError: (error: Error) => void,
  ) {}

  enqueue(operation: () => Promise<unknown>): void {
    if (this.#firstError) {
      throw this.#firstError;
    }
    if (this.#pending.size >= this.limit) {
      throw new ProviderProtocolError(
        `ACP persistence exceeded ${this.limit} pending operations.`,
      );
    }
    let started: Promise<unknown>;
    try {
      started = operation();
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.#firstError = normalized;
      this.onFirstError(normalized);
      throw normalized;
    }
    const tracked = started.then(
      () => {},
      (error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        if (!this.#firstError) {
          this.#firstError = normalized;
          this.onFirstError(normalized);
        }
      },
    );
    this.#pending.add(tracked);
    void tracked.then(() => {
      this.#pending.delete(tracked);
    });
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
    if (this.#firstError) {
      throw this.#firstError;
    }
  }
}

class NdjsonRpcConnection {
  onNotification: (notification: RpcRequest) => void = () => {};
  onRequest: (request: RpcRequest) => Promise<unknown> = async (request) => {
    throw new ProviderProtocolError(
      `Unsupported ACP client method ${request.method}.`,
    );
  };

  #nextId = 0;
  #allowProcessExit = false;
  #shuttingDown = false;
  #closed = false;
  #sealed = false;
  #failed: Error | null = null;
  #inputEnd: Promise<void> | null = null;
  #buffer = Buffer.alloc(0);
  #stdoutBytes = 0;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly processHandle: ChildProcessWithoutNullStreams,
    private readonly maxFrameBytes: number,
    private readonly maxStdoutBytes: number,
  ) {
    processHandle.stdout.on("data", (chunk: Buffer) => {
      try {
        this.#receiveChunk(chunk);
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new ProviderProtocolError(String(error)),
        );
      }
    });
    processHandle.once("error", () => {
      this.fail(
        new ProviderExecutionError("provider_process_start_failed", "Failed"),
      );
    });
    processHandle.stdin.on("error", (error) => {
      this.fail(stdinFailure(error));
    });
    processHandle.once("exit", () => {
      if (
        !this.#allowProcessExit &&
        !this.#closed &&
        !this.#sealed &&
        !this.#failed
      ) {
        this.fail(
          new ProviderExecutionError("provider_process_exited", "Unknown"),
        );
      }
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#failed) {
      return Promise.reject(this.#failed);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#closed && !this.#failed) {
      this.#send({ jsonrpc: "2.0", method, params });
    }
  }

  fail(error: Error): void {
    if (this.#failed) {
      return;
    }
    this.#failed = error;
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  close(): void {
    this.#closed = true;
    this.processHandle.stdout.removeAllListeners("data");
    if (this.#pending.size > 0) {
      this.fail(new Error("ACP connection closed."));
    }
  }

  allowProcessExit(): void {
    this.#allowProcessExit = true;
    this.#shuttingDown = true;
  }

  endInput(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#inputEnd) {
      return this.#inputEnd;
    }
    if (
      this.processHandle.stdin.destroyed ||
      this.processHandle.stdin.writableEnded
    ) {
      this.#inputEnd = Promise.resolve();
      return this.#inputEnd;
    }
    this.#inputEnd = new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.processHandle.stdin.removeListener("finish", settle);
        this.processHandle.stdin.removeListener("close", settle);
        this.processHandle.stdin.removeListener("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        this.fail(stdinFailure(error));
        settle();
      };
      this.processHandle.stdin.once("finish", settle);
      this.processHandle.stdin.once("close", settle);
      this.processHandle.stdin.once("error", onError);
      try {
        this.processHandle.stdin.end(settle);
      } catch (error) {
        this.fail(
          stdinFailure(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
        settle();
      }
    });
    return this.#inputEnd;
  }

  seal(): void {
    if (this.#failed) {
      throw this.#failed;
    }
    if (this.#buffer.length > 0) {
      const error = new ProviderProtocolError(
        "ACP process ended with an incomplete NDJSON frame.",
      );
      this.fail(error);
      throw error;
    }
    this.#sealed = true;
    this.processHandle.stdout.removeAllListeners("data");
  }

  #receiveChunk(chunk: Buffer): void {
    if (this.#closed || this.#failed) {
      return;
    }
    this.#stdoutBytes = addWithinLimit(
      this.#stdoutBytes,
      chunk.length,
      this.maxStdoutBytes,
      "ACP stdout",
    );
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.length > this.maxFrameBytes) {
          throw new ProviderProtocolError(
            `ACP frame exceeded ${this.maxFrameBytes} bytes.`,
            "provider_output_limit",
          );
        }
        return;
      }
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.length === 0) {
        continue;
      }
      if (frame.length > this.maxFrameBytes) {
        throw new ProviderProtocolError(
          `ACP frame exceeded ${this.maxFrameBytes} bytes.`,
          "provider_output_limit",
        );
      }
      this.#receiveFrame(frame.toString("utf8"));
    }
  }

  #receiveFrame(frame: string): void {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      throw new ProviderProtocolError("ACP process emitted invalid NDJSON.");
    }
    const record = getRecord(message, "ACP message");
    if (typeof record.id === "number" && ("result" in record || "error" in record)) {
      const response = record as unknown as RpcResponse;
      const pending = this.#pending.get(response.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(response.id);
      if (response.error) {
        pending.reject(
          new ProviderProtocolError("ACP request returned an error."),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    const request = record as unknown as RpcRequest;
    if (typeof request.method !== "string") {
      throw new ProviderProtocolError("ACP request is missing method.");
    }
    if (typeof request.id !== "number") {
      this.onNotification(request);
      return;
    }
    void this.onRequest(request)
      .then(
        (result) => {
          if (this.#canRespond()) {
            this.#send({ jsonrpc: "2.0", id: request.id, result });
          }
        },
        (error: unknown) => {
          if (this.#canRespond()) {
            this.#send({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: errorMessage(error) },
            });
          }
        },
      )
      .catch((error: unknown) => {
        if (!this.#shuttingDown && !this.#closed && !this.#failed) {
          this.fail(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
  }

  #canRespond(): boolean {
    return (
      !this.#shuttingDown &&
      !this.#closed &&
      !this.#failed &&
      this.processHandle.stdin.writable
    );
  }

  #send(message: unknown): void {
    if (
      this.#closed ||
      this.#failed ||
      !this.processHandle.stdin.writable
    ) {
      throw this.#failed ?? new Error("ACP connection is not writable.");
    }
    try {
      this.processHandle.stdin.write(
        `${JSON.stringify(message)}\n`,
        (error?: Error | null) => {
          if (error) {
            this.fail(stdinFailure(error));
          }
        },
      );
    } catch (error) {
      const failure = stdinFailure(
        error instanceof Error ? error : new Error(String(error)),
      );
      this.fail(failure);
      throw failure;
    }
  }
}

function buildPrompt(context: ProviderExecutionContext): string {
  const state =
    context.cause.type === "attention"
      ? {
          cause: "attention",
          attention: context.cause.attention,
          triggeringMessage: context.cause.triggeringMessage,
          triggeringRevision: context.cause.triggeringRevision,
          thread: {
            projectId: context.cause.thread.projectId,
            channelId: context.cause.thread.channelId,
            threadRootId: context.cause.thread.threadRootId,
            cursor: context.cause.thread.cursor,
            messages: context.cause.thread.messages,
          },
          eligibleRuns: context.cause.eligibleRuns,
          agent: context.agent,
        }
      : {
          cause: "run",
          run: context.cause.run,
          thread: context.cause.thread,
          agent: context.agent,
        };
  const required =
    context.cause.type === "attention"
      ? "Return exactly one of: ignore_attention(reason), continue_run(runId from eligibleRuns), or create_run. Do not infer a Run match outside eligibleRuns."
      : "End with exactly one complete, fail, or wait action.";
  const allowed =
    context.cause.type === "attention"
      ? "Allowed actions: ignore_attention, continue_run, create_run."
      : `Allowed actions: append_activity, publish_reply, report_status, complete, fail, wait.${context.capabilities.reportArtifactsEnabled
        ? " publish_report(idempotencyKey, text) may finalize a plain-text report; reuse the stable key on retries."
        : " Report Artifact storage is not configured."} Arbitrary publish_artifact descriptors are forbidden.`;
  return [
    "You are executing one bounded Torsor Activation.",
    "The JSON below is rebuilt from durable Kernel state and is authoritative.",
    "Provider sessions and model memory are never authoritative recovery state.",
    "Return only one JSON object with an actions array and no Markdown.",
    required,
    allowed,
    "Provenance, Agent identity, Run identity, revisions, Activation identity, and ProviderAttempt identity are server-bound.",
    JSON.stringify(state),
  ].join("\n");
}

function parseActions(
  output: string,
  limits: CopilotAcpLimits,
): readonly CopilotAction[] {
  const trimmed = output.trim();
  const normalized = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new ProviderProtocolError(
      "Copilot ACP did not return a valid JSON action envelope.",
    );
  }
  assertJsonDepth(parsed, limits.maxJsonDepth, "action envelope");
  const record = getRecord(parsed, "action envelope");
  if (!Array.isArray(record.actions) || record.actions.length === 0) {
    throw new ProviderProtocolError(
      "Copilot ACP action envelope must contain at least one action.",
    );
  }
  if (record.actions.length > limits.maxActionCount) {
    throw new ProviderProtocolError(
      `Copilot ACP action envelope exceeded ${limits.maxActionCount} actions.`,
    );
  }
  return record.actions.map((action) => parseAction(action, limits));
}

function parseAction(
  value: unknown,
  limits: CopilotAcpLimits,
): CopilotAction {
  const action = getRecord(value, "action");
  const type = requireBoundedString(
    action.type,
    "action.type",
    64,
  );
  switch (type) {
    case "publish_report":
      if (Object.keys(action).some((key) => !["type", "idempotencyKey", "text"].includes(key))) {
        throw new ProviderProtocolError("publish_report accepts only type, idempotencyKey and text.");
      }
      return {
        type,
        idempotencyKey: requireBoundedString(action.idempotencyKey, "action.idempotencyKey", 256),
        text: requireBoundedString(action.text, "action.text", limits.maxFieldLength),
      };
    case "create_run":
      return { type };
    case "continue_run":
      return {
        type,
        runId: requireBoundedString(
          action.runId,
          "action.runId",
          limits.maxFieldLength,
        ),
      };
    case "ignore_attention":
      return {
        type,
        reason: requireBoundedString(
          action.reason,
          "action.reason",
          limits.maxFieldLength,
        ),
      };
    case "append_activity":
      return {
        type,
        kind: requireBoundedString(
          action.kind,
          "action.kind",
          Math.min(256, limits.maxFieldLength),
        ),
        payload: toJsonValue(
          action.payload,
          limits.maxJsonDepth,
        ),
        ...(action.retentionClass === undefined
          ? {}
          : {
              retentionClass: requireEnum(
                action.retentionClass,
                ["durable", "transient"] as const,
                "action.retentionClass",
              ),
            }),
      };
    case "publish_reply":
      return {
        type,
        body: requireBoundedString(
          action.body,
          "action.body",
          limits.maxFieldLength,
        ),
        ...optionalStringArray(
          action.targetAgentIds,
          "action.targetAgentIds",
          limits,
        ),
        ...optionalNumber(action.expectedThreadCursor, "expectedThreadCursor"),
      };
    case "report_status":
      return {
        type,
        status: requireBoundedString(
          action.status,
          "action.status",
          Math.min(256, limits.maxFieldLength),
        ),
        ...(action.detail === undefined
          ? {}
          : {
              detail: requireBoundedString(
                action.detail,
                "action.detail",
                limits.maxFieldLength,
              ),
            }),
      };
    case "complete":
      return {
        type,
        ...optionalNumber(
          action.incorporatedThroughInputSequence,
          "incorporatedThroughInputSequence",
        ),
        ...(action.finalReply === undefined
          ? {}
          : { finalReply: parseReply(action.finalReply, limits) }),
      };
    case "fail":
      return {
        type,
        reason: requireBoundedString(
          action.reason,
          "action.reason",
          limits.maxFieldLength,
        ),
      };
    case "wait":
      return {
        type,
        reason: requireBoundedString(
          action.reason,
          "action.reason",
          limits.maxFieldLength,
        ),
      };
    default:
      throw new ProviderProtocolError(`Unsupported action type ${type}.`);
  }
}

async function applyActions(
  actions: readonly CopilotAction[],
  context: ProviderExecutionContext,
): Promise<void> {
  for (const action of actions) {
    if (context.signal.aborted) {
      throw abortReason(context.signal);
    }
    switch (action.type) {
      case "create_run":
        await context.capabilities.createRunFromAttention();
        break;
      case "continue_run":
        await context.capabilities.continueAttentionWithRun(action.runId);
        break;
      case "ignore_attention":
        await context.capabilities.ignoreAttention(action.reason);
        break;
      case "append_activity":
        await context.capabilities.appendActivity(
          action.kind,
          action.payload,
          action.retentionClass,
        );
        break;
      case "publish_reply":
        await context.capabilities.publishReply(action);
        break;
      case "publish_report":
        await context.capabilities.publishReport({ idempotencyKey: action.idempotencyKey, text: action.text });
        break;
      case "report_status":
        await context.capabilities.reportStatus(action.status, action.detail);
        break;
      case "complete":
        await context.capabilities.complete(action);
        break;
      case "fail":
        await context.capabilities.fail(action.reason);
        break;
      case "wait":
        await context.capabilities.wait(action.reason);
        break;
    }
  }
}

function validateActionPlan(
  actions: readonly CopilotAction[],
  causeType: ProviderExecutionContext["cause"]["type"],
): void {
  if (causeType === "attention") {
    if (
      actions.length !== 1 ||
      !["create_run", "continue_run", "ignore_attention"].includes(
        actions[0]!.type,
      )
    ) {
      throw new ProviderProtocolError(
        "An Attention Activation must return exactly one ignore_attention, continue_run, or create_run action.",
      );
    }
    return;
  }
  if (
    actions.some((action) =>
      action.type === "create_run" ||
      action.type === "continue_run" ||
      action.type === "ignore_attention"
    )
  ) {
    throw new ProviderProtocolError(
      "A Run Activation cannot contain Attention decision actions.",
    );
  }
  const terminalIndexes = actions.flatMap((action, index) =>
    action.type === "complete" ||
    action.type === "fail" ||
    action.type === "wait"
      ? [index]
      : [],
  );
  if (
    terminalIndexes.length !== 1 ||
    terminalIndexes[0] !== actions.length - 1
  ) {
    throw new ProviderProtocolError(
      "A Run Activation must contain exactly one final complete, fail, or wait action.",
    );
  }
}

function parseReply(
  value: unknown,
  limits: CopilotAcpLimits,
): {
  readonly body: string;
  readonly targetAgentIds?: readonly string[];
  readonly expectedThreadCursor?: number;
} {
  const reply = getRecord(value, "finalReply");
  return {
    body: requireBoundedString(
      reply.body,
      "finalReply.body",
      limits.maxFieldLength,
    ),
    ...optionalStringArray(
      reply.targetAgentIds,
      "finalReply.targetAgentIds",
      limits,
    ),
    ...optionalNumber(reply.expectedThreadCursor, "expectedThreadCursor"),
  };
}

function optionalStringArray(
  value: unknown,
  name: string,
  limits: CopilotAcpLimits,
): { readonly targetAgentIds?: readonly string[] } {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ProviderProtocolError(`${name} must be an array of strings.`);
  }
  if (value.length > limits.maxTargetCount) {
    throw new ProviderProtocolError(
      `${name} exceeded ${limits.maxTargetCount} entries.`,
    );
  }
  return {
    targetAgentIds: value.map((item, index) =>
      requireBoundedString(
        item,
        `${name}[${index}]`,
        limits.maxFieldLength,
      ),
    ),
  };
}

function optionalNumber<K extends string>(
  value: unknown,
  name: K,
): { readonly [P in K]?: number } {
  if (value === undefined) {
    return {};
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ProviderProtocolError(`${name} must be a non-negative integer.`);
  }
  return { [name]: value } as { readonly [P in K]?: number };
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new ProviderProtocolError(
      `${name} must be one of ${values.join(", ")}.`,
    );
  }
  return value;
}

function getRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderProtocolError(`${name} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new ProviderProtocolError(
      `${name} exceeded ${maxLength} characters.`,
    );
  }
  return value;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toJsonValue(value: unknown, maxDepth: number): JsonValue {
  assertJsonDepth(value, maxDepth, "JSON value");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, maxDepth - 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        toJsonValue(item, maxDepth - 1),
      ]),
    );
  }
  throw new ProviderProtocolError("Value is not JSON serializable.");
}

function assertJsonDepth(
  value: unknown,
  maxDepth: number,
  name: string,
  depth = 0,
): void {
  if (depth > maxDepth) {
    throw new ProviderProtocolError(
      `${name} exceeded JSON depth ${maxDepth}.`,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonDepth(item, maxDepth, name, depth + 1);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertJsonDepth(item, maxDepth, name, depth + 1);
    }
  }
}

function addWithinLimit(
  current: number,
  addition: number,
  limit: number,
  name: string,
): number {
  if (addition > limit - current) {
    throw new ProviderProtocolError(
      `${name} exceeded ${limit} bytes.`,
      "provider_output_limit",
    );
  }
  return current + addition;
}

function validateLimits(limits: CopilotAcpLimits): CopilotAcpLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Copilot ACP limit ${name} must be a positive integer.`);
    }
  }
  return limits;
}

function buildSanitizedEnvironment(
  explicit: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const allowedHostNames = new Set(
    [
      "PATH",
      "PATHEXT",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "LANG",
      "LC_ALL",
      "TERM",
    ].map((name) => name.toUpperCase()),
  );
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      allowedHostNames.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  for (const [name, value] of Object.entries(explicit)) {
    const upper = name.toUpperCase();
    if (
      upper === "COPILOT_ALLOW_ALL" ||
      upper === "COPILOT_ASSISTED_APPROVAL" ||
      upper === "GH_TOKEN" ||
      upper === "GITHUB_TOKEN" ||
      upper === "COPILOT_GITHUB_TOKEN" ||
      (!upper.startsWith("COPILOT_PROVIDER_") &&
        upper !== "COPILOT_PROVIDERS_CONFIG" &&
        upper !== "COPILOT_HOME")
    ) {
      throw new Error(
        `Copilot ACP environment variable ${name} is not in the explicit provider allowlist.`,
      );
    }
    environment[name] = value;
  }
  return environment;
}

function normalizeExecutionError(
  error: unknown,
  signal: AbortSignal,
): Error {
  if (signal.aborted) {
    return abortReason(signal);
  }
  return normalizeProviderExecutionError(error, "Unknown");
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason === undefined) {
    return new ProviderExecutionError("provider_cancelled", "Unknown");
  }
  return normalizeProviderExecutionError(signal.reason, "Unknown");
}

async function stopProcess(
  processHandle: ChildProcessWithoutNullStreams,
  graceMs: number,
  endInput: () => Promise<void>,
): Promise<void> {
  if (isProcessClosed(processHandle)) {
    return;
  }
  const gracefulClose = waitForClose(processHandle, graceMs);
  await endInput();
  if (await gracefulClose) {
    return;
  }

  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    const terminatedClose = waitForClose(processHandle, graceMs);
    processHandle.kill();
    if (await terminatedClose) {
      return;
    }
  }
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    const forcedClose = waitForClose(processHandle, graceMs);
    processHandle.kill("SIGKILL");
    if (await forcedClose) {
      return;
    }
  }
  if (!isProcessClosed(processHandle)) {
    throw new ProviderExecutionError(
      "provider_cleanup_failed",
      "Unknown",
    );
  }
}

function stdinFailure(error: Error): ProviderExecutionError {
  void error;
  return new ProviderExecutionError(
    "provider_io_error",
    "Unknown",
  );
}

function waitForClose(
  processHandle: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (isProcessClosed(processHandle)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      processHandle.removeListener("close", onClose);
      resolve(false);
    }, timeoutMs);
    processHandle.once("close", onClose);
  });
}

function isProcessClosed(
  processHandle: ChildProcessWithoutNullStreams,
): boolean {
  return (
    (processHandle.exitCode !== null || processHandle.signalCode !== null) &&
    processHandle.stdout.destroyed &&
    processHandle.stderr.destroyed
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
