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

function activityItem(event: ActivityEvent): TimelineItem {
  let title = "Unknown activity";
  let body: string | null = null;
  if (event.kind === "agent_message_chunk") {
    title = "Agent output";
    body = payloadText(event.payload, "text");
  } else if (event.kind === "status") {
    title = payloadText(event.payload, "status") ?? "Agent status";
    body = payloadText(event.payload, "detail");
  } else if (event.kind === "provider_attempt_failure_parked") {
    title = "Provider failure parked the Run";
    body = payloadText(event.payload, "reason");
  } else if (event.kind === "late_output") {
    title = "Late output";
    body = payloadText(event.payload, "text");
  }
  return {
    id: `activity:${event.id}`,
    source: "RunActivityEvent",
    title,
    label: `Activity sequence ${event.sequence}`,
    timestamp: event.createdAt,
    kind: event.kind,
    tone: event.kind === "provider_attempt_failure_parked" ? "failed" : "neutral",
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
