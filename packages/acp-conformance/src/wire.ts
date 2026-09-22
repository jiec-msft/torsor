import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

import { assertJson, fail, HarnessError, record } from "./facts.js";
import { OwnedProcess } from "./process.js";
import type { Limits } from "./schema.js";
import { Transcript } from "./transcript.js";
import { validatePayload } from "./protocol.js";

const stopReasons = new Set(["end_turn", "cancelled", "refusal", "max_tokens", "max_turn_requests"]);
const clientSessionMethods = new Set(["session/new", "session/prompt", "session/cancel"]);
const turnUpdates = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);

export class Wire {
  readonly stream: Stream;
  readonly #pending = new Map<string, { method: string; sessionId: unknown; toolCallId: unknown; cancelled: boolean }>();
  #buffer = Buffer.alloc(0);
  #bytes = 0;
  #events = 0;
  #ended = false;
  #initialized = false;
  readonly #sessions = new Map<string, Set<string>>();

  constructor(
    private readonly owned: OwnedProcess,
    private readonly limits: Limits,
    private readonly transcript: Transcript,
    private readonly workspace: string,
  ) {
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        owned.stdout.on("data", (chunk: Buffer) => {
          if (this.#ended || owned.error) return;
          try {
            this.#bytes += chunk.length;
            if (this.#bytes > limits.stdoutBytes) fail("stdout_limit", "Provider stdout exceeded its byte budget.");
            this.#buffer = Buffer.concat([this.#buffer, chunk]);
            for (;;) {
              const end = this.#buffer.indexOf(10);
              if (end < 0) {
                if (this.#buffer.length > limits.frameBytes) fail("frame_limit", "Provider frame exceeded its byte budget.");
                break;
              }
              if (end > limits.frameBytes) fail("frame_limit", "Provider frame exceeded its byte budget.");
              const frame = this.#buffer.subarray(0, end);
              this.#buffer = this.#buffer.subarray(end + 1);
              this.observe(this.parse(frame), "provider");
              controller.enqueue(Buffer.concat([frame, Buffer.from("\n")]));
            }
          } catch (error) { this.failure(error); }
        });
        void owned.stdoutEnded.then(() => {
          if (this.#ended) return;
          this.#ended = true;
          if (this.#buffer.length > 0) owned.fail("partial_frame", "Provider stdout ended with an unterminated frame.");
          else if ([...this.#pending.keys()].some((key) => key.startsWith("client:"))) {
            owned.fail("stdout_closed", "Provider stdout closed with an outstanding client request.");
          }
          controller.close();
        });
      },
      cancel: () => { this.#ended = true; },
    });
    const output = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        try {
          if (chunk.length > limits.frameBytes + 1) fail("frame_limit", "Client frame exceeded its byte budget.");
          this.observe(this.parse(chunk), "client");
          await owned.write(chunk);
        } catch (error) {
          this.failure(error);
          throw error;
        }
      },
    });
    this.stream = ndJsonStream(output, input);
  }

  private parse(frame: Uint8Array): Record<string, unknown> {
    let message: unknown;
    try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)); }
    catch { fail("malformed_frame", "Expected a UTF-8 JSON-RPC frame."); }
    assertJson(message);
    if (!record(message) || message.jsonrpc !== "2.0") fail("invalid_envelope", "Expected a single JSON-RPC 2.0 object.");
    return message;
  }

  private observe(message: Record<string, unknown>, direction: "client" | "provider"): void {
    if (++this.#events > this.limits.events) fail("event_limit", "Protocol event count exceeded its budget.");
    const hasId = Object.hasOwn(message, "id");
    if (hasId && typeof message.id !== "string" && !Number.isSafeInteger(message.id)) {
      fail("invalid_envelope", "JSON-RPC ID must be a string or safe integer.");
    }
    const response = !Object.hasOwn(message, "method");
    const owner = response ? direction === "client" ? "provider" : "client" : direction;
    const key = `${owner}:${typeof message.id}:${String(message.id)}`;
    if (response) {
      if (!hasId || Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) {
        fail("invalid_envelope", "Response must contain exactly one result or error.");
      }
      const request = this.#pending.get(key);
      if (!request) fail("unexpected_response", "Response ID is unknown or already completed.");
      if (direction === "client" && request.method === "session/request_permission") {
        this.permission(request.sessionId, request.toolCallId);
      }
      this.#pending.delete(key);
      if (request.cancelled && (!record(message.result) || message.result.stopReason !== "cancelled")) {
        fail("protocol_result", "A cancelled prompt must return stopReason cancelled.");
      }
      if (Object.hasOwn(message, "error")) {
        if (!record(message.error) || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== "string") {
          fail("invalid_envelope", "RPC error requires an integer code and string message.");
        }
      } else if (direction === "provider") this.result(request.method, message.result);
    } else {
      if (typeof message.method !== "string" || Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
        fail("invalid_envelope", "Request or notification has an invalid envelope.");
      }
      if (direction === "client" && message.method.startsWith("session/")) {
        if (!clientSessionMethods.has(message.method) || (message.method === "session/cancel") === hasId) {
          fail("protocol_state", "Session method or message kind is outside the supported lifecycle safety boundary.");
        }
      }
      if (Object.hasOwn(message, "params") && !record(message.params)) fail("invalid_envelope", "ACP params must be an object.");
      validatePayload(message.method, "params", message.params);
      if (direction === "client" && message.method === "session/new" && !this.#initialized) {
        fail("protocol_state", "Initialize must complete before creating a session.");
      }
      if (direction === "client" && message.method === "initialize") {
        const params = message.params;
        if (!record(params) || params.protocolVersion !== 1 || !record(params.clientCapabilities) ||
          Object.keys(params.clientCapabilities).length !== 0) {
          fail("protocol_state", "Harness initialization requires version 1 and no optional client capabilities.");
        }
      }
      if (direction === "client" && message.method === "session/new") {
        const params = message.params;
        if (!record(params) || params.cwd !== this.workspace || !Array.isArray(params.mcpServers) ||
          params.mcpServers.length !== 0 || (Object.hasOwn(params, "additionalDirectories") &&
            (!Array.isArray(params.additionalDirectories) || params.additionalDirectories.length !== 0))) {
          fail("protocol_state", "Sessions must use the synthetic workspace without MCP servers or additional directories.");
        }
      }
      if (direction === "client" && (message.method === "session/prompt" || message.method === "session/cancel")) {
        if (!record(message.params) || typeof message.params.sessionId !== "string" || !this.#sessions.has(message.params.sessionId)) {
          fail("protocol_state", "Prompt and cancel require a session created on this connection.");
        }
        if (message.method === "session/prompt" && this.activePrompt(message.params.sessionId)) {
          fail("protocol_state", "A session cannot have overlapping prompts.");
        }
      }
      if (direction === "provider" && message.method === "session/update") {
        const params = message.params;
        if (hasId || !record(params) || typeof params.sessionId !== "string" || !this.#sessions.has(params.sessionId)) {
          fail("protocol_state", "Session updates must be notifications for a session created on this connection.");
        }
        if (record(params.update) && typeof params.update.sessionUpdate === "string" &&
          turnUpdates.has(params.update.sessionUpdate) && !this.activePrompt(params.sessionId)) {
          fail("protocol_state", "Content and tool updates require an outstanding prompt for their session.");
        }
        if (record(params.update) && (params.update.sessionUpdate === "tool_call" || params.update.sessionUpdate === "tool_call_update")) {
          this.tool(params.sessionId, params.update.toolCallId, params.update.sessionUpdate === "tool_call");
        }
      }
      if (direction === "provider" && message.method === "session/request_permission") {
        const params = message.params;
        if (!hasId || !record(params) || !record(params.toolCall)) {
          fail("protocol_state", "Permission must be a request identifying a session and tool.");
        }
        this.permission(params.sessionId, params.toolCall.toolCallId);
      }
      if (direction === "client" && message.method === "session/cancel" && record(message.params)) {
        for (const [pendingKey, request] of this.#pending) {
          if (pendingKey.startsWith("client:") && request.method === "session/prompt" &&
            request.sessionId === message.params.sessionId) request.cancelled = true;
        }
      }
      if (hasId) {
        if (this.#pending.has(key)) fail("invalid_envelope", "Request ID is already active.");
        this.#pending.set(key, {
          method: message.method,
          sessionId: record(message.params) ? message.params.sessionId : undefined,
          toolCallId: record(message.params) && record(message.params.toolCall) ? message.params.toolCall.toolCallId : undefined,
          cancelled: false,
        });
      }
    }
    this.transcript.protocol(direction, message);
  }

  private tool(sessionId: string, toolCallId: unknown, initial = false): void {
    const tools = this.#sessions.get(sessionId);
    if (!tools || typeof toolCallId !== "string" || !toolCallId) {
      fail("protocol_state", "Tool identity requires a created session and nonempty tool ID.");
    }
    if (initial ? tools.has(toolCallId) : !tools.has(toolCallId)) {
      fail("protocol_state", initial
        ? "Initial tool ID was already used in this session."
        : "Tool update or permission refers to a tool not announced in this session.");
    }
    if (initial) tools.add(toolCallId);
  }

  private permission(sessionId: unknown, toolCallId: unknown): void {
    if (typeof sessionId !== "string" || !this.#sessions.has(sessionId) || !this.activePrompt(sessionId)) {
      fail("protocol_state", "Permission requires a created session with an outstanding prompt.");
    }
    this.tool(sessionId, toolCallId);
  }

  private activePrompt(sessionId: string): boolean {
    return [...this.#pending].some(([key, request]) =>
      key.startsWith("client:") && request.method === "session/prompt" && request.sessionId === sessionId,
    );
  }

  private result(method: string, result: unknown): void {
    validatePayload(method, "result", result);
    if (method === "initialize") {
      if (!record(result) || result.protocolVersion !== 1 || !record(result.agentCapabilities)) {
        fail("protocol_result", "Initialize requires protocol version 1 and agentCapabilities.");
      }
      this.#initialized = true;
    }
    if (method === "session/new") {
      if (!record(result) || typeof result.sessionId !== "string" || !result.sessionId) {
        fail("protocol_result", "Session creation requires a nonempty sessionId.");
      }
      if (this.#sessions.has(result.sessionId)) {
        fail("protocol_result", "Session creation returned an ID already used on this connection.");
      }
      this.#sessions.set(result.sessionId, new Set());
    }
    if (method === "session/prompt" && (!record(result) || typeof result.stopReason !== "string" || !stopReasons.has(result.stopReason))) {
      fail("protocol_result", "Prompt result requires a supported stopReason.");
    }
  }

  private failure(error: unknown): void {
    if (error instanceof HarnessError) this.owned.fail(error.code, error.message);
    else this.owned.fail("transport_failed", "Protocol transport failed.");
  }
}
