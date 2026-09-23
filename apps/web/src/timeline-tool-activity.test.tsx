import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveTimeline } from "./LiveTimeline";
import { runProjection } from "./test/fixtures";
import { timelineItems } from "./timeline-model";
import type { ActivityEvent, JsonValue, RunProjection } from "./types";

function projection(events: readonly { kind: string; payload: JsonValue }[]): RunProjection {
  const items = events.map((event, index): ActivityEvent => ({
    ...runProjection.activity.items[0]!,
    ...event,
    id: `tool-activity-${index + 1}`,
    sequence: index + 1,
    activationId: "tool-activation",
    providerAttemptId: "tool-attempt",
    retentionClass: "durable",
    createdAt: `2026-01-01T00:00:0${3 - index}.000Z`,
  }));
  return {
    ...runProjection,
    activity: { items, hasEarlier: false, earliestSequence: 1, latestSequence: items.length },
  };
}

describe("normalized native tool Timeline", () => {
  const phases = [
    ["tool_started", "Tool started", "running", "in_progress", "In progress"],
    ["tool_completed", "Tool completed", "completed", "completed", "Completed"],
    ["tool_failed", "Tool failed", "failed", "failed", "Failed"],
  ] as const;

  it.each(phases)("renders %s with a fixed label, tone, bounded body, and provenance", (
    kind, title, tone, status, statusLabel,
  ) => {
    const data = projection([{
      kind,
      payload: {
        toolCallId: "tool-1", kind: "execute", status,
        title: "synthetic-private-title", text: "synthetic-private-text",
        arguments: { command: "synthetic-private-command" },
        result: "synthetic-private-result", path: "C:\\synthetic-private\\file",
        mcpServerName: "synthetic-private-mcp", error: "synthetic-private-error",
      },
    }]);
    const item = timelineItems(data).find((item) => item.source === "RunActivityEvent")!;
    expect(item).toMatchObject({
      title, tone, kind,
      body: `Execute · tool-1 · ${statusLabel}`,
      provenance: [
        "tool-activity-1", "Activation tool-activation", "ProviderAttempt tool-attempt",
        "Retention durable",
      ],
    });
    expect(JSON.stringify(item)).not.toContain("synthetic-private");
    render(<LiveTimeline projection={data} loadingHistory={false} historyError={null}
      refreshError={null} refreshing={false} connection="live"
      onLoadEarlier={() => {}} onRefresh={() => {}} />);
    const row = screen.getByText(title).closest("li")!;
    expect(row).toHaveClass(`timeline-${tone}`);
    expect(within(row).getByText(`Execute · tool-1 · ${statusLabel}`)).toBeVisible();
    expect(within(row).getByText("Activity sequence 1")).toBeVisible();
    expect(row).toHaveTextContent("Activation tool-activation");
    expect(row).toHaveTextContent("ProviderAttempt tool-attempt");
    expect(row).not.toHaveTextContent("synthetic-private");
  });

  it.each([
    ["read", "Read"], ["edit", "Edit"], ["delete", "Delete"], ["move", "Move"],
    ["search", "Search"], ["execute", "Execute"], ["think", "Think"],
    ["fetch", "Fetch"], ["switch_mode", "Switch mode"], ["other", "Other"],
  ])("uses a stable human label for %s", (kind, label) => {
    const data = projection([{
      kind: "tool_started", payload: { toolCallId: "tool-128", kind, status: "in_progress" },
    }]);
    expect(timelineItems(data).find((item) => item.source === "RunActivityEvent")!.body)
      .toBe(`${label} · tool-128 · In progress`);
  });

  it.each(([
    { toolCallId: "synthetic-private-id", kind: "synthetic-private-kind", status: "synthetic-private-status" },
    { toolCallId: "tool-129", kind: "__proto__", status: "failed" },
    { toolCallId: "tool-01", kind: "constructor", status: "failed" },
    { toolCallId: 7, kind: null, status: false },
    null, [], "synthetic-private-payload",
  ] satisfies JsonValue[]).map((payload) => ({ payload })))(
    "never renders raw IDs or unrecognized payload fields: $payload", ({ payload }) => {
      const data = projection([{ kind: "tool_started", payload }]);
      expect(timelineItems(data).find((item) => item.source === "RunActivityEvent"))
        .toMatchObject({
          title: "Tool started", tone: "running", body: "Other · In progress",
        });
      expect(JSON.stringify(timelineItems(data))).not.toContain("synthetic-private");
    },
  );

  it("preserves activity sequence when clocks reverse and IDs repeat across ProviderAttempts", () => {
    const data = projection(phases.map(([kind, , , status]) => ({
      kind, payload: { toolCallId: "tool-1", kind: "execute", status },
    })));
    const secondAttempt = {
      ...data,
      activity: {
        ...data.activity,
        items: data.activity.items.map((event, index) => ({
          ...event, providerAttemptId: index === 2 ? "replacement-attempt" : "tool-attempt",
        })),
      },
    };
    const activities = timelineItems(secondAttempt).filter((item) => item.source === "RunActivityEvent");
    expect(activities.map((item) => item.kind)).toEqual(phases.map(([kind]) => kind));
    expect(activities[2]!.provenance).toContain("ProviderAttempt replacement-attempt");
    expect(secondAttempt.run.state).toBe("Active");
  });
});
