// @vitest-environment node
/// <reference types="node" />

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KernelBootstrap } from "@torsor/kernel";
import {
  createTorsorHttpService,
  type LocalCredential,
  type TorsorHttpService,
} from "../../server/src/index";
import { afterEach, describe, expect, it } from "vitest";

import { WebController } from "./controller";

const bootstrap: KernelBootstrap = {
  principals: [
    { id: "principal-human", kind: "human", displayName: "Avery Stone" },
    { id: "principal-orbit", kind: "agent", displayName: "Orbit" },
  ],
  projects: [{ id: "project-sample", name: "Sample Project" }],
  channels: [
    {
      id: "channel-general",
      projectId: "project-sample",
      name: "general",
    },
  ],
  agents: [
    {
      id: "agent-orbit",
      principalId: "principal-orbit",
      projectId: "project-sample",
      name: "Orbit",
      configRevision: 1,
      config: { model: "deterministic-fake" },
    },
  ],
};

const credentials: readonly LocalCredential[] = [
  {
    token: "human-token",
    principalContext: { principalId: "principal-human" },
  },
];

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe("WebController production HTTP path", () => {
  it("deduplicates an acknowledged Start while its Thread list refresh is held", async () => {
    const server = await startServer();
    const browser = new BrowserTransport();
    const window = createWindowController(server.origin, browser);
    await window.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    await window.controller.loadThreads("channel-general");
    const heldRefresh = browser.holdNext((url) =>
      url.includes("/api/v1/channels/channel-general/threads"),
    );
    const input = {
      channelId: "channel-general",
      body: "Keep the acknowledged Start singular.",
      targetAgentIds: ["agent-orbit"],
    } as const;

    const first = window.controller.startThread(input);
    await heldRefresh.observed;
    expect(window.controller.getSnapshot().commandPending).toBe(false);
    await window.controller.startThread(input);
    heldRefresh.release();
    await first;

    await window.controller.startThread({
      ...input,
      body: "Allow a later fresh Start.",
    });
    await window.controller.loadThreads("channel-general");
    const threads = window.controller.getSnapshot().threads;
    const original = threads.filter(
      (candidate) =>
        candidate.messages[0]?.revisions[0]?.body === input.body,
    );
    const fresh = threads.filter(
      (candidate) =>
        candidate.messages[0]?.revisions[0]?.body ===
        "Allow a later fresh Start.",
    );
    expect(original).toHaveLength(1);
    expect(original[0]?.attentions).toHaveLength(1);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.attentions).toHaveLength(1);
  });

  it("deduplicates an acknowledged Reply after a separate live refresh advances its cursor", async () => {
    const server = await startServer();
    const browser = new BrowserTransport();
    const window = createWindowController(server.origin, browser);
    await window.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    await window.controller.startThread({
      channelId: "channel-general",
      body: "Root message for acknowledged Reply coverage.",
      targetAgentIds: ["agent-orbit"],
    });
    await window.controller.loadThreads("channel-general");
    const threadId = window.controller.getSnapshot().threads[0]!.threadRootId;
    await window.controller.loadThread(threadId);
    const heldRefresh = browser.holdNext((url) =>
      url.includes(`/api/v1/threads/${threadId}`),
    );
    const input = {
      threadRootId: threadId,
      expectedThreadCursor: 1,
      body: "Keep the acknowledged Reply singular.",
      targetAgentIds: ["agent-orbit"],
    } as const;

    const first = window.controller.replyToThread(input);
    await heldRefresh.observed;
    expect(window.controller.getSnapshot().commandPending).toBe(false);
    await window.controller.loadThread(threadId);
    expect(window.controller.getSnapshot().thread?.cursor).toBe(2);
    await window.controller.replyToThread({
      ...input,
      expectedThreadCursor: 2,
    });
    heldRefresh.release();
    await first;

    await window.controller.replyToThread({
      ...input,
      expectedThreadCursor: 2,
      body: "Allow a later fresh Reply.",
    });
    await window.controller.loadThread(threadId);
    const projection = window.controller.getSnapshot().thread!;
    expect(
      projection.messages.filter(
        (message) => message.revisions[0]?.body === input.body,
      ),
    ).toHaveLength(1);
    expect(
      projection.messages.filter(
        (message) =>
          message.revisions[0]?.body === "Allow a later fresh Reply.",
      ),
    ).toHaveLength(1);
    expect(projection.attentions).toHaveLength(3);
  });

  it("ignores a held real 401 after another window replaces the shared-cookie session", async () => {
    const server = await startServer();
    const browser = new BrowserTransport();
    const broadcasts = new BroadcastHub();
    const first = createWindowController(
      server.origin,
      browser,
      broadcasts,
    );
    const second = createWindowController(
      server.origin,
      browser,
      broadcasts,
    );
    await first.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    const revokedCookie = browser.cookie;
    const revoked = await fetch(`${server.origin}/api/v1/session`, {
      method: "DELETE",
      headers: { Cookie: revokedCookie },
    });
    expect(revoked.status).toBe(204);

    const heldUnauthorized = browser.holdNext((url) =>
      url.includes("/api/v1/commands/start-thread"),
    );
    const oldCommand = first.controller.startThread({
      channelId: "channel-general",
      body: "This obsolete request receives a real delayed 401.",
    });
    await heldUnauthorized.observed;

    await second.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    expect(browser.cookie).not.toBe(revokedCookie);
    heldUnauthorized.release();
    await expect(oldCommand).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });

    expect(first.controller.getSnapshot().session).toBe("ready");
    expect(second.controller.getSnapshot().session).toBe("ready");
    expect(second.eventSources.at(-1)?.closed).toBe(false);
  });
});

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

class TestEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(): void {}

  close(): void {
    this.closed = true;
  }
}

class BroadcastHub {
  readonly channels = new Set<TestBroadcastChannel>();

  create = (): BroadcastChannel => {
    const channel = new TestBroadcastChannel(this);
    this.channels.add(channel);
    return channel as unknown as BroadcastChannel;
  };
}

class TestBroadcastChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(private readonly hub: BroadcastHub) {}

  postMessage(message: unknown): void {
    for (const channel of this.hub.channels) {
      if (channel !== this) {
        channel.onmessage?.({ data: message } as MessageEvent<unknown>);
      }
    }
  }

  close(): void {
    this.hub.channels.delete(this);
  }
}

class BrowserTransport {
  readonly #nativeFetch = globalThis.fetch.bind(globalThis);
  #cookie = "";
  #hold:
    | {
        readonly predicate: (url: string) => boolean;
        readonly gate: Promise<void>;
        readonly observed: () => void;
      }
    | null = null;

  get cookie(): string {
    return this.#cookie;
  }

  fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (this.#cookie) {
      headers.set("Cookie", this.#cookie);
    }
    const response = await this.#nativeFetch(input, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";", 1)[0]!;
      this.#cookie = pair.endsWith("=") ? "" : pair;
    }
    const url = String(input);
    const hold = this.#hold;
    if (hold?.predicate(url)) {
      this.#hold = null;
      hold.observed();
      await hold.gate;
    }
    return response;
  };

  holdNext(predicate: (url: string) => boolean): {
    readonly observed: Promise<void>;
    readonly release: () => void;
  } {
    if (this.#hold) {
      throw new Error("Only one held browser response is supported.");
    }
    let release!: () => void;
    let observed!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observedPromise = new Promise<void>((resolve) => {
      observed = resolve;
    });
    this.#hold = { predicate, gate, observed };
    return { observed: observedPromise, release };
  }
}

function createWindowController(
  origin: string,
  browser: BrowserTransport,
  broadcasts = new BroadcastHub(),
): {
  readonly controller: WebController;
  readonly eventSources: TestEventSource[];
} {
  const eventSources: TestEventSource[] = [];
  const controller = new WebController({
    apiBase: origin,
    fetch: browser.fetch as typeof fetch,
    sessionStorage: new MemoryStorage(),
    eventSourceFactory: (url) => {
      const events = new TestEventSource(url);
      eventSources.push(events);
      return events as unknown as EventSource;
    },
    broadcastChannelFactory: broadcasts.create,
  });
  cleanup.push(async () => controller.dispose());
  return { controller, eventSources };
}

async function startServer(): Promise<{
  readonly service: TorsorHttpService;
  readonly origin: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "torsor-web-integration-"));
  const service = createTorsorHttpService({
    databasePath: join(directory, "torsor.sqlite"),
    bootstrap,
    credentials,
    port: 0,
  });
  const origin = await service.listen();
  cleanup.push(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, origin };
}
