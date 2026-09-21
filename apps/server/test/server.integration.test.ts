import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  TorsorKernel,
  type KernelBootstrap,
  type PrincipalContext,
  type PublicEventEnvelope,
} from "@torsor/kernel";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTorsorHttpService,
  type LocalCredential,
  type TorsorHttpService,
} from "../src/index.js";

const bootstrap: KernelBootstrap = {
  principals: [
    { id: "principal-human", kind: "human", displayName: "Avery Stone" },
    { id: "principal-riley", kind: "human", displayName: "Riley Park" },
    { id: "principal-runtime", kind: "runtime", displayName: "Local Runtime" },
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
      configRevision: 3,
      config: { model: "deterministic-fake", mode: "read-only" },
    },
  ],
};

const humanContext = { principalId: "principal-human" } as const;
const runtimeContext = { principalId: "principal-runtime" } as const;
const credentials: readonly LocalCredential[] = [
  { token: "human-token", principalContext: humanContext },
  {
    token: "riley-token",
    principalContext: { principalId: "principal-riley" },
  },
];

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe("Torsor HTTP and SSE service", () => {
  it("maps authenticated commands and rejects caller-supplied provenance", async () => {
    const harness = await startHarness();

    const forged = await command(
      harness.origin,
      "start-thread",
      {
        idempotencyKey: "forged-provenance",
        projectId: "project-sample",
        channelId: "channel-general",
        body: "This must not be accepted.",
        authorPrincipalId: "principal-riley",
      },
    );
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const created = await command(
      harness.origin,
      "start-thread",
      {
        idempotencyKey: "authenticated-thread",
        projectId: "project-sample",
        channelId: "channel-general",
        body: "A durable local request.",
      },
      "human-token",
      { "X-Torsor-Principal": "principal-riley" },
    );
    expect(created.status).toBe(200);
    const events = await collectEvents(harness.origin, null, 1);
    expect(events[0]).toMatchObject({
      type: "MessagePublished",
      actorPrincipalId: "principal-human",
      activationId: null,
    });
  });

  it("preserves revision conflicts as structured HTTP errors", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    const seeded = await seedRun(databasePath);
    const harness = await startHarness({ databasePath });

    const first = await command(harness.origin, "send-to-run", {
      idempotencyKey: "send-first",
      runId: seeded.runId,
      expectedRunRevision: 1,
      body: "Add this input.",
    });
    expect(first.status).toBe(200);

    const stale = await command(harness.origin, "send-to-run", {
      idempotencyKey: "send-stale",
      runId: seeded.runId,
      expectedRunRevision: 1,
      body: "This uses an old revision.",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: {
        code: "stale_revision",
        details: { expectedRevision: 1, actualRevision: 2 },
      },
    });
  });

  it("hands off bootstrap to SSE without missing durable events", async () => {
    const harness = await startHarness();
    await command(harness.origin, "start-thread", {
      idempotencyKey: "before-bootstrap",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Already represented in bootstrap.",
    });
    const snapshot = await bootstrapProjection(harness.origin);

    const created = await command(harness.origin, "start-thread", {
      idempotencyKey: "after-bootstrap",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Must arrive on the stream.",
    });
    const createdBody = (await created.json()) as {
      result: { entityId: string };
    };
    const events = await collectEvents(
      harness.origin,
      snapshot.latestEventId,
      1,
    );
    expect(events[0]).toMatchObject({
      type: "MessagePublished",
      entityId: createdBody.result.entityId,
    });
  });

  it("supports an HttpOnly browser session for native EventSource clients", async () => {
    const harness = await startHarness();
    const session = await fetch(`${harness.origin}/api/v1/session`, {
      method: "POST",
      headers: authorization(),
    });
    expect(session.status).toBe(201);
    const cookie = session.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const snapshotResponse = await fetch(
      `${harness.origin}/api/v1/projects/project-sample/bootstrap`,
      { headers: { Cookie: cookie! } },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshotBody = (await snapshotResponse.json()) as {
      bootstrap: { latestEventId: string | null };
    };

    const eventPromise = collectEventsWithHeaders(
      harness.origin,
      snapshotBody.bootstrap.latestEventId,
      1,
      { Cookie: cookie! },
    );
    await command(harness.origin, "start-thread", {
      idempotencyKey: "browser-session-event",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Native EventSource receives this with its session cookie.",
    });
    expect(await eventPromise).toHaveLength(1);
  });

  it("requires JSON and a CSRF token for cookie-authenticated commands", async () => {
    const harness = await startHarness();
    const session = await fetch(`${harness.origin}/api/v1/session`, {
      method: "POST",
      headers: authorization(),
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const sessionBody = (await session.json()) as { csrfToken: string };

    const unsafe = await fetch(
      `${harness.origin}/api/v1/commands/start-thread`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "text/plain",
          Origin: "http://127.0.0.1:9999",
        },
        body: JSON.stringify({
          idempotencyKey: "unsafe-cookie-command",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "This request must be rejected.",
        }),
      },
    );
    expect(unsafe.status).toBe(415);

    const safe = await fetch(
      `${harness.origin}/api/v1/commands/start-thread`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-Torsor-CSRF": sessionBody.csrfToken,
        },
        body: JSON.stringify({
          idempotencyKey: "safe-cookie-command",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "This request carries the session CSRF token.",
        }),
      },
    );
    expect(safe.status).toBe(200);
  });

  it("expires browser sessions on the server", async () => {
    const harness = await startHarness({ sessionDurationMs: 20 });
    const session = await fetch(`${harness.origin}/api/v1/session`, {
      method: "POST",
      headers: authorization(),
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const expired = await fetch(
      `${harness.origin}/api/v1/projects/project-sample/bootstrap`,
      { headers: { Cookie: cookie } },
    );
    expect(expired.status).toBe(401);
  });

  it("closes an existing SSE stream when its browser session expires", async () => {
    const harness = await startHarness({
      sessionDurationMs: 100,
      eventPollIntervalMs: 5,
    });
    const session = await fetch(`${harness.origin}/api/v1/session`, {
      method: "POST",
      headers: authorization(),
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const response = await fetch(
      `${harness.origin}/api/v1/events?projectId=project-sample`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await waitFor(() => harness.service.activeEventStreamCount === 1);

    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("The expired SSE stream stayed open.")),
          1_000,
        ),
      ),
    ]);
    expect(result.done).toBe(true);
    await waitFor(() => harness.service.activeEventStreamCount === 0);
  });

  it("reconnects with Last-Event-ID and replays in durable order", async () => {
    const harness = await startHarness();
    const snapshot = await bootstrapProjection(harness.origin);
    await command(harness.origin, "start-thread", {
      idempotencyKey: "replay-one",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "First replay event.",
    });
    await command(harness.origin, "start-thread", {
      idempotencyKey: "replay-two",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Second replay event.",
    });

    const first = await collectEvents(
      harness.origin,
      snapshot.latestEventId,
      1,
    );
    const second = await collectEventsWithHeaders(
      harness.origin,
      snapshot.latestEventId,
      1,
      {
        ...authorization(),
        "Last-Event-ID": first[0]!.eventId,
      },
    );
    const firstEvent = first[0]!;
    const secondEvent = second[0]!;
    expect(firstEvent.eventId).not.toBe(secondEvent.eventId);
    expect(firstEvent.occurredAt <= secondEvent.occurredAt).toBe(true);
  });

  it("shares durable data across concurrent clients while pagination stays stable", async () => {
    const harness = await startHarness();
    const [left, right] = await Promise.all([
      command(
        harness.origin,
        "start-thread",
        {
          idempotencyKey: "concurrent-left",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Created from one window.",
        },
        "human-token",
      ),
      command(
        harness.origin,
        "start-thread",
        {
          idempotencyKey: "concurrent-right",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Created from another window.",
        },
        "riley-token",
      ),
    ]);
    expect([left.status, right.status]).toEqual([200, 200]);

    const firstPage = await jsonRequest<{
      items: readonly unknown[];
      hasMore: boolean;
      nextCursor: string;
      snapshotEventId: string;
    }>(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample&limit=1`,
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await jsonRequest<{ items: readonly unknown[] }>(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample&limit=1&after=${encodeURIComponent(firstPage.nextCursor)}&snapshot=${encodeURIComponent(firstPage.snapshotEventId)}`,
    );
    expect(secondPage.items).toHaveLength(1);
  });

  it("rejects reversed and nonexistent pagination windows", async () => {
    const harness = await startHarness();
    await command(harness.origin, "start-thread", {
      idempotencyKey: "window-one",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "First pagination item.",
    });
    const older = await bootstrapProjection(harness.origin);
    await command(harness.origin, "start-thread", {
      idempotencyKey: "window-two",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Second pagination item.",
    });
    const newer = await bootstrapProjection(harness.origin);

    const reversed = await fetch(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample&limit=1&after=${encodeURIComponent(newer.latestEventId!)}&snapshot=${encodeURIComponent(older.latestEventId!)}`,
      { headers: authorization() },
    );
    expect(reversed.status).toBe(400);
    expect(await reversed.json()).toMatchObject({
      error: { code: "invalid_cursor_window" },
    });

    const nonexistent = await fetch(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample&after=event-missing&snapshot=event-missing`,
      { headers: authorization() },
    );
    expect(nonexistent.status).toBe(404);
    expect(await nonexistent.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("isolates a slow stream and cleans up disconnected clients", async () => {
    const harness = await startHarness({
      eventBatchSize: 1,
      eventPollIntervalMs: 5,
      heartbeatIntervalMs: 20,
    });
    const slowController = new AbortController();
    const slow = await fetch(
      `${harness.origin}/api/v1/events?projectId=project-sample`,
      {
        headers: authorization(),
        signal: slowController.signal,
      },
    );
    expect(slow.status).toBe(200);
    await waitFor(() => harness.service.activeEventStreamCount === 1);

    for (let index = 0; index < 12; index += 1) {
      const response = await command(harness.origin, "start-thread", {
        idempotencyKey: `slow-client-${index}`,
        projectId: "project-sample",
        channelId: "channel-general",
        body: `Event ${index} ${"x".repeat(4_096)}`,
      });
      expect(response.status).toBe(200);
    }
    const snapshot = await bootstrapProjection(harness.origin);
    const fastEventPromise = collectEvents(
      harness.origin,
      snapshot.latestEventId,
      1,
    );
    await command(harness.origin, "start-thread", {
      idempotencyKey: "fast-client-event",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "A fast client still receives this.",
    });
    expect(await fastEventPromise).toHaveLength(1);

    slowController.abort();
    await waitFor(() => harness.service.activeEventStreamCount === 0);
  });

  it("reopens the same database and preserves query and replay state", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    const first = await startHarness({ databasePath });
    const created = await command(first.origin, "start-thread", {
      idempotencyKey: "before-restart",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "Persist across the server restart.",
    });
    const body = (await created.json()) as { result: { entityId: string } };
    await first.service.close();

    const second = await startHarness({ databasePath });
    const thread = await jsonRequest<{
      thread: { threadRootId: string; messages: readonly unknown[] };
    }>(`${second.origin}/api/v1/threads/${body.result.entityId}`);
    expect(thread.thread).toMatchObject({
      threadRootId: body.result.entityId,
    });
    expect(thread.thread.messages).toHaveLength(1);

    const replay = await collectEvents(second.origin, null, 1);
    expect(replay[0]?.entityId).toBe(body.result.entityId);
  });

  it("reports agent configuration and current durable status", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    await seedRun(databasePath);
    const harness = await startHarness({ databasePath });
    const agents = await jsonRequest<{
      items: ReadonlyArray<{
        id: string;
        configRevision: number;
        config: unknown;
        status: string;
        runCounts: { active: number };
      }>;
    }>(`${harness.origin}/api/v1/projects/project-sample/agents`);
    expect(agents.items[0]).toMatchObject({
      id: "agent-orbit",
      configRevision: 3,
      config: { model: "deterministic-fake", mode: "read-only" },
      status: "active",
      runCounts: { active: 1 },
    });
  });

  it("applies Kernel activation scope before exposing events to an Agent", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    const seeded = await seedRun(databasePath);
    const kernel = TorsorKernel.open({ databasePath, bootstrap });
    let activationId: string | undefined;
    let cursor: string | null = null;
    try {
      const run = await kernel.query(
        { type: "GetRunProjection", runId: seeded.runId },
        humanContext,
      );
      const activation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "agent-event-scope",
          runId: seeded.runId,
          expectedRunRevision: run.run.revision,
        },
        runtimeContext,
      );
      activationId = activation.entityId;
      cursor = (
        await kernel.query(
          { type: "GetBootstrap", projectId: "project-sample" },
          humanContext,
        )
      ).latestEventId;
      await kernel.execute(
        {
          type: "StartThread",
          idempotencyKey: "unrelated-agent-event",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "This unrelated Thread is outside the Activation scope.",
        },
        humanContext,
      );
    } finally {
      kernel.close();
    }
    expect(activationId).toBeTruthy();
    const service = createTorsorHttpService({
      databasePath,
      bootstrap,
      credentials: [
        {
          token: "agent-token",
          principalContext: {
            principalId: "principal-orbit",
            activationId: activationId!,
          },
        },
      ],
      port: 0,
      eventPollIntervalMs: 5,
      heartbeatIntervalMs: 20,
    });
    const origin = await service.listen();
    cleanup.push(() => service.close());
    const controller = new AbortController();
    const url = new URL(`${origin}/api/v1/events`);
    url.searchParams.set("projectId", "project-sample");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    const response = await fetch(
      url,
      {
        headers: authorization("agent-token"),
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const text = new TextDecoder().decode(firstChunk.value);
    expect(text).toMatch(/^: heartbeat /);
  });

  it("rejects incompatible development schemas on service startup", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA user_version = 99;");
    database.close();

    expect(() =>
      createTorsorHttpService({
        databasePath,
        bootstrap,
        credentials,
        port: 0,
      }),
    ).toThrow(/Incompatible development database schema version 99/);
  });

  it("closes promptly when a client leaves a command body incomplete", async () => {
    const harness = await startHarness();
    const address = new URL(harness.origin);
    const socket = createConnection({
      host: address.hostname,
      port: Number(address.port),
    });
    await once(socket, "connect");
    socket.write(
      [
        "POST /api/v1/commands/start-thread HTTP/1.1",
        `Host: ${address.host}`,
        "Authorization: Bearer human-token",
        "Content-Type: application/json",
        "Content-Length: 1000",
        "",
        "{",
      ].join("\r\n"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    await Promise.race([
      harness.service.close(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Service shutdown waited on an incomplete body.")),
          1_000,
        ),
      ),
    ]);
    socket.destroy();
  });
});

interface Harness {
  readonly service: TorsorHttpService;
  readonly origin: string;
}

async function startHarness(
  options: {
    readonly databasePath?: string;
    readonly eventBatchSize?: number;
    readonly eventPollIntervalMs?: number;
    readonly heartbeatIntervalMs?: number;
    readonly sessionDurationMs?: number;
  } = {},
): Promise<Harness> {
  const databasePath =
    options.databasePath ?? join(await temporaryDirectory(), "torsor.sqlite");
  const service = createTorsorHttpService({
    databasePath,
    bootstrap,
    credentials,
    port: 0,
    ...(options.eventBatchSize
      ? { eventBatchSize: options.eventBatchSize }
      : {}),
    ...(options.eventPollIntervalMs
      ? { eventPollIntervalMs: options.eventPollIntervalMs }
      : {}),
    ...(options.heartbeatIntervalMs
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
    ...(options.sessionDurationMs
      ? { sessionDurationMs: options.sessionDurationMs }
      : {}),
  });
  const origin = await service.listen();
  cleanup.push(() => service.close());
  return { service, origin };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "torsor-server-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function seedRun(
  databasePath: string,
): Promise<{ readonly runId: string }> {
  const kernel = TorsorKernel.open({ databasePath, bootstrap });
  try {
    const thread = await kernel.execute(
      {
        type: "StartThread",
        idempotencyKey: "seed-thread",
        projectId: "project-sample",
        channelId: "channel-general",
        body: "Orbit, create a durable Run.",
        targetAgentIds: ["agent-orbit"],
      },
      humanContext,
    );
    const attentionPage = await kernel.query(
      {
        type: "ListOpenAttentions",
        projectId: "project-sample",
        targetAgentId: "agent-orbit",
      },
      runtimeContext,
    );
    const attention = attentionPage.items[0]!;
    const claim = await kernel.execute(
      {
        type: "ClaimAttention",
        idempotencyKey: "seed-claim",
        attentionId: attention.id,
        expectedAttentionRevision: attention.revision,
        leaseDurationMs: 30_000,
      },
      runtimeContext,
    );
    const activation = await kernel.execute(
      {
        type: "StartActivation",
        idempotencyKey: "seed-attention-activation",
        attentionId: attention.id,
        handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
      },
      runtimeContext,
    );
    const run = await kernel.execute(
      {
        type: "ResolveAttentionWithRun",
        idempotencyKey: "seed-run",
        attentionId: attention.id,
        expectedAttentionRevision: claim.revision!,
        handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
      },
      {
        principalId: "principal-orbit",
        activationId: activation.entityId,
      },
    );
    expect(thread.entityId).toBeTruthy();
    return { runId: run.entityId };
  } finally {
    kernel.close();
  }
}

async function command(
  origin: string,
  slug: string,
  body: unknown,
  token = "human-token",
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(`${origin}/api/v1/commands/${slug}`, {
    method: "POST",
    headers: {
      ...authorization(token),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function bootstrapProjection(
  origin: string,
): Promise<{ readonly latestEventId: string | null }> {
  const body = await jsonRequest<{
    bootstrap: { latestEventId: string | null };
  }>(`${origin}/api/v1/projects/project-sample/bootstrap`);
  return body.bootstrap;
}

async function jsonRequest<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authorization() });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function authorization(token = "human-token"): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function collectEvents(
  origin: string,
  cursor: string | null,
  count: number,
  lastEventId?: string,
): Promise<readonly PublicEventEnvelope[]> {
  return collectEventsWithHeaders(
    origin,
    cursor,
    count,
    {
      ...authorization(),
      ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
    },
  );
}

async function collectEventsWithHeaders(
  origin: string,
  cursor: string | null,
  count: number,
  headers: Readonly<Record<string, string>>,
): Promise<readonly PublicEventEnvelope[]> {
  const controller = new AbortController();
  const url = new URL(`${origin}/api/v1/events`);
  url.searchParams.set("projectId", "project-sample");
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  const response = await fetch(url, {
    headers,
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const events: PublicEventEnvelope[] = [];
  try {
    while (events.length < count) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      buffered += decoder.decode(result.value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (data) {
          events.push(
            JSON.parse(data.slice("data: ".length)) as PublicEventEnvelope,
          );
        }
        boundary = buffered.indexOf("\n\n");
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the expected server state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
