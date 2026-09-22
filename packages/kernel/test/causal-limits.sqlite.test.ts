import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalArtifactStorage,
  TorsorKernel,
  type CommandResult,
  type KernelOpenOptions,
  type PrincipalContext,
  type ResolveAttentionWithRunCommand,
} from "../src/index.js";
import {
  bootstrap,
  claimRunOutboxAuthority,
  createRun,
  humanContext,
  runtimeContext,
} from "./helpers.js";

const kernels: TorsorKernel[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const kernel of kernels.splice(0)) kernel.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function openDatabase(options: Partial<KernelOpenOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "torsor-causal-"));
  directories.push(directory);
  const databasePath = join(directory, "kernel.sqlite");
  const kernel = TorsorKernel.open({ ...options, databasePath, bootstrap });
  kernels.push(kernel);
  return { kernel, databasePath };
}

function reopen(databasePath: string) {
  const kernel = TorsorKernel.open({ databasePath });
  kernels.push(kernel);
  return kernel;
}

async function delegate(
  kernel: TorsorKernel,
  parent: CommandResult,
  context: PrincipalContext,
  target: "orbit" | "keel",
  key: string,
) {
  const message = await kernel.execute({
    type: "PublishRunReply",
    idempotencyKey: `${key}-reply`,
    runId: parent.entityId,
    expectedRunRevision: parent.revision!,
    body: "Inspect another synthetic component.",
    targetAgentIds: [`agent-${target}`],
  }, context);
  return prepareDecision(kernel, message, target, key);
}

function durableRows(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries([
      "runs", "run_inputs", "attentions", "activation_attempts",
      "attention_domain_fences", "public_events", "outbox_events",
      "idempotency_records", "run_history",
      "artifacts", "causal_limits",
    ].map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]));
  } finally {
    database.close();
  }
}

type Decision = Awaited<ReturnType<typeof prepareDecision>>;
type RaceOutcome =
  | { status: "fulfilled"; result: CommandResult }
  | { status: "rejected"; code: string; details: unknown };

async function raceDecisions(databasePath: string, decisions: readonly Decision[]) {
  const signal = new SharedArrayBuffer(4);
  const workers: Worker[] = [];
  const ready: Promise<void>[] = [];
  const results: Promise<RaceOutcome>[] = [];
  try {
    for (const decision of decisions) {
      const worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        import(workerData.moduleUrl).then(async ({ TorsorKernel }) => {
          const kernel = TorsorKernel.open({ databasePath: workerData.databasePath });
          try {
            parentPort.postMessage({ type: "ready" });
            if (Atomics.wait(new Int32Array(workerData.signal), 0, 0, 10000) === "timed-out") {
              throw new Error("Race start timed out.");
            }
            try {
              const result = await kernel.execute(workerData.command, workerData.context);
              parentPort.postMessage({ type: "result", value: { status: "fulfilled", result } });
            } catch (error) {
              parentPort.postMessage({ type: "result", value: {
                status: "rejected", code: error.code, details: error.details
              } });
            }
          } finally { kernel.close(); }
        }).catch((error) => { throw error; });
      `, {
        eval: true,
        workerData: {
          ...decision, databasePath, signal,
          moduleUrl: new URL("../dist/index.js", import.meta.url).href,
        },
      });
      workers.push(worker);
      ready.push(new Promise<void>((resolve, reject) => {
        worker.on("message", (message) => {
          if (message.type === "ready") resolve();
        });
        worker.on("error", reject);
        worker.on("exit", () => reject(new Error("Worker exited before ready.")));
      }));
      results.push(new Promise<RaceOutcome>((resolve, reject) => {
        worker.on("message", (message) => {
          if (message.type === "result") resolve(message.value);
        });
        worker.on("error", reject);
        worker.on("exit", () => reject(new Error("Worker exited before result.")));
      }));
    }
    const allResults = Promise.all(results);
    await Promise.race([Promise.all(ready), allResults]);
    Atomics.store(new Int32Array(signal), 0, 1);
    Atomics.notify(new Int32Array(signal), 0);
    return await allResults;
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

async function startRequest(kernel: TorsorKernel, key: string) {
  return kernel.execute({
    type: "StartThread",
    idempotencyKey: key,
    projectId: "project-sample",
    channelId: "channel-general",
    body: "Inspect the synthetic sample.",
    targetAgentIds: ["agent-orbit", "agent-keel"],
  }, humanContext);
}

async function prepareDecision(
  kernel: TorsorKernel,
  message: CommandResult,
  agent: "orbit" | "keel",
  key: string,
) {
  const page = await kernel.query({
    type: "ListOpenAttentions",
    targetAgentId: `agent-${agent}`,
    limit: 100,
  }, runtimeContext);
  const attention = page.items.find(
    (item) => item.messageRevisionId === message.relatedIds!.messageRevisionId,
  );
  if (!attention) throw new Error("Expected a triggering Attention.");
  const claim = await kernel.execute({
    type: "ClaimAttention",
    idempotencyKey: `${key}-claim`,
    attentionId: attention.id,
    expectedAttentionRevision: attention.revision,
    leaseDurationMs: 300_000,
  }, runtimeContext);
  const activation = await kernel.execute({
    type: "StartActivation",
    idempotencyKey: `${key}-activation`,
    attentionId: attention.id,
    handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
  }, runtimeContext);
  const command: ResolveAttentionWithRunCommand = {
    type: "ResolveAttentionWithRun",
    idempotencyKey: `${key}-resolve`,
    attentionId: attention.id,
    expectedAttentionRevision: claim.revision!,
    handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
  };
  return {
    command,
    context: {
      principalId: `principal-${agent}`,
      activationId: activation.entityId,
    },
  };
}

async function activateRun(
  kernel: TorsorKernel,
  run: CommandResult,
  agent: "orbit" | "keel",
  key: string,
) {
  const authority = await claimRunOutboxAuthority(kernel, run.entityId, key);
  const activation = await kernel.execute({
    type: "StartActivation",
    idempotencyKey: `${key}-start`,
    runId: run.entityId,
    expectedRunRevision: run.revision!,
    ...authority,
  }, runtimeContext);
  await kernel.execute({
    type: "AcknowledgeOutboxEvents",
    idempotencyKey: `${key}-ack`,
    outboxEventIds: [authority.outboxEventId],
    leaseToken: authority.outboxLeaseToken,
  }, runtimeContext);
  return {
    principalId: `principal-${agent}`,
    activationId: activation.entityId,
  };
}

describe("durable causal limits (MVP 25.1-25.2, 28.2, 32.7)", () => {
  it("preserves causal admission and separate Artifact provenance across rollback, input, restart and replay", async () => {
    const { databasePath } = await openDatabase({
      causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 2 },
    });
    const storage = await LocalArtifactStorage.open(join(dirname(databasePath), "artifacts"));
    let kernel = TorsorKernel.open({ databasePath, artifactStorage: storage });
    kernels.push(kernel);
    const message = await startRequest(kernel, "artifact-root");
    const rootDecision = await prepareDecision(kernel, message, "orbit", "artifact-root");
    const root = await kernel.execute(rootDecision.command, rootDecision.context);
    const rootContext = await activateRun(kernel, root, "orbit", "artifact-root");
    const report = {
      idempotencyKey: "shared-report", expectedRunRevision: 1,
      content: Buffer.from("Shared synthetic causal report.\n"),
    };
    const rootReport = await kernel.finalizeReport({ ...report, runId: root.entityId }, rootContext);
    const childDecision = await delegate(kernel, root, rootContext, "keel", "artifact-child");
    const child = await kernel.execute(childDecision.command, childDecision.context);
    const childContext = await activateRun(kernel, child, "keel", "artifact-child");

    const beforeFailure = durableRows(databasePath);
    const hook = Symbol.for("torsor.kernel.command-before-commit");
    Reflect.set(globalThis, hook, ({ commandType }: { commandType: string }) => {
      if (commandType === "PublishArtifact") throw new Error("Synthetic descriptor commit failure.");
    });
    try {
      await expect(kernel.finalizeReport({ ...report, runId: child.entityId }, childContext))
        .rejects.toThrow("Synthetic descriptor commit failure");
    } finally {
      Reflect.deleteProperty(globalThis, hook);
    }
    expect(durableRows(databasePath)).toEqual(beforeFailure);
    const childReport = await kernel.finalizeReport({ ...report, runId: child.entityId }, childContext);
    expect(childReport.entityId).not.toBe(rootReport.entityId);
    const rootContent = await kernel.readArtifact(rootReport.entityId, humanContext);
    const childContent = await kernel.readArtifact(childReport.entityId, humanContext);
    expect(childContent.content).toEqual(report.content);
    expect(childContent.artifact.contentDigest).toBe(rootContent.artifact.contentDigest);
    expect(childContent.artifact).toMatchObject({
      producerRunId: child.entityId, producerActivationId: childContext.activationId,
      producerThreadRootId: message.entityId,
    });
    await expect(kernel.finalizeReport({
      ...report, runId: child.entityId, ...{ parentRunId: root.entityId },
    }, childContext)).rejects.toMatchObject({ code: "InvalidCommand" });
    await expect(kernel.readArtifact(rootReport.entityId, childContext))
      .rejects.toMatchObject({ code: "Forbidden" });
    await expect(kernel.readArtifact(childReport.entityId, rootContext))
      .rejects.toMatchObject({ code: "Forbidden" });

    const grandchildDecision = await delegate(kernel, child, childContext, "orbit", "artifact-grandchild");
    await expect(kernel.execute(grandchildDecision.command, grandchildDecision.context))
      .rejects.toMatchObject({
        code: "CausalLimitExceeded",
        details: { causalRootId: message.entityId, delegationDepth: 2, nonTerminalRunCount: 2 },
      });
    const page = await kernel.query({
      type: "ListRunProjections", projectId: "project-sample",
    }, humanContext);
    const expectedChild = {
      causalRootId: message.entityId, parentRunId: root.entityId,
      parentAttentionId: childDecision.command.attentionId, delegationDepth: 1,
    };
    expect(page.items.find((item) => item.run.id === child.entityId)).toMatchObject({
      run: expectedChild, artifacts: [childContent.artifact],
    });

    const beforeRestart = durableRows(databasePath);
    for (const connection of kernels) connection.close();
    kernel = TorsorKernel.open({ databasePath, artifactStorage: storage });
    kernels.push(kernel);
    expect(await kernel.execute(childDecision.command, childDecision.context)).toEqual(child);
    expect(await kernel.finalizeReport({ ...report, runId: root.entityId }, rootContext)).toEqual(rootReport);
    expect(await kernel.finalizeReport({ ...report, runId: child.entityId }, childContext)).toEqual(childReport);
    expect(durableRows(databasePath)).toEqual(beforeRestart);
    await expect(kernel.execute(grandchildDecision.command, grandchildDecision.context))
      .rejects.toMatchObject({ code: "CausalLimitExceeded" });

    const send = {
      type: "SendToRun" as const, idempotencyKey: "artifact-followup",
      runId: child.entityId, expectedRunRevision: 1, body: "Inspect the report without resetting its causal root.",
    };
    const sent = await kernel.execute(send, humanContext);
    expect(await kernel.execute(send, humanContext)).toEqual(sent);
    expect(await kernel.finalizeReport({ ...report, runId: child.entityId }, childContext)).toEqual(childReport);
    const updated = await kernel.query({ type: "GetRunProjection", runId: child.entityId }, humanContext);
    expect(updated.run).toMatchObject({ ...expectedChild, state: "Active", revision: 2 });
    expect(updated.inputs).toHaveLength(2);
    expect(updated.inputs.every((input) => input.disposition === "Pending")).toBe(true);
    expect(updated.artifacts).toEqual([childContent.artifact]);

    await kernel.execute({
      type: "CancelRun", idempotencyKey: "artifact-cancel-parent", runId: root.entityId,
      expectedRunRevision: 1, reason: "Synthetic parent release.",
    }, humanContext);
    const grandchild = await kernel.execute(grandchildDecision.command, grandchildDecision.context);
    expect((await kernel.query({ type: "GetRunProjection", runId: grandchild.entityId }, humanContext)).run)
      .toMatchObject({ causalRootId: message.entityId, parentRunId: child.entityId, delegationDepth: 2 });
    expect((await kernel.readArtifact(rootReport.entityId, humanContext)).content).toEqual(report.content);
    await expect(kernel.readArtifact(rootReport.entityId, rootContext)).rejects.toMatchObject({ code: "Conflict" });
    const historicalRuns = await kernel.query({
      type: "ListRunProjections", projectId: "project-sample", snapshotEventId: page.snapshotEventId,
    }, humanContext);
    expect(historicalRuns).toEqual(page);
    const historicalThreads = await kernel.query({
      type: "ListThreadProjections", projectId: "project-sample", snapshotEventId: page.snapshotEventId,
    }, humanContext);
    expect(historicalThreads.items[0]!.runs.find((run) => run.id === child.entityId)).toMatchObject(expectedChild);
    expect(historicalThreads.items[0]!.artifacts).toEqual(expect.arrayContaining([
      rootContent.artifact, childContent.artifact,
    ]));
  });

  it("derives immutable provenance through Human requests and Agent delegation", async () => {
    const { kernel } = await openDatabase();
    const message = await startRequest(kernel, "root");
    const decision = await prepareDecision(kernel, message, "orbit", "root");
    const root = await kernel.execute(decision.command, decision.context);
    const rootContext = await activateRun(kernel, root, "orbit", "root");
    const reply = await kernel.execute({
      type: "PublishRunReply",
      idempotencyKey: "delegate",
      runId: root.entityId,
      expectedRunRevision: 1,
      body: "Investigate a separate part.",
      targetAgentIds: ["agent-keel"],
    }, rootContext);
    const childDecision = await prepareDecision(kernel, reply, "keel", "child");
    const child = await kernel.execute(childDecision.command, childDecision.context);
    const expectedRoot = {
      causalRootId: message.entityId,
      parentAttentionId: decision.command.attentionId,
      parentRunId: null,
      delegationDepth: 0,
    };
    const expectedChild = {
      causalRootId: message.entityId,
      parentAttentionId: childDecision.command.attentionId,
      parentRunId: root.entityId,
      delegationDepth: 1,
    };
    const projection = await kernel.query({
      type: "GetRunProjection", runId: root.entityId,
    }, humanContext);
    expect(projection.run).toMatchObject(expectedRoot);
    const thread = await kernel.query({
      type: "GetThreadProjection", threadRootId: message.entityId,
    }, humanContext);
    expect(thread.runs.find((run) => run.id === child.entityId)).toMatchObject(expectedChild);
    const runPage = await kernel.query({
      type: "ListRunProjections", projectId: "project-sample",
    }, humanContext);
    expect(runPage.items.find((item) => item.run.id === child.entityId)?.run)
      .toMatchObject(expectedChild);
    const threadPage = await kernel.query({
      type: "ListThreadProjections", projectId: "project-sample",
    }, humanContext);
    expect(threadPage.items[0]!.runs.find((run) => run.id === root.entityId))
      .toMatchObject(expectedRoot);
    expect((await kernel.readEvents(null, 100)).find(
      (event) => event.type === "RunCreated" && event.entityId === child.entityId,
    )?.payload).toMatchObject({
      ...expectedChild,
      nonTerminalRunCount: 2,
      maxDepth: 4,
      maxNonTerminalRunsPerRoot: 50,
    });
  });

  it("admits depth 4 and rejects depth 5 without consuming Attention authority", async () => {
    const { kernel } = await openDatabase();
    const message = await startRequest(kernel, "depth-root");
    let decision = await prepareDecision(kernel, message, "orbit", "depth-0");
    let agent: "orbit" | "keel" = "orbit";
    for (let depth = 0; depth <= 4; depth += 1) {
      const run = await kernel.execute(decision.command, decision.context);
      expect((await kernel.query({
        type: "GetRunProjection", runId: run.entityId,
      }, humanContext)).run).toMatchObject({
        causalRootId: message.entityId, delegationDepth: depth,
      });
      const context = await activateRun(kernel, run, agent, `depth-${depth}`);
      agent = agent === "orbit" ? "keel" : "orbit";
      decision = await delegate(kernel, run, context, agent, `depth-${depth + 1}`);
    }
    await expect(kernel.execute(decision.command, decision.context)).rejects.toMatchObject({
      code: "CausalLimitExceeded",
      details: {
        causalRootId: message.entityId, delegationDepth: 5,
        nonTerminalRunCount: 5, maxDepth: 4,
        maxNonTerminalRunsPerRoot: 50, dimension: "depth",
      },
    });
    await kernel.execute({
      ...decision.command,
      type: "IgnoreAttention",
      idempotencyKey: "ignore-depth",
      reason: "Delegation is bounded.",
    }, decision.context);
  });

  it("serializes the actual 50th slot across connections, replays once, and survives restart", async () => {
    const { kernel, databasePath } = await openDatabase();
    const message = await startRequest(kernel, "capacity-root");
    const orbitDecision = await prepareDecision(kernel, message, "orbit", "orbit-root");
    const orbit = await kernel.execute(orbitDecision.command, orbitDecision.context);
    const orbitContext = await activateRun(kernel, orbit, "orbit", "orbit-root");
    const keelDecision = await prepareDecision(kernel, message, "keel", "keel-root");
    const keel = await kernel.execute(keelDecision.command, keelDecision.context);
    const keelContext = await activateRun(kernel, keel, "keel", "keel-root");
    for (let index = 2; index < 49; index += 1) {
      const decision = await delegate(kernel, orbit, orbitContext, "keel", `fill-${index}`);
      await kernel.execute(decision.command, decision.context);
    }
    const left = await delegate(kernel, orbit, orbitContext, "keel", "left");
    const right = await delegate(kernel, keel, keelContext, "orbit", "right");
    const outcomes = await raceDecisions(databasePath, [left, right]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([{
      status: "rejected", code: "CausalLimitExceeded",
      details: {
        causalRootId: message.entityId, delegationDepth: 1,
        nonTerminalRunCount: 50, maxDepth: 4,
        maxNonTerminalRunsPerRoot: 50, dimension: "nonTerminalRuns",
      },
    }]);
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    const winner = [left, right][winnerIndex]!;
    const loser = [left, right][1 - winnerIndex]!;
    const before = durableRows(databasePath);
    kernel.close();
    const restarted = reopen(databasePath);
    const replay = await raceDecisions(databasePath, [winner, winner]);
    expect(replay).toEqual([outcomes[winnerIndex], outcomes[winnerIndex]]);
    await expect(restarted.execute(loser.command, loser.context)).rejects
      .toMatchObject({ code: "CausalLimitExceeded" });
    expect(durableRows(databasePath)).toEqual(before);
    expect(before.runs).toHaveLength(50);
    await expect(restarted.execute({
      ...winner.command, handlerLeaseToken: "different-payload",
    }, winner.context)).rejects.toMatchObject({ code: "Conflict" });
  }, 30_000);

  it("rolls back admission, evidence, Outbox and idempotency before retrying the same key", async () => {
    const { kernel, databasePath } = await openDatabase({
      causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 1 },
    });
    const message = await startRequest(kernel, "rollback-root");
    const decision = await prepareDecision(kernel, message, "orbit", "rollback");
    const before = durableRows(databasePath);
    const hook = Symbol.for("torsor.kernel.command-before-commit");
    Reflect.set(globalThis, hook, ({ commandType }: { commandType: string }) => {
      if (commandType === "ResolveAttentionWithRun") throw new Error("Injected commit failure.");
    });
    try {
      await expect(kernel.execute(decision.command, decision.context))
        .rejects.toThrow("Injected commit failure.");
    } finally {
      Reflect.deleteProperty(globalThis, hook);
    }
    expect(durableRows(databasePath)).toEqual(before);
    kernel.close();
    const restarted = reopen(databasePath);
    await restarted.execute(decision.command, decision.context);
    expect(durableRows(databasePath).runs).toHaveLength(1);
    const other = await prepareDecision(restarted, message, "keel", "other");
    await expect(restarted.execute(other.command, other.context))
      .rejects.toMatchObject({ code: "CausalLimitExceeded" });
    expect(() => TorsorKernel.open({
      databasePath,
      causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 50 },
    })).toThrow(/causal limits/i);
  });

  it.each(["Completed", "Failed", "Cancelled"] as const)(
    "releases only committed %s capacity without resetting a terminal parent's provenance",
    async (state) => {
      const { kernel, databasePath } = await openDatabase({
        causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 1 },
      });
      const message = await startRequest(kernel, "terminal-root");
      const decision = await prepareDecision(kernel, message, "orbit", "terminal");
      const run = await kernel.execute(decision.command, decision.context);
      const context = await activateRun(kernel, run, "orbit", "terminal");
      const child = await delegate(kernel, run, context, "keel", "child");
      await expect(kernel.execute(child.command, child.context))
        .rejects.toMatchObject({ code: "CausalLimitExceeded" });
      const terminal = state === "Completed" ? {
        type: "CompleteRun" as const,
        incorporatedThroughInputSequence: 1,
      } : state === "Failed" ? {
        type: "FailRun" as const, reason: "Synthetic failure.",
      } : {
        type: "CancelRun" as const, reason: "Human stopped the work.",
      };
      const command = {
        ...terminal, idempotencyKey: "terminal", runId: run.entityId,
        expectedRunRevision: 1,
      };
      const actor = state === "Cancelled" ? humanContext : context;
      const before = durableRows(databasePath);
      const hook = Symbol.for("torsor.kernel.command-before-commit");
      Reflect.set(globalThis, hook, ({ commandType }: { commandType: string }) => {
        if (commandType === command.type) throw new Error("Terminal rollback.");
      });
      try {
        await expect(kernel.execute(command, actor)).rejects.toThrow("Terminal rollback.");
      } finally {
        Reflect.deleteProperty(globalThis, hook);
      }
      expect(durableRows(databasePath)).toEqual(before);
      await expect(kernel.execute(child.command, child.context))
        .rejects.toMatchObject({ code: "CausalLimitExceeded" });
      await kernel.execute(command, actor);
      const created = await kernel.execute(child.command, child.context);
      expect((await kernel.query({
        type: "GetRunProjection", runId: created.entityId,
      }, humanContext)).run).toMatchObject({
        causalRootId: message.entityId, parentRunId: run.entityId, delegationDepth: 1,
      });
      const after = durableRows(databasePath);
      await kernel.execute(command, actor);
      expect(durableRows(databasePath)).toEqual(after);
      expect((await kernel.readEvents(null, 100)).find(
        (event) => event.type === `Run${state}`,
      )?.payload).toMatchObject({
        causalRootId: message.entityId, nonTerminalRunCount: 0,
        maxNonTerminalRunsPerRoot: 1,
      });
    },
  );

  it("keeps original provenance on continuation and uses new roots for each Human request", async () => {
    const { kernel } = await openDatabase({
      causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 1 },
    });
    const original = await startRequest(kernel, "original");
    const decision = await prepareDecision(kernel, original, "orbit", "original");
    const run = await kernel.execute(decision.command, decision.context);
    const context = await activateRun(kernel, run, "orbit", "original");
    const reply = await kernel.execute({
      type: "ReplyToThread", idempotencyKey: "human-reply",
      threadRootId: original.entityId, body: "Continue with this new evidence.",
      targetAgentIds: ["agent-orbit", "agent-keel"],
    }, humanContext);
    const continued = await prepareDecision(kernel, reply, "orbit", "continue");
    await kernel.execute({
      ...continued.command, type: "ResolveAttentionWithExistingRun",
      runId: run.entityId, expectedRunRevision: 1,
    }, continued.context);
    const other = await prepareDecision(kernel, reply, "keel", "reply-root");
    const newRoot = await kernel.execute(other.command, other.context);
    expect((await kernel.query({
      type: "GetRunProjection", runId: newRoot.entityId,
    }, humanContext)).run).toMatchObject({
      causalRootId: reply.entityId, parentRunId: null, delegationDepth: 0,
    });
    const sent = await kernel.execute({
      type: "SendToRun", idempotencyKey: "human-send",
      runId: run.entityId, expectedRunRevision: 2,
      body: "Add explicit Human input and ask Keel separately.",
      targetAgentIds: ["agent-orbit", "agent-keel"],
    }, humanContext);
    const sentDecision = await prepareDecision(kernel, sent, "keel", "send-root");
    const sentRoot = await kernel.execute(sentDecision.command, sentDecision.context);
    expect((await kernel.query({
      type: "GetRunProjection", runId: sentRoot.entityId,
    }, humanContext)).run).toMatchObject({
      causalRootId: sent.entityId, parentRunId: null, delegationDepth: 0,
    });
    const unchanged = await kernel.query({
      type: "GetRunProjection", runId: run.entityId,
    }, humanContext);
    expect(unchanged.run).toMatchObject({
      causalRootId: original.entityId, delegationDepth: 0,
      parentAttentionId: decision.command.attentionId, parentRunId: null, revision: 3,
    });
    expect(unchanged.inputs).toHaveLength(3);
    const child = await delegate(kernel, { ...run, revision: 3 }, context, "keel", "still-original");
    await expect(kernel.execute(child.command, child.context)).rejects.toMatchObject({
      code: "CausalLimitExceeded", details: { causalRootId: original.entityId },
    });
  });

  it("charges one slot for simultaneous first execution of the same idempotent decision", async () => {
    const { kernel, databasePath } = await openDatabase({
      causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 1 },
    });
    const request = await startRequest(kernel, "same-command");
    const decision = await prepareDecision(kernel, request, "orbit", "same-command");
    const outcomes = await raceDecisions(databasePath, [decision, decision]);
    expect(outcomes[0]!.status).toBe("fulfilled");
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(durableRows(databasePath).runs).toHaveLength(1);
    const otherTarget = await prepareDecision(kernel, request, "keel", "same-root-other-target");
    await expect(kernel.execute(otherTarget.command, otherTarget.context))
      .rejects.toMatchObject({
        code: "CausalLimitExceeded",
        details: { causalRootId: request.entityId, delegationDepth: 0, nonTerminalRunCount: 1 },
      });
  });

  it("inherits completion-reply provenance and never cascades a parent's capacity release", async () => {
    const { kernel } = await openDatabase({
      causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 2 },
    });
    const request = await startRequest(kernel, "complete-reply");
    const decision = await prepareDecision(kernel, request, "orbit", "parent");
    const parent = await kernel.execute(decision.command, decision.context);
    const context = await activateRun(kernel, parent, "orbit", "parent");
    const firstDecision = await delegate(kernel, parent, context, "keel", "first");
    const first = await kernel.execute(firstDecision.command, firstDecision.context);
    const complete = {
      type: "CompleteRun" as const, idempotencyKey: "final-reply",
      runId: parent.entityId, expectedRunRevision: 1,
      incorporatedThroughInputSequence: 1,
      finalReply: { body: "Follow up this result.", targetAgentIds: ["agent-keel"] },
    };
    await expect(kernel.execute({
      ...complete, finalReply: { ...complete.finalReply, causedByRunId: first.entityId },
    }, context)).rejects.toMatchObject({ code: "InvalidCommand" });
    const completed = await kernel.execute(complete, context);
    const thread = await kernel.query({
      type: "GetThreadProjection", threadRootId: request.entityId,
    }, humanContext);
    const finalMessage = thread.messages.find(
      (message) => message.id === completed.relatedIds!.finalMessageId,
    )!;
    const finalDecision = await prepareDecision(kernel, {
      commandType: "CompleteRun", entityId: finalMessage.id,
      relatedIds: { messageRevisionId: finalMessage.revisions[0]!.id },
    }, "keel", "final-child");
    const finalChild = await kernel.execute(finalDecision.command, finalDecision.context);
    expect((await kernel.query({
      type: "GetRunProjection", runId: finalChild.entityId,
    }, humanContext)).run).toMatchObject({
      parentRunId: parent.entityId, causalRootId: request.entityId, delegationDepth: 1,
    });
    expect((await kernel.query({
      type: "GetRunProjection", runId: first.entityId,
    }, humanContext)).run.state).toBe("Active");
    expect((await kernel.readEvents(null, 100)).find(
      (event) => event.type === "RunCompleted",
    )?.payload).toMatchObject({ nonTerminalRunCount: 1 });
  });

  it.each(["Failed", "Unknown"] as const)("retains capacity across Provider %s, Waiting, expiry and new Activations", async (status) => {
    let now = new Date("2026-09-21T08:00:00.000Z");
    const { kernel } = await openDatabase({
      causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 1 },
      clock: () => now,
    });
    const setup = await createRun(kernel);
    const parent: CommandResult = { commandType: "ResolveAttentionWithRun", entityId: setup.runId, revision: 1 };
    const decision = await delegate(kernel, parent, setup.agentContext, "keel", "provider-child");
    const attempt = await kernel.execute({
      type: "StartProviderAttempt", idempotencyKey: "provider-start",
      activationId: setup.activationId, adapter: "synthetic", adapterVersion: "1",
      capabilitySnapshot: {}, runInputIds: [setup.runInputId],
      requestIdempotencyKey: "provider-request",
      outboxEventId: setup.outboxEventId, outboxLeaseToken: setup.outboxLeaseToken,
    }, runtimeContext);
    if (status === "Failed") {
      await kernel.execute({
        type: "FailProviderAttempt", idempotencyKey: "provider-failed",
        providerAttemptId: attempt.entityId, error: "Synthetic transport failure.",
      }, runtimeContext);
    } else {
      await kernel.execute({
        type: "FinishProviderAttempt", idempotencyKey: "provider-unknown",
        providerAttemptId: attempt.entityId, status: "Unknown",
        detail: "Synthetic uncertain transport result.",
      }, runtimeContext);
    }
    await expect(kernel.execute(decision.command, decision.context))
      .rejects.toMatchObject({ code: "CausalLimitExceeded" });
    await kernel.execute({
      type: "ParkRunAfterProviderAttemptFailure", idempotencyKey: "park",
      runId: setup.runId, providerAttemptId: attempt.entityId,
      expectedRunRevision: 1, expectedActivationGeneration: 1,
      reason: "Retain work after transport failure.",
    }, runtimeContext);
    await expect(kernel.execute(decision.command, decision.context))
      .rejects.toMatchObject({ code: "CausalLimitExceeded" });
    now = new Date(now.getTime() + 600_000);
    const projection = await kernel.query({
      type: "GetThreadProjection", threadRootId: setup.threadId,
    }, humanContext);
    const source = projection.messages.find(
      (message) => message.causedByRunId === setup.runId,
    )!;
    const reclaimed = await prepareDecision(kernel, {
      commandType: "PublishRunReply", entityId: source.id,
      relatedIds: { messageRevisionId: source.revisions[0]!.id },
    }, "keel", "reclaimed");
    await expect(kernel.execute(reclaimed.command, reclaimed.context))
      .rejects.toMatchObject({ code: "CausalLimitExceeded" });
    const authority = await claimRunOutboxAuthority(kernel, setup.runId, "retry-provider");
    const activated = await kernel.execute({
      type: "StartActivation", idempotencyKey: "retry-activation",
      runId: setup.runId, expectedRunRevision: 2, ...authority,
    }, runtimeContext);
    await expect(kernel.execute(reclaimed.command, reclaimed.context))
      .rejects.toMatchObject({ code: "CausalLimitExceeded" });
    await kernel.execute({
      type: "WaitRun", idempotencyKey: "explicit-wait", runId: setup.runId,
      expectedRunRevision: activated.revision!, reason: "Await Human guidance.",
    }, { principalId: "principal-orbit", activationId: activated.entityId });
    await expect(kernel.execute(reclaimed.command, reclaimed.context))
      .rejects.toMatchObject({ code: "CausalLimitExceeded" });
  });

  it("persists immutable provenance and uses a root-scoped nonterminal index", async () => {
    const { kernel, databasePath } = await openDatabase();
    const request = await startRequest(kernel, "immutable");
    const decision = await prepareDecision(kernel, request, "orbit", "immutable");
    const created = await kernel.execute(decision.command, decision.context);
    const database = new DatabaseSync(databasePath);
    try {
      for (const assignment of [
        "causal_root_id = 'forged'", "parent_attention_id = 'forged'",
        "parent_run_id = 'forged'", "delegation_depth = 1",
      ]) {
        expect(() => database.prepare(`UPDATE runs SET ${assignment} WHERE id = ?`)
          .run(created.entityId)).toThrow("Run causal provenance is immutable");
      }
      const plan = database.prepare(`EXPLAIN QUERY PLAN
        SELECT COUNT(*) FROM runs WHERE causal_root_id = ?
        AND state NOT IN ('Completed', 'Failed', 'Cancelled')`).all(request.entityId);
      expect(plan.some((row) => String(row.detail).includes("runs_causal_nonterminal_idx")))
        .toBe(true);
    } finally {
      database.close();
    }
  });

  it.each([
    { maxDepth: -1, maxNonTerminalRunsPerRoot: 50 },
    { maxDepth: 1.5, maxNonTerminalRunsPerRoot: 50 },
    { maxDepth: 4, maxNonTerminalRunsPerRoot: 0 },
    { maxDepth: 4, maxNonTerminalRunsPerRoot: 1.5 },
    { maxDepth: Number.MAX_SAFE_INTEGER + 1, maxNonTerminalRunsPerRoot: 50 },
  ])("rejects invalid server configuration without initializing a partial schema: %j", async (causalLimits) => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-causal-invalid-"));
    directories.push(directory);
    const databasePath = join(directory, "kernel.sqlite");
    expect(() => TorsorKernel.open({ databasePath, causalLimits }))
      .toThrow(/safe integer/);
    const kernel = reopen(databasePath);
    expect(await kernel.readEvents(null, 100)).toEqual([]);
    const matching = TorsorKernel.open({
      databasePath, causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 50 },
    });
    matching.close();
  });

  it.each([
    { causalRootId: "forged-root" },
    { parentRunId: "forged-parent" },
    { parentAttentionId: "forged-attention" },
    { delegationDepth: 0 },
    { causalLimits: { maxDepth: 999, maxNonTerminalRunsPerRoot: 999 } },
    { maxDepth: 999 },
    { maxNonTerminalRunsPerRoot: 999 },
    { causal_root_id: "forged-root" },
    { parent_run_id: "forged-parent" },
    { parent_attention_id: "forged-attention" },
    { delegation_depth: 0 },
    { causedByRunId: "forged-parent" },
    { max_depth: 999 },
    { max_non_terminal_runs_per_root: 999 },
  ])("rejects forged server-owned fields: %j", async (forged) => {
    const { kernel } = await openDatabase();
    const message = await startRequest(kernel, "root");
    const decision = await prepareDecision(kernel, message, "orbit", "root");
    await expect(kernel.execute({
      ...decision.command, ...forged,
    }, decision.context)).rejects.toMatchObject({ code: "InvalidCommand" });
    const result = await kernel.execute(decision.command, decision.context);
    expect(result.revision).toBe(1);
  });
});
