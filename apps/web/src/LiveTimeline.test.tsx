import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LiveTimeline } from "./LiveTimeline";
import { runProjection } from "./test/fixtures";
import type { RunProjection } from "./types";

function projection(first = 1, last = 3): RunProjection {
  const items = Array.from({ length: last - first + 1 }, (_, index) => ({
    ...runProjection.activity.items[0]!,
    id: `activity-${first + index}`,
    sequence: first + index,
    kind: index === 1 ? "status" : "agent_message_chunk",
    payload: index === 1 ? { status: "Inspecting", detail: "Public progress" } : { text: `<script>delta ${first + index}</script>` },
  }));
  return {
    ...runProjection,
    activity: { items, earliestSequence: first, latestSequence: last, hasEarlier: first > 1 },
  };
}

const defaults = {
  loadingHistory: false,
  historyError: null,
  refreshError: null,
  refreshing: false,
  connection: "live" as const,
  onLoadEarlier: vi.fn(),
  onRefresh: vi.fn(),
};

describe("Live Agent Timeline (MVP 35.3, 37, 44.1, 44.3)", () => {
  it("shows typed facts, sequence, time and provenance without interpreting unknown payloads", () => {
    const data = projection();
    render(<LiveTimeline {...defaults} projection={{
      ...data,
      activity: {
        ...data.activity,
        items: [...data.activity.items, {
          ...data.activity.items[0]!, id: "unknown", sequence: 4,
          kind: "future_private_format", payload: { reasoning: "MUST NOT DISPLAY" },
        }],
      },
    }} />);
    const region = screen.getByRole("region", { name: "Live Agent Timeline" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("<script>delta 1</script>")).toBeVisible();
    expect(region.querySelector("script")).toBeNull();
    expect(screen.getByText("Activity sequence 1")).toBeVisible();
    expect(screen.getByText("Public progress")).toBeVisible();
    expect(screen.getByText("Unknown activity")).toBeVisible();
    expect(screen.getByText("future_private_format")).toBeVisible();
    expect(screen.queryByText("MUST NOT DISPLAY")).not.toBeInTheDocument();
    expect(region.querySelector("time")).toHaveAttribute("datetime");
    expect(screen.getAllByText(/provider-1/).length).toBeGreaterThan(0);
    expect(screen.getByText("Input sequence 1")).toBeVisible();
    expect(screen.getByText("Pending")).toBeVisible();
    expect(screen.getByText("Running (Acknowledged)")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.queryByText("Run completed")).not.toBeInTheDocument();
  });

  it.each(["Completed", "Failed", "Cancelled"] as const)(
    "shows authoritative %s independently of Provider state",
    (state) => {
      render(<LiveTimeline {...defaults} projection={{
        ...projection(),
        run: { ...runProjection.run, state, revision: 4, terminalReason: "Synthetic terminal reason" },
      }} />);
      expect(screen.getByText(state)).toBeVisible();
      expect(screen.getByText("Run revision 4")).toBeVisible();
      expect(screen.getByText("Synthetic terminal reason")).toBeVisible();
      if (state === "Cancelled") {
        expect(screen.getByText("Provider stop unconfirmed")).toBeVisible();
      }
      expect(screen.getByText("Running (Acknowledged)")).toBeVisible();
    },
  );

  it("shows Provider failure or Unknown without claiming Run failure or completion", () => {
    const data = projection();
    const { rerender } = render(<LiveTimeline {...defaults} projection={{
      ...data,
      providerAttempts: [{ ...data.providerAttempts[0]!, status: "Failed", detail: "Synthetic provider error" }],
    }} />);
    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    rerender(<LiveTimeline {...defaults} projection={{
      ...data,
      providerAttempts: [{ ...data.providerAttempts[0]!, status: "Unknown" }],
    }} />);
    expect(screen.getByText("Unknown")).toBeVisible();
  });

  it("follows appends only at the bottom, anchors prepends, and explicitly returns to latest", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<LiveTimeline {...defaults} projection={projection(101, 103)} />);
    const region = screen.getByRole("region", { name: "Live Agent Timeline" });
    let height = 1000;
    let top = 800;
    Object.defineProperties(region, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 200)); } },
    });
    fireEvent.scroll(region);
    height = 1200;
    rerender(<LiveTimeline {...defaults} projection={projection(101, 104)} />);
    expect(top).toBe(1000);

    const anchor = within(region).getByText("Activity sequence 101").closest("li")!;
    let anchorPosition = 420;
    vi.spyOn(region, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => ({
      top: anchorPosition - top, bottom: anchorPosition - top + 80,
    } as DOMRect));
    top = 400;
    fireEvent.scroll(region);
    expect(screen.getByText("Reading history")).toBeVisible();
    height = 1300;
    rerender(<LiveTimeline {...defaults} projection={projection(101, 105)} />);
    expect(top).toBe(400);

    height = 1600;
    anchorPosition += 300;
    rerender(<LiveTimeline {...defaults} projection={projection(1, 105)} />);
    expect(top).toBe(700);
    await user.click(screen.getByRole("button", { name: "Back to latest" }));
    expect(top).toBe(1400);
    expect(screen.getByText("Following latest")).toBeVisible();
  });

  it("keeps history errors retryable, shows stale connectivity and resets on Run switch", async () => {
    const user = userEvent.setup();
    const load = vi.fn();
    const { rerender } = render(<LiveTimeline {...defaults} projection={projection(101, 200)}
      connection="reconnecting" historyError="History unavailable" onLoadEarlier={load} />);
    expect(screen.getByRole("alert")).toHaveTextContent("History unavailable");
    expect(screen.getByText(/Reconnecting/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry earlier activity" }));
    expect(load).toHaveBeenCalledOnce();
    expect(screen.getByText("Reading history")).toBeVisible();
    rerender(<LiveTimeline {...defaults} projection={{
      ...projection(), run: { ...runProjection.run, id: "run-2" },
    }} />);
    expect(screen.getByText("Following latest")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Activity sequence 101")).not.toBeInTheDocument();
  });

  it("shows a reconnect catch-up failure in the timeline with an explicit live retry", async () => {
    const refresh = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<LiveTimeline {...defaults} projection={projection()}
      refreshError="Live history unavailable" onRefresh={refresh} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Live history unavailable");
    await user.click(screen.getByRole("button", { name: "Retry live activity" }));
    expect(refresh).toHaveBeenCalledOnce();
    rerender(<LiveTimeline {...defaults} projection={projection()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
