import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TorsorApp } from "./App";
import type { WebController, WebState } from "./controller";
import {
  agent,
  attention,
  bootstrap,
  runProjection,
  thread,
} from "./test/fixtures";

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
    commandPending: false,
    queryError: null,
    lastEventId: "event-7",
    ...overrides,
  };
}

function stubController(state: WebState = readyState()) {
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    resume: vi.fn(async () => undefined),
    exchangeSession: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    loadThreads: vi.fn(async () => undefined),
    loadThread: vi.fn(async () => undefined),
    clearThread: vi.fn(),
    loadRun: vi.fn(async () => undefined),
    clearRun: vi.fn(),
    startThread: vi.fn(async () => undefined),
    replyToThread: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  return controller as unknown as WebController & typeof controller;
}

function mutableController(initialState: WebState) {
  let state = initialState;
  const listeners = new Set<() => void>();
  const controller = {
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
    clearRun: vi.fn(),
    startThread: vi.fn(async () => undefined),
    replyToThread: vi.fn(async () => undefined),
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
});

describe("TorsorApp", () => {
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

  it("moves focus into compact drawers, makes the workbench inert, and restores focus", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
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

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(drawer).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(openChannels).toHaveFocus());
    expect(document.getElementById("main-content")).not.toHaveAttribute(
      "inert",
    );
  });
});
