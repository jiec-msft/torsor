import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DeterministicFakeAdapter,
  LocalWorktreeExecutor,
  resolveProviderPolicy,
  type ProviderAdapter,
} from "@torsor/agent-runtime";
import {
  TorsorKernel,
} from "@torsor/kernel";
import {
  OperationalLogSinkError,
  OperationalLogger,
} from "@torsor/operational-logging";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BoundedOperationalLogSink,
  OperationalLogFileError,
  createLocalRuntimeHost,
} from "../src/index.js";
import {
  bootstrap,
  syntheticRepository,
} from "../../../packages/agent-runtime/test/fixtures/worktree-fixture.js";
import type { ControlledChild } from "../../../packages/agent-runtime/src/controlled-process.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("privacy-safe production operational logging", () => {
  it("correlates an HTTP request through a terminal failed Run without private payload data", async () => {
    const directory = await temporaryDirectory();
    const lines: string[] = [];
    const logger = new OperationalLogger({
      sink: { write: (line) => { lines.push(line); } },
    });

    const adapter = new DeterministicFakeAdapter(async (context) => {
      if (context.cause.type === "attention") {
        await context.capabilities.createRunFromAttention();
      } else {
        await context.capabilities.fail("Synthetic private provider failure.");
      }
    });
    const host = createLocalRuntimeHost({
      databasePath: join(directory, "kernel.sqlite"),
      bootstrap,
      port: 0,
      credentials: [{
        token: "synthetic-human-token",
        principalContext: { principalId: "human" },
      }],
      runtimePrincipalId: "runtime",
      projectIds: ["project"],
      adapter,
      operationalLogger: logger,
      runtimePollIntervalMs: 1,
    });
    cleanup.push(() => host.close());

    const origin = await host.start();
    const privateCanaries = [
      "prompt-canary-7bd80f",
      "provider-response-canary-46ac1d",
      "tool-argument-canary-e948a2",
      "credential-canary-2dd101",
      "C:\\private\\operator\\workspace",
    ];
    const response = await fetch(`${origin}/api/v1/commands/start-thread`, {
      method: "POST",
      headers: {
        ...authorization(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotencyKey: "logging-failed-run",
        projectId: "project",
        channelId: "channel",
        body: privateCanaries.join(" "),
        targetAgentIds: ["orbit"],
      }),
    });
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    const { result } = await response.json() as {
      result: { entityId: string; correlationId: string };
    };
    await vi.waitFor(async () => {
      const threadResponse = await fetch(
        `${origin}/api/v1/threads/${result.entityId}`,
        { headers: authorization() },
      );
      const body = await threadResponse.json() as {
        thread: { runs: readonly { state: string }[] };
      };
      expect(body.thread.runs).toMatchObject([{ state: "Failed" }]);
    });
    await host.close();

    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({
      event: "http.request",
      outcome: "succeeded",
      requestId,
      correlationId: result.correlationId,
      httpStatus: 200,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "runtime.run_terminal",
      outcome: "failed",
      correlationId: result.correlationId,
      errorCode: "run_failed",
    }));
    expect(events.filter((event) =>
      event.event === "runtime.provider_attempt" &&
      event.correlationId === result.correlationId
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "started" }),
      expect.objectContaining({ outcome: "succeeded" }),
    ]));
    const serialized = lines.join("");
    for (const canary of privateCanaries) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain("Synthetic private provider failure.");
    expect(serialized).not.toContain("Authorization");
  });

  it("keeps one correlation through a native Provider process, Writer authority, and failed Run", async () => {
    const repository = syntheticRepository();
    cleanup.push(async () => { repository.dispose(); });
    const lines: string[] = [];
    const logger = new OperationalLogger({
      sink: { write: (line) => { lines.push(line); } },
    });
    const capabilities = new DeterministicFakeAdapter().capabilities;
    const adapter: ProviderAdapter = {
      name: "synthetic-native-failure",
      version: "1",
      capabilities,
      policy: resolveProviderPolicy({
        kind: "trusted-local",
        permissionMode: "allow-all",
      }),
      async execute(context) {
        if (context.cause.type === "attention") {
          await context.capabilities.createRunFromAttention();
          return {};
        }
        if (!context.nativeExecution) {
          throw new Error("Synthetic native execution was not admitted.");
        }
        const handle = await context.nativeExecution.start(() => closedChild());
        await handle.finish();
        await context.capabilities.fail("Synthetic private native failure.");
        return {};
      },
    };
    const host = createLocalRuntimeHost({
      databasePath: repository.databasePath,
      bootstrap,
      port: 0,
      credentials: [{
        token: "synthetic-human-token",
        principalContext: { principalId: "human" },
      }],
      runtimePrincipalId: "runtime",
      projectIds: ["project"],
      adapter,
      operationalLogger: logger,
      runtimePollIntervalMs: 1,
      worktreeExecutorFactory: (kernel, operationalLogger) =>
        new LocalWorktreeExecutor({
          kernel,
          runtimePrincipalId: "runtime",
          ...repository,
          ...(operationalLogger ? { operationalLogger } : {}),
        }),
    });
    cleanup.push(() => host.close());

    const origin = await host.start();
    const response = await fetch(`${origin}/api/v1/commands/start-thread`, {
      method: "POST",
      headers: { ...authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "native-logging-failed-run",
        projectId: "project",
        channelId: "channel",
        body: "Synthetic private native request.",
        targetAgentIds: ["orbit"],
      }),
    });
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    const { result } = await response.json() as {
      result: { entityId: string; correlationId: string };
    };
    await vi.waitFor(async () => {
      const threadResponse = await fetch(
        `${origin}/api/v1/threads/${result.entityId}`,
        { headers: authorization() },
      );
      const body = await threadResponse.json() as {
        thread: { runs: readonly { state: string }[] };
      };
      expect(body.thread.runs).toMatchObject([{ state: "Failed" }]);
      const events = lines.map((line) => JSON.parse(line));
      expect(events).toContainEqual(expect.objectContaining({
        event: "runtime.run_terminal",
        outcome: "failed",
        correlationId: result.correlationId,
      }));
      expect(events).toContainEqual(expect.objectContaining({
        event: "provider_process.stop",
        correlationId: result.correlationId,
      }));
    });
    await host.close();

    const events = lines.map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({
      event: "http.request",
      requestId,
      correlationId: result.correlationId,
    }));
    for (const event of [
      "runtime.activation",
      "runtime.provider_attempt",
      "provider_process.spawn",
      "provider_process.stop",
      "writer_authority.acquire",
      "runtime.run_terminal",
    ]) {
      expect(events).toContainEqual(expect.objectContaining({
        event,
        correlationId: result.correlationId,
      }));
    }
    const serialized = lines.join("");
    expect(serialized).not.toContain("Synthetic private native request.");
    expect(serialized).not.toContain("Synthetic private native failure.");
    expect(serialized).not.toContain(repository.directory);
    expect(serialized).not.toContain("leaseToken");
    expect(serialized).not.toContain("executionToken");
    expect(serialized).not.toContain("fencingToken");
  });

  it("fails the Host explicitly when an operational sink stops accepting events", async () => {
    const directory = await temporaryDirectory();
    let writes = 0;
    const logger = new OperationalLogger({
      sink: {
        write: () => {
          writes += 1;
          if (writes === 2) throw new Error("private sink detail");
        },
      },
    });
    const host = createLocalRuntimeHost({
      databasePath: join(directory, "kernel.sqlite"),
      bootstrap,
      port: 0,
      credentials: [{
        token: "synthetic-human-token",
        principalContext: { principalId: "human" },
      }],
      runtimePrincipalId: "runtime",
      projectIds: ["project"],
      adapter: new DeterministicFakeAdapter(),
      operationalLogger: logger,
      runtimePollIntervalMs: 1,
    });
    const origin = await host.start();
    await fetch(`${origin}/health`);
    await expect(host.finished).rejects.toBeInstanceOf(OperationalLogSinkError);
    await expect(fetch(`${origin}/health`)).rejects.toThrow();
    await expect(host.close()).rejects.toBeInstanceOf(OperationalLogSinkError);
  });

  it("does not acknowledge a committed command before its required request log succeeds", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "kernel.sqlite");
    const idempotencyKey = "logging-failed-command-ack";
    const privateBody = "private-edited-message-canary";
    const seed = TorsorKernel.open({ databasePath, bootstrap });
    const seededMessage = await seed.execute(
      {
        type: "StartThread",
        idempotencyKey: "logging-edit-seed",
        projectId: "project",
        channelId: "channel",
        body: "Synthetic seed message.",
      },
      { principalId: "human" },
    );
    seed.close();
    let committedCorrelationId: string | undefined;
    const attemptedLines: string[] = [];
    const logger = new OperationalLogger({
      sink: {
        write: (line) => {
          attemptedLines.push(line);
          const event = JSON.parse(line) as {
            event: string;
            outcome: string;
            correlationId?: string;
          };
          if (
            event.event === "http.request" &&
            event.outcome === "succeeded" &&
            event.correlationId !== undefined
          ) {
            committedCorrelationId = event.correlationId;
            throw new Error("Synthetic private sink failure.");
          }
        },
      },
    });
    const host = createLocalRuntimeHost({
      databasePath,
      bootstrap,
      port: 0,
      credentials: [{
        token: "synthetic-human-token",
        principalContext: { principalId: "human" },
      }],
      runtimePrincipalId: "runtime",
      projectIds: ["project"],
      adapter: new DeterministicFakeAdapter(),
      operationalLogger: logger,
      runtimePollIntervalMs: 1,
    });
    const origin = await host.start();
    const command = {
      method: "POST",
      headers: { ...authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey,
        messageId: seededMessage.entityId,
        expectedMessageRevision: 1,
        body: privateBody,
        targetAgentIds: [],
      }),
    } as const;
    const response = await fetch(
      `${origin}/api/v1/commands/edit-message`,
      command,
    ).catch(() => undefined);
    expect(
      response?.status === undefined ||
      response.status < 200 ||
      response.status >= 300,
    ).toBe(true);
    await expect(host.finished).rejects.toBeInstanceOf(OperationalLogSinkError);
    await expect(host.close()).rejects.toBeInstanceOf(OperationalLogSinkError);

    const recovered = createLocalRuntimeHost({
      databasePath,
      bootstrap,
      port: 0,
      credentials: [{
        token: "synthetic-human-token",
        principalContext: { principalId: "human" },
      }],
      runtimePrincipalId: "runtime",
      projectIds: ["project"],
      adapter: new DeterministicFakeAdapter(),
      runtimePollIntervalMs: 1,
    });
    cleanup.push(() => recovered.close());
    const recoveredOrigin = await recovered.start();
    const replay = await fetch(
      `${recoveredOrigin}/api/v1/commands/edit-message`,
      command,
    );
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as {
      result: { entityId: string; correlationId: string };
    };
    expect(replayBody.result.entityId).toBe(seededMessage.entityId);
    expect(committedCorrelationId).toMatch(/^corr-/);
    expect(replayBody.result.correlationId).toBe(committedCorrelationId);
    expect(attemptedLines.join("")).not.toContain(privateBody);
    expect(attemptedLines.join("")).not.toContain(idempotencyKey);
    const threadResponse = await fetch(
      `${recoveredOrigin}/api/v1/threads/${seededMessage.entityId}`,
      { headers: authorization() },
    );
    expect(threadResponse.status).toBe(200);
    const threadBody = await threadResponse.json() as {
      thread: { messages: readonly { revisions: readonly unknown[] }[] };
    };
    expect(threadBody.thread.messages[0]!.revisions).toHaveLength(2);
  });

  it("rotates one bounded predecessor and hides filesystem failure details", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "operational.ndjson");
    const sink = new BoundedOperationalLogSink({
      path,
      maximumBytes: 65_536,
    });
    const first = `${"a".repeat(40_000)}\n`;
    const second = `${"b".repeat(30_000)}\n`;
    await sink.write(first);
    await sink.write(second);
    expect(await readFile(`${path}.1`, "utf8")).toBe(first);
    expect(await readFile(path, "utf8")).toBe(second);

    const unavailablePath = join(directory, "missing", "private.ndjson");
    const unavailable = new BoundedOperationalLogSink({
      path: unavailablePath,
      maximumBytes: 65_536,
    });
    const failure = await unavailable.write("{}\n").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OperationalLogFileError);
    expect(String(failure)).not.toContain(unavailablePath);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "torsor-operational-logging-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function authorization(): { readonly Authorization: string } {
  return {
    Authorization: ["Bear", "er synthetic-human-token"].join(""),
  };
}

function closedChild(): ControlledChild {
  return {
    pid: 41_042,
    result: Promise.resolve(""),
    closed: Promise.resolve({ code: 0, signal: null, error: null }),
    requestStop: () => {},
    forceStop: () => false,
  };
}
