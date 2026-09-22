import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WebController } from "./controller";
import type { PublicEvent } from "./types";
import {
  agent,
  attention,
  bootstrap,
  runProjection,
  thread,
} from "./test/fixtures";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function"
        ? listener
        : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  emit(event: PublicEvent): void {
    const message = new MessageEvent("torsor", {
      data: JSON.stringify(event),
      lastEventId: event.eventId,
    });
    for (const listener of this.listeners.get("torsor") ?? []) {
      listener(message);
    }
  }
}

class FakeBroadcastChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  posted: unknown[] = [];
  closed = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  receive(message: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: message }));
  }

  close(): void {
    this.closed = true;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness(
  options: {
    expireThread?: boolean;
    csrfToken?: string;
    principalId?: string;
    threadResponse?: (url: string) => Promise<Response>;
    commandResponse?: (
      callNumber: number,
      init?: RequestInit,
    ) => Promise<Response>;
    bootstrapResponse?: () => Promise<Response>;
  } = {},
) {
  FakeEventSource.instances = [];
  const storage = new MemoryStorage();
  const broadcasts: FakeBroadcastChannel[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const counts = {
    bootstrap: 0,
    threads: 0,
    thread: 0,
    runs: 0,
    run: 0,
    agents: 0,
    attentions: 0,
    commands: 0,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/api/v1/session") && init?.method === "POST") {
      return json(
        {
          authenticated: true,
          principalId: options.principalId ?? "principal-human",
          csrfToken: options.csrfToken ?? "csrf-window-token",
        },
        201,
      );
    }
    if (url.includes("/bootstrap")) {
      counts.bootstrap += 1;
      if (options.bootstrapResponse) {
        return options.bootstrapResponse();
      }
      return json({ bootstrap });
    }
    if (url.includes("/channels/channel-general/threads")) {
      counts.threads += 1;
      return json({
        items: [thread],
        nextCursor: null,
        hasMore: false,
        snapshotEventId: "event-7",
      });
    }
    if (url.includes("/api/v1/threads/")) {
      counts.thread += 1;
      if (options.threadResponse) {
        return options.threadResponse(url);
      }
      if (options.expireThread) {
        return json(
          { error: { code: "unauthorized", message: "Session expired." } },
          401,
        );
      }
      return json({ thread });
    }
    if (url.includes("/projects/project-sample/runs")) {
      counts.runs += 1;
      return json({
        items: [runProjection],
        nextCursor: null,
        hasMore: false,
        snapshotEventId: "event-7",
      });
    }
    if (url.endsWith("/runs/run-1")) {
      counts.run += 1;
      return json({ run: runProjection });
    }
    if (url.endsWith("/projects/project-sample/agents")) {
      counts.agents += 1;
      return json({ items: [agent] });
    }
    if (url.includes("/projects/project-sample/attentions")) {
      counts.attentions += 1;
      return json({
        items: [attention],
        nextCursor: null,
        hasMore: false,
        snapshotEventId: "event-7",
      });
    }
    if (url.includes("/commands/")) {
      counts.commands += 1;
      if (options.commandResponse) {
        return options.commandResponse(counts.commands, init);
      }
      return json({ result: { entityId: "message-new" } });
    }
    if (url.endsWith("/api/v1/session") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  const controller = new WebController({
    fetch: fetchMock as typeof fetch,
    sessionStorage: storage,
    eventSourceFactory: (url) =>
      new FakeEventSource(url) as unknown as EventSource,
    broadcastChannelFactory: () => {
      const channel = new FakeBroadcastChannel();
      broadcasts.push(channel);
      return channel as unknown as BroadcastChannel;
    },
    reconnectProbeDelayMs: 5,
  });
  return { controller, storage, calls, counts, broadcasts };
}

function publicEvent(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    eventId: "event-8",
    type: "MessagePublished",
    projectId: "project-sample",
    channelId: "channel-general",
    threadRootId: "thread-1",
    threadCursor: 3,
    entityType: "Message",
    entityId: "message-3",
    actorPrincipalId: "principal-human",
    activationId: null,
    causationId: null,
    correlationId: "correlation-1",
    payload: {},
    occurredAt: "2026-09-22T04:03:00.000Z",
    ...overrides,
  };
}

describe("WebController", () => {
  it("binds the browser fetch receiver when no custom transport is supplied", async () => {
    FakeEventSource.instances = [];
    const storage = new MemoryStorage();
    const nativeLikeFetch = vi.fn(function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      const url = String(input);
      if (url.endsWith("/api/v1/session") && init?.method === "POST") {
        return Promise.resolve(
          json(
            {
              authenticated: true,
              principalId: "principal-human",
              csrfToken: "csrf-window-token",
            },
            201,
          ),
        );
      }
      if (url.includes("/bootstrap")) {
        return Promise.resolve(json({ bootstrap }));
      }
      if (url.includes("/runs")) {
        return Promise.resolve(
          json({
            items: [runProjection],
            nextCursor: null,
            hasMore: false,
            snapshotEventId: "event-7",
          }),
        );
      }
      if (url.includes("/agents")) {
        return Promise.resolve(json({ items: [agent] }));
      }
      if (url.includes("/attentions")) {
        return Promise.resolve(
          json({
            items: [attention],
            nextCursor: null,
            hasMore: false,
            snapshotEventId: "event-7",
          }),
        );
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", nativeLikeFetch);
    const controller = new WebController({
      sessionStorage: storage,
      eventSourceFactory: (url) =>
        new FakeEventSource(url) as unknown as EventSource,
      broadcastChannelFactory: () =>
        new FakeBroadcastChannel() as unknown as BroadcastChannel,
    });

    await controller.exchangeSession("local-secret", "project-sample");

    expect(controller.getSnapshot().session).toBe("ready");
    controller.dispose();
    vi.unstubAllGlobals();
  });

  it("exchanges a bearer credential, retains only CSRF session state, and hands bootstrap to SSE", async () => {
    const harness = createHarness();

    await harness.controller.exchangeSession("local-secret", "project-sample");

    expect(harness.calls[0]?.init?.headers).toEqual({
      Authorization: "Bearer local-secret",
    });
    expect(harness.storage.values.get("torsor.session.csrf")).toBe(
      "csrf-window-token",
    );
    expect(harness.storage.values.get("torsor.session.principal")).toBe(
      "principal-human",
    );
    expect([...harness.storage.values.values()]).not.toContain("local-secret");
    expect(harness.controller.getSnapshot()).toMatchObject({
      session: "ready",
      lastEventId: "event-7",
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toContain("cursor=event-7");
  });

  it("clears expired session state and closes the event stream on a 401", async () => {
    const harness = createHarness({ expireThread: true });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    const events = FakeEventSource.instances[0]!;

    await harness.controller.loadThread("thread-1");

    expect(harness.controller.getSnapshot().session).toBe("expired");
    expect(harness.controller.getSnapshot().bootstrap).toBeNull();
    expect(harness.storage.values.size).toBe(0);
    expect(events.closed).toBe(true);
  });

  it("sends Human commands with JSON and the window CSRF token", async () => {
    const harness = createHarness();
    await harness.controller.exchangeSession("local-secret", "project-sample");

    await harness.controller.replyToThread({
      threadRootId: "thread-1",
      expectedThreadCursor: 2,
      body: "Preserve this synthetic instruction.",
      targetAgentIds: ["agent-orbit"],
    });

    const command = harness.calls.find((call) =>
      call.url.includes("/commands/reply-to-thread"),
    );
    expect(command?.init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Torsor-CSRF": "csrf-window-token",
    });
    expect(JSON.parse(String(command?.init?.body))).toMatchObject({
      threadRootId: "thread-1",
      expectedThreadCursor: 2,
      body: "Preserve this synthetic instruction.",
      targetAgentIds: ["agent-orbit"],
    });
  });

  it("marks reconnection stale and refetches only event-affected projections", async () => {
    const harness = createHarness();
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThreads("channel-general");
    await harness.controller.loadThread("thread-1");
    await harness.controller.loadRun("run-1");
    const baseline = { ...harness.counts };
    const events = FakeEventSource.instances[0]!;

    events.fail();
    expect(harness.controller.getSnapshot().connection).toBe("reconnecting");
    events.open();
    expect(harness.controller.getSnapshot().connection).toBe("live");
    events.emit(publicEvent());

    await waitFor(() => {
      expect(harness.counts.threads).toBe(baseline.threads + 1);
      expect(harness.counts.thread).toBe(baseline.thread + 1);
    });
    expect(harness.counts.run).toBe(baseline.run);
    expect(harness.counts.runs).toBe(baseline.runs);
    expect(harness.counts.agents).toBe(baseline.agents);
    expect(
      harness.broadcasts[0]?.posted.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "kind" in message &&
          message.kind === "event",
      ),
    ).toHaveLength(1);
  });

  it("refreshes selected and global Run facts for activation completion", async () => {
    const harness = createHarness();
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThreads("channel-general");
    await harness.controller.loadThread("thread-1");
    await harness.controller.loadRun("run-1");
    const baseline = { ...harness.counts };

    FakeEventSource.instances[0]!.emit(
      publicEvent({
        type: "ActivationFinished",
        entityType: "ActivationAttempt",
        entityId: "activation-1",
        payload: { outcome: "Completed" },
      }),
    );

    await waitFor(() => {
      expect(harness.counts.run).toBe(baseline.run + 1);
      expect(harness.counts.runs).toBe(baseline.runs + 1);
      expect(harness.counts.agents).toBe(baseline.agents + 1);
    });
  });

  it("refreshes selected Run detail for provider-attempt events without a Run ID payload", async () => {
    const harness = createHarness();
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThreads("channel-general");
    await harness.controller.loadThread("thread-1");
    await harness.controller.loadRun("run-1");
    const baseline = { ...harness.counts };

    FakeEventSource.instances[0]!.emit(
      publicEvent({
        type: "ProviderAttemptAcknowledged",
        entityType: "ProviderAttempt",
        entityId: "provider-1",
        payload: { status: "Acknowledged" },
      }),
    );

    await waitFor(() => {
      expect(harness.counts.run).toBe(baseline.run + 1);
      expect(harness.counts.runs).toBe(baseline.runs + 1);
    });
  });

  it("uses cross-window event invalidations without changing local view state", async () => {
    const harness = createHarness();
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThreads("channel-general");
    await harness.controller.loadThread("thread-1");
    const baseline = { ...harness.counts };
    FakeEventSource.instances[0]!.fail();
    expect(harness.controller.getSnapshot().connection).toBe("reconnecting");

    harness.broadcasts[0]?.receive({
      kind: "event",
      event: publicEvent({ eventId: "event-window" }),
    });

    await waitFor(() => {
      expect(harness.counts.threads).toBe(baseline.threads + 1);
      expect(harness.counts.thread).toBe(baseline.thread + 1);
    });
    expect(harness.controller.getSnapshot().connection).toBe("reconnecting");
    expect(
      harness.broadcasts[0]?.posted.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "kind" in message &&
          message.kind === "event",
      ),
    ).toHaveLength(0);
  });

  it("synchronizes rotated CSRF session state across open windows", async () => {
    const first = createHarness({ csrfToken: "csrf-first" });
    const second = createHarness({ csrfToken: "csrf-second" });
    await first.controller.exchangeSession("first-secret", "project-sample");
    await second.controller.exchangeSession("second-secret", "project-sample");
    const rotatedSession = second.broadcasts[0]?.posted.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        message.kind === "session",
    );
    first.broadcasts[0]?.receive(rotatedSession);

    await first.controller.replyToThread({
      threadRootId: "thread-1",
      expectedThreadCursor: 2,
      body: "Use the rotated same-origin browser session.",
    });

    const command = first.calls.find((call) =>
      call.url.includes("/commands/reply-to-thread"),
    );
    expect(command?.init?.headers).toMatchObject({
      "X-Torsor-CSRF": "csrf-second",
    });
    expect(first.storage.values.get("torsor.session.csrf")).toBe("csrf-second");
  });

  it("expires a window instead of adopting another principal's session", async () => {
    const first = createHarness({
      csrfToken: "csrf-first",
      principalId: "principal-human",
    });
    const second = createHarness({
      csrfToken: "csrf-second",
      principalId: "principal-riley",
    });
    await first.controller.exchangeSession("first-secret", "project-sample");
    await second.controller.exchangeSession("second-secret", "project-sample");
    const otherPrincipalSession = second.broadcasts[0]?.posted.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        message.kind === "session",
    );

    first.broadcasts[0]?.receive(otherPrincipalSession);

    expect(first.controller.getSnapshot().session).toBe("expired");
    expect(first.storage.values.size).toBe(0);
  });

  it("retries a command once when it races with cross-window session rotation", async () => {
    let resolveFirstCommand: ((response: Response) => void) | undefined;
    const first = createHarness({
      csrfToken: "csrf-first",
      commandResponse: (callNumber) =>
        callNumber === 1
          ? new Promise((resolve) => {
              resolveFirstCommand = resolve;
            })
          : Promise.resolve(json({ result: { entityId: "message-new" } })),
    });
    const second = createHarness({ csrfToken: "csrf-second" });
    await first.controller.exchangeSession("first-secret", "project-sample");
    const commandPromise = first.controller.replyToThread({
      threadRootId: "thread-1",
      expectedThreadCursor: 2,
      body: "Reconcile a rotated browser session.",
    });
    await waitFor(() => expect(first.counts.commands).toBe(1));

    await second.controller.exchangeSession("second-secret", "project-sample");
    const rotation = second.broadcasts[0]?.posted.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        message.kind === "session",
    );
    first.broadcasts[0]?.receive(rotation);
    resolveFirstCommand?.(
      json(
        {
          error: {
            code: "invalid_csrf_token",
            message: "The browser session CSRF token is invalid.",
          },
        },
        403,
      ),
    );

    await commandPromise;

    const commandCalls = first.calls.filter((call) =>
      call.url.includes("/commands/reply-to-thread"),
    );
    expect(commandCalls).toHaveLength(2);
    expect(commandCalls[0]?.init?.headers).toMatchObject({
      "X-Torsor-CSRF": "csrf-first",
    });
    expect(commandCalls[1]?.init?.headers).toMatchObject({
      "X-Torsor-CSRF": "csrf-second",
    });
    expect(first.controller.getSnapshot().session).toBe("ready");
  });

  it("discards an older same-projection response that arrives last", async () => {
    const responses: Array<(response: Response) => void> = [];
    const harness = createHarness({
      threadResponse: () =>
        new Promise((resolve) => {
          responses.push(resolve);
        }),
    });

    await harness.controller.exchangeSession("local-secret", "project-sample");
    const firstLoad = harness.controller.loadThread("thread-1");
    const secondLoad = harness.controller.loadThread("thread-1");
    const newerThread = {
      ...thread,
      cursor: 4,
      messages: thread.messages.map((message, index) =>
        index === 0
          ? {
              ...message,
              revisions: [
                {
                  ...message.revisions[0]!,
                  body: "Newer projection response.",
                },
              ],
            }
          : message,
      ),
    };
    responses[1]?.(json({ thread: newerThread }));
    await secondLoad;
    responses[0]?.(json({ thread }));
    await firstLoad;

    expect(
      harness.controller.getSnapshot().thread?.messages[0]?.revisions[0]?.body,
    ).toBe("Newer projection response.");
  });

  it("does not refresh an old thread after a pending command completes", async () => {
    let resolveCommand: ((response: Response) => void) | undefined;
    const harness = createHarness({
      commandResponse: () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
      threadResponse: (url) =>
        Promise.resolve(
          json({
            thread: url.endsWith("/thread-2")
              ? { ...thread, threadRootId: "thread-2" }
              : thread,
          }),
        ),
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThread("thread-1");
    const command = harness.controller.replyToThread({
      threadRootId: "thread-1",
      expectedThreadCursor: 2,
      body: "Complete without changing the newer selection.",
    });
    await waitFor(() => expect(harness.counts.commands).toBe(1));
    await harness.controller.loadThread("thread-2");

    resolveCommand?.(json({ result: { entityId: "message-new" } }));
    await command;

    expect(harness.controller.getSnapshot().thread?.threadRootId).toBe(
      "thread-2",
    );
    expect(harness.counts.thread).toBe(2);
  });

  it("defers cross-window events during bootstrap so SSE can replay them", async () => {
    let resolveBootstrap: ((response: Response) => void) | undefined;
    const harness = createHarness({
      bootstrapResponse: () =>
        new Promise((resolve) => {
          resolveBootstrap = resolve;
        }),
    });
    const exchange = harness.controller.exchangeSession(
      "local-secret",
      "project-sample",
    );
    await waitFor(() => expect(harness.counts.bootstrap).toBe(1));
    const event = publicEvent({ eventId: "event-during-bootstrap" });
    harness.broadcasts[0]?.receive({ kind: "event", event });
    resolveBootstrap?.(json({ bootstrap }));
    await exchange;
    await harness.controller.loadThreads("channel-general");
    await harness.controller.loadThread("thread-1");
    const baseline = { ...harness.counts };

    FakeEventSource.instances[0]!.emit(event);

    await waitFor(() => {
      expect(harness.counts.threads).toBe(baseline.threads + 1);
      expect(harness.counts.thread).toBe(baseline.thread + 1);
    });
  });

  it("clears incompatible projections and loading state when navigation is cancelled", async () => {
    let resolvePending: ((response: Response) => void) | undefined;
    const harness = createHarness({
      threadResponse: (url) =>
        url.endsWith("/thread-1")
          ? Promise.resolve(json({ thread }))
          : new Promise((resolve) => {
              resolvePending = resolve;
            }),
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThread("thread-1");

    const pending = harness.controller.loadThread("thread-2");
    expect(harness.controller.getSnapshot()).toMatchObject({
      thread: null,
      loadingThread: true,
    });
    harness.controller.clearThread();
    expect(harness.controller.getSnapshot()).toMatchObject({
      thread: null,
      loadingThread: false,
      run: null,
      loadingRun: false,
    });
    resolvePending?.(json({ thread: { ...thread, threadRootId: "thread-2" } }));
    await pending;
    expect(harness.controller.getSnapshot().thread).toBeNull();
  });

  it("cleans up EventSource and BroadcastChannel resources", async () => {
    const harness = createHarness();
    await harness.controller.exchangeSession("local-secret", "project-sample");
    const events = FakeEventSource.instances[0]!;
    const channel = harness.broadcasts[0]!;

    harness.controller.dispose();

    expect(events.closed).toBe(true);
    expect(channel.closed).toBe(true);
  });
});
