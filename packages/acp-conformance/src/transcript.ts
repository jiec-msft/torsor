import { record } from "./facts.js";

export interface TranscriptEvent {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  direction: "client" | "provider" | "harness";
  kind: string;
  message: Record<string, unknown>;
}

const methods = new Set([
  "initialize", "session/new", "session/prompt", "session/cancel",
  "session/update", "session/request_permission", "fs/read_text_file",
  "fs/write_text_file", "terminal/create", "terminal/output", "terminal/kill",
  "terminal/release", "terminal/wait_for_exit",
]);
const updates = new Set([
  "agent_message_chunk", "user_message_chunk", "agent_thought_chunk", "tool_call",
  "tool_call_update", "plan", "available_commands_update", "current_mode_update",
  "config_option_update", "session_info_update", "usage_update",
]);
const stops = new Set(["end_turn", "cancelled", "refusal", "max_tokens", "max_turn_requests"]);
const toolKinds = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const toolStatuses = new Set(["pending", "in_progress", "completed", "failed"]);

export class Transcript {
  readonly events: TranscriptEvent[] = [];
  readonly #ids = new Map<unknown, string>();
  readonly #sessions = new Map<unknown, string>();
  readonly #tools = new Map<unknown, string>();

  add(direction: TranscriptEvent["direction"], kind: string, message: Record<string, unknown> = {}): void {
    const sequence = this.events.length;
    this.events.push({
      schemaVersion: 1, sequence, timestamp: new Date(sequence).toISOString(),
      direction, kind, message,
    });
  }

  protocol(direction: "client" | "provider", message: Record<string, unknown>): void {
    const safe: Record<string, unknown> = { jsonrpc: "2.0" };
    const kind = typeof message.method === "string"
      ? Object.hasOwn(message, "id") ? "request" : "notification"
      : "response";
    if (Object.hasOwn(message, "id")) {
      const owner = kind === "response" ? (direction === "client" ? "provider" : "client") : direction;
      const key = `${owner}:${typeof message.id}:${String(message.id)}`;
      safe.id = this.alias(this.#ids, key, "request");
    }
    if (typeof message.method === "string") {
      safe.method = methods.has(message.method) ? message.method : "<extension>";
    }
    if (record(message.error)) {
      safe.error = { code: message.error.code };
    } else if (Object.hasOwn(message, "result")) {
      safe.result = this.payload(message.result);
    }
    if (record(message.params)) {
      safe.params = this.payload(message.params, typeof message.method === "string" ? message.method : undefined);
    }
    this.add(direction, kind, safe);
  }

  private payload(value: unknown, method?: string): Record<string, unknown> {
    if (!record(value)) return { value: "<redacted>" };
    const safe: Record<string, unknown> = {};
    if (Number.isSafeInteger(value.protocolVersion)) safe.protocolVersion = value.protocolVersion;
    if (typeof value.sessionId === "string") safe.sessionId = this.alias(this.#sessions, value.sessionId, "session");
    if (typeof value.stopReason === "string") safe.stopReason = stops.has(value.stopReason) ? value.stopReason : "<unknown>";
    if (record(value.agentCapabilities)) {
      const capabilities: Record<string, unknown> = {};
      for (const key of ["loadSession"]) {
        if (typeof value.agentCapabilities[key] === "boolean") capabilities[key] = value.agentCapabilities[key];
      }
      for (const key of ["promptCapabilities", "mcpCapabilities"]) {
        const nested = value.agentCapabilities[key];
        if (record(nested)) {
          capabilities[key] = Object.fromEntries(
            ["image", "audio", "embeddedContext", "http", "sse"]
              .filter((name) => typeof nested[name] === "boolean")
              .map((name) => [name, nested[name]]),
          );
        }
      }
      safe.agentCapabilities = capabilities;
    }
    if (record(value.clientCapabilities)) safe.clientCapabilities = {};
    if (Array.isArray(value.authMethods)) safe.authMethodCount = value.authMethods.length;
    if (Object.hasOwn(value, "cwd")) safe.cwd = "<workspace>";
    if (Object.hasOwn(value, "prompt")) safe.prompt = "<redacted>";
    if (record(value.update)) {
      const update: Record<string, unknown> = {
        sessionUpdate: typeof value.update.sessionUpdate === "string" && updates.has(value.update.sessionUpdate)
          ? value.update.sessionUpdate : "<unknown>",
      };
      if (method === "session/update" && typeof value.sessionId === "string" &&
        (value.update.sessionUpdate === "tool_call" || value.update.sessionUpdate === "tool_call_update")) {
        Object.assign(update, this.tool(value.update, value.sessionId));
      }
      safe.update = update;
    }
    if (method === "session/request_permission" && record(value.toolCall) && typeof value.sessionId === "string") {
      safe.toolCall = this.tool(value.toolCall, value.sessionId);
    }
    if (record(value.outcome)) safe.outcome = { outcome: value.outcome.outcome === "cancelled" ? "cancelled" : "<redacted>" };
    return safe;
  }

  private tool(value: Record<string, unknown>, sessionId: string): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    if (typeof value.toolCallId === "string") {
      safe.toolCallId = this.alias(this.#tools, JSON.stringify([sessionId, value.toolCallId]), "tool");
    }
    if (typeof value.kind === "string") safe.kind = toolKinds.has(value.kind) ? value.kind : "<unknown>";
    if (typeof value.status === "string") safe.status = toolStatuses.has(value.status) ? value.status : "<unknown>";
    return safe;
  }

  private alias(map: Map<unknown, string>, key: unknown, prefix: string): string {
    let value = map.get(key);
    if (!value) { value = `${prefix}-${map.size + 1}`; map.set(key, value); }
    return value;
  }
}

export function toJsonl(result: { transcript: readonly TranscriptEvent[] }): string {
  return result.transcript.map((event) => JSON.stringify(event) + "\n").join("");
}
