import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TorsorApp } from "./App";
import { runComposerHttp } from "./test/run-composer-http";

const fixtures: Awaited<ReturnType<typeof runComposerHttp>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe("mounted Timeline and Composer over HTTP (§37.3, §44.1–44.2)", () => {
  it("keeps reading position and focus through history backfill and an acknowledged paired refresh", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const fixture = await runComposerHttp({ pauseEvents: true });
    fixtures.push(fixture);
    const { controller, browser, first } = fixture;
    await fixture.appendActivity(150);
    window.history.replaceState({}, "", `/?project=project-sample&channel=channel-general&thread=${first.threadId}&run=${first.id}&panel=run&panels=detail`);
    const user = userEvent.setup();
    render(<TorsorApp controller={controller} />);
    const body = await screen.findByLabelText("Run input");
    await waitFor(() => expect(controller.getSnapshot().loadingRun).toBe(false));
    const region = screen.getByRole("region", { name: "Live Agent Timeline" });
    const anchor = within(region).getByText("Activity sequence 51").closest("li")!;
    const addedHeight = () => {
      const projection = controller.getSnapshot().run!;
      return (51 - projection.activity.earliestSequence!) * 3 + (projection.inputs.length - 1) * 40;
    };
    let top = 200;
    Object.defineProperties(region, {
      scrollHeight: { configurable: true, get: () => 1000 + addedHeight() },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => {
        top = Math.max(0, Math.min(value, region.scrollHeight - region.clientHeight));
      } },
    });
    vi.spyOn(region, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => ({
      top: 220 + addedHeight() - top, bottom: 300 + addedHeight() - top,
    } as DOMRect));
    fireEvent.scroll(region);
    expect(screen.getByText("Reading history")).toBeVisible();
    await user.type(body, "Keep the Human's reading position.");
    const thread = browser.hold(`/api/v1/threads/${first.threadId}`);
    await user.click(screen.getByRole("button", { name: "Send to Run" }));
    await thread.observed;
    expect(screen.getByRole("region", { name: "Live Agent Timeline" })).toBe(region);
    expect(controller.getSnapshot().loadingRun).toBe(true);
    await user.click(screen.getByRole("button", { name: "Load earlier activity" }));
    await waitFor(() => expect(controller.getSnapshot().run!.activity.items).toHaveLength(150));
    expect(top).toBe(350);
    body.focus();
    await act(async () => { thread.release(); });
    await waitFor(() => expect(controller.getSnapshot().run!.inputs).toHaveLength(2));
    expect(screen.getByRole("region", { name: "Live Agent Timeline" })).toBe(region);
    expect(top).toBe(390);
    expect(body).toHaveFocus();
    expect(body).toHaveValue("");
    expect(screen.getByText("Reading history")).toBeVisible();
    expect(controller.getSnapshot().run!.activity.items).toHaveLength(150);
    await user.click(screen.getByRole("button", { name: "Back to latest" }));
    expect(top).toBe(region.scrollHeight - region.clientHeight);
    expect(screen.getByText("Following latest")).toBeVisible();
    expect(browser.requests.filter((request) => request.path.endsWith("/send-to-run"))).toHaveLength(1);
  });
});
