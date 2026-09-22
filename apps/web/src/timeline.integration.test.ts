// @vitest-environment node
/// <reference types="node" />

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRuntime, CopilotAcpAdapter, DeterministicFakeAdapter } from "@torsor/agent-runtime";
import { TorsorKernel, type KernelBootstrap } from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";
import { createTorsorHttpService } from "../../server/src/index";
import { WebController } from "./controller";
import type { PublicEvent, RunProjection, ThreadProjection } from "./types";
import type { ActivityPage } from "./timeline-history";

const seed: KernelBootstrap = {
  principals: [
    { id: "human", kind: "human", displayName: "Avery" },
    { id: "runtime", kind: "runtime", displayName: "Runtime" },
    { id: "agent-principal", kind: "agent", displayName: "Orbit" },
  ],
  projects: [{ id: "project", name: "Synthetic Timeline" }],
  channels: [{ id: "channel", projectId: "project", name: "general" }],
  agents: [{ id: "agent", principalId: "agent-principal", projectId: "project", name: "Orbit", configRevision: 1, config: {} }],
};

describe("durable Live Timeline public path", () => {
  it("projects real ACP deltas through SQLite, paged HTTP and replayed SSE without implicit Messages or completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-timeline-"));
    const databasePath = join(directory, "timeline.sqlite");
    const kernel = TorsorKernel.open({ databasePath, bootstrap: seed });
    const service = createTorsorHttpService({
      databasePath, bootstrap: seed, port: 0,
      credentials: [{ token: "synthetic-human", principalContext: { principalId: "human" } }],
    });
    const sources: ReplaySource[] = [];
    const controllers: WebController[] = [];
    const origin = await service.listen();
    let cookie = "";
    const browserFetch: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("Cookie", cookie);
      const response = await fetch(url, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      return response;
    };
    function createController() {
      const values = new Map<string, string>();
      const controller = new WebController({
        apiBase: origin, fetch: browserFetch,
        sessionStorage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => { values.set(key, value); },
          removeItem: (key) => { values.delete(key); },
        },
        eventSourceFactory: (url) => {
          const source = new ReplaySource(url);
          sources.push(source);
          return source as unknown as EventSource;
        },
        broadcastChannelFactory: () => ({
          postMessage() {}, close() {}, onmessage: null,
        }) as unknown as BroadcastChannel,
      });
      controllers.push(controller);
      return controller;
    }
    try {
      const controller = createController();
      await controller.exchangeSession("synthetic-human", "project");
      await controller.startThread({
        channelId: "channel", body: "Observe this synthetic Run.", targetAgentIds: ["agent"],
      });
      const runtimeOptions = { kernel, runtimePrincipalId: "runtime", projectIds: ["project"], outboxBatchSize: 1 };
      const attentionRuntime = new AgentRuntime({
        ...runtimeOptions, adapter: new DeterministicFakeAdapter(),
      });
      await attentionRuntime.runOnce();
      const runPage = await kernel.query({ type: "ListRunProjections", projectId: "project" }, { principalId: "human" });
      const runId = runPage.items[0]!.run.id;
      const threadId = runPage.items[0]!.run.threadRootId;
      await controller.loadRun(runId);
      const before = controller.getSnapshot().run!;
      expect(before.run.state).toBe("Active");
      expect(before.activity.items).toHaveLength(0);
      const bootstrap = await kernel.query({ type: "GetBootstrap", projectId: "project" }, { principalId: "human" });

      const fixtureUpdateBound = 256;
      const adapter = new CopilotAcpAdapter({
        command: process.execPath,
        commandArgs: [fileURLToPath(new URL("../../../packages/agent-runtime/test/fixtures/mock-acp-server.mjs", import.meta.url)), "slow-split", "4"],
        unsafeAllowCustomCommandArgs: true,
        cwd: process.cwd(),
        // A loaded runner may deliver the entire bounded transcript in one pipe
        // read. This projection test must not depend on notification scheduling.
        limits: { maxPendingPersistenceOperations: fixtureUpdateBound },
      });
      const runtime = new AgentRuntime({ ...runtimeOptions, adapter });
      const execution = runtime.drainUntilIdle();
      // Inspect through HTTP before the explicit action plan can complete.
      await vi.waitFor(async () => {
        const response = await browserFetch(`${origin}/api/v1/runs/${runId}`);
        const body = await response.json() as { run: RunProjection };
        expect(body.run.activity.items.length).toBeGreaterThan(0);
        expect(body.run.run.state).toBe("Active");
        expect(body.run.inputs[0]?.disposition).toBe("Pending");
        const thread = await browserFetch(`${origin}/api/v1/threads/${threadId}`);
        expect((await thread.json() as { thread: ThreadProjection }).thread.messages).toHaveLength(1);
      }, { timeout: 5000, interval: 10 });
      await execution;

      const finished = await kernel.query({ type: "GetBootstrap", projectId: "project" }, { principalId: "human" });
      const events = await readSse(
        `${origin}/api/v1/events?projectId=project&cursor=${bootstrap.latestEventId}`,
        cookie, finished.latestEventId!,
      );
      const activityEvents = events.filter((event) => event.type === "RunActivityAppended");
      expect(activityEvents.length).toBeGreaterThan(100);
      expect(activityEvents.length).toBeLessThanOrEqual(fixtureUpdateBound);
      expect(activityEvents[0]?.payload).not.toHaveProperty("text");
      for (const event of [...events].reverse()) sources[0]!.emit(event);
      for (const event of activityEvents) sources[0]!.emit(event);
      await vi.waitFor(() => {
        expect(controller.getSnapshot().run?.run.state).toBe("Completed");
        expect(controller.getSnapshot().run?.activity.items).toHaveLength(activityEvents.length);
      }, { timeout: 5000 });
      const projected = controller.getSnapshot().run!;
      expect(controller.getSnapshot().queryError).toBeNull();
      expect(projected.activity.items.map((event) => event.sequence)).toEqual(
        Array.from({ length: activityEvents.length }, (_, index) => index + 1),
      );
      expect(projected.activity.items[0]).toMatchObject({
        kind: "agent_message_chunk",
        activationId: projected.activations[0]!.id,
        providerAttemptId: projected.providerAttempts[0]!.id,
        retentionClass: "transient",
      });
      const finalThread = await browserFetch(`${origin}/api/v1/threads/${threadId}`);
      expect((await finalThread.json() as { thread: ThreadProjection }).thread.messages).toHaveLength(2);

      const fresh = createController();
      await fresh.exchangeSession("synthetic-human", "project");
      await fresh.loadRun(runId);
      expect(fresh.getSnapshot().run?.activity.items).toHaveLength(100);
      expect(await fresh.loadEarlierRunActivity()).toBe(true);
      expect(fresh.getSnapshot().run?.activity.items).toHaveLength(activityEvents.length);
      expect(fresh.getSnapshot().run?.activity.hasEarlier).toBe(false);

      const page = await browserFetch(`${origin}/api/v1/runs/${runId}/activity?beforeSequence=101&limit=40`);
      const body = await page.json() as ActivityPage;
      expect(body.items.map((event) => event.sequence)).toEqual(Array.from({ length: 40 }, (_, i) => i + 61));
      expect(body.nextCursor).toBe(61);
      expect((await fetch(`${origin}/api/v1/runs/${runId}/activity?beforeSequence=101`)).status).toBe(401);
      expect((await browserFetch(`${origin}/api/v1/runs/${runId}/activity?beforeSequence=-1`)).status).toBe(400);
      expect((await browserFetch(`${origin}/api/v1/runs/${runId}/activity?limit=501`)).status).toBe(400);
    } finally {
      for (const controller of controllers) controller.dispose();
      await service.close();
      kernel.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

class ReplaySource extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) { super(); }
  close() {}
  emit(event: PublicEvent) {
    const message = new MessageEvent("torsor", { data: JSON.stringify(event), lastEventId: event.eventId });
    this.dispatchEvent(message);
  }
}

async function readSse(url: string, cookie: string, through: string): Promise<PublicEvent[]> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  const events: PublicEvent[] = [];
  try {
    const response = await fetch(url, { headers: { Cookie: cookie }, signal: abort.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before its durable cursor.");
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6)) as PublicEvent;
        events.push(event);
        if (event.eventId === through) return events;
      }
    }
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}
