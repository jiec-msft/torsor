import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import {
  type AttentionView,
  type CommandResult,
  type KernelCommand,
  type PrincipalContext,
  TorsorKernel,
} from "../src/index.js";
import {
  bootstrap,
  createRun,
  humanContext,
  runtimeContext,
} from "./helpers.js";

async function createClaimedAttention(
  kernel: TorsorKernel,
  key: string,
  threadRootId?: string,
  leaseDurationMs = 30_000,
): Promise<{
  activationId: string;
  attention: AttentionView;
  attentionRevision: number;
  context: PrincipalContext;
  leaseToken: string;
  threadRootId: string;
}> {
  const message = threadRootId
    ? await kernel.execute(
      {
        type: "ReplyToThread",
        idempotencyKey: `${key}-message`,
        threadRootId,
        body: `SQLite Attention ${key}.`,
        targetAgentIds: ["agent-orbit"],
      },
      humanContext,
    )
    : await kernel.execute(
      {
        type: "StartThread",
        idempotencyKey: `${key}-message`,
        projectId: "project-sample",
        channelId: "channel-general",
        body: `SQLite Attention ${key}.`,
        targetAgentIds: ["agent-orbit"],
      },
      humanContext,
    );
  const page = await kernel.query(
    {
      type: "ListOpenAttentions",
      targetAgentId: "agent-orbit",
      limit: 100,
    },
    runtimeContext,
  );
  const attention = page.items.find(
    (item) =>
      item.messageRevisionId === message.relatedIds!.messageRevisionId,
  );
  if (!attention) {
    throw new Error("Expected the SQLite Message to open an Attention.");
  }
  const claim = await kernel.execute(
    {
      type: "ClaimAttention",
      idempotencyKey: `${key}-claim`,
      attentionId: attention.id,
      expectedAttentionRevision: attention.revision,
      leaseDurationMs,
    },
    runtimeContext,
  );
  const leaseToken = claim.relatedIds!.handlerLeaseToken!;
  const activation = await kernel.execute(
    {
      type: "StartActivation",
      idempotencyKey: `${key}-activation`,
      attentionId: attention.id,
      handlerLeaseToken: leaseToken,
    },
    runtimeContext,
  );
  return {
    activationId: activation.entityId,
    attention,
    attentionRevision: claim.revision!,
    context: {
      principalId: "principal-orbit",
      activationId: activation.entityId,
    },
    leaseToken,
    threadRootId: threadRootId ?? message.entityId,
  };
}

type RacingCommandOutcome =
  | {
    status: "fulfilled";
    result: CommandResult;
  }
  | {
    status: "rejected";
    code: string | null;
    message: string;
  };

type RacingCommand = {
  ready: Promise<void>;
  result: Promise<RacingCommandOutcome>;
  worker: Worker;
};

function prepareRacingCommand(
  databasePath: string,
  signal: SharedArrayBuffer,
  command: KernelCommand,
  principalContext: PrincipalContext,
): RacingCommand {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const startSignal = new Int32Array(workerData.signal);
      import(workerData.moduleUrl)
        .then(async ({ TorsorKernel }) => {
          const kernel = TorsorKernel.open({
            databasePath: workerData.databasePath,
            bootstrap: workerData.bootstrap,
          });
          parentPort.postMessage({ type: "ready" });
          if (Atomics.wait(startSignal, 0, 0, 5000) === "timed-out") {
            throw new Error("Timed out waiting to start the racing command.");
          }
          try {
            const result = await kernel.execute(
              workerData.command,
              workerData.principalContext,
            );
            parentPort.postMessage({
              type: "outcome",
              outcome: { status: "fulfilled", result },
            });
          } catch (error) {
            parentPort.postMessage({
              type: "outcome",
              outcome: {
                status: "rejected",
                code:
                  typeof error === "object" &&
                  error !== null &&
                  "code" in error
                    ? error.code
                    : null,
                message:
                  error instanceof Error ? error.message : String(error),
              },
            });
          } finally {
            kernel.close();
          }
        })
        .catch((error) => {
          parentPort.postMessage({
            type: "error",
            message:
              error instanceof Error
                ? error.stack ?? error.message
                : String(error),
          });
        });
    `,
    {
      eval: true,
      workerData: {
        bootstrap,
        command,
        databasePath,
        moduleUrl: new URL("../dist/index.js", import.meta.url).href,
        principalContext,
        signal,
      },
    },
  );
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (outcome: RacingCommandOutcome) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<RacingCommandOutcome>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on(
    "message",
    (message: {
      message?: string;
      outcome?: RacingCommandOutcome;
      type: string;
    }) => {
      if (message.type === "ready") {
        resolveReady();
      } else if (message.type === "outcome" && message.outcome) {
        resolveResult(message.outcome);
      } else if (message.type === "error") {
        const error = new Error(
          message.message ?? "Racing command worker failed.",
        );
        rejectReady(error);
        rejectResult(error);
      }
    },
  );
  worker.on("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(
        `Racing command worker exited with code ${code}.`,
      );
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result, worker };
}

describe("Attention decisions with SQLite", () => {
  it("persists Ignore and existing-Run continuation across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-decisions-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const runSetup = await createRun(first);
      const continuedAttention = await createClaimedAttention(
        first,
        "reopen-continue",
        runSetup.threadId,
      );
      const continueCommand = {
        type: "ResolveAttentionWithExistingRun",
        idempotencyKey: "reopen-continue-decision",
        attentionId: continuedAttention.attention.id,
        expectedAttentionRevision:
          continuedAttention.attentionRevision,
        handlerLeaseToken: continuedAttention.leaseToken,
        runId: runSetup.runId,
        expectedRunRevision: 1,
      } as const;
      const continued = await first.execute(
        continueCommand,
        continuedAttention.context,
      );
      const ignoredAttention = await createClaimedAttention(
        first,
        "reopen-ignore",
      );
      const ignoreCommand = {
        type: "IgnoreAttention",
        idempotencyKey: "reopen-ignore-decision",
        attentionId: ignoredAttention.attention.id,
        expectedAttentionRevision: ignoredAttention.attentionRevision,
        handlerLeaseToken: ignoredAttention.leaseToken,
        reason: "No durable work is required.",
      } as const;
      const ignored = await first.execute(
        ignoreCommand,
        ignoredAttention.context,
      );
      first.close();

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const continuedRetry = await reopened.execute(
          continueCommand,
          continuedAttention.context,
        );
        const ignoredRetry = await reopened.execute(
          ignoreCommand,
          ignoredAttention.context,
        );
        const run = await reopened.query(
          { type: "GetRunProjection", runId: runSetup.runId },
          humanContext,
        );
        const continuedThread = await reopened.query(
          {
            type: "GetThreadProjection",
            threadRootId: runSetup.threadId,
          },
          humanContext,
        );
        const ignoredThread = await reopened.query(
          {
            type: "GetThreadProjection",
            threadRootId: ignoredAttention.threadRootId,
          },
          humanContext,
        );
        const events = await reopened.readEvents(null, 500);

        expect(continuedRetry).toEqual(continued);
        expect(ignoredRetry).toEqual(ignored);
        expect(run.run.revision).toBe(2);
        expect(run.inputs).toHaveLength(2);
        expect(
          run.inputs.filter(
            (input) =>
              input.sourceAttentionId ===
              continuedAttention.attention.id,
          ),
        ).toHaveLength(1);
        expect(
          continuedThread.attentions.find(
            (attention) =>
              attention.id === continuedAttention.attention.id,
          ),
        ).toMatchObject({
          status: "Resolved",
          resolutionOutcome: "ExistingRunContinued",
          resolvedRunId: runSetup.runId,
        });
        expect(
          ignoredThread.attentions.find(
            (attention) =>
              attention.id === ignoredAttention.attention.id,
          ),
        ).toMatchObject({
          status: "Ignored",
          resolutionOutcome: "Ignored",
          resolvedRunId: null,
        });
        expect(
          events.filter(
            (event) =>
              event.type === "AttentionIgnored" &&
              event.entityId === ignoredAttention.attention.id,
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) =>
              event.type === "RunInputAdded" &&
              event.entityId === continued.relatedIds!.runInputId,
          ),
        ).toHaveLength(1);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never resurrects superseded Attention authority after clock rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-domain-clock-"));
    const databasePath = join(directory, "kernel.sqlite");
    let now = new Date("2026-09-21T08:00:00.000Z");
    const options = {
      databasePath,
      bootstrap,
      clock: () => now,
    };
    const beforeCommitHookSymbol = Symbol.for(
      "torsor.kernel.command-before-commit",
    );
    try {
      const first = TorsorKernel.open(options);
      const second = TorsorKernel.open(options);
      const attentionA = await createClaimedAttention(
        first,
        "clock-owner-a",
        undefined,
        1_000,
      );
      const messageB = await first.execute(
        {
          type: "ReplyToThread",
          idempotencyKey: "clock-owner-b-message",
          threadRootId: attentionA.threadRootId,
          body: "SQLite Attention clock-owner-b.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const open = await first.query(
        {
          type: "ListOpenAttentions",
          targetAgentId: "agent-orbit",
          limit: 100,
        },
        runtimeContext,
      );
      const attentionB = open.items.find(
        (attention) =>
          attention.messageRevisionId ===
          messageB.relatedIds!.messageRevisionId,
      )!;
      const attemptA = await first.execute(
        {
          type: "StartProviderAttempt",
          idempotencyKey: "clock-owner-a-provider",
          activationId: attentionA.activationId,
          adapter: "deterministic-fake",
          adapterVersion: "1",
          capabilitySnapshot: {},
          runInputIds: [],
          requestIdempotencyKey: "clock-owner-a-request",
        },
        runtimeContext,
      );
      await first.execute(
        {
          type: "FinishProviderAttempt",
          idempotencyKey: "clock-owner-a-provider-finish",
          providerAttemptId: attemptA.entityId,
          status: "Completed",
        },
        runtimeContext,
      );

      const claimBCommand = {
        type: "ClaimAttention",
        idempotencyKey: "clock-owner-b-claim",
        attentionId: attentionB.id,
        expectedAttentionRevision: attentionB.revision,
        leaseDurationMs: 1_000,
      } as const;
      now = new Date("2026-09-21T08:00:02.000Z");
      Reflect.set(
        globalThis,
        beforeCommitHookSymbol,
        ({ commandType }: { readonly commandType: string }) => {
          if (commandType === "ClaimAttention") {
            throw new Error("Synthetic takeover rollback.");
          }
        },
      );
      await expect(
        second.execute(claimBCommand, runtimeContext),
      ).rejects.toThrow("Synthetic takeover rollback.");
      Reflect.deleteProperty(globalThis, beforeCommitHookSymbol);

      now = new Date("2026-09-21T08:00:00.500Z");
      await expect(
        first.execute(
          {
            type: "ClaimAttention",
            idempotencyKey: "clock-owner-a-claim",
            attentionId: attentionA.attention.id,
            expectedAttentionRevision: attentionA.attention.revision,
            leaseDurationMs: 1_000,
          },
          runtimeContext,
        ),
      ).resolves.toMatchObject({
        relatedIds: { handlerLeaseToken: attentionA.leaseToken },
      });

      now = new Date("2026-09-21T08:00:02.000Z");
      const claimB = await second.execute(claimBCommand, runtimeContext);
      const activationB = await second.execute(
        {
          type: "StartActivation",
          idempotencyKey: "clock-owner-b-activation",
          attentionId: attentionB.id,
          handlerLeaseToken: claimB.relatedIds!.handlerLeaseToken!,
        },
        runtimeContext,
      );
      first.close();
      second.close();

      now = new Date("2026-09-21T08:00:00.500Z");
      const reopened = TorsorKernel.open(options);
      try {
        await expect(
          reopened.execute(
            {
              type: "ClaimAttention",
              idempotencyKey: "clock-owner-a-claim",
              attentionId: attentionA.attention.id,
              expectedAttentionRevision: attentionA.attention.revision,
              leaseDurationMs: 1_000,
            },
            runtimeContext,
          ),
        ).rejects.toMatchObject({ code: "Conflict" });
        const reopenedAttentions = await reopened.query(
          {
            type: "ListOpenAttentions",
            targetAgentId: "agent-orbit",
            limit: 100,
          },
          runtimeContext,
        );
        const currentA = reopenedAttentions.items.find(
          (attention) => attention.id === attentionA.attention.id,
        )!;
        expect(currentA).toMatchObject({
          revision: attentionA.attentionRevision + 1,
          handlerLeaseHolderPrincipalId: null,
          handlerLeaseExpiresAt: null,
        });
        await expect(
          reopened.execute(
            {
              type: "IgnoreAttention",
              idempotencyKey: "clock-owner-a-stale-decision",
              attentionId: attentionA.attention.id,
              expectedAttentionRevision: currentA.revision,
              handlerLeaseToken: attentionA.leaseToken,
              reason: "Stale authority must not decide.",
            },
            attentionA.context,
          ),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/Conflict|Forbidden/),
        });
        await expect(
          reopened.execute(
            {
              type: "StartProviderAttempt",
              idempotencyKey: "clock-owner-a-stale-provider",
              activationId: attentionA.activationId,
              adapter: "deterministic-fake",
              adapterVersion: "1",
              capabilitySnapshot: {},
              runInputIds: [],
              requestIdempotencyKey: "clock-owner-a-stale-request",
            },
            runtimeContext,
          ),
        ).rejects.toMatchObject({ code: "Conflict" });

        await expect(
          reopened.execute(claimBCommand, runtimeContext),
        ).resolves.toMatchObject({
          relatedIds: {
            handlerLeaseToken: claimB.relatedIds!.handlerLeaseToken,
          },
        });
        const attemptB = await reopened.execute(
          {
            type: "StartProviderAttempt",
            idempotencyKey: "clock-owner-b-provider",
            activationId: activationB.entityId,
            adapter: "deterministic-fake",
            adapterVersion: "1",
            capabilitySnapshot: {},
            runInputIds: [],
            requestIdempotencyKey: "clock-owner-b-request",
          },
          runtimeContext,
        );
        await reopened.execute(
          {
            type: "FinishProviderAttempt",
            idempotencyKey: "clock-owner-b-provider-finish",
            providerAttemptId: attemptB.entityId,
            status: "Completed",
          },
          runtimeContext,
        );
        await expect(
          reopened.execute(
            {
              type: "IgnoreAttention",
              idempotencyKey: "clock-owner-b-decision",
              attentionId: attentionB.id,
              expectedAttentionRevision: claimB.revision!,
              handlerLeaseToken: claimB.relatedIds!.handlerLeaseToken!,
              reason: "The current domain owner remains authoritative.",
            },
            {
              principalId: "principal-orbit",
              activationId: activationB.entityId,
            },
          ),
        ).resolves.toMatchObject({ entityId: attentionB.id });
        expect(
          (await reopened.readEvents(null, 500)).filter(
            (event) =>
              event.type === "AttentionHandlerLeaseSuperseded" &&
              event.entityId === attentionA.attention.id,
          ),
        ).toHaveLength(1);
      } finally {
        reopened.close();
      }

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          database.prepare(
            `SELECT handler_lease_token, handler_lease_expires_at
               FROM attentions
              WHERE id = ?`,
          ).get(attentionA.attention.id),
        ).toMatchObject({
          handler_lease_token: null,
          handler_lease_expires_at: null,
        });
        expect(
          database.prepare(
            `SELECT revoked_at, revocation_reason
               FROM activation_attempts
              WHERE id = ?`,
          ).get(attentionA.activationId),
        ).toMatchObject({
          revoked_at: "2026-09-21T08:00:02.000Z",
          revocation_reason: "attention_domain_superseded",
        });
      } finally {
        database.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, beforeCommitHookSymbol);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes existing-Run continuation against Run completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-decision-race-"));
    const databasePath = join(directory, "kernel.sqlite");
    const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const startSignal = new Int32Array(signal);
    let continuationWorker: RacingCommand | undefined;
    let completionWorker: RacingCommand | undefined;
    try {
      const kernel = TorsorKernel.open({ databasePath, bootstrap });
      const runSetup = await createRun(kernel);
      const attention = await createClaimedAttention(
        kernel,
        "completion-race",
        runSetup.threadId,
      );
      kernel.close();

      continuationWorker = prepareRacingCommand(
        databasePath,
        signal,
        {
          type: "ResolveAttentionWithExistingRun",
          idempotencyKey: "race-continue",
          attentionId: attention.attention.id,
          expectedAttentionRevision: attention.attentionRevision,
          handlerLeaseToken: attention.leaseToken,
          runId: runSetup.runId,
          expectedRunRevision: 1,
        },
        attention.context,
      );
      completionWorker = prepareRacingCommand(
        databasePath,
        signal,
        {
          type: "CompleteRun",
          idempotencyKey: "race-complete",
          runId: runSetup.runId,
          expectedRunRevision: 1,
          incorporatedThroughInputSequence: 1,
        },
        runSetup.agentContext,
      );
      await Promise.all([
        continuationWorker.ready,
        completionWorker.ready,
      ]);
      Atomics.store(startSignal, 0, 1);
      Atomics.notify(startSignal, 0, 2);
      const [continuation, completion] = await Promise.all([
        continuationWorker.result,
        completionWorker.result,
      ]);

      expect(
        [continuation.status, completion.status].sort(),
      ).toEqual(["fulfilled", "rejected"]);
      if (continuation.status === "fulfilled") {
        expect(completion).toMatchObject({
          status: "rejected",
          code: "StaleRevision",
        });
      } else {
        expect(continuation).toMatchObject({
          status: "rejected",
          code: "TerminalRun",
        });
        expect(completion.status).toBe("fulfilled");
      }

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const run = await reopened.query(
          { type: "GetRunProjection", runId: runSetup.runId },
          humanContext,
        );
        const thread = await reopened.query(
          {
            type: "GetThreadProjection",
            threadRootId: runSetup.threadId,
          },
          humanContext,
        );
        const persistedAttention = thread.attentions.find(
          (candidate) => candidate.id === attention.attention.id,
        );

        if (continuation.status === "fulfilled") {
          expect(run.run).toMatchObject({
            state: "Active",
            revision: 2,
          });
          expect(run.inputs).toHaveLength(2);
          expect(persistedAttention).toMatchObject({
            status: "Resolved",
            resolutionOutcome: "ExistingRunContinued",
          });
        } else {
          expect(run.run).toMatchObject({
            state: "Completed",
            revision: 2,
          });
          expect(run.inputs).toHaveLength(1);
          expect(persistedAttention).toMatchObject({
            status: "Open",
            resolutionOutcome: null,
          });
        }
      } finally {
        reopened.close();
      }
    } finally {
      if (continuationWorker) {
        await continuationWorker.worker.terminate();
      }
      if (completionWorker) {
        await completionWorker.worker.terminate();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
