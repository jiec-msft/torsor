import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TorsorApp } from "./App";
import type { WebController, WebState } from "./controller";
import { RunComposerModel } from "./run-composer-model";
import { RunControlsModel } from "./run-controls-model";
import {
  agent,
  attention,
  bootstrap,
  runProjection,
  thread,
} from "./test/fixtures";
import styles from "./styles.css?raw";
import timelineStyles from "./timeline.css?raw";

function readyState(overrides: Partial<WebState> = {}): WebState {
  return {
    session: "ready",
    connection: "live",
    authError: null,
    bootstrap,
    threads: [thread],
    threadsChannelId: "channel-general",
    thread,
    runs: [runProjection],
    run: runProjection,
    agents: [agent],
    attentions: [attention],
    loadingThreads: false,
    loadingThread: false,
    loadingRun: false,
    loadingRunHistory: false,
    runHistoryError: null,
    runRefreshError: null,
    commandPending: false,
    queryError: null,
    lastEventId: "event-7",
    ...overrides,
  };
}

function stubController(state: WebState = readyState()) {
  const controller = {
    runComposer: new RunComposerModel(),
    runControls: new RunControlsModel({ getItem: () => null, setItem: () => {} }),
    principalId: "principal-human",
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    resume: vi.fn(async () => undefined),
    exchangeSession: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    loadThreads: vi.fn(async () => undefined),
    loadThread: vi.fn(async () => undefined),
    clearThread: vi.fn(),
    loadRun: vi.fn(async () => undefined),
    loadEarlierRunActivity: vi.fn(async () => true),
    clearRun: vi.fn(),
    startThread: vi.fn(
      (
        _input: Parameters<WebController["startThread"]>[0],
      ): Promise<void> => Promise.resolve(),
    ),
    replyToThread: vi.fn(
      (
        _input: Parameters<WebController["replyToThread"]>[0],
      ): Promise<void> => Promise.resolve(),
    ),
    editMessage: vi.fn(async () => ({ committed: true as const, refreshed: true })),
    deleteMessage: vi.fn(async () => ({ committed: true as const, refreshed: true })),
    updateAgentConfig: vi.fn(async () => ({ committed: true as const, refreshed: true })),
    adoptRunConfig: vi.fn(async () => ({ committed: true as const, refreshed: true })),
    dispose: vi.fn(),
  };
  return controller as unknown as WebController & typeof controller;
}

function mutableController(initialState: WebState) {
  let state = initialState;
  const listeners = new Set<() => void>();
  const controller = {
    runComposer: new RunComposerModel(),
    runControls: new RunControlsModel({ getItem: () => null, setItem: () => {} }),
    principalId: "principal-human",
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resume: vi.fn(async () => undefined),
    exchangeSession: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    loadThreads: vi.fn(async () => undefined),
    loadThread: vi.fn(async () => undefined),
    clearThread: vi.fn(),
    loadRun: vi.fn(async () => undefined),
    loadEarlierRunActivity: vi.fn(async () => true),
    clearRun: vi.fn(),
    startThread: vi.fn(
      (
        _input: Parameters<WebController["startThread"]>[0],
      ): Promise<void> => Promise.resolve(),
    ),
    replyToThread: vi.fn(
      (
        _input: Parameters<WebController["replyToThread"]>[0],
      ): Promise<void> => Promise.resolve(),
    ),
    editMessage: vi.fn(async () => ({ committed: true as const, refreshed: true })),
    deleteMessage: vi.fn(async () => ({ committed: true as const, refreshed: true })),
    updateAgentConfig: vi.fn(async () => ({ committed: true as const, refreshed: true })),
    adoptRunConfig: vi.fn(async () => ({ committed: true as const, refreshed: true })),
    dispose: vi.fn(),
    update(next: WebState) {
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
  return controller as unknown as WebController & typeof controller;
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1440,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 900,
  });
});

describe("TorsorApp", () => {
  it("exposes author-only Message revision controls and tombstone confirmation", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1",
    );
    const controller = stubController();
    render(<TorsorApp controller={controller} />);

    expect(screen.getAllByRole("button", { name: "Edit message" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Delete message" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Edit message" }));
    const editor = screen.getByLabelText("Revised message");
    await user.clear(editor);
    await user.type(editor, "A Human-authored revised message.");
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    expect(controller.editMessage).toHaveBeenCalledWith({
      messageId: "thread-1",
      threadRootId: "thread-1",
      expectedMessageRevision: 1,
      body: "A Human-authored revised message.",
      targetAgentIds: ["agent-orbit"],
    });

    await user.click(screen.getByRole("button", { name: "Delete message" }));
    expect(
      screen.getByText(/Revision history, Attention, and RunInput references remain/),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm tombstone" }));
    expect(controller.deleteMessage).toHaveBeenCalledWith({
      messageId: "thread-1",
      threadRootId: "thread-1",
      expectedMessageRevision: 1,
    });
    expect(screen.getAllByText(/Revision history/).length).toBeGreaterThan(0);
  });

  it("renders tombstones without Human mutation controls", () => {
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1",
    );
    const tombstoned = {
      ...thread,
      messages: thread.messages.map((message, index) =>
        index === 0
          ? {
              ...message,
              latestRevision: 2,
              targetAgentIds: [],
              revisions: [
                ...message.revisions,
                {
                  id: "revision-tombstone",
                  revision: 2,
                  body: "",
                  tombstone: true,
                  targetAgentIds: [],
                  createdAt: "2026-09-22T04:05:00.000Z",
                },
              ],
            }
          : message,
      ),
    };
    render(
      <TorsorApp
        controller={stubController(
          readyState({ thread: tombstoned, threads: [tombstoned] }),
        )}
      />,
    );
    expect(
      screen.getByText("Message deleted; immutable history retained."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete message" })).not.toBeInTheDocument();
  });

  it("exposes Agent config update and nonterminal Run adoption controls", async () => {
    const user = userEvent.setup();
    const newerAgent = { ...agent, configRevision: 4 };
    const state = readyState({ agents: [newerAgent] });
    const controller = stubController(state);
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&view=agents&channel=channel-general&thread=thread-1",
    );
    const rendered = render(<TorsorApp controller={controller} />);
    await user.click(screen.getByRole("button", { name: "Update config" }));
    const config = screen.getByLabelText("Non-secret Agent config JSON");
    fireEvent.change(config, { target: { value: '{"model":"synthetic-v2"}' } });
    await user.click(
      screen.getByRole("button", { name: "Create config revision" }),
    );
    expect(controller.updateAgentConfig).toHaveBeenCalledWith({
      agentId: "agent-orbit",
      expectedAgentConfigRevision: 4,
      config: { model: "synthetic-v2" },
    });

    rendered.unmount();
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail",
    );
    render(<TorsorApp controller={controller} />);
    expect(
      screen.getByText("Existing Activations remain pinned to their recorded configuration."),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Adopt current config" }),
    );
    expect(controller.adoptRunConfig).toHaveBeenCalledWith({
      runId: "run-1",
      threadRootId: "thread-1",
      expectedRunRevision: 2,
      expectedAgentConfigRevision: 4,
      targetAgentConfigRevision: 4,
    });
  });

  it("keeps the selected timeline mounted and focused during live refresh", () => {
    window.history.replaceState(
      {}, "", "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail",
    );
    const controller = mutableController(readyState());
    render(<TorsorApp controller={controller} />);
    const timeline = screen.getByRole("region", { name: "Live Agent Timeline" });
    timeline.focus();
    act(() => controller.update(readyState({ loadingRun: true })));
    expect(screen.getByRole("region", { name: "Live Agent Timeline" })).toBe(timeline);
    expect(timeline).toHaveFocus();
    expect(screen.queryByText("Loading atomic Run projection")).not.toBeInTheDocument();
  });

  it("does not let queued drawer focus steal the Human's timeline focus", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    let frame!: FrameRequestCallback;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 42;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    window.history.replaceState(
      {}, "", "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail",
    );
    const { unmount } = render(<TorsorApp controller={stubController()} />);
    const timeline = screen.getByRole("region", { name: "Live Agent Timeline" });
    timeline.focus();
    act(() => frame(0));
    expect(timeline).toHaveFocus();
    unmount();
    expect(cancel).toHaveBeenCalledWith(42);
  });

  it("keeps timeline history and disclosure controls reachable in a compact Run drawer", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 375 });
    window.history.replaceState(
      {}, "", "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail",
    );
    const controller = stubController(readyState({
      run: { ...runProjection, activity: { ...runProjection.activity, hasEarlier: true } },
    }));
    render(<><style>{styles}{timelineStyles}</style><TorsorApp controller={controller} /></>);
    const drawer = screen.getByRole("dialog", { name: "Status and detail" });
    await waitFor(() => expect(drawer).toHaveFocus());
    const diagnostics = within(drawer).getByText("Run diagnostics");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(drawer).getByRole("button", { name: "Refresh Run and Thread" })).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(within(drawer).getByRole("button", { name: "Collapse detail panel" })).toHaveFocus();
    await user.click(diagnostics);
    expect(diagnostics.parentElement).toHaveAttribute("open");
    await user.keyboard("{Tab}");
    expect(within(drawer).getByRole("button", { name: /Also published/ })).toHaveFocus();
    await user.click(within(drawer).getByRole("button", { name: "Load earlier activity" }));
    expect(controller.loadEarlierRunActivity).toHaveBeenCalledOnce();
    expect(getComputedStyle(drawer.querySelector(".run-detail")!).overflowY).toBe("auto");
    expect(getComputedStyle(within(drawer).getByRole("region", { name: "Live Agent Timeline" })).overflowY).toBe("auto");
  });

  it("restores thread, Run, and independent panel state from the URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail",
    );
    const controller = stubController();

    render(<TorsorApp controller={controller} />);

    await waitFor(() => {
      expect(controller.loadThread).toHaveBeenCalledWith("thread-1");
      expect(controller.loadRun).toHaveBeenCalledWith("run-1");
    });
    expect(
      screen.getByRole("button", { name: "Expand channels" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Provider attempts")).toBeInTheDocument();
  });

  it("navigates projections through URL-local state", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&panels=channels,detail",
    );
    render(<TorsorApp controller={stubController()} />);

    await user.click(screen.getByRole("button", { name: /^Activity/ }));

    expect(
      screen.getByRole("heading", { name: "Activity across threads" }),
    ).toBeInTheDocument();
    expect(window.location.search).toContain("view=activity");
  });

  it("preserves composer content and reports a command error", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&panels=channels,detail",
    );
    const controller = stubController();
    vi.mocked(controller.replyToThread).mockRejectedValueOnce(
      new Error("The thread revision changed. Reload and try again."),
    );
    render(<TorsorApp controller={controller} />);
    const composer = screen.getByLabelText("Reply to thread");

    await user.type(composer, "Keep this draft after failure.");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The thread revision changed",
    );
    expect(composer).toHaveValue("Keep this draft after failure.");
  });

  it("preserves an unsent reply draft during a background Thread refresh", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&panels=channels,detail",
    );
    const controller = mutableController(readyState());
    render(<TorsorApp controller={controller} />);
    const composer = screen.getByLabelText("Reply to thread");

    await user.type(composer, "Keep this draft while live facts refresh.");
    act(() => {
      controller.update(readyState({ loadingThread: true }));
    });

    expect(screen.getByLabelText("Reply to thread")).toBe(composer);
    expect(composer).toHaveValue("Keep this draft while live facts refresh.");
    expect(
      screen.queryByText("Loading atomic thread projection"),
    ).not.toBeInTheDocument();
  });

  it("recovers the original Start payload after lost response, 401, and reauthentication", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&panels=channels,detail",
    );
    const controller = mutableController(readyState());
    const calls: unknown[] = [];
    const durableOperations = new Set<string>();
    vi.mocked(controller.startThread).mockImplementation(async (input) => {
      calls.push(input);
      durableOperations.add(JSON.stringify(input));
      if (calls.length === 1) {
        throw new TypeError("The committed response was lost.");
      }
      if (calls.length === 2) {
        controller.update(
          readyState({
            session: "expired",
            connection: "offline",
            bootstrap: null,
            threads: [],
            threadsChannelId: null,
            thread: null,
            runs: [],
            run: null,
            agents: [],
            attentions: [],
            lastEventId: null,
          }),
        );
        throw new Error("Session expired.");
      }
    });
    vi.mocked(controller.exchangeSession).mockImplementation(async () => {
      controller.update(readyState({ thread: null, run: null }));
    });
    render(<TorsorApp controller={controller} />);

    const composer = screen.getByLabelText("Start a thread");
    const form = composer.closest("form")!;
    await user.type(composer, "Preserve this exact Start payload.");
    await user.selectOptions(within(form).getByLabelText("Notify"), "agent-orbit");
    await user.click(within(form).getByRole("button", { name: "Start" }));
    await screen.findByText("The committed response was lost.");

    await user.click(within(form).getByRole("button", { name: "Start" }));
    await screen.findByText(/The browser session expired or was revoked/);
    await user.type(
      screen.getByLabelText("Local bearer credential"),
      "replacement-secret",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    const recoveredComposer = await screen.findByLabelText("Start a thread");
    const recoveredForm = recoveredComposer.closest("form")!;
    expect(recoveredComposer).toHaveValue("Preserve this exact Start payload.");
    expect(within(recoveredForm).getByLabelText("Notify")).toHaveValue(
      "agent-orbit",
    );
    await user.click(
      within(recoveredForm).getByRole("button", { name: "Start" }),
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
    expect(durableOperations.size).toBe(1);
  });

  it("recovers the original Reply payload after lost response, 401, and reauthentication", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&panels=channels,detail",
    );
    const controller = mutableController(readyState());
    const calls: unknown[] = [];
    const durableOperations = new Set<string>();
    vi.mocked(controller.replyToThread).mockImplementation(async (input) => {
      calls.push(input);
      durableOperations.add(JSON.stringify(input));
      if (calls.length === 1) {
        throw new TypeError("The committed response was lost.");
      }
      if (calls.length === 2) {
        controller.update(
          readyState({
            session: "expired",
            connection: "offline",
            bootstrap: null,
            threads: [],
            threadsChannelId: null,
            thread: null,
            runs: [],
            run: null,
            agents: [],
            attentions: [],
            lastEventId: null,
          }),
        );
        throw new Error("Session expired.");
      }
    });
    vi.mocked(controller.exchangeSession).mockImplementation(async () => {
      controller.update(readyState());
    });
    render(<TorsorApp controller={controller} />);

    const composer = screen.getByLabelText("Reply to thread");
    const form = composer.closest("form")!;
    await user.type(composer, "Preserve this exact Reply payload.");
    await user.selectOptions(within(form).getByLabelText("Notify"), "agent-orbit");
    await user.click(within(form).getByRole("button", { name: "Reply" }));
    await screen.findByText("The committed response was lost.");

    await user.click(within(form).getByRole("button", { name: "Reply" }));
    await screen.findByText(/The browser session expired or was revoked/);
    await user.type(
      screen.getByLabelText("Local bearer credential"),
      "replacement-secret",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    const recoveredComposer = await screen.findByLabelText("Reply to thread");
    const recoveredForm = recoveredComposer.closest("form")!;
    expect(recoveredComposer).toHaveValue("Preserve this exact Reply payload.");
    expect(within(recoveredForm).getByLabelText("Notify")).toHaveValue(
      "agent-orbit",
    );
    await user.click(
      within(recoveredForm).getByRole("button", { name: "Reply" }),
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
    expect(durableOperations.size).toBe(1);
  });

  it.each([
    {
      name: "Start",
      route:
        "/?project=project-sample&channel=channel-general&panels=channels,detail",
      label: "Start a thread",
      button: "Start",
      method: "startThread" as const,
    },
    {
      name: "Reply",
      route:
        "/?project=project-sample&channel=channel-general&thread=thread-1&panels=channels,detail",
      label: "Reply to thread",
      button: "Reply",
      method: "replyToThread" as const,
    },
  ])("preserves later $name composer edits when send succeeds", async ({
    route,
    label,
    button,
    method,
  }) => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", route);
    const controller = mutableController(readyState());
    let resolveCommand!: () => void;
    const command = new Promise<void>((resolve) => {
      resolveCommand = resolve;
    });
    const holdCommand = async () => {
      controller.update(readyState({ commandPending: true }));
      await command;
      controller.update(readyState());
    };
    if (method === "startThread") {
      vi.mocked(controller.startThread).mockImplementationOnce(holdCommand);
    } else {
      vi.mocked(controller.replyToThread).mockImplementationOnce(holdCommand);
    }
    render(<TorsorApp controller={controller} />);

    const composer = screen.getByLabelText(label);
    const form = composer.closest("form")!;
    const notify = within(form).getByLabelText("Notify");
    await user.type(composer, "Submitted revision.");
    await user.selectOptions(notify, "agent-orbit");
    await user.click(within(form).getByRole("button", { name: button }));
    expect(
      within(form).getByRole("button", { name: button }),
    ).toBeDisabled();

    await user.clear(composer);
    await user.type(composer, "A later unsent revision.");
    await user.selectOptions(notify, "");
    await act(async () => resolveCommand());

    expect(composer).toHaveValue("A later unsent revision.");
    expect(notify).toHaveValue("");
  });

  it.each([
    {
      name: "Start",
      route:
        "/?project=project-sample&channel=channel-general&panels=channels,detail",
      label: "Start a thread",
      button: "Start",
      method: "startThread" as const,
    },
    {
      name: "Reply",
      route:
        "/?project=project-sample&channel=channel-general&thread=thread-1&panels=channels,detail",
      label: "Reply to thread",
      button: "Reply",
      method: "replyToThread" as const,
    },
  ])("keeps acknowledged $name content locked until refresh completion", async ({
    route,
    label,
    button,
    method,
  }) => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", route);
    const controller = mutableController(readyState());
    let resolveRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls === 1) {
        controller.update(readyState({ commandPending: true }));
        controller.update(
          readyState({
            ...(method === "replyToThread"
              ? { thread: { ...thread, cursor: 3 } }
              : {}),
          }),
        );
        await refresh;
      }
    };
    if (method === "startThread") {
      vi.mocked(controller.startThread).mockImplementation(send);
    } else {
      vi.mocked(controller.replyToThread).mockImplementation(send);
    }
    render(<TorsorApp controller={controller} />);

    const composer = screen.getByLabelText(label);
    const form = composer.closest("form")!;
    const submit = within(form).getByRole("button", { name: button });
    await user.type(composer, "Acknowledged content.");
    await user.click(submit);

    await waitFor(() => expect(submit).toBeDisabled());
    expect(composer).toHaveValue("Acknowledged content.");
    await user.click(submit);
    expect(calls).toBe(1);

    await act(async () => resolveRefresh());
    await waitFor(() => expect(composer).toHaveValue(""));
    await user.type(composer, "Later fresh content.");
    await user.click(submit);
    expect(calls).toBe(2);
  });

  it("shows authoritative Attention-only Agent activity", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&view=agents&channel=channel-general&thread=thread-1&panels=channels,detail",
    );
    const attentionOnly = {
      ...agent,
      liveRunActivationCount: 0,
      liveAttentionActivationCount: 1,
      liveActivationCount: 1,
      nonterminalRunCount: 0,
      status: "active" as const,
    };
    render(
      <TorsorApp
        controller={stubController(readyState({ agents: [attentionOnly] }))}
      />,
    );

    expect(screen.getByText("Attention-only")).toBeInTheDocument();
    expect(screen.getByText("Attention activation")).toBeInTheDocument();
  });

  it("expires a mounted Activation badge and time range from the clock", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-22T05:00:00.000Z"));
      window.history.replaceState(
        {},
        "",
        "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail",
      );

      render(<TorsorApp controller={stubController()} />);

      expect(screen.getByText("Live")).toBeInTheDocument();
      expect(screen.getByText(/→ live$/)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_001);
      });

      expect(screen.getByText("Expired")).toBeInTheDocument();
      expect(screen.queryByText(/→ live$/)).not.toBeInTheDocument();
      expect(screen.getByText(/→ expired /)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs expiry crossed between render and passive-effect setup", async () => {
    const expiresAt = Date.parse(runProjection.activations[0]!.expiresAt);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(expiresAt - 1)
      .mockReturnValue(expiresAt + 1);
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail",
    );

    render(<TorsorApp controller={stubController()} />);

    await waitFor(() =>
      expect(screen.getByText("Expired")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/→ live$/)).not.toBeInTheDocument();
    expect(screen.getByText(/→ expired /)).toBeInTheDocument();
  });

  it("collapses panels from the keyboard with explicit expanded state", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&panels=channels,detail",
    );
    render(<TorsorApp controller={stubController()} />);
    const collapse = screen.getByRole("button", {
      name: "Collapse channels",
      expanded: true,
    });

    collapse.focus();
    await user.keyboard("{Enter}");

    expect(
      screen.getByRole("button", { name: "Expand channels" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(new URLSearchParams(window.location.search).get("panels")).toBe(
      "detail",
    );
  });

  it("does not select a previous channel's thread while a new channel loads", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-second&panels=channels,detail",
    );
    const controller = stubController(
      readyState({
        bootstrap: {
          ...bootstrap,
          channels: [
            ...bootstrap.channels,
            {
              id: "channel-second",
              projectId: "project-sample",
              name: "second",
            },
          ],
        },
        threads: [thread],
        threadsChannelId: "channel-general",
        thread: null,
        run: null,
      }),
    );

    render(<TorsorApp controller={controller} />);

    await waitFor(() => {
      expect(controller.loadThreads).toHaveBeenCalledWith("channel-second");
    });
    expect(controller.loadThread).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get("thread")).toBeNull();
  });

  it("keeps a stale same-channel Thread list visible and navigable", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&panels=channels,detail",
    );
    render(
      <TorsorApp
        controller={stubController(
          readyState({
            thread: null,
            run: null,
            loadingThreads: true,
            queryError: "Thread list refresh failed.",
          }),
        )}
      />,
    );

    const threadButton = screen.getByRole("button", {
      name: /Inspect the synthetic release path/,
    });
    expect(threadButton).toBeInTheDocument();
    expect(screen.queryByText("Loading threads")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Thread list refresh failed",
    );

    await user.click(threadButton);
    expect(new URLSearchParams(window.location.search).get("thread")).toBe(
      "thread-1",
    );
  });

  it("reloads URL-selected projections after reauthentication", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail",
    );
    const controller = mutableController(readyState());
    render(<TorsorApp controller={controller} />);
    await waitFor(() => {
      expect(controller.loadThread).toHaveBeenCalledWith("thread-1");
      expect(controller.loadRun).toHaveBeenCalledWith("run-1");
    });
    vi.mocked(controller.loadThreads).mockClear();
    vi.mocked(controller.loadThread).mockClear();
    vi.mocked(controller.loadRun).mockClear();

    act(() => {
      controller.update(
        readyState({
          session: "expired",
          connection: "offline",
          bootstrap: null,
          threads: [],
          threadsChannelId: null,
          thread: null,
          runs: [],
          run: null,
          agents: [],
          attentions: [],
          lastEventId: null,
        }),
      );
    });
    act(() => {
      controller.update(
        readyState({
          threads: [],
          threadsChannelId: null,
          thread: null,
          run: null,
        }),
      );
    });

    await waitFor(() => {
      expect(controller.loadThreads).toHaveBeenCalledWith("channel-general");
      expect(controller.loadThread).toHaveBeenCalledWith("thread-1");
      expect(controller.loadRun).toHaveBeenCalledWith("run-1");
    });
  });

  it("re-bootstraps and resets projection loads when the URL Project changes", async () => {
    window.history.replaceState(
      {},
      "",
      "/?project=project-b&channel=channel-general&thread=thread-1&run=run-1&panel=run&panels=detail",
    );
    const projectB = {
      ...bootstrap,
      project: { ...bootstrap.project, id: "project-b", name: "Project B" },
      channels: bootstrap.channels.map((channel) => ({
        ...channel,
        projectId: "project-b",
      })),
    };
    const controller = stubController(readyState({ bootstrap: projectB }));
    render(<TorsorApp controller={controller} />);
    await waitFor(() => {
      expect(controller.resume).toHaveBeenCalledWith("project-b");
    });
    vi.mocked(controller.clearThread).mockClear();
    vi.mocked(controller.clearRun).mockClear();

    act(() => {
      window.history.pushState(
        {},
        "",
        "/?project=project-sample&channel=channel-general&thread=thread-1&panels=channels,detail",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(controller.resume).toHaveBeenLastCalledWith("project-sample");
      expect(controller.clearThread).toHaveBeenCalledTimes(1);
      expect(controller.clearRun).toHaveBeenCalledTimes(1);
    });
  });

  it("shows an explicit stale reconnecting state at narrow widths", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&thread=thread-1&panels=",
    );

    render(
      <TorsorApp
        controller={stubController(
          readyState({ connection: "reconnecting" }),
        )}
      />,
    );

    expect(screen.getAllByText("Stale · reconnecting")).not.toHaveLength(0);
  });

  it("keeps the authentication gate scrollable in a short landscape viewport", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 812,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 375,
    });
    render(
      <>
        <style>{styles}</style>
        <TorsorApp
          controller={stubController(
            readyState({
              session: "signed-out",
              connection: "offline",
              bootstrap: null,
              threads: [],
              threadsChannelId: null,
              thread: null,
              runs: [],
              run: null,
              agents: [],
              attentions: [],
              lastEventId: null,
            }),
          )}
        />
      </>,
    );

    const connect = screen.getByRole("button", { name: "Connect" });
    const gate = connect.closest(".session-screen");
    expect(gate).not.toBeNull();
    expect(getComputedStyle(gate!).overflowY).toBe("auto");
    expect(getComputedStyle(gate!).height).toBe("100dvh");
    expect(getComputedStyle(document.body).overflow).toBe("hidden");
    expect(gate).toContainElement(connect);
  });

  it("keeps Thread navigation and Start reachable in a short landscape drawer", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 812,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 375,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches:
          query.includes("max-width: 1099px") &&
          !query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    const controller = stubController(
      readyState({
        bootstrap: {
          ...bootstrap,
          channels: [
            ...bootstrap.channels,
            {
              id: "channel-design",
              projectId: "project-sample",
              name: "design",
            },
            {
              id: "channel-release",
              projectId: "project-sample",
              name: "release",
            },
          ],
        },
        thread: null,
        run: null,
      }),
    );
    window.history.replaceState(
      {},
      "",
      "/?project=project-sample&channel=channel-general&panels=",
    );
    render(<TorsorApp controller={controller} />);

    await user.click(
      screen.getByRole("button", { name: "Expand channels" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Channels and threads",
    });
    const threadButton = within(drawer).getByRole("button", {
      name: /Inspect the synthetic release path/,
    });
    const start = within(drawer).getByLabelText("Start a thread");
    expect(
      threadButton.compareDocumentPosition(start) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(styles).toMatch(
      /@media \(max-width: 1099px\) and \(max-height: 600px\)[\s\S]*?\.channels-panel \{[\s\S]*?overflow-y: auto;[\s\S]*?\.channels-panel \.thread-list \{[\s\S]*?overflow: visible;/,
    );

    await user.click(threadButton);
    expect(new URLSearchParams(window.location.search).get("thread")).toBe(
      "thread-1",
    );
    await user.click(
      screen.getByRole("button", { name: "Expand channels" }),
    );
    const reopenedDrawer = await screen.findByRole("dialog", {
      name: "Channels and threads",
    });
    const reopenedStart = within(reopenedDrawer).getByLabelText(
      "Start a thread",
    );
    await user.click(reopenedStart);
    await user.type(reopenedStart, "Reachable after Thread navigation.");
    expect(reopenedStart).toHaveValue("Reachable after Thread navigation.");
  });

  it.each([375, 768, 1024])(
    "keeps reduced-motion compact drawer focus contained at %ipx",
    async (width) => {
      const user = userEvent.setup();
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({
          matches:
            query.includes("prefers-reduced-motion") ||
            (query.includes("max-width: 1099px") && width <= 1099),
          media: query,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        }),
      });
      window.history.replaceState(
        {},
        "",
        "/?project=project-sample&channel=channel-general&thread=thread-1&panels=",
      );
      render(<TorsorApp controller={stubController()} />);
      const openChannels = screen.getByRole("button", {
        name: "Expand channels",
      });

      await user.click(openChannels);

      const drawer = await screen.findByRole("dialog", {
        name: "Channels and threads",
      });
      await waitFor(() => expect(drawer).toHaveFocus());
      expect(document.getElementById("main-content")).toHaveAttribute("inert");
      expect(
        screen.getByRole("button", { name: "Close open panels" }),
      ).toHaveAttribute("tabindex", "-1");

      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(drawer).toContainElement(document.activeElement as HTMLElement);
      await user.keyboard("{Tab}");
      expect(drawer).toContainElement(document.activeElement as HTMLElement);

      await user.keyboard("{Escape}");

      await waitFor(() => expect(openChannels).toHaveFocus());
      expect(document.getElementById("main-content")).not.toHaveAttribute(
        "inert",
      );
    },
  );
});
