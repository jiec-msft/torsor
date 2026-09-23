import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TorsorApp } from "./App";
import { runComposerHttp } from "./test/run-composer-http";

const fixtures: Awaited<ReturnType<typeof runComposerHttp>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function setup() {
  const fixture = await runComposerHttp({ pauseEvents: true });
  fixtures.push(fixture);
  const { first } = fixture;
  window.history.replaceState({}, "", `/?project=project-sample&channel=channel-general&thread=${first.threadId}&run=${first.id}&panel=run&panels=detail`);
  return fixture;
}

describe("Human controls through production HTTP (MVP 44.2.1)", () => {
  it.each(["cancel", "withdraw"] as const)("recovers lost %s response after browser reload with one durable effect and no extra Message", async (kind) => {
    const fixture = await setup();
    const { controller, first, kernel, browser } = fixture;
    controller.runComposer.edit(first.id, "Synthetic Human assignment.");
    await controller.sendToRun(first.id);
    const input = controller.getSnapshot().run!.inputs.find((value) => value.assignedByPrincipalId === "principal-human")!;
    const before = controller.getSnapshot();
    const slug = kind === "cancel" ? "cancel-run" : "withdraw-run-input";
    const label = kind === "cancel" ? "Cancel Run" : `Withdraw Input ${input.sequence} (${input.id})`;
    const user = userEvent.setup();
    const view = render(<TorsorApp controller={controller} />);
    const button = await screen.findByRole("button", { name: label });
    await waitFor(() => expect(button).toBeEnabled());
    const loss = browser.hold(`/api/v1/commands/${slug}`, "response-loss");
    await user.click(button);
    await loss.observed;
    // Reload while the original request is still in flight, after its server commit.
    view.unmount();
    controller.dispose();
    const reopened = fixture.createController();
    render(<TorsorApp controller={reopened} />);
    const retry = await screen.findByRole("button", { name: /Retry same action/ });
    await waitFor(() => expect(reopened.getSnapshot().run?.run.id).toBe(first.id));
    await waitFor(() => expect(reopened.getSnapshot().loadingRun).toBe(false));
    await waitFor(() => expect(retry).toBeEnabled());
    expect(screen.getByRole("region", { name: "Human Run controls" })).toHaveTextContent("Outcome unknown");
    expect(browser.requests.filter((request) => request.path.endsWith(`/${slug}`))).toHaveLength(1);
    await act(async () => { loss.release(); });
    await user.click(retry);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Human Run controls" })).getByRole("status"))
      .toHaveTextContent(kind === "cancel" ? "Logical cancellation committed" : "Input withdrawal committed"));
    await waitFor(() => expect(reopened.getSnapshot().loadingRun).toBe(false));
    const requests = browser.requests.filter((request) => request.path.endsWith(`/${slug}`));
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).toBe(requests[0]!.body);
    expect(reopened.getSnapshot().run?.run.revision).toBe(before.run!.run.revision + 1);
    expect(reopened.getSnapshot().thread?.messages).toEqual(before.thread!.messages);
    expect(reopened.getSnapshot().run?.activity).toEqual(before.run!.activity);
    const events = await kernel.readEvents(null, 500);
    expect(events.filter((event) => event.type === (kind === "cancel" ? "RunCancelled" : "RunInputWithdrawn"))).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Live Agent Timeline" })).toHaveTextContent(kind === "cancel" ? "Cancelled" : "Withdrawn");
  });

  it("rejects a stale withdrawal when another request already settled the input, then exposes durable state", async () => {
    const { controller, first, kernel, browser } = await setup();
    controller.runComposer.edit(first.id, "Synthetic Human assignment.");
    await controller.sendToRun(first.id);
    const projection = controller.getSnapshot().run!;
    const input = projection.inputs.find((value) => value.assignedByPrincipalId === "principal-human")!;
    await kernel.execute({
      type: "WithdrawRunInput", idempotencyKey: "other-window-withdraw",
      runInputId: input.id, expectedRunRevision: projection.run.revision,
      expectedDispositionRevision: input.dispositionRevision, reason: "Withdrawn in another synthetic window.",
    }, { principalId: "principal-human" });
    expect(await controller.withdrawRunInput(first.id, input.id)).toBe(false);
    expect(await controller.withdrawRunInput(first.id, input.id)).toBe(false);
    await controller.refreshRunControls(first.id);
    expect(controller.getSnapshot().run?.inputs.find((value) => value.id === input.id)?.disposition).toBe("Withdrawn");
    expect(await controller.withdrawRunInput(first.id, input.id)).toBe(false);
    expect(browser.requests.filter((request) => request.path.endsWith("/withdraw-run-input"))).toHaveLength(1);
  });

  it.each(["StopRequested", "Uncertain", "StopConfirmed"] as const)(
    "cancels only logical work while physical state remains %s, without exposing unavailable evidence", async (physicalState) => {
      const fixture = await setup();
      const { controller, kernel, first } = fixture;
      await fixture.appendActivity(1);
      const runtime = { principalId: "principal-runtime" };
      const projection = await kernel.query({ type: "GetRunProjection", runId: first.id }, runtime);
      const activation = projection.activations.find((value) => value.runId === first.id)!;
      await kernel.execute({
        type: "RegisterPhysicalWorktree", idempotencyKey: "synthetic-register",
        worktreeId: "synthetic-tree", runId: first.id, repositoryId: "synthetic-repository",
        repositoryPath: "synthetic-repository", baseRevision: "a".repeat(40),
        directoryPath: "synthetic-worktree", directoryIdentity: "synthetic-directory",
      }, runtime);
      const lease = await kernel.execute({
        type: "AcquireWorktreeWriterLease", idempotencyKey: "synthetic-acquire",
        worktreeId: "synthetic-tree", leaseDurationMs: 300_000,
      }, runtime);
      const execution = await kernel.execute({
        type: "StartWorktreeExecution", idempotencyKey: "synthetic-execution",
        worktreeId: "synthetic-tree", activationId: activation.id, executorId: "synthetic-executor",
        generation: lease.leaseGeneration!, fencingToken: lease.fencingToken!, leaseToken: lease.leaseToken!,
      }, runtime);
      await kernel.execute({
        type: "RecordWorktreeExecution", idempotencyKey: "synthetic-state",
        executionId: execution.entityId, executorId: "synthetic-executor", executionToken: execution.executionToken!,
        state: physicalState, evidence: "Synthetic retained-handle evidence.",
      }, runtime);
      await controller.loadRun(first.id);
      const user = userEvent.setup();
      render(<TorsorApp controller={controller} />);
      const cancel = await screen.findByRole("button", { name: "Cancel Run" });
      await waitFor(() => expect(cancel).toBeEnabled());
      await user.click(cancel);
      await waitFor(() => expect(controller.getSnapshot().run?.run.state).toBe("Cancelled"));
      const controls = screen.getByRole("region", { name: "Human Run controls" });
      expect(controls).toHaveTextContent("Logical cancellation committed");
      expect(controls).toHaveTextContent("Physical stop and Worktree quarantine cannot be confirmed from this projection");
      expect(controls).not.toHaveTextContent("Synthetic retained-handle evidence");
      const tree = await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "synthetic-tree" }, runtime);
      expect(tree.latestExecution?.state).toBe(physicalState);
      expect(tree.state).toBe(physicalState === "Uncertain" ? "Quarantined" : "Ready");
    },
  );
});
