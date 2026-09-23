import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TorsorApp } from "./App";
import { actions, controlHarness, humanProjection, rejected } from "./test/run-controls";

const harnesses: ReturnType<typeof controlHarness>[] = [];
afterEach(() => harnesses.splice(0).forEach(({ controller }) => controller.dispose()));
async function setup() {
  const harness = controlHarness();
  harnesses.push(harness);
  await harness.connect();
  window.history.replaceState({}, "", "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail");
  return harness;
}

describe.each(actions)("Rendered Human $name controls (MVP 44.2.1)", (action) => {
  it("supports keyboard activation, disables busy duplicates, and renders the refreshed Timeline", async () => {
    const harness = await setup();
    const user = userEvent.setup();
    render(<TorsorApp controller={harness.controller} />);
    const button = await screen.findByRole("button", { name: action.label });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAccessibleDescription();
    button.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(harness.controller.getSnapshot().run?.run.revision).toBe(3));
    const controls = screen.getByRole("region", { name: "Human Run controls" });
    expect(within(controls).getByRole("status")).toHaveTextContent(action.name === "cancel" ? "Logical cancellation committed" : "Input withdrawal committed");
    expect(screen.getByRole("region", { name: "Live Agent Timeline" })).toHaveTextContent(action.name === "cancel" ? "Cancelled" : "Withdrawn");
    if (action.name === "cancel") {
      expect(controls).toHaveTextContent("Physical stop and Worktree quarantine cannot be confirmed from this projection");
      expect(screen.getByRole("region", { name: "Live Agent Timeline" })).toHaveTextContent("Provider stop unconfirmed");
    }
    expect(harness.requests).toHaveLength(1);
  });

  it("keeps unknown recovery reachable through pane closure and prevents double activation", async () => {
    const harness = await setup();
    let release!: () => void;
    harness.setCommand(() => new Promise((_resolve, reject) => { release = () => reject(new TypeError("Synthetic loss")); }));
    const user = userEvent.setup();
    render(<TorsorApp controller={harness.controller} />);
    const button = await screen.findByRole("button", { name: action.label });
    await waitFor(() => expect(button).toBeEnabled());
    await user.dblClick(button);
    expect(harness.requests).toHaveLength(1);
    expect(button).toBeDisabled();
    expect(screen.getByRole("region", { name: "Human Run controls" })).toHaveAttribute("aria-busy", "true");
    await act(async () => { release(); });
    expect(screen.getByRole("region", { name: "Human Run controls" })).toHaveTextContent("Outcome unknown");
    await user.click(within(screen.getByRole("dialog", { name: "Status and detail" })).getByRole("button", { name: "Collapse detail panel" }));
    await user.click(screen.getByRole("button", { name: "Expand detail panel" }));
    const retry = await screen.findByRole("button", { name: /Retry same action/ });
    harness.setCommand(null);
    retry.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(harness.requests).toHaveLength(2));
    expect(harness.requests[1]!.body).toEqual(harness.requests[0]!.body);
  });

  it.each(["stale_revision", "conflict", "forbidden"])("reports %s without claiming a commit and requires refresh", async (code) => {
    const harness = await setup();
    harness.setCommand(async () => rejected(code, code === "forbidden" ? 403 : 409));
    const user = userEvent.setup();
    render(<TorsorApp controller={harness.controller} />);
    const button = await screen.findByRole("button", { name: action.label });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const controls = screen.getByRole("region", { name: "Human Run controls" });
    expect(within(controls).getByRole("alert")).toHaveTextContent("Action rejected");
    expect(within(controls).getByRole("alert")).toHaveTextContent(code);
    expect(button).toBeDisabled();
    expect(controls).toHaveTextContent("Refresh and review");
  });

  it.each(["unauthorized", "invalid_csrf_token"])("survives %s and the App session gate with the same identity", async (code) => {
    const harness = await setup();
    harness.setCommand(async () => rejected(code, code === "unauthorized" ? 401 : 403));
    const user = userEvent.setup();
    render(<TorsorApp controller={harness.controller} />);
    const button = await screen.findByRole("button", { name: action.label });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByRole("heading", { name: "Connect to Torsor" });
    expect(screen.getByText(/Run control recovery is retained/)).toBeInTheDocument();
    harness.setCommand(null);
    await user.type(screen.getByLabelText("Local bearer credential"), "synthetic-human");
    await user.click(screen.getByRole("button", { name: /Connect/ }));
    const retry = await screen.findByRole("button", { name: /Retry same action/ });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);
    expect(harness.requests[1]!.body).toEqual(harness.requests[0]!.body);
  });

  it.each(["run", "thread"] as const)("keeps acknowledged success through %s refresh failure and remount in a narrow modal", async (half) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const harness = await setup();
    const user = userEvent.setup();
    const view = render(<TorsorApp controller={harness.controller} />);
    const button = await screen.findByRole("button", { name: action.label });
    await waitFor(() => expect(button).toBeEnabled());
    harness.failReads(half);
    await user.click(button);
    let controls = screen.getByRole("region", { name: "Human Run controls" });
    expect(await within(controls).findByRole("alert")).toHaveTextContent("Committed; projections could not be refreshed");
    expect(controls.closest("[inert]")).toBeNull();
    view.unmount();
    render(<TorsorApp controller={harness.controller} />);
    controls = await screen.findByRole("region", { name: "Human Run controls" });
    expect(within(controls).getByRole("alert")).toHaveTextContent("Committed; projections could not be refreshed");
    harness.failReads(null);
    const refresh = within(controls).getByRole("button", { name: "Refresh controls and Timeline" });
    await waitFor(() => expect(refresh).toBeEnabled());
    refresh.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(controls).queryByRole("alert")).not.toBeInTheDocument());
    expect(refresh).toHaveFocus();
    expect(harness.requests).toHaveLength(1);
  });

  it("retains an acknowledged receipt after reload when the initial Run read fails", async () => {
    const harness = await setup();
    expect(await action.invoke(harness.controller)).toBe(true);
    harness.controller.dispose();
    const reopened = controlHarness(harness.storage);
    harnesses.push(reopened);
    reopened.failReads("run");
    await reopened.connect();
    render(<TorsorApp controller={reopened.controller} />);
    const controls = await screen.findByRole("region", { name: "Human Run controls" });
    expect(await within(controls).findByRole("alert")).toHaveTextContent("Committed; projections could not be refreshed");
    expect(within(controls).getByRole("status")).toHaveTextContent("committed");
    expect(reopened.requests).toHaveLength(0);
    reopened.failReads(null);
    const refresh = within(controls).getByRole("button", { name: "Refresh controls and Timeline" });
    await waitFor(() => expect(refresh).toBeEnabled());
    await userEvent.setup().click(refresh);
    await waitFor(() => expect(within(controls).queryByRole("alert")).not.toBeInTheDocument());
    expect(reopened.requests).toHaveLength(0);
  });
});

it("explains terminal and other-assigner eligibility without executable new controls", async () => {
  const harness = await setup();
  harness.setProjection({
    ...humanProjection, run: { ...humanProjection.run, state: "Cancelled" },
    inputs: [{ ...humanProjection.inputs[0]!, disposition: "Abandoned" }],
  });

  await harness.controller.loadRun("run-1");
  render(<TorsorApp controller={harness.controller} />);
  const controls = await screen.findByRole("region", { name: "Human Run controls" });
  await waitFor(() => expect(controls).toHaveTextContent("Cancelled"));
  expect(within(controls).queryByRole("button", { name: "Cancel Run" })).not.toBeInTheDocument();
  expect(within(controls).queryByRole("button", { name: /Withdraw Input/ })).not.toBeInTheDocument();
  expect(controls).toHaveTextContent("Abandoned");
  expect(harness.requests).toHaveLength(0);
  fireEvent.click(controls);
  expect(harness.requests).toHaveLength(0);
});

it("does not expose another Human's withdrawal and preserves the original-Human recovery explanation", async () => {
  const harness = await setup();
  harness.setCommand(async () => { throw new TypeError("Synthetic response loss"); });
  await harness.controller.withdrawRunInput("run-1", "run-input-1");
  harness.setPrincipal("principal-other");
  await harness.connect();
  render(<TorsorApp controller={harness.controller} />);
  const retry = await screen.findByRole("button", { name: /Retry same action/ });
  expect(retry).toBeDisabled();
  expect(screen.getByRole("region", { name: "Human Run controls" })).toHaveTextContent("Reconnect as the original Human");
  expect(screen.queryByRole("button", { name: /^Withdraw Input/ })).not.toBeInTheDocument();
});
