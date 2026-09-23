import type { ActivityEvent, JsonValue, RunProjection } from "./types";

export interface TimelineItem {
  readonly id: string;
  readonly source: "RunActivityEvent" | "RunInput" | "ProviderAttempt" | "Run";
  readonly title: string;
  readonly label: string;
  readonly timestamp: string;
  readonly kind?: string;
  readonly state?: string;
  readonly tone: "neutral" | "running" | "failed" | "cancelled" | "completed";
  readonly body: string | null;
  readonly provenance: readonly string[];
}

function payloadText(payload: JsonValue, field: string): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = payload[field];
  return typeof value === "string" ? value : null;
}

const toolKindLabels = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Execute",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
  other: "Other",
} as const;

function toolBody(payload: JsonValue, status: string): string {
  const kind = payloadText(payload, "kind");
  const label = kind && Object.hasOwn(toolKindLabels, kind)
    ? toolKindLabels[kind as keyof typeof toolKindLabels] : "Other";
  const id = payloadText(payload, "toolCallId");
  const publicId = id && /^tool-[1-9][0-9]{0,2}$/.test(id) && Number(id.slice(5)) <= 128
    ? id : null;
  return [label, ...(publicId ? [publicId] : []), status].join(" · ");
}

function activityItem(event: ActivityEvent): TimelineItem {
  let title = "Unknown activity";
  let body: string | null = null;
  let tone: TimelineItem["tone"] = "neutral";
  if (event.kind === "agent_message_chunk") {
    title = "Agent output";
    body = payloadText(event.payload, "text");
  } else if (event.kind === "status") {
    title = payloadText(event.payload, "status") ?? "Agent status";
    body = payloadText(event.payload, "detail");
  } else if (event.kind === "provider_attempt_failure_parked") {
    title = "Provider failure parked the Run";
    body = payloadText(event.payload, "reason");
    tone = "failed";
  } else if (event.kind === "late_output") {
    title = "Late output";
    body = payloadText(event.payload, "text");
  } else if (event.kind === "tool_started") {
    title = "Tool started";
    body = toolBody(event.payload, "In progress");
    tone = "running";
  } else if (event.kind === "tool_completed") {
    title = "Tool completed";
    body = toolBody(event.payload, "Completed");
    tone = "completed";
  } else if (event.kind === "tool_failed") {
    title = "Tool failed";
    body = toolBody(event.payload, "Failed");
    tone = "failed";
  }
  return {
    id: `activity:${event.id}`,
    source: "RunActivityEvent",
    title,
    label: `Activity sequence ${event.sequence}`,
    timestamp: event.createdAt,
    kind: event.kind,
    tone,
    body,
    provenance: [
      event.id,
      ...(event.activationId ? [`Activation ${event.activationId}`] : []),
      ...(event.providerAttemptId ? [`ProviderAttempt ${event.providerAttemptId}`] : []),
      `Retention ${event.retentionClass}`,
    ],
  };
}

export function timelineItems(projection: RunProjection): readonly TimelineItem[] {
  const { run } = projection;
  const facts: TimelineItem[] = [
    ...projection.inputs.map((input): TimelineItem => ({
      id: `input:${input.id}`,
      source: "RunInput",
      title: "Assigned input",
      label: `Input sequence ${input.sequence}`,
      timestamp: input.createdAt,
      state: input.disposition,
      tone: "neutral",
      body: input.dispositionReason,
      provenance: [
        input.id, `Message revision ${input.messageRevisionId}`,
        `Assigned by ${input.assignedByPrincipalId}`,
        `Disposition revision ${input.dispositionRevision}`,
      ],
    })),
    ...projection.providerAttempts.map((attempt): TimelineItem => ({
      id: `provider:${attempt.id}`,
      source: "ProviderAttempt",
      title: attempt.adapter,
      label: `Provider ${attempt.id}`,
      timestamp: attempt.finishedAt ?? attempt.startedAt,
      state: attempt.status === "Started" || attempt.status === "Acknowledged"
        ? `Running (${attempt.status})` : attempt.status,
      tone: attempt.status === "Failed" ? "failed"
        : attempt.status === "Completed" ? "completed"
        : attempt.status === "Unknown" ? "neutral" : "running",
      body: run.state === "Cancelled" &&
        ["Started", "Acknowledged", "Unknown"].includes(attempt.status)
        ? "Provider stop unconfirmed" : null,
      provenance: [
        `Activation ${attempt.activationId}`,
        `Adapter version ${attempt.adapterVersion}`,
        `Inputs supplied: ${attempt.runInputIds.join(", ") || "none"}`,
        ...(attempt.detail ? [attempt.detail] : []),
      ],
    })),
    {
      id: `run:${run.id}`,
      source: "Run",
      title: "Current Run state",
      label: `Run revision ${run.revision}`,
      timestamp: run.updatedAt,
      state: run.state,
      tone: run.state === "Failed" ? "failed"
        : run.state === "Cancelled" ? "cancelled"
        : run.state === "Completed" ? "completed" : "neutral",
      body: run.terminalReason,
      provenance: [run.id, `Source Thread ${run.threadRootId}`],
    },
  ];
  facts.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  const items: TimelineItem[] = [];
  let factIndex = 0;
  // Activity sequence is authoritative even if the producer's clock moves backward.
  for (const event of projection.activity.items) {
    while (factIndex < facts.length && facts[factIndex]!.timestamp <= event.createdAt) {
      items.push(facts[factIndex++]!);
    }
    items.push(activityItem(event));
  }
  items.push(...facts.slice(factIndex));
  return items;
}
