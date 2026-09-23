import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TorsorApp } from "./App";
import { runComposerHttp } from "./test/run-composer-http";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe("rendered collaboration recovery over production HTTP", () => {
  it("recovers one committed Message edit and Attention after 401 reauthentication", async () => {
    const user = userEvent.setup();
    const harness = await runComposerHttp({ pauseEvents: true });
    cleanup.push(() => harness.close());
    const editMessage = vi.spyOn(harness.controller, "editMessage");
    window.history.replaceState(
      {},
      "",
      `/?project=project-sample&channel=channel-general&thread=${harness.first.threadId}`,
    );
    render(<TorsorApp controller={harness.controller} />);

    await user.click(
      await screen.findByRole("button", { name: "Edit message" }),
    );
    const editor = screen.getByLabelText("Revised message");
    await user.clear(editor);
    await user.type(editor, "Recover this exact committed edit.");
    const lost = harness.browser.hold(
      "/api/v1/commands/edit-message",
      "response-loss",
    );
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    await lost.observed;
    lost.release();
    expect(
      await screen.findByText("Outcome unknown. Retry same edit."),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Retry same edit" }),
      ).toBeEnabled();
    });

    const committed = await harness.kernel.query(
      {
        type: "GetThreadProjection",
        threadRootId: harness.first.threadId,
      },
      { principalId: "principal-human" },
    );
    const root = committed.messages[0]!;
    expect(root.revisions).toHaveLength(2);
    expect(root.revisions[1]).toMatchObject({
      body: "Recover this exact committed edit.",
      targetAgentIds: ["agent-orbit"],
    });
    expect(
      committed.attentions.filter(
        (attention) =>
          attention.messageRevisionId === root.revisions[1]!.id,
      ),
    ).toHaveLength(1);

    harness.sources[0]!.close();
    await harness.sources[0]!.done;
    await harness.browser.revokeSession(harness.origin);
    expect(harness.controller.getSnapshot().session).toBe("ready");
    await user.click(screen.getByRole("button", { name: "Retry same edit" }));
    expect(
      await screen.findByText(/The browser session expired or was revoked/),
    ).toBeVisible();
    await waitFor(() => {
      expect(harness.controller.getSnapshot().commandPending).toBe(false);
    });
    await waitFor(() => {
      expect(editMessage).toHaveBeenCalledTimes(2);
      expect(
        harness.browser.requests.filter(
          (request) => request.path === "/api/v1/commands/edit-message",
        ),
      ).toHaveLength(2);
    });
    await user.type(
      screen.getByLabelText("Local bearer credential"),
      "synthetic-human",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText("Outcome unknown. Retry same edit."),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Retry same edit" }),
    );
    await waitFor(() => {
      expect(
        harness.browser.requests.filter(
          (request) => request.path === "/api/v1/commands/edit-message",
        ),
      ).toHaveLength(3);
    });
    await screen.findByText("Message revision committed.");

    const requests = harness.browser.requests.filter(
      (request) => request.path === "/api/v1/commands/edit-message",
    );
    expect(requests).toHaveLength(3);
    expect(requests[1]!.body).toBe(requests[0]!.body);
    expect(requests[2]!.body).toBe(requests[0]!.body);
    const recovered = await harness.kernel.query(
      {
        type: "GetThreadProjection",
        threadRootId: harness.first.threadId,
      },
      { principalId: "principal-human" },
    );
    expect(recovered.messages[0]!.revisions).toHaveLength(2);
    expect(
      recovered.attentions.filter(
        (attention) =>
          attention.messageRevisionId ===
          recovered.messages[0]!.revisions[1]!.id,
      ),
    ).toHaveLength(1);
  });

  it("recovers one committed Agent config revision after 401 reauthentication", async () => {
    const user = userEvent.setup();
    const harness = await runComposerHttp({ pauseEvents: true });
    cleanup.push(() => harness.close());
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&view=agents",
    );
    render(<TorsorApp controller={harness.controller} />);

    await user.click(
      await screen.findByRole("button", { name: "Update config" }),
    );
    const editor = screen.getByLabelText("Non-secret Agent config JSON");
    fireEvent.change(editor, {
      target: { value: '{"model":"recover-once"}' },
    });
    const lost = harness.browser.hold(
      "/api/v1/commands/update-agent-config",
      "response-loss",
    );
    await user.click(
      screen.getByRole("button", { name: "Create config revision" }),
    );
    await lost.observed;
    lost.release();
    expect(
      await screen.findByText("Outcome unknown. Retry same config update."),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Retry same config update" }),
      ).toBeEnabled();
    });

    harness.sources[0]!.close();
    await harness.sources[0]!.done;
    await harness.browser.revokeSession(harness.origin);
    expect(harness.controller.getSnapshot().session).toBe("ready");
    await user.click(
      screen.getByRole("button", { name: "Retry same config update" }),
    );
    expect(
      await screen.findByText(/The browser session expired or was revoked/),
    ).toBeVisible();
    await waitFor(() => {
      expect(harness.controller.getSnapshot().commandPending).toBe(false);
    });
    await user.type(
      screen.getByLabelText("Local bearer credential"),
      "synthetic-human",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText("Outcome unknown. Retry same config update."),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Retry same config update" }),
    );
    await screen.findByText("Agent config revision committed.");

    const requests = harness.browser.requests.filter(
      (request) =>
        request.path === "/api/v1/commands/update-agent-config",
    );
    expect(requests).toHaveLength(3);
    expect(requests[1]!.body).toBe(requests[0]!.body);
    expect(requests[2]!.body).toBe(requests[0]!.body);
    const projection = await harness.kernel.query(
      { type: "GetBootstrap", projectId: "project-sample" },
      { principalId: "principal-human" },
    );
    expect(
      projection.agents.find((candidate) => candidate.id === "agent-orbit"),
    ).toMatchObject({
      configRevision: 2,
      config: { model: "recover-once" },
    });
  });
});
