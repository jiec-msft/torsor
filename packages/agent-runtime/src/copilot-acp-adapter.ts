import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { JsonValue } from "@torsor/kernel";

import {
  ProviderExecutionError,
  ProviderProtocolError,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderExecutionResult,
} from "./types.js";

export interface CopilotAcpAdapterOptions {
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly shutdownGraceMs?: number;
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
  | { readonly type: "create_run" }
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
      readonly type: "publish_artifact";
      readonly contentDigest: string;
      readonly baseRevision: string;
      readonly mediaType: string;
      readonly storageLocation: string;
      readonly metadata?: JsonValue;
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

export class CopilotAcpAdapter implements ProviderAdapter {
  readonly name = "github-copilot-cli-acp";
  readonly version = "1";
  readonly capabilities = {
    acceptsInputWhileRunning: false,
    supportsCancel: true,
    supportsResume: false,
    supportsSessionContinuation: true,
    supportsGracefulPause: false,
    supportsIdempotentRequests: false,
  } as const;

  readonly #command: string;
  readonly #commandArgs: readonly string[];
  readonly #cwd: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #shutdownGraceMs: number;

  constructor(options: CopilotAcpAdapterOptions = {}) {
    this.#command = options.command ?? "copilot";
    this.#commandArgs = options.commandArgs ?? [
      "--acp",
      "--stdio",
      "--no-auto-update",
      "--no-remote",
      "--no-remote-export",
      "--no-ask-user",
    ];
    this.#cwd = options.cwd ?? process.cwd();
    this.#environment = options.environment ?? {};
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
  }

  async execute(
    context: ProviderExecutionContext,
  ): Promise<ProviderExecutionResult> {
    const processHandle = spawn(this.#command, [...this.#commandArgs], {
      cwd: this.#cwd,
      env: { ...process.env, ...this.#environment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const connection = new NdjsonRpcConnection(processHandle);
    let sessionId: string | null = null;
    const outputChunks: string[] = [];
    const updateTasks: Promise<unknown>[] = [];
    const stderrChunks: string[] = [];
    processHandle.stderr.setEncoding("utf8");
    processHandle.stderr.on("data", (chunk: string) => {
      if (stderrChunks.join("").length < 16_384) {
        stderrChunks.push(chunk);
      }
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
      if (notification.method !== "session/update") {
        return;
      }
      const update = getRecord(getRecord(notification.params, "params").update, "update");
      const updateType = getOptionalString(update.sessionUpdate);
      if (updateType === "agent_message_chunk") {
        const content = getRecord(update.content, "content");
        if (content.type === "text" && typeof content.text === "string") {
          outputChunks.push(content.text);
          if (context.cause.type === "run") {
            updateTasks.push(
              context.capabilities.appendActivity(
                "agent_message_chunk",
                {
                  text: content.text,
                  ...(typeof update.messageId === "string"
                    ? { messageId: update.messageId }
                    : {}),
                },
                "transient",
              ),
            );
          }
        }
        return;
      }
      if (
        context.cause.type === "run" &&
        (updateType === "tool_call" || updateType === "tool_call_update")
      ) {
        updateTasks.push(
          context.capabilities.appendActivity(
            updateType,
            toJsonValue(update),
            "durable",
          ),
        );
      }
    };

    const abort = () => {
      if (sessionId) {
        connection.notify("session/cancel", { sessionId });
      }
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
          cwd: this.#cwd,
          mcpServers: [],
        }),
        "session/new result",
      );
      sessionId = requireString(session.sessionId, "sessionId");
      const prompt = buildPrompt(context);
      const promptResult = getRecord(
        await connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }),
        "session/prompt result",
      );
      await Promise.all(updateTasks);
      const stopReason = requireString(promptResult.stopReason, "stopReason");
      if (stopReason !== "end_turn") {
        throw new ProviderExecutionError(
          `Copilot ACP stopped with ${stopReason}.`,
          stopReason === "cancelled" ? "Unknown" : "Failed",
        );
      }
      const actions = parseActions(outputChunks.join(""));
      validateActionPlan(actions, context.cause.type);
      await applyActions(actions, context);
      return {
        detail: `Copilot ACP completed session ${sessionId}.`,
        diagnosticSessionId: sessionId,
      };
    } catch (error) {
      if (context.signal.aborted) {
        const reason = context.signal.reason;
        throw reason instanceof Error
          ? reason
          : new ProviderExecutionError("Copilot ACP execution was aborted.", "Unknown");
      }
      if (error instanceof ProviderExecutionError) {
        throw error;
      }
      const stderr = stderrChunks.join("").trim();
      throw new ProviderExecutionError(
        stderr
          ? `Copilot ACP failed: ${errorMessage(error)}; stderr: ${stderr}`
          : `Copilot ACP failed: ${errorMessage(error)}`,
        "Unknown",
      );
    } finally {
      context.signal.removeEventListener("abort", abort);
      connection.close();
      await stopProcess(processHandle, this.#shutdownGraceMs);
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
  #closed = false;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  readonly #lines;

  constructor(private readonly processHandle: ChildProcessWithoutNullStreams) {
    this.#lines = createInterface({ input: processHandle.stdout });
    this.#lines.on("line", (line) => {
      try {
        this.#receive(line);
      } catch (error) {
        this.#rejectPending(
          error instanceof Error
            ? error
            : new ProviderProtocolError(String(error)),
        );
      }
    });
    processHandle.once("error", (error) => {
      this.#rejectPending(error);
    });
    processHandle.once("exit", (code, signal) => {
      if (!this.#closed && this.#pending.size > 0) {
        this.#rejectPending(
          new Error(
            `ACP process exited before completing requests (code=${String(code)}, signal=${String(signal)}).`,
          ),
        );
      }
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
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
    if (!this.#closed) {
      this.#send({ jsonrpc: "2.0", method, params });
    }
  }

  close(): void {
    this.#closed = true;
    this.#lines.close();
    this.#rejectPending(new Error("ACP connection closed."));
    this.processHandle.stdin.end();
  }

  #receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#rejectPending(new Error("ACP process emitted invalid NDJSON."));
      return;
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
          new Error(
            `ACP request failed (${response.error.code}): ${response.error.message}`,
          ),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    const request = record as unknown as RpcRequest;
    if (typeof request.method !== "string") {
      return;
    }
    if (typeof request.id !== "number") {
      this.onNotification(request);
      return;
    }
    void this.onRequest(request).then(
      (result) => {
        this.#send({ jsonrpc: "2.0", id: request.id, result });
      },
      (error: unknown) => {
        this.#send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: errorMessage(error) },
        });
      },
    );
  }

  #send(message: unknown): void {
    if (this.#closed || !this.processHandle.stdin.writable) {
      throw new Error("ACP connection is not writable.");
    }
    this.processHandle.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function buildPrompt(context: ProviderExecutionContext): string {
  const state =
    context.cause.type === "attention"
      ? {
          cause: "attention",
          attention: context.cause.attention,
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
      ? "Return exactly one create_run action."
      : "End with exactly one complete, fail, or wait action.";
  return [
    "You are executing one bounded Torsor Activation.",
    "The JSON below is rebuilt from durable Kernel state and is authoritative.",
    "Do not claim that provider session history is authoritative.",
    "Return only one JSON object with an actions array and no Markdown.",
    required,
    "Allowed actions are create_run, append_activity, publish_reply, publish_artifact, report_status, complete, fail, and wait.",
    "Provenance, Agent identity, Run identity, revisions, Activation identity, and ProviderAttempt identity are server-bound and must not be included.",
    JSON.stringify(state),
  ].join("\n");
}

function parseActions(output: string): readonly CopilotAction[] {
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
  const record = getRecord(parsed, "action envelope");
  if (!Array.isArray(record.actions) || record.actions.length === 0) {
    throw new ProviderProtocolError(
      "Copilot ACP action envelope must contain at least one action.",
    );
  }
  return record.actions.map(parseAction);
}

function parseAction(value: unknown): CopilotAction {
  const action = getRecord(value, "action");
  const type = requireString(action.type, "action.type");
  switch (type) {
    case "create_run":
      return { type };
    case "append_activity":
      return {
        type,
        kind: requireString(action.kind, "action.kind"),
        payload: toJsonValue(action.payload),
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
        body: requireString(action.body, "action.body"),
        ...optionalStringArray(action.targetAgentIds, "action.targetAgentIds"),
        ...optionalNumber(action.expectedThreadCursor, "expectedThreadCursor"),
      };
    case "publish_artifact":
      return {
        type,
        contentDigest: requireString(action.contentDigest, "action.contentDigest"),
        baseRevision: requireString(action.baseRevision, "action.baseRevision"),
        mediaType: requireString(action.mediaType, "action.mediaType"),
        storageLocation: requireString(
          action.storageLocation,
          "action.storageLocation",
        ),
        ...(action.metadata === undefined
          ? {}
          : { metadata: toJsonValue(action.metadata) }),
      };
    case "report_status":
      return {
        type,
        status: requireString(action.status, "action.status"),
        ...(action.detail === undefined
          ? {}
          : { detail: requireString(action.detail, "action.detail") }),
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
          : { finalReply: parseReply(action.finalReply) }),
      };
    case "fail":
      return { type, reason: requireString(action.reason, "action.reason") };
    case "wait":
      return { type, reason: requireString(action.reason, "action.reason") };
    default:
      throw new ProviderProtocolError(`Unsupported action type ${type}.`);
  }
}

async function applyActions(
  actions: readonly CopilotAction[],
  context: ProviderExecutionContext,
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case "create_run":
        await context.capabilities.createRunFromAttention();
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
      case "publish_artifact":
        await context.capabilities.publishArtifact(action);
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
    if (actions.length !== 1 || actions[0]?.type !== "create_run") {
      throw new ProviderProtocolError(
        "An Attention Activation must return exactly one create_run action.",
      );
    }
    return;
  }
  if (actions.some((action) => action.type === "create_run")) {
    throw new ProviderProtocolError(
      "A Run Activation cannot contain create_run.",
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

function parseReply(value: unknown): {
  readonly body: string;
  readonly targetAgentIds?: readonly string[];
  readonly expectedThreadCursor?: number;
} {
  const reply = getRecord(value, "finalReply");
  return {
    body: requireString(reply.body, "finalReply.body"),
    ...optionalStringArray(reply.targetAgentIds, "finalReply.targetAgentIds"),
    ...optionalNumber(reply.expectedThreadCursor, "expectedThreadCursor"),
  };
}

function optionalStringArray(
  value: unknown,
  name: string,
): { readonly targetAgentIds?: readonly string[] } {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ProviderProtocolError(`${name} must be an array of strings.`);
  }
  return { targetAgentIds: value as string[] };
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderProtocolError(`${name} must be a non-empty string.`);
  }
  return value;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toJsonValue(value: unknown): JsonValue {
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
    return value.map(toJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]),
    );
  }
  throw new ProviderProtocolError("Value is not JSON serializable.");
}

async function stopProcess(
  processHandle: ChildProcessWithoutNullStreams,
  graceMs: number,
): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return;
  }
  processHandle.stdin.end();
  processHandle.kill();
  await Promise.race([
    new Promise<void>((resolve) => {
      processHandle.once("exit", () => resolve());
    }),
    new Promise<void>((resolve) => {
      setTimeout(resolve, graceMs);
    }),
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
