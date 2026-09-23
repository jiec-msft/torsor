import { ProviderProtocolError } from "./types.js";

const toolKinds = [
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch",
  "switch_mode", "other",
] as const;

type ToolKind = (typeof toolKinds)[number];
type ToolStatus = "in_progress" | "completed" | "failed";

export type CopilotToolActivityEvent = {
  readonly kind: "tool_started" | "tool_completed" | "tool_failed";
  readonly payload: {
    readonly toolCallId: string;
    readonly kind: ToolKind;
    readonly status: ToolStatus;
  };
};

interface ToolState {
  readonly publicId: string;
  readonly kind: ToolKind;
  readonly status: ToolStatus;
}

function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) {
    throw new ProviderProtocolError();
  }
  return descriptor?.value;
}

function normalizeKind(value: unknown): ToolKind {
  return typeof value === "string" && toolKinds.includes(value as ToolKind)
    ? value as ToolKind : "other";
}

function normalizeStatus(value: unknown): ToolStatus {
  if (value === "pending" || value === "in_progress") return "in_progress";
  if (value === "completed" || value === "failed") return value;
  throw new ProviderProtocolError();
}

function event(state: ToolState, status: ToolStatus): CopilotToolActivityEvent {
  return Object.freeze({
    kind: status === "in_progress" ? "tool_started"
      : status === "completed" ? "tool_completed" : "tool_failed",
    payload: Object.freeze({ toolCallId: state.publicId, kind: state.kind, status }),
  });
}

export class CopilotToolActivity {
  readonly #tools = new Map<string, ToolState>();
  readonly #maxToolCalls: number;
  readonly #maxToolUpdates: number;
  #updates = 0;

  constructor(maxToolCalls = 128, maxToolUpdates = 512) {
    if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 128 ||
        !Number.isInteger(maxToolUpdates) || maxToolUpdates < 1 || maxToolUpdates > 512) {
      throw new ProviderProtocolError();
    }
    this.#maxToolCalls = maxToolCalls;
    this.#maxToolUpdates = maxToolUpdates;
  }

  assertComplete(): void {
    for (const state of this.#tools.values()) {
      if (state.status === "in_progress") throw new ProviderProtocolError();
    }
  }

  accept(update: unknown): readonly CopilotToolActivityEvent[] {
    if (update === null || typeof update !== "object" || Array.isArray(update)) return [];
    const updateType = field(update, "sessionUpdate");
    if (updateType !== "tool_call" && updateType !== "tool_call_update") return [];
    if (this.#updates >= this.#maxToolUpdates) {
      throw new ProviderProtocolError(undefined, "provider_output_limit");
    }
    this.#updates += 1;

    const rawId = field(update, "toolCallId");
    if (typeof rawId !== "string" || rawId.length === 0 || rawId.length > 256) {
      throw new ProviderProtocolError();
    }
    const previous = this.#tools.get(rawId);
    if (!previous && updateType === "tool_call_update") throw new ProviderProtocolError();
    if (!previous && this.#tools.size >= this.#maxToolCalls) {
      throw new ProviderProtocolError(undefined, "provider_output_limit");
    }
    const rawStatus = field(update, "status");
    const status = rawStatus === undefined
      ? previous?.status ?? "in_progress" : normalizeStatus(rawStatus);
    const rawKind = field(update, "kind");
    const kind = rawKind === undefined ? previous?.kind ?? "other" : normalizeKind(rawKind);
    if (previous && previous.status !== "in_progress") {
      if (status !== previous.status || kind !== previous.kind) throw new ProviderProtocolError();
      return [];
    }

    const state: ToolState = {
      publicId: previous?.publicId ?? `tool-${this.#tools.size + 1}`,
      kind,
      status,
    };
    this.#tools.set(rawId, state);
    const events: CopilotToolActivityEvent[] = [];
    if (!previous) events.push(event(state, "in_progress"));
    if (status !== "in_progress") events.push(event(state, status));
    return events;
  }
}
