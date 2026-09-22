import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TorsorApp } from "./App";
import { runComposerHttp } from "./test/run-composer-http";

const fixtures: Awaited<ReturnType<typeof runComposerHttp>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe("Run Composer committed refresh recovery in a narrow modal (§44.2)", () => {
  it("restores an enabled nonempty Composer after a Reply supersedes only the paired Thread read", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const fixture = await runComposerHttp();
    fixtures.push(fixture);
    const { controller, browser, first } = fixture;
    window.history.replaceState({}, "", `/?project=project-sample&channel=channel-general&thread=${first.threadId}&run=${first.id}&panel=run&panels=detail`);
    const user = userEvent.setup();
    render(<TorsorApp controller={controller} />);
    await user.type(await screen.findByLabelText("Run input"), "Keep this unsent draft.");
    await waitFor(() => expect(controller.getSnapshot().loadingRun).toBe(false));
    const older = browser.hold(`/api/v1/runs/${first.id}`);
    let single!: Promise<boolean>;
    await act(async () => {
      single = controller.loadRun(first.id);
      await older.observed;
    });
    const paired = browser.hold(`/api/v1/runs/${first.id}`);
    await user.click(screen.getByRole("button", { name: "Refresh Run and Thread" }));
    await paired.observed;
    await act(async () => { await fixture.reply("An ordinary concurrent Reply."); });
    await waitFor(() => {
      expect(controller.getSnapshot().thread?.messages).toHaveLength(2);
      expect(controller.getSnapshot().loadingThread).toBe(false);
    });
    await act(async () => {
      older.release();
      paired.release();
      await single;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send to Run" })).toBeEnabled());
    expect(screen.queryByText("Loading atomic Run projection")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Run input")).toHaveValue("Keep this unsent draft.");
    expect(controller.getSnapshot().queryError).toBeNull();
  });

  it.each(["run", "thread"] as const)("keeps commit success and exposes a %s read failure inside the 375px modal", async (half) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const fixture = await runComposerHttp();
    fixtures.push(fixture);
    const { controller, browser, first, sources } = fixture;
    sources[0]!.paused = true;
    window.history.replaceState({}, "", `/?project=project-sample&channel=channel-general&thread=${first.threadId}&run=${first.id}&panel=run&panels=detail`);
    const user = userEvent.setup();
    const view = render(<TorsorApp controller={controller} />);
    await user.type(await screen.findByLabelText("Run input"), "One durable Human instruction.");
    await waitFor(() => expect(controller.getSnapshot().loadingRun).toBe(false));
    for (const source of sources) source.paused = true;
    const failed = browser.hold(half === "run" ? `/api/v1/runs/${first.id}` : `/api/v1/threads/${first.threadId}`, true);
    await user.click(screen.getByRole("button", { name: "Send to Run" }));
    await failed.observed;
    const dialog = screen.getByRole("dialog", { name: "Status and detail" });
    const destination = within(dialog).getByRole("button", { name: /Also published/ });
    destination.focus();
    await act(async () => { failed.release(); });
    const warning = await within(dialog).findByRole("alert");
    expect(warning).toHaveTextContent("Committed; projections could not be refreshed");
    expect(warning.closest("[inert]")).toBeNull();
    expect(document.querySelector("main.primary-surface")).toHaveAttribute("inert");
    expect(destination).toHaveFocus();
    expect(within(dialog).queryByRole("button", { name: "Retry same submission" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Run input")).toHaveValue("");
    const command = browser.requests.find((request) => request.path.endsWith("/send-to-run"))!;
    const committed = controller.runComposer.getSnapshot()[first.id]!;
    expect(committed.status).toBe("submitted");
    expect(committed.request).toBeNull();
    expect(committed.acknowledged?.request).toEqual(JSON.parse(command.body!));
    view.unmount();
    render(<TorsorApp controller={controller} />);
    const reopened = await screen.findByRole("dialog", { name: "Status and detail" });
    expect(within(reopened).getByRole("alert")).toHaveTextContent("Committed; projections could not be refreshed");
    await waitFor(() => expect(controller.getSnapshot().loadingRun).toBe(false));
    const refresh = within(reopened).getByRole("button", { name: "Refresh Run and Thread" });
    expect(refresh).toBeEnabled();
    refresh.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument());
    expect(refresh).toHaveFocus();
    expect(controller.getSnapshot().thread?.messages).toHaveLength(2);
    expect(controller.getSnapshot().run?.inputs).toHaveLength(2);
    expect(controller.runComposer.getSnapshot()[first.id]?.acknowledged).toEqual(committed.acknowledged);
    expect(browser.requests.filter((request) => request.path.endsWith("/send-to-run"))).toHaveLength(1);
  });
});
