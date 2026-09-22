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
    threadsResponse?: (
      callNumber: number,
      url: string,
    ) => Promise<Response>;
    threadResponse?: (url: string) => Promise<Response>;
    runsResponse?: (callNumber: number) => Promise<Response>;
    runResponse?: (url: string) => Promise<Response>;
    commandResponse?: (
      callNumber: number,
      init?: RequestInit,
    ) => Promise<Response>;
    bootstrapResponse?: () => Promise<Response>;
    agentResponse?: (callNumber: number) => Promise<Response>;
    reconnectProbeDelayMs?: number;
    agentLivenessRefreshMs?: number;
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
      if (options.threadsResponse) {
        return options.threadsResponse(counts.threads, url);
      }
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
      if (options.runsResponse) {
        return options.runsResponse(counts.runs);
      }
      return json({
        items: [runProjection],
        nextCursor: null,
        hasMore: false,
        snapshotEventId: "event-7",
      });
    }
    if (url.endsWith("/runs/run-1")) {
      counts.run += 1;
      if (options.runResponse) {
        return options.runResponse(url);
      }
      return json({ run: runProjection });
    }
    if (url.endsWith("/runs/run-2")) {
      counts.run += 1;
      if (options.runResponse) {
        return options.runResponse(url);
      }
      return json({
        run: {
          ...runProjection,
          run: { ...runProjection.run, id: "run-2" },
        },
      });
    }
    if (url.endsWith("/projects/project-sample/agents")) {
      counts.agents += 1;
      if (options.agentResponse) {
        return options.agentResponse(counts.agents);
      }
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
    reconnectProbeDelayMs: options.reconnectProbeDelayMs ?? 5,
    ...(options.agentLivenessRefreshMs !== undefined
      ? { agentLivenessRefreshMs: options.agentLivenessRefreshMs }
      : {}),
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

  it("reuses the start-thread idempotency key after an uncertain response", async () => {
    const harness = createHarness({
      commandResponse: (callNumber) =>
        callNumber === 1
          ? Promise.reject(new TypeError("The response was lost."))
          : Promise.resolve(json({ result: { entityId: "thread-new" } })),
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    const input = {
      channelId: "channel-general",
      body: "Start this work exactly once.",
      targetAgentIds: ["agent-orbit"],
    } as const;

    await expect(harness.controller.startThread(input)).rejects.toThrow(
      "The response was lost.",
    );
    await harness.controller.startThread(input);

    const commands = harness.calls.filter((call) =>
      call.url.includes("/commands/start-thread"),
    );
    expect(commands).toHaveLength(2);
    const firstBody = JSON.parse(String(commands[0]?.init?.body)) as {
      idempotencyKey: string;
    };
    const secondBody = JSON.parse(String(commands[1]?.init?.body)) as {
      idempotencyKey: string;
    };
    expect(secondBody.idempotencyKey).toBe(firstBody.idempotencyKey);
  });

  it("retains each unresolved start request across other starts and bootstrap", async () => {
    const committedKeys = new Set<string>();
    const durableThreads = new Map<string, number>();
    const durableAttentions = new Map<string, number>();
    const harness = createHarness({
      commandResponse: (callNumber, init) => {
        const request = JSON.parse(String(init?.body)) as {
          idempotencyKey: string;
          body: string;
          targetAgentIds?: readonly string[];
        };
        if (!committedKeys.has(request.idempotencyKey)) {
          committedKeys.add(request.idempotencyKey);
          durableThreads.set(
            request.body,
            (durableThreads.get(request.body) ?? 0) + 1,
          );
          if (request.targetAgentIds?.length) {
            durableAttentions.set(
              request.body,
              (durableAttentions.get(request.body) ?? 0) + 1,
            );
          }
        }
        return callNumber === 1
          ? Promise.reject(new TypeError("The committed response was lost."))
          : Promise.resolve(json({ result: { entityId: `thread-${callNumber}` } }));
      },
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    const startA = {
      channelId: "channel-general",
      body: "Start durable operation A.",
      targetAgentIds: ["agent-orbit"],
    } as const;

    await expect(harness.controller.startThread(startA)).rejects.toThrow(
      "The committed response was lost.",
    );
    await harness.controller.startThread({
      channelId: "channel-general",
      body: "Start durable operation B.",
    });
    await harness.controller.resume("project-sample");
    await harness.controller.startThread(startA);

    const commands = harness.calls.filter((call) =>
      call.url.includes("/commands/start-thread"),
    );
    expect(commands).toHaveLength(3);
    expect(JSON.parse(String(commands[2]?.init?.body))).toEqual(
      JSON.parse(String(commands[0]?.init?.body)),
    );
    expect(durableThreads.get(startA.body)).toBe(1);
    expect(durableAttentions.get(startA.body)).toBe(1);
    expect(durableThreads.get("Start durable operation B.")).toBe(1);
  });

  it("retains an uncertain start request through 401 and reauthentication", async () => {
    const committedKeys = new Set<string>();
    let durableThreads = 0;
    let durableAttentions = 0;
    const harness = createHarness({
      commandResponse: (callNumber, init) => {
        const request = JSON.parse(String(init?.body)) as {
          idempotencyKey: string;
          targetAgentIds?: readonly string[];
        };
        if (!committedKeys.has(request.idempotencyKey)) {
          committedKeys.add(request.idempotencyKey);
          durableThreads += 1;
          if (request.targetAgentIds?.length) {
            durableAttentions += 1;
          }
        }
        if (callNumber === 1) {
          return Promise.reject(
            new TypeError("The committed response was lost."),
          );
        }
        if (callNumber === 2) {
          return Promise.resolve(
            json(
              {
                error: {
                  code: "unauthorized",
                  message: "The browser session was revoked.",
                },
              },
              401,
            ),
          );
        }
        return Promise.resolve(json({ result: { entityId: "thread-auth" } }));
      },
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    const input = {
      channelId: "channel-general",
      body: "Start once across reauthentication.",
      targetAgentIds: ["agent-orbit"],
    } as const;

    await expect(harness.controller.startThread(input)).rejects.toThrow(
      "The committed response was lost.",
    );
    await expect(harness.controller.startThread(input)).rejects.toThrow(
      "The browser session was revoked.",
    );
    expect(harness.controller.getSnapshot().session).toBe("expired");

    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.startThread(input);

    const commands = harness.calls.filter((call) =>
      call.url.includes("/commands/start-thread"),
    );
    expect(commands).toHaveLength(3);
    expect(JSON.parse(String(commands[1]?.init?.body))).toEqual(
      JSON.parse(String(commands[0]?.init?.body)),
    );
    expect(JSON.parse(String(commands[2]?.init?.body))).toEqual(
      JSON.parse(String(commands[0]?.init?.body)),
    );
    expect(durableThreads).toBe(1);
    expect(durableAttentions).toBe(1);
  });

  it("reuses the complete reply request after a committed response is lost", async () => {
    const committedKeys = new Set<string>();
    let projectedThread = thread;
    const harness = createHarness({
      threadResponse: () => Promise.resolve(json({ thread: projectedThread })),
      commandResponse: (callNumber, init) => {
        const request = JSON.parse(String(init?.body)) as {
          idempotencyKey: string;
        };
        if (!committedKeys.has(request.idempotencyKey)) {
          committedKeys.add(request.idempotencyKey);
          projectedThread = {
            ...thread,
            cursor: 3,
            messages: [
              ...thread.messages,
              {
                ...thread.messages[0]!,
                id: "message-reply",
                replyToMessageId: "thread-1",
                authorPrincipalId: "principal-human",
                authorAgentId: null,
                causedByAttentionId: null,
                causedByRunId: null,
                threadCursor: 3,
                revisions: [
                  {
                    id: "revision-reply",
                    revision: 1,
                    body: "Commit this reply once.",
                    createdAt: "2026-09-22T04:03:00.000Z",
                  },
                ],
                targetAgentIds: ["agent-orbit"],
                createdAt: "2026-09-22T04:03:00.000Z",
              },
            ],
            attentions: [
              ...thread.attentions,
              {
                ...attention,
                cursor: 2,
                id: "attention-reply",
                messageRevisionId: "revision-reply",
                createdAt: "2026-09-22T04:03:00.000Z",
              },
            ],
          };
        }
        return callNumber === 1
          ? Promise.reject(new TypeError("The committed response was lost."))
          : Promise.resolve(json({ result: { entityId: "message-reply" } }));
      },
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThread("thread-1");
    const originalInput = {
      threadRootId: "thread-1",
      expectedThreadCursor: 2,
      body: "Commit this reply once.",
      targetAgentIds: ["agent-orbit"],
    } as const;

    await expect(
      harness.controller.replyToThread(originalInput),
    ).rejects.toThrow("The committed response was lost.");
    FakeEventSource.instances[0]!.emit(
      publicEvent({ eventId: "event-committed-reply", threadCursor: 3 }),
    );
    await waitFor(() =>
      expect(harness.controller.getSnapshot().thread?.cursor).toBe(3),
    );

    await harness.controller.replyToThread({
      ...originalInput,
      expectedThreadCursor: 3,
    });

    const commands = harness.calls.filter((call) =>
      call.url.includes("/commands/reply-to-thread"),
    );
    expect(commands).toHaveLength(2);
    expect(JSON.parse(String(commands[1]?.init?.body))).toEqual(
      JSON.parse(String(commands[0]?.init?.body)),
    );
    expect(committedKeys.size).toBe(1);
    expect(harness.controller.getSnapshot().thread?.messages).toHaveLength(3);
    expect(harness.controller.getSnapshot().thread?.attentions).toHaveLength(2);
  });

  it("retains an uncertain reply request through 401 and reauthentication", async () => {
    const committedKeys = new Set<string>();
    let durableReplies = 0;
    let projectedThread = thread;
    const harness = createHarness({
      threadResponse: () => Promise.resolve(json({ thread: projectedThread })),
      commandResponse: (callNumber, init) => {
        const request = JSON.parse(String(init?.body)) as {
          idempotencyKey: string;
        };
        if (!committedKeys.has(request.idempotencyKey)) {
          committedKeys.add(request.idempotencyKey);
          durableReplies += 1;
          projectedThread = {
            ...thread,
            cursor: 3,
            messages: [
              ...thread.messages,
              {
                ...thread.messages[0]!,
                id: "message-auth-reply",
                replyToMessageId: "thread-1",
                authorPrincipalId: "principal-human",
                authorAgentId: null,
                causedByAttentionId: null,
                causedByRunId: null,
                threadCursor: 3,
                revisions: [
                  {
                    id: "revision-auth-reply",
                    revision: 1,
                    body: "Reply once across reauthentication.",
                    createdAt: "2026-09-22T04:03:00.000Z",
                  },
                ],
                targetAgentIds: [],
                createdAt: "2026-09-22T04:03:00.000Z",
              },
            ],
          };
        }
        if (callNumber === 1) {
          return Promise.reject(
            new TypeError("The committed response was lost."),
          );
        }
        if (callNumber === 2) {
          return Promise.resolve(
            json(
              {
                error: {
                  code: "unauthorized",
                  message: "The browser session was revoked.",
                },
              },
              401,
            ),
          );
        }
        return Promise.resolve(
          json({ result: { entityId: "message-auth-reply" } }),
        );
      },
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThread("thread-1");
    const input = {
      threadRootId: "thread-1",
      expectedThreadCursor: 2,
      body: "Reply once across reauthentication.",
    } as const;

    await expect(harness.controller.replyToThread(input)).rejects.toThrow(
      "The committed response was lost.",
    );
    FakeEventSource.instances[0]!.emit(
      publicEvent({ eventId: "event-auth-reply", threadCursor: 3 }),
    );
    await waitFor(() =>
      expect(harness.controller.getSnapshot().thread?.cursor).toBe(3),
    );
    await expect(
      harness.controller.replyToThread({
        ...input,
        expectedThreadCursor: 3,
      }),
    ).rejects.toThrow("The browser session was revoked.");

    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThread("thread-1");
    await harness.controller.replyToThread({
      ...input,
      expectedThreadCursor: 3,
    });

    const commands = harness.calls.filter((call) =>
      call.url.includes("/commands/reply-to-thread"),
    );
    expect(commands).toHaveLength(3);
    expect(JSON.parse(String(commands[1]?.init?.body))).toEqual(
      JSON.parse(String(commands[0]?.init?.body)),
    );
    expect(JSON.parse(String(commands[2]?.init?.body))).toEqual(
      JSON.parse(String(commands[0]?.init?.body)),
    );
    expect(durableReplies).toBe(1);
    expect(
      harness.controller
        .getSnapshot()
        .thread?.messages.filter(
          (message) =>
            message.revisions[0]?.body ===
            "Reply once across reauthentication.",
        ),
    ).toHaveLength(1);
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

  it("retries a failed event invalidation before deduplicating the event", async () => {
    let failNextThreadRefresh = false;
    const harness = createHarness({
      reconnectProbeDelayMs: 10_000,
      threadResponse: () => {
        if (failNextThreadRefresh) {
          failNextThreadRefresh = false;
          return Promise.reject(new Error("Thread refresh failed."));
        }
        return Promise.resolve(json({ thread }));
      },
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThreads("channel-general");
    await harness.controller.loadThread("thread-1");
    const baseline = { ...harness.counts };
    const events = FakeEventSource.instances[0]!;
    const event = publicEvent({ eventId: "event-retry" });

    failNextThreadRefresh = true;
    events.emit(event);
    await waitFor(() => {
      expect(harness.counts.thread).toBe(baseline.thread + 1);
      expect(harness.controller.getSnapshot().queryError).toContain(
        "Thread refresh failed",
      );
    });
    await Promise.resolve();

    events.fail();
    events.open();
    await waitFor(() => {
      expect(harness.counts.thread).toBe(baseline.thread + 2);
      expect(harness.controller.getSnapshot().queryError).toBeNull();
    });

    events.emit(event);
    await Promise.resolve();
    expect(harness.counts.thread).toBe(baseline.thread + 2);
  });

  it("keeps an invalidation pending when its replacement refresh fails", async () => {
    let raceRequests = false;
    const pendingResponses: Array<(response: Response) => void> = [];
    const convergedThread = { ...thread, cursor: 4 };
    const harness = createHarness({
      threadResponse: () =>
        raceRequests
          ? new Promise((resolve) => {
              pendingResponses.push(resolve);
            })
          : Promise.resolve(json({ thread: convergedThread })),
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThread("thread-1");
    const baseline = harness.counts.thread;
    raceRequests = true;

    FakeEventSource.instances[0]!.emit(
      publicEvent({ eventId: "event-superseded-refresh" }),
    );
    await waitFor(() => expect(pendingResponses).toHaveLength(1));
    const reply = harness.controller.replyToThread({
      threadRootId: "thread-1",
      expectedThreadCursor: 2,
      body: "Start the replacement refresh.",
    });
    await waitFor(() => expect(pendingResponses).toHaveLength(2));

    pendingResponses[1]?.(
      json(
        {
          error: {
            code: "projection_failed",
            message: "Replacement refresh failed.",
          },
        },
        500,
      ),
    );
    await reply;
    pendingResponses[0]?.(json({ thread: { ...thread, cursor: 3 } }));
    await waitFor(() =>
      expect(harness.controller.getSnapshot().queryError).toContain(
        "Replacement refresh failed",
      ),
    );

    raceRequests = false;
    const events = FakeEventSource.instances[0]!;
    events.fail();
    events.open();
    await waitFor(() => {
      expect(harness.counts.thread).toBe(baseline + 3);
      expect(harness.controller.getSnapshot().thread?.cursor).toBe(4);
      expect(harness.controller.getSnapshot().queryError).toBeNull();
    });

    events.emit(publicEvent({ eventId: "event-superseded-refresh" }));
    await Promise.resolve();
    expect(harness.counts.thread).toBe(baseline + 3);
  });

  it("cancels a queued Thread refresh after navigation changes selection", async () => {
    let blockThreadA = false;
    let resolveThreadA: ((response: Response) => void) | undefined;
    const threadB = { ...thread, threadRootId: "thread-2" };
    const harness = createHarness({
      threadResponse: (url) => {
        if (url.endsWith("/thread-2")) {
          return Promise.resolve(json({ thread: threadB }));
        }
        if (blockThreadA) {
          return new Promise((resolve) => {
            resolveThreadA = resolve;
          });
        }
        return Promise.resolve(json({ thread }));
      },
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThread("thread-1");
    const baseline = harness.counts.thread;
    blockThreadA = true;

    const events = FakeEventSource.instances[0]!;
    events.emit(publicEvent({ eventId: "event-thread-a-1" }));
    events.emit(publicEvent({ eventId: "event-thread-a-2" }));
    await waitFor(() => expect(harness.counts.thread).toBe(baseline + 1));

    await harness.controller.loadThread("thread-2");
    resolveThreadA?.(json({ thread: { ...thread, cursor: 3 } }));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.controller.getSnapshot().thread?.threadRootId).toBe(
      "thread-2",
    );
    expect(harness.counts.thread).toBe(baseline + 2);
  });

  it("cancels a queued Run refresh after navigation changes selection", async () => {
    let blockRunA = false;
    let resolveRunA: ((response: Response) => void) | undefined;
    const runB = {
      ...runProjection,
      run: { ...runProjection.run, id: "run-2" },
    };
    const harness = createHarness({
      runResponse: (url) => {
        if (url.endsWith("/run-2")) {
          return Promise.resolve(json({ run: runB }));
        }
        if (blockRunA) {
          return new Promise((resolve) => {
            resolveRunA = resolve;
          });
        }
        return Promise.resolve(json({ run: runProjection }));
      },
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadRun("run-1");
    const baseline = harness.counts.run;
    blockRunA = true;

    const events = FakeEventSource.instances[0]!;
    for (const eventId of ["event-run-a-1", "event-run-a-2"]) {
      events.emit(
        publicEvent({
          eventId,
          type: "ProviderAttemptAcknowledged",
          entityType: "ProviderAttempt",
          payload: { runId: "run-1" },
        }),
      );
    }
    await waitFor(() => expect(harness.counts.run).toBe(baseline + 1));

    await harness.controller.loadRun("run-2");
    resolveRunA?.(json({ run: runProjection }));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.controller.getSnapshot().run?.run.id).toBe("run-2");
    expect(harness.counts.run).toBe(baseline + 2);
  });

  it("does not let liveness success hide a failed thread invalidation", async () => {
    vi.useFakeTimers();
    try {
      let failuresRemaining = 0;
      const harness = createHarness({
        reconnectProbeDelayMs: 20,
        agentLivenessRefreshMs: 25,
        threadResponse: () => {
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            return Promise.reject(new Error("Thread projection stayed stale."));
          }
          return Promise.resolve(json({ thread: { ...thread, cursor: 4 } }));
        },
      });
      await harness.controller.exchangeSession(
        "local-secret",
        "project-sample",
      );
      await harness.controller.loadThread("thread-1");
      const baselineAgents = harness.counts.agents;
      failuresRemaining = 2;

      FakeEventSource.instances[0]!.emit(
        publicEvent({ eventId: "event-stale-thread" }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.controller.getSnapshot().queryError).toContain(
        "Thread projection stayed stale",
      );

      await vi.advanceTimersByTimeAsync(20);
      expect(harness.controller.getSnapshot().queryError).toContain(
        "Thread projection stayed stale",
      );

      await vi.advanceTimersByTimeAsync(5);
      expect(harness.counts.agents).toBe(baselineAgents + 1);
      expect(harness.controller.getSnapshot().queryError).toContain(
        "Thread projection stayed stale",
      );

      await vi.advanceTimersByTimeAsync(35);
      expect(harness.controller.getSnapshot().thread?.cursor).toBe(4);
      expect(harness.controller.getSnapshot().queryError).toBeNull();
      harness.controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a large activation replay into bounded projection refreshes", async () => {
    const idleAgent = {
      ...agent,
      liveRunActivationCount: 0,
      liveActivationCount: 0,
      nonterminalRunCount: 0,
      status: "idle" as const,
    };
    const harness = createHarness({
      agentResponse: (callNumber) =>
        Promise.resolve(json({ items: [callNumber >= 3 ? idleAgent : agent] })),
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    const baseline = { ...harness.counts };
    const events = FakeEventSource.instances[0]!;

    for (let index = 0; index < 50; index += 1) {
      events.emit(
        publicEvent({
          eventId: `event-activation-${index}`,
          type: "ActivationStarted",
          entityType: "ActivationAttempt",
          entityId: `activation-${index}`,
          payload: { runId: "run-1" },
        }),
      );
    }

    await waitFor(() => {
      expect(harness.counts.runs).toBe(baseline.runs + 2);
      expect(harness.counts.agents).toBe(baseline.agents + 2);
      expect(harness.counts.attentions).toBe(baseline.attentions + 2);
      expect(harness.controller.getSnapshot().agents[0]?.status).toBe("idle");
      expect(harness.controller.getSnapshot().lastEventId).toBe(
        "event-activation-49",
      );
    });
    await Promise.resolve();
    expect(harness.counts.runs).toBe(baseline.runs + 2);

    events.emit(
      publicEvent({
        eventId: "event-activation-49",
        entityType: "ActivationAttempt",
      }),
    );
    await Promise.resolve();
    expect(harness.counts.runs).toBe(baseline.runs + 2);
  });

  it("uses one projection retry timer for a failed activation replay", async () => {
    vi.useFakeTimers();
    try {
      const convergedRun = {
        ...runProjection,
        run: {
          ...runProjection.run,
          state: "Completed" as const,
          terminalReason: "Synthetic completion.",
        },
      };
      const harness = createHarness({
        reconnectProbeDelayMs: 20,
        agentLivenessRefreshMs: 10_000,
        runsResponse: (callNumber) =>
          callNumber === 1 || callNumber >= 4
            ? Promise.resolve(
                json({
                  items: [callNumber >= 4 ? convergedRun : runProjection],
                  nextCursor: null,
                  hasMore: false,
                  snapshotEventId: "event-7",
                }),
              )
            : Promise.resolve(
                json(
                  {
                    error: {
                      code: "projection_failed",
                      message: "Run replay refresh failed.",
                    },
                  },
                  500,
                ),
              ),
      });
      await harness.controller.exchangeSession(
        "local-secret",
        "project-sample",
      );
      const baselineRuns = harness.counts.runs;
      const baselineTimers = vi.getTimerCount();
      const events = FakeEventSource.instances[0]!;

      for (let index = 0; index < 50; index += 1) {
        events.emit(
          publicEvent({
            eventId: `event-failed-activation-${index}`,
            type: "ActivationStarted",
            entityType: "ActivationAttempt",
            entityId: `activation-failed-${index}`,
            payload: { runId: "run-1" },
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.counts.runs).toBe(baselineRuns + 2);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(baselineTimers + 1);

      await vi.advanceTimersByTimeAsync(20);
      expect(harness.counts.runs).toBe(baselineRuns + 3);
      expect(harness.controller.getSnapshot().runs[0]?.run.state).toBe(
        "Completed",
      );

      events.emit(
        publicEvent({
          eventId: "event-failed-activation-49",
          entityType: "ActivationAttempt",
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.counts.runs).toBe(baselineRuns + 3);
      harness.controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins new Run events to an existing projection backoff", async () => {
    vi.useFakeTimers();
    try {
      const convergedRun = {
        ...runProjection,
        run: {
          ...runProjection.run,
          state: "Completed" as const,
          terminalReason: "Backoff reconciled.",
        },
      };
      const harness = createHarness({
        reconnectProbeDelayMs: 1_000,
        agentLivenessRefreshMs: 10_000,
        runsResponse: (callNumber) => {
          if (callNumber === 2) {
            return Promise.resolve(
              json(
                {
                  error: {
                    code: "projection_unavailable",
                    message: "Run projection is temporarily unavailable.",
                  },
                },
                503,
              ),
            );
          }
          return Promise.resolve(
            json({
              items: [callNumber >= 3 ? convergedRun : runProjection],
              nextCursor: null,
              hasMore: false,
              snapshotEventId: "event-7",
            }),
          );
        },
      });
      await harness.controller.exchangeSession(
        "local-secret",
        "project-sample",
      );
      const baselineRuns = harness.counts.runs;
      const baselineTimers = vi.getTimerCount();
      const events = FakeEventSource.instances[0]!;

      events.emit(
        publicEvent({
          eventId: "event-backoff-run-0",
          type: "RunInputAdded",
          entityType: "RunInput",
          channelId: null,
          threadRootId: null,
          payload: { runId: "run-1" },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.counts.runs).toBe(baselineRuns + 1);

      for (let index = 1; index < 20; index += 1) {
        await vi.advanceTimersByTimeAsync(10);
        events.emit(
          publicEvent({
            eventId: `event-backoff-run-${index}`,
            type: "RunInputAdded",
            entityType: "RunInput",
            channelId: null,
            threadRootId: null,
            payload: { runId: "run-1" },
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(harness.counts.runs).toBe(baselineRuns + 1);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(baselineTimers + 1);

      await vi.advanceTimersByTimeAsync(810);
      expect(harness.counts.runs).toBe(baselineRuns + 2);
      expect(harness.controller.getSnapshot().runs[0]?.run.state).toBe(
        "Completed",
      );

      events.emit(
        publicEvent({
          eventId: "event-backoff-run-19",
          entityType: "RunInput",
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.counts.runs).toBe(baselineRuns + 2);
      harness.controller.dispose();
    } finally {
      vi.useRealTimers();
    }
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

  it("retires abandoned selection errors and prioritizes the current Thread error", async () => {
    let failThreadA = true;
    let failThreadB = false;
    const harness = createHarness({
      reconnectProbeDelayMs: 10_000,
      threadResponse: (url) => {
        if (url.endsWith("/thread-1") && failThreadA) {
          return Promise.reject(new Error("Thread A failed."));
        }
        if (url.endsWith("/thread-2") && failThreadB) {
          return Promise.reject(new Error("Thread B failed."));
        }
        return Promise.resolve(
          json({
            thread: url.endsWith("/thread-2")
              ? { ...thread, threadRootId: "thread-2" }
              : thread,
          }),
        );
      },
      runsResponse: (callNumber) =>
        callNumber === 1
          ? Promise.resolve(
              json({
                items: [runProjection],
                nextCursor: null,
                hasMore: false,
                snapshotEventId: "event-7",
              }),
            )
          : Promise.resolve(
              json(
                {
                  error: {
                    code: "projection_failed",
                    message: "Global Run refresh failed.",
                  },
                },
                500,
              ),
            ),
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");

    await harness.controller.loadThread("thread-1");
    expect(harness.controller.getSnapshot().queryError).toContain(
      "Thread A failed",
    );

    failThreadA = false;
    await harness.controller.loadThread("thread-2");
    expect(harness.controller.getSnapshot().queryError).toBeNull();

    FakeEventSource.instances[0]!.emit(
      publicEvent({
        eventId: "event-global-run-error",
        entityType: "Run",
        entityId: "run-1",
        channelId: null,
        threadRootId: null,
      }),
    );
    await waitFor(() =>
      expect(harness.controller.getSnapshot().queryError).toContain(
        "Global Run refresh failed",
      ),
    );

    failThreadB = true;
    await harness.controller.loadThread("thread-2");
    expect(harness.controller.getSnapshot().queryError).toContain(
      "Thread B failed",
    );
  });

  it("preserves a same-channel Thread list snapshot when refresh fails", async () => {
    let rejectRefresh: ((error: Error) => void) | undefined;
    const harness = createHarness({
      threadsResponse: (callNumber) =>
        callNumber === 1
          ? Promise.resolve(
              json({
                items: [thread],
                nextCursor: null,
                hasMore: false,
                snapshotEventId: "event-7",
              }),
            )
          : new Promise((_, reject) => {
              rejectRefresh = reject;
            }),
    });
    await harness.controller.exchangeSession("local-secret", "project-sample");
    await harness.controller.loadThreads("channel-general");

    const refresh = harness.controller.loadThreads("channel-general");
    expect(harness.controller.getSnapshot()).toMatchObject({
      threads: [thread],
      threadsChannelId: "channel-general",
      loadingThreads: true,
    });

    rejectRefresh?.(new Error("Thread list refresh failed."));
    await refresh;
    expect(harness.controller.getSnapshot()).toMatchObject({
      threads: [thread],
      threadsChannelId: "channel-general",
      loadingThreads: false,
      queryError: "Thread list refresh failed.",
    });
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

  it("periodically refreshes authoritative Agent liveness without an event", async () => {
    vi.useFakeTimers();
    try {
      const idleAgent = {
        ...agent,
        liveRunActivationCount: 0,
        liveActivationCount: 0,
        nonterminalRunCount: 0,
        status: "idle" as const,
      };
      const harness = createHarness({
        agentLivenessRefreshMs: 100,
        agentResponse: (callNumber) =>
          Promise.resolve(
            json({ items: [callNumber === 1 ? agent : idleAgent] }),
          ),
      });
      await harness.controller.exchangeSession("local-secret", "project-sample");
      const baseline = {
        agents: harness.counts.agents,
        attentions: harness.counts.attentions,
      };

      await vi.advanceTimersByTimeAsync(100);

      expect(harness.counts.agents).toBe(baseline.agents + 1);
      expect(harness.counts.attentions).toBe(baseline.attentions + 1);
      expect(harness.controller.getSnapshot().agents[0]?.status).toBe("idle");
      harness.controller.dispose();
      await vi.advanceTimersByTimeAsync(100);
      expect(harness.counts.agents).toBe(baseline.agents + 1);
    } finally {
      vi.useRealTimers();
    }
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
