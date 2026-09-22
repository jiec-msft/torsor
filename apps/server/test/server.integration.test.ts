import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
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
  projects: [
    { id: "project-sample", name: "Sample Project" },
    { id: "project-other", name: "Other Project" },
  ],
  channels: [
    {
      id: "channel-general",
      projectId: "project-sample",
      name: "general",
    },
    {
      id: "channel-other",
      projectId: "project-other",
      name: "other",
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
  it.each([
    { causalRootId: "forged-root" },
    { parentRunId: "forged-parent" },
    { delegationDepth: 0 },
    { causalLimits: { maxDepth: 999, maxNonTerminalRunsPerRoot: 999 } },
  ])("rejects causal overrides at the HTTP boundary: %j", async (forged) => {
    const harness = await startHarness();
    const response = await command(harness.origin, "start-thread", {
      idempotencyKey: "forged-causal",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "This request must not publish.",
      ...forged,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_command" },
    });
    const retry = await command(harness.origin, "start-thread", {
      idempotencyKey: "forged-causal",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "This request must not publish.",
    });
    expect(retry.status).toBe(200);
  });

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
    const sessionBody = (await session.json()) as {
      principalId: string;
      csrfToken: string;
    };
    expect(sessionBody.principalId).toBe("principal-human");

    const reused = await fetch(`${harness.origin}/api/v1/session`, {
      method: "POST",
      headers: {
        ...authorization(),
        Cookie: cookie!,
      },
    });
    expect(reused.status).toBe(201);
    expect(await reused.json()).toEqual(sessionBody);
    expect(reused.headers.get("set-cookie")?.split(";", 1)[0]).toBe(
      cookie?.split(";", 1)[0],
    );

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

  it("isolates sessions created by independent cookie jars", async () => {
    const harness = await startHarness();
    const first = await createBrowserSession(harness.origin);
    const second = await createBrowserSession(harness.origin);
    expect(first.cookie).not.toBe(second.cookie);
    expect(first.csrfToken).not.toBe(second.csrfToken);

    const snapshotResponse = await fetch(
      `${harness.origin}/api/v1/projects/project-sample/bootstrap`,
      { headers: { Cookie: second.cookie } },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      bootstrap: { latestEventId: string | null };
    };
    const eventPromise = collectEventsWithHeaders(
      harness.origin,
      snapshot.bootstrap.latestEventId,
      1,
      { Cookie: second.cookie },
    );

    const signedOut = await fetch(`${harness.origin}/api/v1/session`, {
      method: "DELETE",
      headers: { Cookie: first.cookie },
    });
    expect(signedOut.status).toBe(204);
    const revoked = await fetch(
      `${harness.origin}/api/v1/projects/project-sample/bootstrap`,
      { headers: { Cookie: first.cookie } },
    );
    expect(revoked.status).toBe(401);
    const stillAuthenticated = await fetch(
      `${harness.origin}/api/v1/projects/project-sample/bootstrap`,
      { headers: { Cookie: second.cookie } },
    );
    expect(stillAuthenticated.status).toBe(200);

    const created = await fetch(
      `${harness.origin}/api/v1/commands/start-thread`,
      {
        method: "POST",
        headers: {
          Cookie: second.cookie,
          "Content-Type": "application/json",
          "X-Torsor-CSRF": second.csrfToken,
        },
        body: JSON.stringify({
          idempotencyKey: "independent-browser-session",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "The second browser remains independently authenticated.",
        }),
      },
    );
    expect(created.status).toBe(200);
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

  it("rejects commands when a browser session expires or is revoked while reading the body", async () => {
    const harness = await startHarness({ sessionDurationMs: 150 });
    const expiring = await createBrowserSession(harness.origin);
    const expiredResponse = await sendPartialCookieCommand(
      harness.origin,
      expiring,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 180));
      },
      "expired-partial-body",
    );
    expect(expiredResponse).toContain("HTTP/1.1 401");
    expect(expiredResponse).toContain('"code":"unauthorized"');

    const revocable = await createBrowserSession(harness.origin);
    const revokedResponse = await sendPartialCookieCommand(
      harness.origin,
      revocable,
      async () => {
        const deleted = await fetch(`${harness.origin}/api/v1/session`, {
          method: "DELETE",
          headers: { Cookie: revocable.cookie },
        });
        expect(deleted.status).toBe(204);
      },
      "revoked-partial-body",
    );
    expect(revokedResponse).toContain("HTTP/1.1 401");
    expect(revokedResponse).toContain('"code":"unauthorized"');

    const threads = await jsonRequest<{ items: readonly unknown[] }>(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample`,
    );
    expect(threads.items).toEqual([]);
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

  it("replays through bounded authorized event queries without Thread projection rebuilds", async () => {
    const harness = await startHarness({ eventBatchSize: 5 });
    for (let index = 0; index < 20; index += 1) {
      await command(harness.origin, "start-thread", {
        idempotencyKey: `bounded-replay-${index}`,
        projectId: "project-sample",
        channelId: "channel-general",
        body: `Bounded replay event ${index}.`,
      });
    }

    const eventQueryHook = Symbol.for(
      "torsor.kernel.authorized-public-event-query",
    );
    const originalQuery = Reflect.get(
      TorsorKernel.prototype,
      "query",
    ) as Function;
    let eventQueryCount = 0;
    let threadProjectionQueryCount = 0;
    Reflect.set(globalThis, eventQueryHook, () => {
      eventQueryCount += 1;
    });
    Reflect.set(
      TorsorKernel.prototype,
      "query",
      function (
        this: TorsorKernel,
        query: Readonly<{ type: string }>,
        context: PrincipalContext,
      ) {
        if (query.type === "GetThreadProjection") {
          threadProjectionQueryCount += 1;
        }
        return Reflect.apply(originalQuery, this, [query, context]);
      },
    );
    try {
      const events = await collectEvents(harness.origin, null, 20);
      expect(events).toHaveLength(20);
    } finally {
      Reflect.deleteProperty(globalThis, eventQueryHook);
      Reflect.set(TorsorKernel.prototype, "query", originalQuery);
    }
    expect(eventQueryCount).toBeGreaterThanOrEqual(4);
    expect(eventQueryCount).toBeLessThanOrEqual(6);
    expect(threadProjectionQueryCount).toBe(0);
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

  it("returns Thread and Run projections exactly as of the first-page snapshot", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    const firstRun = await seedRun(databasePath, "snapshot-run-first");
    const secondRun = await seedRun(databasePath, "snapshot-run-second");
    const harness = await startHarness({ databasePath });

    const firstThreadPage = await jsonRequest<{
      items: ReadonlyArray<{ threadRootId: string }>;
      nextCursor: string;
      snapshotEventId: string;
    }>(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample&limit=1`,
    );
    const historicalThreads = await jsonRequest<{
      items: ReadonlyArray<{
        threadRootId: string;
        messages: readonly unknown[];
      }>;
    }>(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample&limit=10&snapshot=${encodeURIComponent(firstThreadPage.snapshotEventId)}`,
    );
    const secondThread = historicalThreads.items.find(
      (thread) => thread.threadRootId !== firstThreadPage.items[0]!.threadRootId,
    )!;

    await command(harness.origin, "reply-to-thread", {
      idempotencyKey: "snapshot-thread-mutation",
      threadRootId: secondThread.threadRootId,
      body: "This reply is newer than the page snapshot.",
    });
    await command(harness.origin, "start-thread", {
      idempotencyKey: "snapshot-thread-late",
      projectId: "project-sample",
      channelId: "channel-general",
      body: "This Thread is newer than the page snapshot.",
    });

    const secondThreadPage = await jsonRequest<{
      items: ReadonlyArray<{ messages: readonly unknown[] }>;
      hasMore: boolean;
      snapshotEventId: string;
    }>(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample&limit=1&after=${encodeURIComponent(firstThreadPage.nextCursor)}&snapshot=${encodeURIComponent(firstThreadPage.snapshotEventId)}`,
    );
    expect(secondThreadPage.items[0]?.messages).toHaveLength(1);
    expect(secondThreadPage.hasMore).toBe(false);
    expect(secondThreadPage.snapshotEventId).toBe(
      firstThreadPage.snapshotEventId,
    );

    const firstRunPage = await jsonRequest<{
      items: ReadonlyArray<{ run: { id: string } }>;
      nextCursor: string;
      snapshotEventId: string;
    }>(
      `${harness.origin}/api/v1/projects/project-sample/runs?limit=1`,
    );
    const secondRunId =
      firstRunPage.items[0]!.run.id === firstRun.runId
        ? secondRun.runId
        : firstRun.runId;
    await command(harness.origin, "send-to-run", {
      idempotencyKey: "snapshot-run-mutation",
      runId: secondRunId,
      expectedRunRevision: 1,
      body: "This RunInput is newer than the page snapshot.",
    });
    await seedRun(databasePath, "snapshot-run-late");

    const secondRunPage = await jsonRequest<{
      items: ReadonlyArray<{
        run: { id: string; revision: number };
        inputs: readonly unknown[];
      }>;
      hasMore: boolean;
      snapshotEventId: string;
    }>(
      `${harness.origin}/api/v1/projects/project-sample/runs?limit=1&after=${encodeURIComponent(firstRunPage.nextCursor)}&snapshot=${encodeURIComponent(firstRunPage.snapshotEventId)}`,
    );
    expect(secondRunPage.items[0]).toMatchObject({
      run: { id: secondRunId, revision: 1 },
    });
    expect(secondRunPage.items[0]?.inputs).toHaveLength(1);
    expect(secondRunPage.hasMore).toBe(false);
    expect(secondRunPage.snapshotEventId).toBe(firstRunPage.snapshotEventId);
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
      error: { code: "invalid_command" },
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

  it("does not distinguish foreign Project cursors from nonexistent cursors", async () => {
    const harness = await startHarness();
    await command(harness.origin, "start-thread", {
      idempotencyKey: "foreign-cursor-thread",
      projectId: "project-other",
      channelId: "channel-other",
      body: "This cursor belongs to another Project.",
    });
    const foreignPage = await jsonRequest<{ snapshotEventId: string }>(
      `${harness.origin}/api/v1/channels/channel-other/threads?projectId=project-other`,
    );

    const capture = async (url: string) => {
      const response = await fetch(url, { headers: authorization() });
      const body = (await response.json()) as {
        error?: { requestId?: string; [key: string]: unknown };
      };
      if (body.error) {
        delete body.error.requestId;
      }
      return {
        status: response.status,
        body,
      };
    };
    const foreignProjection = await capture(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample&snapshot=${encodeURIComponent(foreignPage.snapshotEventId)}`,
    );
    const missingProjection = await capture(
      `${harness.origin}/api/v1/channels/channel-general/threads?projectId=project-sample&snapshot=event-does-not-exist`,
    );
    expect(foreignProjection).toEqual(missingProjection);

    const foreignReplay = await capture(
      `${harness.origin}/api/v1/events?projectId=project-sample&cursor=${encodeURIComponent(foreignPage.snapshotEventId)}`,
    );
    const missingReplay = await capture(
      `${harness.origin}/api/v1/events?projectId=project-sample&cursor=event-does-not-exist`,
    );
    expect(foreignReplay).toEqual(missingReplay);
    expect(foreignReplay).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
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

  it("uses authoritative Attention and Run Activation status precedence", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    let now = new Date("2026-09-22T00:00:00.000Z");
    const attention = await seedAttentionActivation(
      databasePath,
      "agent-status",
      () => now,
    );
    const harness = await startHarness({
      databasePath,
      clock: () => now,
    });

    const agents = await jsonRequest<{
      items: ReadonlyArray<{
        id: string;
        configRevision: number;
        config: unknown;
        status: string;
        liveRunActivationCount: number;
        liveAttentionActivationCount: number;
        liveActivationCount: number;
        nonterminalRunCount: number;
      }>;
    }>(`${harness.origin}/api/v1/projects/project-sample/agents`);
    expect(agents.items[0]).toMatchObject({
      id: "agent-orbit",
      configRevision: 3,
      config: { model: "deterministic-fake", mode: "read-only" },
      status: "active",
      liveRunActivationCount: 0,
      liveAttentionActivationCount: 1,
      liveActivationCount: 1,
      nonterminalRunCount: 0,
    });

    const kernel = TorsorKernel.open({
      databasePath,
      bootstrap,
      clock: () => now,
    });
    let runId: string;
    try {
      const resolved = await kernel.execute(
        {
          type: "ResolveAttentionWithRun",
          idempotencyKey: "agent-status-resolve",
          attentionId: attention.attentionId,
          expectedAttentionRevision: attention.attentionRevision,
          handlerLeaseToken: attention.handlerLeaseToken,
        },
        attention.agentContext,
      );
      runId = resolved.entityId;
    } finally {
      kernel.close();
    }
    let current = await jsonRequest<{
      items: ReadonlyArray<{
        status: string;
        liveAttentionActivationCount: number;
        nonterminalRunCount: number;
      }>;
    }>(`${harness.origin}/api/v1/projects/project-sample/agents`);
    expect(current.items[0]).toMatchObject({
      status: "waiting",
      liveAttentionActivationCount: 0,
      nonterminalRunCount: 1,
    });

    const activationKernel = TorsorKernel.open({
      databasePath,
      bootstrap,
      clock: () => now,
    });
    let runActivationId: string;
    try {
      const outboxAuthority = await claimRunOutboxAuthority(
        activationKernel,
        runId,
        "agent-status-run-activation",
      );
      const activation = await activationKernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "agent-status-run-activation",
          runId,
          expectedRunRevision: 1,
          ...outboxAuthority,
        },
        runtimeContext,
      );
      runActivationId = activation.entityId;
    } finally {
      activationKernel.close();
    }
    current = await jsonRequest(
      `${harness.origin}/api/v1/projects/project-sample/agents`,
    );
    expect(current.items[0]).toMatchObject({
      status: "active",
      nonterminalRunCount: 1,
    });

    const finishKernel = TorsorKernel.open({
      databasePath,
      bootstrap,
      clock: () => now,
    });
    try {
      await finishKernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: "agent-status-finish-run",
          activationId: runActivationId,
          outcome: "Completed",
        },
        {
          principalId: "principal-orbit",
          activationId: runActivationId,
        },
      );
    } finally {
      finishKernel.close();
    }
    current = await jsonRequest(
      `${harness.origin}/api/v1/projects/project-sample/agents`,
    );
    expect(current.items[0]).toMatchObject({
      status: "waiting",
      liveActivationCount: 0,
      nonterminalRunCount: 1,
    });

    await seedAttentionActivation(
      databasePath,
      "agent-status-expiring",
      () => now,
      1_000,
    );
    current = await jsonRequest(
      `${harness.origin}/api/v1/projects/project-sample/agents`,
    );
    expect(current.items[0]).toMatchObject({
      status: "active",
      liveAttentionActivationCount: 1,
    });
    now = new Date(now.getTime() + 1_001);
    current = await jsonRequest(
      `${harness.origin}/api/v1/projects/project-sample/agents`,
    );
    expect(current.items[0]).toMatchObject({
      status: "waiting",
      liveAttentionActivationCount: 0,
      liveActivationCount: 0,
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
      const outboxAuthority = await claimRunOutboxAuthority(
        kernel,
        seeded.runId,
        "agent-event-scope",
      );
      const activation = await kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: "agent-event-scope",
          runId: seeded.runId,
          expectedRunRevision: run.run.revision,
          ...outboxAuthority,
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
      eventBatchSize: 1,
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
    const text = new TextDecoder().decode(firstChunk.value);
    expect(text).toContain("event: checkpoint");
    expect(text).not.toContain("event: torsor");

    const activityKernel = TorsorKernel.open({ databasePath, bootstrap });
    try {
      await activityKernel.execute(
        {
          type: "AppendRunActivity",
          idempotencyKey: "agent-event-visible-activity",
          runId: seeded.runId,
          activationId,
          kind: "progress",
          payload: { detail: "Visible after a fully filtered page." },
          retentionClass: "durable",
        },
        {
          principalId: "principal-orbit",
          activationId,
        },
      );
    } finally {
      activityKernel.close();
    }
    let received = "";
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      while (!received.includes('"type":"RunActivityAppended"')) {
        const next = await reader.read();
        expect(next.done).toBe(false);
        received += new TextDecoder().decode(next.value);
      }
    } finally {
      clearTimeout(timer);
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it.each([14, 99])("rejects incompatible development schema %i on service startup", async (version) => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${version};`);
    database.close();

    expect(() =>
      createTorsorHttpService({
        databasePath,
        bootstrap,
        credentials,
        port: 0,
      }),
    ).toThrow(`Incompatible development database schema version ${version}; expected 15.`);
  });

  it.each(["partial", "missing-index", "missing-trigger"])("refuses %s schema 15 unchanged before HTTP startup", async (layout) => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    if (layout !== "partial") TorsorKernel.open({ databasePath, bootstrap }).close();
    const database = new DatabaseSync(databasePath);
    database.exec(layout === "partial"
      ? "CREATE TABLE causal_limits (singleton INTEGER PRIMARY KEY); PRAGMA user_version = 15;"
      : layout === "missing-index" ? "DROP INDEX runs_causal_nonterminal_idx;"
      : "DROP TRIGGER runs_causal_provenance_immutable;");
    database.close();
    const before = await readFile(databasePath);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let service: TorsorHttpService | undefined;
      try {
        expect(() => { service = createTorsorHttpService({ databasePath, bootstrap, credentials, port: 0 }); })
          .toThrow("Incompatible development database schema 15 contract.");
      } finally {
        await service?.close();
      }
      expect((await readFile(databasePath)).equals(before)).toBe(true);
    }
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

  it("serializes concurrent listen and close without leaving a listener", async () => {
    const directory = await temporaryDirectory();
    const service = createTorsorHttpService({
      databasePath: join(directory, "torsor.sqlite"),
      bootstrap,
      credentials,
      port: 0,
    });
    const listenPromise = service.listen();
    const closePromise = service.close();
    const [listenResult, closeResult] = await Promise.allSettled([
      listenPromise,
      closePromise,
    ]);
    expect(closeResult.status).toBe("fulfilled");
    expect(listenResult.status).toBe("fulfilled");
    const origin = (listenResult as PromiseFulfilledResult<string>).value;
    await expect(fetch(`${origin}/health`)).rejects.toThrow();

    await Promise.all([service.close(), service.close(), service.close()]);
    await expect(service.listen()).rejects.toThrow(
      "The HTTP service is closed.",
    );
  });

  it("cleans up after startup failure and keeps later close idempotent", async () => {
    const blocker = createHttpServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP blocker address.");
    }
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "torsor.sqlite");
    const service = createTorsorHttpService({
      databasePath,
      bootstrap,
      credentials,
      host: "127.0.0.1",
      port: address.port,
    });

    await expect(service.listen()).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await Promise.all([service.close(), service.close()]);
    await expect(service.listen()).rejects.toThrow(
      "The HTTP service is closed.",
    );

    blocker.close();
    await once(blocker, "close");
    const replacement = createTorsorHttpService({
      databasePath,
      bootstrap,
      credentials,
      port: 0,
    });
    const origin = await replacement.listen();
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    await replacement.close();
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
    readonly clock?: () => Date;
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
    ...(options.clock ? { clock: options.clock } : {}),
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
  prefix = "seed",
  clock?: () => Date,
): Promise<{ readonly runId: string }> {
  const kernel = TorsorKernel.open({
    databasePath,
    bootstrap,
    ...(clock ? { clock } : {}),
  });
  try {
    const thread = await kernel.execute(
      {
        type: "StartThread",
        idempotencyKey: `${prefix}-thread`,
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
        idempotencyKey: `${prefix}-claim`,
        attentionId: attention.id,
        expectedAttentionRevision: attention.revision,
        leaseDurationMs: 30_000,
      },
      runtimeContext,
    );
    const activation = await kernel.execute(
      {
        type: "StartActivation",
        idempotencyKey: `${prefix}-attention-activation`,
        attentionId: attention.id,
        handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
      },
      runtimeContext,
    );
    const run = await kernel.execute(
      {
        type: "ResolveAttentionWithRun",
        idempotencyKey: `${prefix}-run`,
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

async function claimRunOutboxAuthority(
  kernel: TorsorKernel,
  runId: string,
  key: string,
): Promise<{
  readonly outboxEventId: string;
  readonly outboxLeaseToken: string;
}> {
  for (let index = 0; index < 100; index += 1) {
    const claim = await kernel.execute(
      {
        type: "ClaimOutboxEvents",
        idempotencyKey: `${key}-outbox-claim-${index}`,
        limit: 1,
        leaseDurationMs: 30_000,
      },
      runtimeContext,
    );
    const event = claim.outboxEvents?.[0];
    if (!event || !claim.leaseToken) {
      throw new Error(`Expected an Outbox event for Run ${runId}.`);
    }
    if (
      event.aggregateId === runId &&
      (
        event.topic === "run.activation-requested" ||
        event.topic === "run-input.available"
      )
    ) {
      return {
        outboxEventId: event.id,
        outboxLeaseToken: claim.leaseToken,
      };
    }
    await kernel.execute(
      {
        type: "AcknowledgeOutboxEvents",
        idempotencyKey: `${key}-outbox-ack-${index}`,
        outboxEventIds: [event.id],
        leaseToken: claim.leaseToken,
      },
      runtimeContext,
    );
  }
  throw new Error(`Outbox authority for Run ${runId} was not found.`);
}

async function seedAttentionActivation(
  databasePath: string,
  prefix: string,
  clock: () => Date,
  durationMs = 30_000,
): Promise<{
  readonly attentionId: string;
  readonly attentionRevision: number;
  readonly handlerLeaseToken: string;
  readonly activationId: string;
  readonly agentContext: PrincipalContext;
}> {
  const kernel = TorsorKernel.open({ databasePath, bootstrap, clock });
  try {
    await kernel.execute(
      {
        type: "StartThread",
        idempotencyKey: `${prefix}-thread`,
        projectId: "project-sample",
        channelId: "channel-general",
        body: "Orbit, inspect this synthetic Attention.",
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
    const attention = attentionPage.items.at(-1)!;
    const claim = await kernel.execute(
      {
        type: "ClaimAttention",
        idempotencyKey: `${prefix}-claim`,
        attentionId: attention.id,
        expectedAttentionRevision: attention.revision,
        leaseDurationMs: Math.max(durationMs, 1_000),
      },
      runtimeContext,
    );
    const activation = await kernel.execute(
      {
        type: "StartActivation",
        idempotencyKey: `${prefix}-activation`,
        attentionId: attention.id,
        handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
        durationMs,
      },
      runtimeContext,
    );
    return {
      attentionId: attention.id,
      attentionRevision: claim.revision!,
      handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
      activationId: activation.entityId,
      agentContext: {
        principalId: "principal-orbit",
        activationId: activation.entityId,
      },
    };
  } finally {
    kernel.close();
  }
}

async function createBrowserSession(
  origin: string,
): Promise<{ readonly cookie: string; readonly csrfToken: string }> {
  const response = await fetch(`${origin}/api/v1/session`, {
    method: "POST",
    headers: authorization(),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { csrfToken: string };
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    csrfToken: body.csrfToken,
  };
}

async function sendPartialCookieCommand(
  origin: string,
  session: { readonly cookie: string; readonly csrfToken: string },
  whilePaused: () => Promise<void>,
  idempotencyKey: string,
): Promise<string> {
  const address = new URL(origin);
  const body = JSON.stringify({
    idempotencyKey,
    projectId: "project-sample",
    channelId: "channel-general",
    body: "This command must not execute after session invalidation.",
  });
  const midpoint = Math.floor(body.length / 2);
  const socket = createConnection({
    host: address.hostname,
    port: Number(address.port),
  });
  socket.setEncoding("utf8");
  const chunks: string[] = [];
  socket.on("data", (chunk: string) => chunks.push(chunk));
  await once(socket, "connect");
  socket.write(
    [
      "POST /api/v1/commands/start-thread HTTP/1.1",
      `Host: ${address.host}`,
      `Cookie: ${session.cookie}`,
      `X-Torsor-CSRF: ${session.csrfToken}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body.slice(0, midpoint),
    ].join("\r\n"),
  );
  await whilePaused();
  socket.write(body.slice(midpoint));
  await once(socket, "close");
  return chunks.join("");
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
