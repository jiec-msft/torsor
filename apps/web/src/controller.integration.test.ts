// @vitest-environment node
/// <reference types="node" />

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TorsorKernel, type KernelBootstrap } from "@torsor/kernel";
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
  it.each([false, true])("replaces an obsolete send 401 with the same request (replacement failure: %s)", async (replacementFails) => {
    const { server, browser, broadcasts, controller, run } = await prepareRunComposer();
    const second = createWindowController(server.origin, browser, broadcasts);
    controller.runComposer.edit(run.id, "Use replacement credentials safely.");
    await revokeBrowserSession(server.origin, browser);
    const held = browser.holdNext((url) => url.includes("/commands/send-to-run"));
    const send = controller.sendToRun(run.id);
    await held.observed;
    await second.controller.exchangeSession("human-token", "project-sample");
    if (replacementFails) await revokeBrowserSession(server.origin, browser);
    held.release();
    await send;
    expect(browser.commandRequests).toHaveLength(2);
    expect(browser.commandRequests[1]).toEqual(browser.commandRequests[0]);
    expect(controller.getSnapshot().session).toBe(replacementFails ? "expired" : "ready");
    expect(second.controller.getSnapshot().session).toBe(replacementFails ? "expired" : "ready");
    expect(controller.runComposer.getSnapshot()[run.id]?.status).toBe(
      replacementFails ? "auth-required" : "submitted",
    );
    if (replacementFails) {
      await controller.exchangeSession("human-token", "project-sample");
      await controller.loadRun(run.id);
      await controller.loadThread(run.threadRootId);
      await controller.sendToRun(run.id);
      expect(browser.commandRequests[2]).toEqual(browser.commandRequests[0]);
    }
    expect(controller.getSnapshot().run!.inputs).toHaveLength(2);
    expect(controller.getSnapshot().thread!.messages).toHaveLength(2);
  });

  it("recovers a committed receipt even after the Run becomes terminal", async () => {
    const { server, browser, controller, run } = await prepareRunComposer();
    controller.runComposer.edit(run.id, "One instruction before cancellation.");
    browser.loseNextCommandResponse();
    await controller.sendToRun(run.id);
    await controller.refreshRunComposer(run.id);
    const revision = controller.getSnapshot().run!.run.revision;
    const cancel = await fetch(`${server.origin}/api/v1/commands/cancel-run`, {
      method: "POST",
      headers: { Authorization: "Bearer human-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "cancel-after-lost-response", runId: run.id,
        expectedRunRevision: revision, reason: "Synthetic cancellation.",
      }),
    });
    expect(cancel.status).toBe(200);
    await controller.refreshRunComposer(run.id);
    expect(controller.getSnapshot().run!.run.state).toBe("Cancelled");
    await controller.sendToRun(run.id);
    expect(browser.commandRequests[1]).toEqual(browser.commandRequests[0]);
    expect(controller.runComposer.getSnapshot()[run.id]?.status).toBe("submitted");
    expect(controller.getSnapshot().run!.inputs).toHaveLength(2);
    expect(controller.getSnapshot().thread!.messages).toHaveLength(2);
    expect(controller.getSnapshot().run!.inputs.at(-1)?.disposition).toBe("Abandoned");
  });

  it("rolls back both halves on a before-commit fault and safely retries the same identity", async () => {
    const { browser, controller, run } = await prepareRunComposer();
    const hook = Symbol.for("torsor.kernel.command-before-commit");
    const previous = Reflect.get(globalThis, hook);
    Reflect.set(globalThis, hook, ({ commandType }: { commandType: string }) => {
      if (commandType === "SendToRun") throw new Error("Synthetic commit fault.");
    });
    controller.runComposer.edit(run.id, "Retry the rolled-back transaction.");
    try {
      await controller.sendToRun(run.id);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, hook);
      else Reflect.set(globalThis, hook, previous);
    }
    expect(controller.runComposer.getSnapshot()[run.id]?.status).toBe("unknown");
    await controller.refreshRunComposer(run.id);
    expect(controller.getSnapshot().thread!.messages).toHaveLength(1);
    expect(controller.getSnapshot().run!.inputs).toHaveLength(1);
    expect(controller.getSnapshot().run!.run.revision).toBe(run.revision);
    await controller.sendToRun(run.id);
    expect(browser.commandRequests[1]).toEqual(browser.commandRequests[0]);
    expect(controller.getSnapshot().thread!.messages).toHaveLength(2);
    expect(controller.getSnapshot().run!.inputs).toHaveLength(2);
  });

  it("does not turn a committed submission into failure when projection refresh fails", async () => {
    const { browser, controller, run } = await prepareRunComposer();
    const snapshots: Array<[number, number]> = [];
    const unsubscribe = controller.subscribe(() => {
      const state = controller.getSnapshot();
      snapshots.push([state.thread?.messages.length ?? 0, state.run?.inputs.length ?? 0]);
    });
    controller.runComposer.edit(run.id, "Commit despite a delayed read.");
    browser.failNext((url) => url.includes(`/runs/${run.id}`), "Run projection unavailable.");
    await controller.sendToRun(run.id);
    expect(controller.runComposer.getSnapshot()[run.id]).toMatchObject({ status: "submitted", draft: "" });
    expect(controller.getSnapshot().queryError).toBe("Run projection unavailable.");
    expect(snapshots).not.toContainEqual([2, 1]);
    expect(snapshots).not.toContainEqual([1, 2]);
    await controller.refreshRunComposer(run.id);
    unsubscribe();
    expect(controller.getSnapshot().queryError).toBeNull();
    expect(snapshots.at(-1)).toEqual([2, 2]);
    expect(browser.commandRequests).toHaveLength(1);
  });

  it("atomically publishes a Human RunInput and recovers a lost response with the original identity after reauthentication", async () => {
    const server = await startServer({ seedRun: true });
    const browser = new BrowserTransport();
    const { controller } = createWindowController(server.origin, browser);
    await controller.exchangeSession("human-token", "project-sample");
    await controller.loadRun(server.runId!);
    const run = controller.getSnapshot().run!.run;
    await controller.loadThread(run.threadRootId);
    const before = controller.getSnapshot().thread!;
    controller.runComposer.edit(run.id, "Preserve this public instruction.");
    browser.loseNextCommandResponse();

    await controller.sendToRun(run.id);

    expect(controller.runComposer.getSnapshot()[run.id]).toMatchObject({
      status: "unknown",
      draft: "Preserve this public instruction.",
      request: { runId: run.id, expectedRunRevision: run.revision },
    });
    await controller.loadThread(run.threadRootId);
    await controller.loadRun(run.id);
    const committed = controller.getSnapshot();
    expect(committed.thread!.messages).toHaveLength(before.messages.length + 1);
    const message = committed.thread!.messages.at(-1)!;
    expect(committed.run!.inputs.at(-1)).toMatchObject({
      messageRevisionId: message.revisions[0]!.id,
      assignedByPrincipalId: "principal-human",
      assignedByActivationId: null,
      sourceAttentionId: null,
      disposition: "Pending",
    });
    expect(committed.thread!.attentions).toHaveLength(before.attentions.length);

    await revokeBrowserSession(server.origin, browser);
    await controller.sendToRun(run.id);
    expect(controller.getSnapshot().session).toBe("expired");
    expect(controller.runComposer.getSnapshot()[run.id]?.status).toBe("unknown");
    await controller.exchangeSession("human-token", "project-sample");
    await controller.loadThread(run.threadRootId);
    await controller.loadRun(run.id);
    await controller.sendToRun(run.id);

    expect(browser.commandRequests).toHaveLength(3);
    expect(browser.commandRequests[1]).toEqual(browser.commandRequests[0]);
    expect(browser.commandRequests[2]).toEqual(browser.commandRequests[0]);
    expect(controller.runComposer.getSnapshot()[run.id]).toMatchObject({
      status: "submitted", draft: "", request: null,
    });
    expect(controller.getSnapshot().thread!.messages).toHaveLength(before.messages.length + 1);
    expect(controller.getSnapshot().run!.inputs).toHaveLength(committed.run!.inputs.length);
  });

  it("rejects stale revisions and terminal Runs without publishing either half", async () => {
    const server = await startServer({ seedRun: true });
    const browser = new BrowserTransport();
    const { controller } = createWindowController(server.origin, browser);
    await controller.exchangeSession("human-token", "project-sample");
    await controller.loadRun(server.runId!);
    const run = controller.getSnapshot().run!.run;
    await controller.loadThread(run.threadRootId);
    const before = controller.getSnapshot().thread!;
    const advance = await fetch(`${server.origin}/api/v1/commands/send-to-run`, {
      method: "POST",
      headers: { Authorization: "Bearer human-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "another-human-input", runId: run.id,
        expectedRunRevision: run.revision, body: "A concurrent instruction.",
      }),
    });
    expect(advance.status).toBe(200);
    controller.runComposer.edit(run.id, "Keep my rejected draft.");
    await controller.sendToRun(run.id);
    expect(controller.runComposer.getSnapshot()[run.id]).toMatchObject({
      status: "rejected", rejectionCode: "stale_revision",
      draft: "Keep my rejected draft.", request: null,
    });
    await controller.refreshRunComposer(run.id);
    const refreshed = controller.getSnapshot().run!;
    expect(controller.getSnapshot().thread!.messages).toHaveLength(before.messages.length + 1);
    const cancel = await fetch(`${server.origin}/api/v1/commands/cancel-run`, {
      method: "POST",
      headers: { Authorization: "Bearer human-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "cancel-before-input", runId: run.id,
        expectedRunRevision: refreshed.run.revision, reason: "Synthetic stop.",
      }),
    });
    expect(cancel.status).toBe(200);
    await controller.sendToRun(run.id);
    expect(controller.runComposer.getSnapshot()[run.id]).toMatchObject({
      status: "rejected", rejectionCode: "terminal_run",
      draft: "Keep my rejected draft.",
    });
    await controller.refreshRunComposer(run.id);
    expect(controller.getSnapshot().thread!.messages).toHaveLength(before.messages.length + 1);
    expect(controller.getSnapshot().run!.inputs).toHaveLength(refreshed.inputs.length);
  });

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

  it("retains an acknowledged Start identity through an overlapping authentication failure", async () => {
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
      body: "Keep this overlapping Start singular.",
      targetAgentIds: ["agent-orbit"],
    } as const;

    const acknowledged = window.controller.startThread(input);
    await heldRefresh.observed;
    await window.controller.signOut();
    await window.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    await window.controller.loadThreads("channel-general");
    await revokeBrowserSession(server.origin, browser);
    await expect(window.controller.startThread(input)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    await window.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    await window.controller.loadThreads("channel-general");
    await window.controller.startThread(input);
    heldRefresh.release();
    await acknowledged;

    await window.controller.startThread({
      ...input,
      body: "Allow a fresh Start after overlap.",
    });
    await window.controller.loadThreads("channel-general");
    const operationKeys = browser.commandRequests
      .slice(0, 3)
      .map((request) => request.idempotencyKey);
    expect(new Set(operationKeys).size).toBe(1);
    expect(browser.commandRequests[3]?.idempotencyKey).not.toBe(
      operationKeys[0],
    );
    const threads = window.controller.getSnapshot().threads;
    const original = threads.filter(
      (candidate) =>
        candidate.messages[0]?.revisions[0]?.body === input.body,
    );
    const fresh = threads.filter(
      (candidate) =>
        candidate.messages[0]?.revisions[0]?.body ===
        "Allow a fresh Start after overlap.",
    );
    expect(original).toHaveLength(1);
    expect(original[0]?.attentions).toHaveLength(1);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.attentions).toHaveLength(1);
  });

  it("retains an acknowledged Reply identity and cursor through an overlapping authentication failure", async () => {
    const server = await startServer();
    const browser = new BrowserTransport();
    const window = createWindowController(server.origin, browser);
    await window.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    await window.controller.startThread({
      channelId: "channel-general",
      body: "Root message for overlapping Reply coverage.",
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
      body: "Keep this overlapping Reply singular.",
      targetAgentIds: ["agent-orbit"],
    } as const;

    const acknowledged = window.controller.replyToThread(input);
    await heldRefresh.observed;
    await window.controller.signOut();
    await window.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    await window.controller.loadThread(threadId);
    await revokeBrowserSession(server.origin, browser);
    await expect(
      window.controller.replyToThread({
        ...input,
        expectedThreadCursor: 2,
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    await window.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    await window.controller.loadThread(threadId);
    await window.controller.replyToThread({
      ...input,
      expectedThreadCursor: 2,
    });
    heldRefresh.release();
    await acknowledged;

    await window.controller.replyToThread({
      ...input,
      expectedThreadCursor: 2,
      body: "Allow a fresh Reply after overlap.",
    });
    await window.controller.loadThread(threadId);
    const replyRequests = browser.commandRequests.slice(1);
    const operationKeys = replyRequests
      .slice(0, 3)
      .map((request) => request.idempotencyKey);
    expect(new Set(operationKeys).size).toBe(1);
    expect(
      replyRequests.slice(0, 3).map((request) => request.expectedThreadCursor),
    ).toEqual([1, 1, 1]);
    expect(
      replyRequests.slice(0, 3).map((request) => request.targetAgentIds),
    ).toEqual([
      ["agent-orbit"],
      ["agent-orbit"],
      ["agent-orbit"],
    ]);
    expect(replyRequests[3]?.idempotencyKey).not.toBe(operationKeys[0]);
    const projection = window.controller.getSnapshot().thread!;
    expect(
      projection.messages.filter(
        (message) => message.revisions[0]?.body === input.body,
      ),
    ).toHaveLength(1);
    expect(
      projection.messages.filter(
        (message) =>
          message.revisions[0]?.body ===
          "Allow a fresh Reply after overlap.",
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

  it("recovers a resumed bootstrap after a fenced shared-cookie 401", async () => {
    const server = await startServer();
    const scenario = await prepareRevokedResume(server.origin);
    const originalCsrf = scenario.storage.values.get("torsor.session.csrf");
    const baselineBootstrapRequests = countBootstrapRequests(scenario.browser);
    const heldUnauthorized = scenario.browser.holdNext((url) =>
      url.includes("/api/v1/projects/project-sample/bootstrap"),
    );
    const resumed = scenario.first.controller.resume("project-sample");
    await heldUnauthorized.observed;

    await scenario.second.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    expect(scenario.storage.values.get("torsor.session.csrf")).not.toBe(
      originalCsrf,
    );
    heldUnauthorized.release();
    await expect(resumed).resolves.toBeUndefined();

    expect(scenario.first.controller.getSnapshot()).toMatchObject({
      session: "ready",
      connection: "live",
      authError: null,
    });
    expect(scenario.first.controller.getSnapshot().bootstrap?.project.id).toBe(
      "project-sample",
    );
    expect(scenario.second.controller.getSnapshot().session).toBe("ready");
    expect(countBootstrapRequests(scenario.browser)).toBe(
      baselineBootstrapRequests + 3,
    );
    expect(scenario.first.eventSources).toHaveLength(1);
    expect(scenario.first.eventSources[0]?.closed).toBe(false);
  });

  it("settles a resumed bootstrap when replacement credentials fail", async () => {
    const server = await startServer();
    const scenario = await prepareRevokedResume(server.origin);
    const originalCsrf = scenario.storage.values.get("torsor.session.csrf");
    const baselineBootstrapRequests = countBootstrapRequests(scenario.browser);
    const heldUnauthorized = scenario.browser.holdNext((url) =>
      url.includes("/api/v1/projects/project-sample/bootstrap"),
    );
    const resumed = scenario.first.controller.resume("project-sample");
    await heldUnauthorized.observed;

    await scenario.second.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    const replacementCsrf = scenario.storage.values.get(
      "torsor.session.csrf",
    );
    expect(replacementCsrf).not.toBe(originalCsrf);
    scenario.browser.failNext(
      (url) => url.includes("/api/v1/projects/project-sample/bootstrap"),
      "Replacement project bootstrap failed.",
    );
    heldUnauthorized.release();
    await expect(resumed).rejects.toMatchObject({
      status: 503,
      code: "projection_unavailable",
    });

    expect(scenario.first.controller.getSnapshot()).toMatchObject({
      session: "signed-out",
      connection: "offline",
      authError: "Replacement project bootstrap failed.",
    });
    expect(scenario.storage.values.get("torsor.session.csrf")).toBe(
      replacementCsrf,
    );
    expect(scenario.second.controller.getSnapshot().session).toBe("ready");
    expect(countBootstrapRequests(scenario.browser)).toBe(
      baselineBootstrapRequests + 3,
    );
    expect(scenario.first.eventSources).toHaveLength(0);
  });

  it("expires a resumed bootstrap on a current-credential 401", async () => {
    const server = await startServer();
    const scenario = await prepareRevokedResume(server.origin);
    const baselineBootstrapRequests = countBootstrapRequests(scenario.browser);

    await expect(
      scenario.first.controller.resume("project-sample"),
    ).resolves.toBeUndefined();

    expect(scenario.first.controller.getSnapshot()).toMatchObject({
      session: "expired",
      connection: "offline",
      authError: null,
    });
    expect(scenario.storage.values.size).toBe(0);
    expect(countBootstrapRequests(scenario.browser)).toBe(
      baselineBootstrapRequests + 1,
    );
    expect(scenario.first.eventSources).toHaveLength(0);
  });

  it("recovers a selected Thread after a fenced shared-cookie 401", async () => {
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
    await first.controller.startThread({
      channelId: "channel-general",
      body: "Thread recovered after credential replacement.",
    });
    await first.controller.loadThreads("channel-general");
    const threadId = first.controller.getSnapshot().threads[0]!.threadRootId;
    await revokeBrowserSession(server.origin, browser);
    const heldUnauthorized = browser.holdNext((url) =>
      url.includes(`/api/v1/threads/${threadId}`),
    );
    const selectedThread = first.controller.loadThread(threadId);
    await heldUnauthorized.observed;

    await second.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    heldUnauthorized.release();
    await expect(selectedThread).resolves.toBe(true);

    expect(first.controller.getSnapshot()).toMatchObject({
      session: "ready",
      connection: "live",
      loadingThread: false,
      queryError: null,
    });
    expect(first.controller.getSnapshot().thread?.threadRootId).toBe(
      threadId,
    );
    expect(second.eventSources.at(-1)?.closed).toBe(false);
  });

  it("recovers a selected Thread list after a fenced shared-cookie 401", async () => {
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
    await first.controller.startThread({
      channelId: "channel-general",
      body: "Thread list recovered after credential replacement.",
    });
    await revokeBrowserSession(server.origin, browser);
    const heldUnauthorized = browser.holdNext((url) =>
      url.includes("/api/v1/channels/channel-general/threads"),
    );
    const selectedThreads = first.controller.loadThreads("channel-general");
    await heldUnauthorized.observed;

    await second.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    heldUnauthorized.release();
    await expect(selectedThreads).resolves.toBe(true);

    expect(first.controller.getSnapshot()).toMatchObject({
      session: "ready",
      connection: "live",
      threadsChannelId: "channel-general",
      loadingThreads: false,
      queryError: null,
    });
    expect(first.controller.getSnapshot().threads).toHaveLength(1);
    expect(
      browser.requests.filter((url) =>
        url.includes("/api/v1/channels/channel-general/threads"),
      ),
    ).toHaveLength(2);
  });

  it("settles a selected Thread-list error when replacement credentials fail", async () => {
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
    await revokeBrowserSession(server.origin, browser);
    const heldUnauthorized = browser.holdNext((url) =>
      url.includes("/api/v1/channels/channel-general/threads"),
    );
    const selectedThreads = first.controller.loadThreads("channel-general");
    await heldUnauthorized.observed;

    await second.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    browser.failNext(
      (url) => url.includes("/api/v1/channels/channel-general/threads"),
      "Replacement Thread-list projection failed.",
    );
    heldUnauthorized.release();
    await expect(selectedThreads).resolves.toBe(false);

    expect(first.controller.getSnapshot()).toMatchObject({
      session: "ready",
      connection: "live",
      loadingThreads: false,
      queryError: "Replacement Thread-list projection failed.",
    });
    expect(
      browser.requests.filter((url) =>
        url.includes("/api/v1/channels/channel-general/threads"),
      ),
    ).toHaveLength(2);
  });

  it("recovers a selected Run after a fenced shared-cookie 401", async () => {
    const server = await startServer({ seedRun: true });
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
    await revokeBrowserSession(server.origin, browser);
    const heldUnauthorized = browser.holdNext((url) =>
      url.endsWith(`/api/v1/runs/${server.runId}`),
    );
    const selectedRun = first.controller.loadRun(server.runId!);
    await heldUnauthorized.observed;

    await second.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    heldUnauthorized.release();
    await expect(selectedRun).resolves.toBe(true);

    expect(first.controller.getSnapshot()).toMatchObject({
      session: "ready",
      connection: "live",
      loadingRun: false,
      queryError: null,
    });
    expect(first.controller.getSnapshot().run?.run.id).toBe(server.runId);
    expect(
      browser.requests.filter((url) =>
        url.endsWith(`/api/v1/runs/${server.runId}`),
      ),
    ).toHaveLength(2);
  });

  it("settles a selected Run error when replacement credentials fail", async () => {
    const server = await startServer({ seedRun: true });
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
    await revokeBrowserSession(server.origin, browser);
    const heldUnauthorized = browser.holdNext((url) =>
      url.endsWith(`/api/v1/runs/${server.runId}`),
    );
    const selectedRun = first.controller.loadRun(server.runId!);
    await heldUnauthorized.observed;

    await second.controller.exchangeSession(
      "human-token",
      "project-sample",
    );
    browser.failNext(
      (url) => url.endsWith(`/api/v1/runs/${server.runId}`),
      "Replacement Run projection failed.",
    );
    heldUnauthorized.release();
    await expect(selectedRun).resolves.toBe(false);

    expect(first.controller.getSnapshot()).toMatchObject({
      session: "ready",
      connection: "live",
      loadingRun: false,
      queryError: "Replacement Run projection failed.",
    });
    expect(
      browser.requests.filter((url) =>
        url.endsWith(`/api/v1/runs/${server.runId}`),
      ),
    ).toHaveLength(2);
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

  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

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
  readonly commandRequests: Array<Record<string, unknown>> = [];
  readonly requests: string[] = [];
  #cookie = "";
  #loseCommandResponse = false;
  #failure:
    | {
        readonly predicate: (url: string) => boolean;
        readonly message: string;
      }
    | null = null;
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
    const url = String(input);
    this.requests.push(url);
    if (url.includes("/api/v1/commands/") && typeof init?.body === "string") {
      this.commandRequests.push(
        JSON.parse(init.body) as Record<string, unknown>,
      );
    }
    const headers = new Headers(init?.headers);
    if (this.#cookie) {
      headers.set("Cookie", this.#cookie);
    }
    const failure = this.#failure;
    if (failure?.predicate(url)) {
      this.#failure = null;
      return new Response(
        JSON.stringify({
          error: {
            code: "projection_unavailable",
            message: failure.message,
          },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const response = await this.#nativeFetch(input, { ...init, headers });
    if (url.includes("/api/v1/commands/") && this.#loseCommandResponse) {
      this.#loseCommandResponse = false;
      await response.arrayBuffer();
      throw new TypeError("The committed response was lost.");
    }
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";", 1)[0]!;
      this.#cookie = pair.endsWith("=") ? "" : pair;
    }
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

  failNext(predicate: (url: string) => boolean, message: string): void {
    if (this.#failure) {
      throw new Error("Only one failed browser response is supported.");
    }
    this.#failure = { predicate, message };
  }

  loseNextCommandResponse(): void {
    this.#loseCommandResponse = true;
  }
}

async function revokeBrowserSession(
  origin: string,
  browser: BrowserTransport,
): Promise<void> {
  const response = await fetch(`${origin}/api/v1/session`, {
    method: "DELETE",
    headers: { Cookie: browser.cookie },
  });
  expect(response.status).toBe(204);
}

function createWindowController(
  origin: string,
  browser: BrowserTransport,
  broadcasts = new BroadcastHub(),
  storage = new MemoryStorage(),
): {
  readonly controller: WebController;
  readonly eventSources: TestEventSource[];
  readonly storage: MemoryStorage;
} {
  const eventSources: TestEventSource[] = [];
  const controller = new WebController({
    apiBase: origin,
    fetch: browser.fetch as typeof fetch,
    sessionStorage: storage,
    eventSourceFactory: (url) => {
      const events = new TestEventSource(url);
      eventSources.push(events);
      return events as unknown as EventSource;
    },
    broadcastChannelFactory: broadcasts.create,
  });
  cleanup.push(async () => controller.dispose());
  return { controller, eventSources, storage };
}

async function prepareRevokedResume(origin: string): Promise<{
  readonly browser: BrowserTransport;
  readonly first: ReturnType<typeof createWindowController>;
  readonly second: ReturnType<typeof createWindowController>;
  readonly storage: MemoryStorage;
}> {
  const browser = new BrowserTransport();
  const broadcasts = new BroadcastHub();
  const authenticated = createWindowController(
    origin,
    browser,
    broadcasts,
  );
  await authenticated.controller.exchangeSession(
    "human-token",
    "project-sample",
  );
  authenticated.controller.dispose();
  await revokeBrowserSession(origin, browser);
  const first = createWindowController(
    origin,
    browser,
    broadcasts,
    authenticated.storage,
  );
  const second = createWindowController(origin, browser, broadcasts);
  return {
    browser,
    first,
    second,
    storage: authenticated.storage,
  };
}

function countBootstrapRequests(browser: BrowserTransport): number {
  return browser.requests.filter((url) =>
    url.includes("/api/v1/projects/project-sample/bootstrap"),
  ).length;
}

async function startServer(
  options: { readonly seedRun?: boolean } = {},
): Promise<{
  readonly service: TorsorHttpService;
  readonly origin: string;
  readonly runId?: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "torsor-web-integration-"));
  const databasePath = join(directory, "torsor.sqlite");
  const runId = options.seedRun
    ? await seedRun(databasePath)
    : undefined;
  const service = createTorsorHttpService({
    databasePath,
    bootstrap,
    credentials,
    port: 0,
  });
  const origin = await service.listen();
  cleanup.push(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, origin, ...(runId ? { runId } : {}) };
}

async function prepareRunComposer() {
  const server = await startServer({ seedRun: true });
  const browser = new BrowserTransport();
  const broadcasts = new BroadcastHub();
  const { controller } = createWindowController(server.origin, browser, broadcasts);
  await controller.exchangeSession("human-token", "project-sample");
  await controller.loadRun(server.runId!);
  const run = controller.getSnapshot().run!.run;
  await controller.loadThread(run.threadRootId);
  return { server, browser, broadcasts, controller, run };
}

async function seedRun(databasePath: string): Promise<string> {
  const kernel = TorsorKernel.open({ databasePath, bootstrap });
  try {
    await kernel.execute(
      {
        type: "StartThread",
        idempotencyKey: "selected-run-thread",
        projectId: "project-sample",
        channelId: "channel-general",
        body: "Create a Run for selected projection recovery.",
        targetAgentIds: ["agent-orbit"],
      },
      { principalId: "principal-human" },
    );
    const attentions = await kernel.query(
      {
        type: "ListOpenAttentions",
        projectId: "project-sample",
        targetAgentId: "agent-orbit",
      },
      { principalId: "principal-runtime" },
    );
    const attention = attentions.items[0]!;
    const claim = await kernel.execute(
      {
        type: "ClaimAttention",
        idempotencyKey: "selected-run-claim",
        attentionId: attention.id,
        expectedAttentionRevision: attention.revision,
        leaseDurationMs: 30_000,
      },
      { principalId: "principal-runtime" },
    );
    const activation = await kernel.execute(
      {
        type: "StartActivation",
        idempotencyKey: "selected-run-activation",
        attentionId: attention.id,
        handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
      },
      { principalId: "principal-runtime" },
    );
    const run = await kernel.execute(
      {
        type: "ResolveAttentionWithRun",
        idempotencyKey: "selected-run-resolve",
        attentionId: attention.id,
        expectedAttentionRevision: claim.revision!,
        handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
      },
      {
        principalId: "principal-orbit",
        activationId: activation.entityId,
      },
    );
    return run.entityId;
  } finally {
    kernel.close();
  }
}
