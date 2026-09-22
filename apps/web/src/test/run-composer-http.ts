/// <reference types="node" />
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TorsorKernel, type CausalLimits, type KernelBootstrap } from "@torsor/kernel";
import { createTorsorHttpService } from "../../../server/src/index";
import { WebController } from "../controller";
import type { PublicEvent } from "../types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

interface Gate {
  readonly path: string;
  readonly observed: ReturnType<typeof deferred>;
  readonly released: ReturnType<typeof deferred>;
  readonly fail: boolean | "response-loss";
}

export class ControlledBrowser {
  readonly requests: Array<{ path: string; method: string; body: string | null }> = [];
  readonly #fetch = globalThis.fetch.bind(globalThis);
  readonly #gates: Gate[] = [];
  readonly #releases: Array<() => void> = [];
  #cookie = "";

  hold(path: string, fail: boolean | "response-loss" = false) {
    const gate: Gate = { path, observed: deferred(), released: deferred(), fail };
    this.#gates.push(gate);
    this.#releases.push(gate.released.resolve);
    return { observed: gate.observed.promise, release: gate.released.resolve };
  }

  releaseAll(): void {
    for (const release of this.#releases) release();
  }

  stream = (url: string): Promise<Response> =>
    this.#fetch(url, { headers: { Cookie: this.#cookie } });

  fetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    this.requests.push({
      path, method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    const index = this.#gates.findIndex((gate) => gate.path === path);
    const gate = index < 0 ? undefined : this.#gates.splice(index, 1)[0];
    const headers = new Headers(init?.headers);
    if (this.#cookie) headers.set("Cookie", this.#cookie);
    const response = await this.#fetch(input, { ...init, headers });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.#cookie = cookie.split(";", 1)[0]!;
    const body = await response.text();
    if (gate) {
      gate.observed.resolve();
      await gate.released.promise;
      if (gate.fail === "response-loss") throw new TypeError("Response lost after the HTTP request completed.");
      if (gate.fail) {
        return new Response(JSON.stringify({
          error: { code: "projection_unavailable", message: `Read failed: ${path}` },
        }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(response.status === 204 ? null : body, {
      status: response.status, headers: response.headers,
    });
  };
}

/** Receives the production SSE bytes; only delivery timing is controlled by tests. */
export class HttpEvents extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly received: PublicEvent[] = [];
  readonly ready = deferred();
  readonly done: Promise<void>;
  error: unknown = null;
  paused = false;
  #closed = false;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #queued: PublicEvent[] = [];

  constructor(url: string, browser: ControlledBrowser) {
    super();
    this.done = this.#pump(url, browser).catch((error: unknown) => {
      this.error = error;
      this.ready.resolve();
      this.onerror?.(new Event("error"));
    });
  }

  close(): void {
    this.#closed = true;
    void this.#reader?.cancel();
  }

  resume(): void {
    this.paused = false;
    for (const event of this.#queued.splice(0)) this.#deliver(event);
  }

  #deliver(event: PublicEvent): void {
    if (!this.#closed) {
      this.dispatchEvent(new MessageEvent("torsor", { data: JSON.stringify(event) }));
    }
  }

  async #pump(url: string, browser: ControlledBrowser): Promise<void> {
    const response = await browser.stream(url);
    if (!response.ok || !response.body) throw new Error(`SSE failed: ${response.status}`);
    this.#reader = response.body.getReader();
    if (this.#closed) {
      await this.#reader.cancel();
      this.ready.resolve();
      return;
    }
    this.onopen?.(new Event("open"));
    this.ready.resolve();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!this.#closed) {
      const chunk = await this.#reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame.split("\n").includes("event: torsor")) continue;
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) throw new Error("SSE event has no data.");
        const event = JSON.parse(data.slice(6)) as PublicEvent;
        this.received.push(event);
        if (this.paused) this.#queued.push(event);
        else this.#deliver(event);
      }
    }
  }
}

const bootstrap: KernelBootstrap = {
  principals: [
    { id: "principal-human", kind: "human", displayName: "Avery" },
    { id: "principal-runtime", kind: "runtime", displayName: "Runtime" },
    { id: "principal-orbit", kind: "agent", displayName: "Orbit" },
  ],
  projects: [
    { id: "project-sample", name: "Sample" },
    { id: "project-other", name: "Other" },
  ],
  channels: [
    { id: "channel-general", projectId: "project-sample", name: "general" },
    { id: "channel-other", projectId: "project-other", name: "other" },
  ],
  agents: [{
    id: "agent-orbit", principalId: "principal-orbit", projectId: "project-sample",
    name: "Orbit", configRevision: 1, config: {},
  }],
};

async function seedRun(kernel: TorsorKernel, key: string) {
  const root = await kernel.execute({
    type: "StartThread", idempotencyKey: `${key}-root`,
    projectId: "project-sample", channelId: "channel-general",
    body: `Synthetic ${key}`, targetAgentIds: ["agent-orbit"],
  }, { principalId: "principal-human" });
  const attentions = await kernel.query({
    type: "ListOpenAttentions", projectId: "project-sample", targetAgentId: "agent-orbit",
  }, { principalId: "principal-runtime" });
  const attention = attentions.items.find((item) => item.threadRootId === root.entityId)!;
  const claim = await kernel.execute({
    type: "ClaimAttention", idempotencyKey: `${key}-claim`, attentionId: attention.id,
    expectedAttentionRevision: attention.revision, leaseDurationMs: 30_000,
  }, { principalId: "principal-runtime" });
  const activation = await kernel.execute({
    type: "StartActivation", idempotencyKey: `${key}-activation`,
    attentionId: attention.id, handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
  }, { principalId: "principal-runtime" });
  const result = await kernel.execute({
    type: "ResolveAttentionWithRun", idempotencyKey: `${key}-resolve`,
    attentionId: attention.id, expectedAttentionRevision: claim.revision!,
    handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
  }, { principalId: "principal-orbit", activationId: activation.entityId });
  return { id: result.entityId, threadId: root.entityId };
}

export async function runComposerHttp({
  pauseEvents = false,
  causalLimits,
}: {
  readonly pauseEvents?: boolean;
  readonly causalLimits?: CausalLimits;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "torsor-composer-races-"));
  const kernel = TorsorKernel.open({
    databasePath: join(directory, "state.sqlite"), bootstrap,
    ...(causalLimits ? { causalLimits } : {}),
  });
  const first = await seedRun(kernel, "first");
  const second = await seedRun(kernel, "second");
  const service = createTorsorHttpService({
    kernel, port: 0, eventPollIntervalMs: 5,
    credentials: [{ token: "synthetic-human", principalContext: { principalId: "principal-human" } }],
  });
  const origin = await service.listen();
  const browser = new ControlledBrowser();
  const sources: HttpEvents[] = [];
  const storage = new Map<string, string>();
  const controller = new WebController({
    apiBase: origin, fetch: browser.fetch,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
    },
    eventSourceFactory: (url) => {
      const source = new HttpEvents(url, browser);
      source.paused = pauseEvents;
      sources.push(source);
      return source as unknown as EventSource;
    },
    broadcastChannelFactory: () => Object.assign(new EventTarget(), {
      name: "synthetic", onmessage: null, onmessageerror: null,
      postMessage() {}, close() {},
    }),
    reconnectProbeDelayMs: 60_000,
  });
  await controller.exchangeSession("synthetic-human", "project-sample");
  await sources[0]!.ready.promise;
  await controller.loadRun(first.id);
  await controller.loadThread(first.threadId);
  let activityActivationId: string | null = null;
  let activitySequence = 0;
  return {
    kernel, controller, browser, sources, first, second, origin,
    async appendActivity(count: number) {
      const runtime = { principalId: "principal-runtime" };
      for (let index = 0; !activityActivationId; index += 1) {
        const claimed = await kernel.execute({
          type: "ClaimOutboxEvents", idempotencyKey: `timeline-outbox-${index}`,
          limit: 1, leaseDurationMs: 300_000,
        }, runtime);
        const event = claimed.outboxEvents?.[0];
        if (!event) throw new Error("Expected the first Run's activation event.");
        if (event.aggregateId === first.id && event.topic === "run.activation-requested") {
          const projection = await kernel.query({ type: "GetRunProjection", runId: first.id }, runtime);
          const activation = await kernel.execute({
            type: "StartActivation", idempotencyKey: "timeline-activation",
            runId: first.id, expectedRunRevision: projection.run.revision,
            outboxEventId: event.id, outboxLeaseToken: claimed.leaseToken!,
            durationMs: 300_000,
          }, runtime);
          activityActivationId = activation.entityId;
        }
        await kernel.execute({
          type: "AcknowledgeOutboxEvents", idempotencyKey: `timeline-ack-${index}`,
          outboxEventIds: [event.id], leaseToken: claimed.leaseToken!,
        }, runtime);
      }
      for (let index = 0; index < count; index += 1) {
        activitySequence += 1;
        await kernel.execute({
          type: "AppendRunActivity", idempotencyKey: `timeline-${activitySequence}`,
          runId: first.id, activationId: activityActivationId,
          kind: "agent_message_chunk", payload: { text: `Synthetic output ${activitySequence}` },
          retentionClass: "transient",
        }, runtime);
      }
    },
    async reply(body: string) {
      const response = await fetch(`${origin}/api/v1/commands/reply-to-thread`, {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-human", "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), threadRootId: first.threadId, body }),
      });
      if (!response.ok) throw new Error(`Reply failed: ${response.status}`);
    },
    async close() {
      browser.releaseAll();
      controller.dispose();
      await Promise.all(sources.map((source) => source.done));
      await service.close();
      kernel.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
