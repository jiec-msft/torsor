import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";

import { WebController } from "./controller";
import { RunComposer } from "./RunComposer";
import { TorsorApp } from "./App";
import composerStyles from "./run-composer.css?raw";
import { agent, bootstrap, runProjection, thread } from "./test/fixtures";
import type { RunProjection } from "./types";

const controllers: WebController[] = [];
afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

async function setup(command: () => Promise<Response> = async () => json({
  result: {
    commandType: "SendToRun", entityId: "message-new", revision: 3, threadCursor: 4,
    relatedIds: { runId: "run-1", messageRevisionId: "revision-new", runInputId: "input-new" },
  },
})) {
  const requests: Array<Record<string, unknown>> = [];
  let projection: RunProjection = runProjection;
  const controller = new WebController({
    sessionStorage: window.sessionStorage,
    eventSourceFactory: (url) => Object.assign(new EventTarget(), {
      close: vi.fn(), url, withCredentials: true, readyState: 0,
      onerror: null, onmessage: null, onopen: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      CONNECTING: 0 as const, OPEN: 1 as const, CLOSED: 2 as const,
    }),
    broadcastChannelFactory: (name) => Object.assign(new EventTarget(), {
      name, onmessage: null, onmessageerror: null, close: vi.fn(), postMessage: vi.fn(),
    }),
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/session")) {
        return json({ authenticated: true, principalId: "principal-human", csrfToken: "csrf-synthetic" });
      }
      if (url.includes("/commands/")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return command();
      }
      if (url.includes("/bootstrap")) return json({ bootstrap });
      if (url.includes("/agents")) return json({ items: [agent] });
      if (url.includes("/attentions")) return json({ items: [], hasMore: false });
      if (url.includes("/projects/") && url.includes("/runs")) return json({ items: [projection], hasMore: false });
      if (url.includes("/runs/")) return json({ run: projection });
      if (url.includes("/channels/") && url.includes("/threads")) {
        return json({ items: [thread], hasMore: false });
      }
      if (url.includes("/threads/")) return json({ thread });
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  controllers.push(controller);
  await controller.exchangeSession("synthetic-token", "project-sample");
  await controller.loadThread("thread-1");
  await controller.loadRun("run-1");
  const onOpenThread = vi.fn();
  function Surface({ runId = "run-1" }: { readonly runId?: string }) {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return <RunComposer controller={controller} state={state} runId={runId} onOpenThread={onOpenThread} />;
  }
  return { controller, requests, Surface, onOpenThread, setProjection: (next: RunProjection) => { projection = next; } };
}

describe("Run Composer public UI and controller (§36, §44.2)", () => {
  it("preserves the frozen draft through the real App session gate and reauthentication", async () => {
    let calls = 0;
    const harness = await setup(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Lost response.");
      if (calls === 2) return json({ error: { code: "unauthorized", message: "Session expired." } }, 401);
      return json({
        result: {
          commandType: "SendToRun", entityId: "message-new", revision: 3, threadCursor: 4,
          relatedIds: { runId: "run-1", messageRevisionId: "revision-new", runInputId: "input-new" },
        },
      });
    });
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail");
    render(<TorsorApp controller={harness.controller} />);
    await user.type(await screen.findByLabelText("Run input"), "Retain this uncertain instruction.");
    await user.click(screen.getByRole("button", { name: "Send to Run" }));
    await user.click(screen.getByRole("button", { name: "Retry same submission" }));
    expect(await screen.findByRole("heading", { name: "Connect to Torsor" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("A lost response may have committed");
    harness.setProjection({ ...runProjection, run: { ...runProjection.run, revision: 8 } });
    await user.type(screen.getByLabelText("Local bearer credential"), "synthetic-token");
    await user.click(screen.getByRole("button", { name: /Connect/ }));
    expect(await screen.findByLabelText("Run input")).toHaveValue("Retain this uncertain instruction.");
    expect(screen.getByText(/Submission outcome unknown/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry same submission" }));
    await waitFor(() => expect(screen.getByLabelText("Run input")).toHaveValue(""));
    expect(harness.requests).toHaveLength(3);
    expect(harness.requests[1]).toEqual(harness.requests[0]);
    expect(harness.requests[2]).toEqual(harness.requests[0]);
  });

  it("is wired into the Run pane and keeps a draft through panel closure", async () => {
    const harness = await setup();
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail");
    render(<TorsorApp controller={harness.controller} />);
    await user.type(await screen.findByLabelText("Run input"), "Keep this pane draft.");
    await user.click(within(screen.getByRole("dialog", { name: "Status and detail" })).getByRole("button", { name: "Collapse detail panel" }));
    await user.click(screen.getByRole("button", { name: "Expand detail panel" }));
    expect(screen.getByLabelText("Run input")).toHaveValue("Keep this pane draft.");
    await user.click(screen.getByRole("button", { name: /#general.*thread-1/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Status and detail" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("Reply to thread")).toBeInTheDocument();
  });

  it("does not submit during IME composition and leaves focus with the Human after completion", async () => {
    let release!: (response: Response) => void;
    const harness = await setup(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    render(<harness.Surface />);
    const body = screen.getByLabelText("Run input");
    await user.type(body, "Compose an instruction.");
    fireEvent.keyDown(body, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(harness.requests).toHaveLength(0);
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    const destination = screen.getByRole("button", { name: /#general.*thread-1/ });
    destination.focus();
    await act(async () => release(json({
      result: {
        commandType: "SendToRun", entityId: "message-new", revision: 3, threadCursor: 4,
        relatedIds: { runId: "run-1", messageRevisionId: "revision-new", runInputId: "input-new" },
      },
    })));
    expect(destination).toHaveFocus();
  });

  it("keeps late results and drafts scoped to their selected Run", async () => {
    let release!: (response: Response) => void;
    const harness = await setup(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    const view = render(<harness.Surface />);
    await user.type(screen.getByLabelText("Run input"), "Run one instruction.");
    await user.click(screen.getByRole("button", { name: "Send to Run" }));
    harness.setProjection({ ...runProjection, run: { ...runProjection.run, id: "run-2" } });
    await act(async () => { await harness.controller.loadRun("run-2"); });
    view.rerender(<harness.Surface runId="run-2" />);
    const body = screen.getByLabelText("Run input");
    await user.type(body, "Run two draft.");
    await act(async () => release(json({
      result: {
        commandType: "SendToRun", entityId: "message-new", revision: 3, threadCursor: 4,
        relatedIds: { runId: "run-1", messageRevisionId: "revision-new", runInputId: "input-new" },
      },
    })));
    expect(body).toHaveValue("Run two draft.");
    expect(body).toHaveFocus();
    expect(harness.controller.getSnapshot().run?.run.id).toBe("run-2");
    expect(harness.controller.runComposer.getSnapshot()["run-1"]?.status).toBe("submitted");
    expect(harness.requests).toHaveLength(1);
  });

  it("retains accessible destinations and wrapping, scrollable actions at narrow widths", async () => {
    const harness = await setup();
    render(<harness.Surface />);
    expect(screen.getByLabelText("Run input")).toHaveAccessibleDescription(/Thread thread-1/);
    expect(composerStyles).toMatch(/overflow-wrap: anywhere/);
    expect(composerStyles).toMatch(/overflow-y: auto/);
    expect(composerStyles).toMatch(/flex-wrap: wrap/);
    expect(composerStyles).toMatch(/@media \(max-width: 600px\)/);
    expect(composerStyles).not.toMatch(/outline:\s*(0|none)/);
  });

  it("shows the public destination, submits once from the keyboard, and distinguishes commit from delivery", async () => {
    let release!: (response: Response) => void;
    const harness = await setup(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    render(<harness.Surface />);
    expect(screen.getByText(/Orbit.*agent-orbit/)).toBeInTheDocument();
    expect(screen.getByText(/Run run-1/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /#general.*thread-1/ }));
    expect(harness.onOpenThread).toHaveBeenCalledWith("thread-1", "channel-general");
    const body = screen.getByLabelText("Run input");
    await user.type(body, "Public instruction{Enter}Second line");
    expect(harness.requests).toHaveLength(0);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.getByRole("status")).toHaveTextContent("Submitting");
    expect(body).toHaveAttribute("readonly");
    fireEvent.submit(screen.getByRole("form", { name: "Send to Run" }));
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      runId: "run-1", expectedRunRevision: 2, body: "Public instruction\nSecond line",
    });
    await act(async () => release(json({
      result: {
        commandType: "SendToRun", entityId: "message-new", revision: 3, threadCursor: 4,
        relatedIds: { runId: "run-1", messageRevisionId: "revision-new", runInputId: "input-new" },
      },
    })));
    expect(screen.getByRole("status")).toHaveTextContent("Message and RunInput committed");
    expect(body).toHaveValue("");
    expect(screen.getByText(/Real-time delivery is not guaranteed/)).toBeInTheDocument();
  });

  it("keeps the original body and key after loss, remount, and a changed Run revision", async () => {
    const harness = await setup(async () => { throw new TypeError("Connection lost."); });
    const user = userEvent.setup();
    const view = render(<harness.Surface />);
    await user.type(screen.getByLabelText("Run input"), "Recover exactly this.");
    await user.click(screen.getByRole("button", { name: "Send to Run" }));
    expect(screen.getByRole("status")).toHaveTextContent("Submission outcome unknown");
    expect(screen.queryByText(/Not submitted/)).not.toBeInTheDocument();
    view.unmount();
    harness.setProjection({ ...runProjection, run: { ...runProjection.run, revision: 8, state: "Completed" } });
    await act(async () => { await harness.controller.loadRun("run-1"); });
    render(<harness.Surface />);
    expect(screen.getByLabelText("Run input")).toHaveValue("Recover exactly this.");
    await user.click(screen.getByRole("button", { name: "Retry same submission" }));
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]).toEqual(harness.requests[0]);
  });

  it("requires refresh after definite conflict and preserves an editable draft", async () => {
    const harness = await setup(async () => json({
      error: { code: "stale_revision", message: "Run revision changed.", requestId: "request-conflict" },
    }, 409));
    const user = userEvent.setup();
    render(<harness.Surface />);
    await user.type(screen.getByLabelText("Run input"), "Keep my draft.");
    await user.click(screen.getByRole("button", { name: "Send to Run" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Neither Message nor RunInput committed");
    expect(screen.getByLabelText("Run input")).toHaveValue("Keep my draft.");
    expect(screen.getByRole("button", { name: "Send to Run" })).toBeDisabled();
    harness.setProjection({ ...runProjection, run: { ...runProjection.run, revision: 3 } });
    await user.click(screen.getByRole("button", { name: "Refresh Run and Thread" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send to Run" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send to Run" }));
    expect(harness.requests[1]?.expectedRunRevision).toBe(3);
    expect(harness.requests[1]?.idempotencyKey).not.toBe(harness.requests[0]?.idempotencyKey);
  });

  it("explains terminal and missing Run capability without redirecting a send to Reply", async () => {
    const harness = await setup();
    harness.setProjection({ ...runProjection, run: { ...runProjection.run, state: "Cancelled" } });
    await harness.controller.loadRun("run-1");
    const view = render(<harness.Surface />);
    expect(screen.getByText(/Successor creation is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to Run" })).toBeDisabled();
    view.rerender(<harness.Surface runId="run-other" />);
    expect(screen.getByText(/Waiting for the selected Run/)).toBeInTheDocument();
    expect(harness.requests).toHaveLength(0);
  });
});
