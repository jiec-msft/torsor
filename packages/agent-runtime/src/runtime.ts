import { randomUUID } from "node:crypto";

import {
  KernelError,
  type ActivationAttemptView,
  type AttentionView,
  type BootstrapAgent,
  type JsonValue,
  type OutboxEventView,
  type ProviderAttemptStatus,
  type RunProjection,
  type TorsorKernel,
} from "@torsor/kernel";

import { KernelActivationCapabilityBridge } from "./capability-bridge.js";
import {
  ProviderExecutionError,
  ProviderProtocolError,
  type ProviderAdapter,
  type ProviderCause,
} from "./types.js";

export interface AgentRuntimeHooks {
  readonly beforeAttentionClaim?: (attention: AttentionView) => Promise<void>;
  readonly attentionBufferChanged?: (input: {
    readonly size: number;
    readonly limit: number;
  }) => void;
  readonly afterProviderAttemptStarted?: (input: {
    readonly activationId: string;
    readonly providerAttemptId: string;
    readonly causeType: ProviderCause["type"];
  }) => Promise<void>;
  readonly beforeFailureParking?: (input: {
    readonly runId: string;
    readonly providerAttemptId: string;
    readonly outboxEventId: string;
  }) => Promise<void>;
  readonly afterFailureParking?: (input: {
    readonly runId: string;
    readonly providerAttemptId: string;
    readonly outboxEventId: string;
  }) => Promise<void>;
  readonly beforeAttentionRecoverySettlement?: (input: {
    readonly activationId: string;
    readonly providerAttemptId: string;
  }) => Promise<void>;
  readonly beforeOutboxAcknowledge?: (
    events: readonly OutboxEventView[],
  ) => Promise<void>;
}

export interface AgentRuntimeOptions {
  readonly kernel: TorsorKernel;
  readonly runtimePrincipalId: string;
  readonly projectIds: readonly string[];
  readonly adapter: ProviderAdapter;
  readonly attentionLeaseMs?: number;
  readonly attentionConcurrency?: number;
  readonly activationDurationMs?: number;
  readonly outboxLeaseMs?: number;
  readonly outboxBatchSize?: number;
  readonly providerTimeoutMs?: number;
  readonly cancellationPollMs?: number;
  readonly leaseSafetyMs?: number;
  readonly clock?: () => Date;
  readonly hooks?: AgentRuntimeHooks;
}

export interface RuntimePassResult {
  readonly attentionsDispatched: number;
  readonly outboxEventsProcessed: number;
}

interface RuntimePassExecution extends RuntimePassResult {
  readonly attentionsDeferred: number;
}

type AttentionDispatchResult = "dispatched" | "blocked" | "retry";

export class AgentRuntime {
  readonly #kernel: TorsorKernel;
  readonly #runtimeContext: { readonly principalId: string };
  readonly #projectIds: Set<string>;
  readonly #adapter: ProviderAdapter;
  readonly #attentionLeaseMs: number;
  readonly #attentionConcurrency: number;
  readonly #activationDurationMs: number | undefined;
  readonly #outboxLeaseMs: number;
  readonly #outboxBatchSize: number;
  readonly #providerTimeoutMs: number;
  readonly #cancellationPollMs: number;
  readonly #leaseSafetyMs: number;
  readonly #clock: () => Date;
  readonly #hooks: AgentRuntimeHooks;
  readonly #agents = new Map<string, BootstrapAgent>();
  #attentionProjectOffset = 0;

  constructor(options: AgentRuntimeOptions) {
    if (options.projectIds.length === 0) {
      throw new Error("AgentRuntime requires at least one Project.");
    }
    this.#kernel = options.kernel;
    this.#runtimeContext = { principalId: options.runtimePrincipalId };
    this.#projectIds = new Set(options.projectIds);
    this.#adapter = options.adapter;
    this.#attentionLeaseMs = options.attentionLeaseMs ?? 30_000;
    this.#attentionConcurrency = options.attentionConcurrency ?? 4;
    this.#activationDurationMs = options.activationDurationMs;
    this.#outboxLeaseMs = options.outboxLeaseMs ?? 30_000;
    this.#outboxBatchSize = options.outboxBatchSize ?? 1;
    this.#providerTimeoutMs = options.providerTimeoutMs ?? 25_000;
    this.#cancellationPollMs = options.cancellationPollMs ?? 250;
    this.#leaseSafetyMs = options.leaseSafetyMs ?? 1_000;
    this.#clock = options.clock ?? (() => new Date());
    this.#hooks = options.hooks ?? {};
    if (this.#outboxBatchSize !== 1) {
      throw new Error(
        "AgentRuntime currently requires outboxBatchSize=1 because the Kernel does not expose outbox lease renewal.",
      );
    }
    if (
      !Number.isInteger(this.#attentionConcurrency) ||
      this.#attentionConcurrency < 1 ||
      this.#attentionConcurrency > 32
    ) {
      throw new Error(
        "attentionConcurrency must be an integer between 1 and 32.",
      );
    }
    const minimumLeaseMs = this.#providerTimeoutMs + this.#leaseSafetyMs;
    if (this.#attentionLeaseMs < minimumLeaseMs) {
      throw new Error(
        `attentionLeaseMs must be at least providerTimeoutMs + leaseSafetyMs (${minimumLeaseMs}ms).`,
      );
    }
    if (this.#outboxLeaseMs < minimumLeaseMs) {
      throw new Error(
        `outboxLeaseMs must be at least providerTimeoutMs + leaseSafetyMs (${minimumLeaseMs}ms).`,
      );
    }
    if (
      this.#activationDurationMs !== undefined &&
      this.#activationDurationMs < minimumLeaseMs
    ) {
      throw new Error(
        `activationDurationMs must be at least providerTimeoutMs + leaseSafetyMs (${minimumLeaseMs}ms).`,
      );
    }
  }

  async runOnce(): Promise<RuntimePassResult> {
    const {
      attentionsDeferred: _attentionsDeferred,
      ...result
    } = await this.#runPass();
    return result;
  }

  async #runPass(): Promise<RuntimePassExecution> {
    await this.#refreshAgents();
    await this.#reconcileOrphanedAttentionExecutions();
    const attentionResult = await this.#dispatchOpenAttentions();
    const outboxEventsProcessed = await this.#drainOutboxBatch();
    return {
      attentionsDispatched: attentionResult.dispatched,
      attentionsDeferred: attentionResult.deferred,
      outboxEventsProcessed,
    };
  }

  async drainUntilIdle(maxPasses = 100): Promise<RuntimePassResult> {
    let attentionsDispatched = 0;
    let outboxEventsProcessed = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const result = await this.#runPass();
      attentionsDispatched += result.attentionsDispatched;
      outboxEventsProcessed += result.outboxEventsProcessed;
      if (
        result.attentionsDispatched === 0 &&
        result.attentionsDeferred === 0 &&
        result.outboxEventsProcessed === 0
      ) {
        return { attentionsDispatched, outboxEventsProcessed };
      }
    }
    throw new Error(`AgentRuntime did not become idle after ${maxPasses} passes.`);
  }

  async #refreshAgents(): Promise<void> {
    this.#agents.clear();
    for (const projectId of this.#projectIds) {
      await this.#loadProject(projectId);
    }
  }

  async #dispatchOpenAttentions(): Promise<{
    readonly dispatched: number;
    readonly deferred: number;
  }> {
    const scheduler = new AttentionScheduler({
      concurrency: this.#attentionConcurrency,
      bufferLimit: this.#attentionConcurrency * 100,
      domainLimit: 100,
      ...(this.#hooks.attentionBufferChanged
        ? { onBufferChanged: this.#hooks.attentionBufferChanged }
        : {}),
      dispatch: async (attention) => {
        const agent = this.#agents.get(attention.targetAgentId);
        if (!agent) {
          throw new Error(
            `Attention ${attention.id} targets unknown Agent ${attention.targetAgentId}.`,
          );
        }
        return this.#dispatchAttention(attention, agent);
      },
    });
    const producerError = await this.#enqueueOpenAttentions(scheduler);
    const result = await scheduler.drain();
    if (producerError !== undefined) {
      throw producerError;
    }
    return result;
  }

  async #enqueueOpenAttentions(
    scheduler: AttentionScheduler,
  ): Promise<unknown> {
    const projectIds = [...this.#projectIds];
    const offset =
      projectIds.length === 0
        ? 0
        : this.#attentionProjectOffset % projectIds.length;
    const orderedProjectIds = [
      ...projectIds.slice(offset),
      ...projectIds.slice(0, offset),
    ];
    if (projectIds.length > 0) {
      this.#attentionProjectOffset =
        (offset +
          Math.min(projectIds.length, this.#attentionConcurrency)) %
        projectIds.length;
    }
    let states = orderedProjectIds.map((projectId) => ({
      projectId,
      afterCursor: undefined as number | undefined,
      snapshotEventId: undefined as string | null | undefined,
    }));
    let firstError: unknown;
    while (states.length > 0 && firstError === undefined) {
      const batch = states.splice(0, this.#attentionConcurrency);
      const results = await Promise.all(
        batch.map(async (state) => {
          try {
            const page = await this.#kernel.query(
              {
                type: "ListOpenAttentions",
                projectId: state.projectId,
                ...(state.afterCursor === undefined
                  ? {}
                  : { afterCursor: state.afterCursor }),
                ...(state.snapshotEventId === undefined
                  ? {}
                  : { snapshotEventId: state.snapshotEventId }),
                limit: 100,
              },
              this.#runtimeContext,
            );
            return { state, page };
          } catch (error) {
            firstError ??= error;
            return undefined;
          }
        }),
      );
      const pages = results.filter(
        (
          result,
        ): result is NonNullable<(typeof results)[number]> =>
          result !== undefined,
      );
      for (let index = 0; index < 100; index += 1) {
        for (const { page } of pages) {
          const attention = page.items[index];
          if (attention === undefined) {
            continue;
          }
          if (
            attention.handlerLeaseExpiresAt !== null &&
            new Date(attention.handlerLeaseExpiresAt) > this.#clock()
          ) {
            continue;
          }
          scheduler.enqueue(attention);
        }
      }
      for (const { state, page } of pages) {
        if (page.hasMore && page.nextCursor !== null) {
          states.push({
            projectId: state.projectId,
            afterCursor: page.nextCursor,
            snapshotEventId: page.snapshotEventId,
          });
        }
      }
    }
    return firstError;
  }

  async #loadProject(projectId: string): Promise<void> {
    this.#projectIds.add(projectId);
    const bootstrap = await this.#kernel.query(
      { type: "GetBootstrap", projectId },
      this.#runtimeContext,
    );
    for (const agent of bootstrap.agents) {
      this.#agents.set(agent.id, agent);
    }
  }

  async #dispatchAttention(
    attention: AttentionView,
    agent: BootstrapAgent,
  ): Promise<AttentionDispatchResult> {
    const orderingProjection = await this.#kernel.query(
      {
        type: "GetThreadProjection",
        threadRootId: attention.threadRootId,
      },
      this.#runtimeContext,
    );
    if (
      orderingProjection.attentions.some(
        (candidate) =>
          candidate.targetAgentId === attention.targetAgentId &&
          candidate.status === "Open" &&
          candidate.cursor < attention.cursor,
      )
    ) {
      return "blocked";
    }
    await this.#hooks.beforeAttentionClaim?.(attention);
    let claim;
    try {
      claim = await this.#kernel.execute(
        {
          type: "ClaimAttention",
          idempotencyKey: `attention:${attention.id}:claim:${attention.revision}:${randomUUID()}`,
          attentionId: attention.id,
          expectedAttentionRevision: attention.revision,
          leaseDurationMs: this.#attentionLeaseMs,
        },
        this.#runtimeContext,
      );
    } catch (error) {
      if (
        error instanceof KernelError &&
        (error.code === "Conflict" || error.code === "StaleRevision")
      ) {
        const currentProjection = await this.#kernel.query(
          {
            type: "GetThreadProjection",
            threadRootId: attention.threadRootId,
          },
          this.#runtimeContext,
        );
        const currentAttention = currentProjection.attentions.find(
          (candidate) => candidate.id === attention.id,
        );
        if (
          currentAttention?.status === "Open" &&
          currentAttention.handlerLeaseExpiresAt !== null &&
          new Date(currentAttention.handlerLeaseExpiresAt) > this.#clock()
        ) {
          return "blocked";
        }
        return "retry";
      }
      throw error;
    }
    const handlerLeaseToken = claim.relatedIds?.handlerLeaseToken;
    if (!handlerLeaseToken || claim.revision === undefined) {
      throw new Error(`Attention claim ${attention.id} returned no live lease.`);
    }
    const activation = await this.#kernel.execute(
      {
        type: "StartActivation",
        idempotencyKey: `attention:${attention.id}:activation:${handlerLeaseToken}`,
        attentionId: attention.id,
        handlerLeaseToken,
        ...(this.#activationDurationMs === undefined
          ? {}
          : { durationMs: this.#activationDurationMs }),
      },
      this.#runtimeContext,
    );
    const thread = await this.#kernel.query(
      {
        type: "GetThreadProjection",
        threadRootId: attention.threadRootId,
      },
      this.#runtimeContext,
    );
    const triggeringMessage = thread.messages.find((message) =>
      message.revisions.some(
        (revision) => revision.id === attention.messageRevisionId,
      ),
    );
    const triggeringRevision = triggeringMessage?.revisions.find(
      (revision) => revision.id === attention.messageRevisionId,
    );
    if (!triggeringMessage || !triggeringRevision) {
      throw new Error(
        `Attention ${attention.id} triggering Message revision is not in its Thread projection.`,
      );
    }
    const eligibleRuns = thread.runs.filter(
      (run) =>
        run.ownerAgentId === attention.targetAgentId &&
        run.projectId === attention.projectId &&
        run.homeChannelId === attention.channelId &&
        run.threadRootId === attention.threadRootId &&
        (run.state === "Active" || run.state === "Waiting"),
    );
    const cause = {
      type: "attention",
      attention,
      thread,
      triggeringMessage,
      triggeringRevision,
      eligibleRuns,
    } as const;
    await this.#executeProvider({
      activationId: activation.entityId,
      agent,
      cause,
      attentionRevision: claim.revision,
      handlerLeaseToken,
      runInputIds: [],
      requestIdempotencyKey: `attention:${attention.id}:${handlerLeaseToken}`,
    });
    return "dispatched";
  }

  async #drainOutboxBatch(): Promise<number> {
    const claim = await this.#kernel.execute(
      {
        type: "ClaimOutboxEvents",
        idempotencyKey: `outbox-claim:${randomUUID()}`,
        limit: this.#outboxBatchSize,
        leaseDurationMs: this.#outboxLeaseMs,
      },
      this.#runtimeContext,
    );
    const events = claim.outboxEvents ?? [];
    if (events.length === 0) {
      return 0;
    }
    for (const event of events) {
      await this.#processOutboxEvent(event);
    }
    await this.#hooks.beforeOutboxAcknowledge?.(events);
    await this.#kernel.execute(
      {
        type: "AcknowledgeOutboxEvents",
        idempotencyKey: `outbox-ack:${claim.leaseToken}`,
        outboxEventIds: events.map((event) => event.id),
        leaseToken: claim.leaseToken!,
      },
      this.#runtimeContext,
    );
    return events.length;
  }

  async #processOutboxEvent(event: OutboxEventView): Promise<void> {
    if (event.topic === "message.published") {
      const threadRootId = requirePayloadString(event.payload, "threadRootId");
      const thread = await this.#kernel.query(
        { type: "GetThreadProjection", threadRootId },
        this.#runtimeContext,
      );
      await this.#loadProject(thread.projectId);
      return;
    }
    if (
      event.topic !== "run.activation-requested" &&
      event.topic !== "run-input.available"
    ) {
      return;
    }
    const projection = await this.#kernel.query(
      { type: "GetRunProjection", runId: event.aggregateId },
      this.#runtimeContext,
    );
    const requestIdempotencyKey = `outbox:${event.id}:provider`;
    let currentProjection = projection;
    let activationView: ActivationAttemptView;
    const priorAttempt = currentProjection.providerAttempts
      .filter(
        (candidate) =>
          candidate.requestIdempotencyKey === requestIdempotencyKey,
      )
      .at(-1);
    if (priorAttempt) {
      activationView = requireActivation(
        currentProjection,
        priorAttempt.activationId,
      );
      if (priorAttempt.status === "Completed") {
        await this.#reconcileRunProjection(currentProjection);
        return;
      }
      if (
        priorAttempt.status === "Failed" ||
        priorAttempt.status === "Unknown"
      ) {
        if (
          currentProjection.run.state === "Active" &&
          activationView.runActivationGeneration ===
            currentProjection.run.activationGeneration
        ) {
          await this.#parkRunAfterDeliveryFailure(
            currentProjection,
            event,
            priorAttempt.status,
          );
        } else {
          await this.#reconcileRunProjection(currentProjection);
        }
        return;
      }
      if (
        !isActivationUsable(
          activationView,
          currentProjection,
          this.#clock(),
        ) ||
        !this.#adapter.capabilities.supportsIdempotentRequests
      ) {
        await this.#settleUncertainAttempt(
          currentProjection,
          activationView.id,
          priorAttempt.status,
        );
        currentProjection = await this.#kernel.query(
          { type: "GetRunProjection", runId: currentProjection.run.id },
          this.#runtimeContext,
        );
        if (currentProjection.run.state === "Active") {
          await this.#parkRunAfterDeliveryFailure(
            currentProjection,
            event,
            "Unknown",
          );
        } else {
          await this.#reconcileRunProjection(currentProjection);
        }
        return;
      }
    } else {
      if (
        currentProjection.run.state !== "Active" &&
        !(
          event.topic === "run-input.available" &&
          currentProjection.run.state === "Waiting"
        )
      ) {
        await this.#reconcileRunProjection(currentProjection);
        return;
      }
      const activation = await this.#kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: `outbox:${event.id}:activation:${currentProjection.run.revision}`,
          runId: currentProjection.run.id,
          expectedRunRevision: currentProjection.run.revision,
          ...(this.#activationDurationMs === undefined
            ? {}
            : { durationMs: this.#activationDurationMs }),
        },
        this.#runtimeContext,
      );
      currentProjection = await this.#kernel.query(
        { type: "GetRunProjection", runId: currentProjection.run.id },
        this.#runtimeContext,
      );
      activationView = requireActivation(
        currentProjection,
        activation.entityId,
      );
    }
    let agent = this.#agents.get(currentProjection.run.ownerAgentId);
    if (!agent) {
      await this.#loadProject(currentProjection.run.projectId);
      agent = this.#agents.get(currentProjection.run.ownerAgentId);
    }
    if (!agent) {
      throw new Error(
        `Run ${currentProjection.run.id} belongs to unknown Agent ${currentProjection.run.ownerAgentId}.`,
      );
    }
    const thread = await this.#kernel.query(
      {
        type: "GetThreadProjection",
        threadRootId: currentProjection.run.threadRootId,
      },
      this.#runtimeContext,
    );
    const cause = {
      type: "run",
      run: currentProjection,
      thread,
    } as const;
    const pendingInputIds = new Set(
      currentProjection.inputs
        .filter((input) => input.disposition === "Pending")
        .map((input) => input.id),
    );
    const deliveryInputIds = activationView.runInputIds.filter((inputId) =>
      pendingInputIds.has(inputId),
    );
    if (deliveryInputIds.length === 0) {
      await this.#kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: `${activationView.id}:no-pending-input`,
          activationId: activationView.id,
          outcome: "Completed",
          detail: "The outbox wake-up had no Pending RunInput to deliver.",
        },
        this.#runtimeContext,
      );
      return;
    }
    await this.#executeProvider({
      activationId: activationView.id,
      agent,
      cause,
      runInputIds: deliveryInputIds,
      requestIdempotencyKey,
    });
  }

  async #executeProvider(input: {
    readonly activationId: string;
    readonly agent: BootstrapAgent;
    readonly cause: ProviderCause;
    readonly attentionRevision?: number;
    readonly handlerLeaseToken?: string;
    readonly runInputIds: readonly string[];
    readonly requestIdempotencyKey: string;
  }): Promise<void> {
    const attempt = await this.#kernel.execute(
      {
        type: "StartProviderAttempt",
        idempotencyKey: `${input.activationId}:provider-attempt`,
        activationId: input.activationId,
        adapter: this.#adapter.name,
        adapterVersion: this.#adapter.version,
        capabilitySnapshot: providerCapabilitiesJson(this.#adapter),
        runInputIds: input.runInputIds,
        requestIdempotencyKey: input.requestIdempotencyKey,
      },
      this.#runtimeContext,
    );
    await this.#hooks.afterProviderAttemptStarted?.({
      activationId: input.activationId,
      providerAttemptId: attempt.entityId,
      causeType: input.cause.type,
    });
    const existingStatus = await this.#findProviderAttemptStatus(
      attempt.entityId,
    );
    if (existingStatus && isTerminalProviderStatus(existingStatus)) {
      return;
    }
    const bridge =
      input.cause.type === "attention"
        ? new KernelActivationCapabilityBridge({
            kernel: this.#kernel,
            agent: input.agent,
            activationId: input.activationId,
            providerAttemptId: attempt.entityId,
            causeType: "attention",
            attention: input.cause.attention,
            attentionRevision: input.attentionRevision!,
            handlerLeaseToken: input.handlerLeaseToken!,
            eligibleRuns: input.cause.eligibleRuns,
          })
        : new KernelActivationCapabilityBridge({
            kernel: this.#kernel,
            agent: input.agent,
            activationId: input.activationId,
            providerAttemptId: attempt.entityId,
            causeType: "run",
            projection: input.cause.run,
          });
    const controller = new AbortController();
    const stopMonitor = this.#monitorExecution(
      input.cause,
      input.activationId,
      controller,
      () => bridge.terminalAction !== null,
    );
    try {
      const result = await executeWithAbort(
        this.#adapter.execute({
          activationId: input.activationId,
          providerAttemptId: attempt.entityId,
          requestIdempotencyKey: input.requestIdempotencyKey,
          agent: input.agent,
          cause: input.cause,
          capabilities: bridge,
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (input.cause.type === "attention" && !bridge.attentionDecision) {
        throw new ProviderProtocolError(
          "Attention provider execution ended without ignore, continue, or create.",
        );
      }
      if (input.cause.type === "run" && !bridge.terminalAction) {
        throw new ProviderProtocolError(
          "Run provider execution ended without complete, fail, or wait.",
        );
      }
      await this.#settleProviderAttempt({
        providerAttemptId: attempt.entityId,
        idempotencyKey: `${attempt.entityId}:completed`,
        status: "Completed",
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
      if (input.cause.type === "run") {
        await this.#kernel.execute(
          {
            type: "FinishActivation",
            idempotencyKey: `${input.activationId}:completed`,
            activationId: input.activationId,
            outcome: "Completed",
            ...(result.diagnosticSessionId
              ? {
                  detail: `Provider diagnostic session: ${result.diagnosticSessionId}`,
                }
              : {}),
          },
          this.#runtimeContext,
        );
      }
    } catch (error) {
      const providerError =
        error instanceof ProviderExecutionError
          ? error
          : new ProviderExecutionError(errorMessage(error), "Failed");
      if (input.cause.type === "run" && bridge.terminalAction === null) {
        const latest = await this.#kernel.query(
          { type: "GetRunProjection", runId: input.cause.run.run.id },
          this.#runtimeContext,
        );
        const activation = latest.activations.find(
          (candidate) => candidate.id === input.activationId,
        );
        if (
          latest.run.state === "Active" &&
          activation?.finishedAt === null &&
          activation.revokedAt === null &&
          activation.runActivationGeneration === latest.run.activationGeneration
        ) {
          try {
            await bridge.wait(
              `Provider delivery did not complete: ${providerError.message}`,
            );
          } catch (waitError) {
            if (
              !(
                waitError instanceof KernelError &&
                (waitError.code === "StaleRevision" ||
                  waitError.code === "Conflict" ||
                  waitError.code === "TerminalRun")
              )
            ) {
              throw waitError;
            }
          }
        }
      }
      if (providerError.outcome === "Unknown") {
        await this.#settleProviderAttempt({
          providerAttemptId: attempt.entityId,
          idempotencyKey: `${attempt.entityId}:unknown`,
          status: "Unknown",
          detail: providerError.message,
        });
      } else {
        await this.#settleProviderAttempt({
          providerAttemptId: attempt.entityId,
          idempotencyKey: `${attempt.entityId}:failed`,
          status: "Failed",
          detail: providerError.message,
        });
      }
      if (input.cause.type === "run" || !bridge.attentionDecision) {
        await this.#kernel.execute(
          {
            type: "FinishActivation",
            idempotencyKey: `${input.activationId}:failed`,
            activationId: input.activationId,
            outcome: controller.signal.aborted ? "Expired" : "Failed",
            detail: providerError.message,
          },
          this.#runtimeContext,
        );
      }
      throw providerError;
    } finally {
      stopMonitor();
    }
  }

  #monitorExecution(
    cause: ProviderCause,
    activationId: string,
    controller: AbortController,
    hasProviderTerminalAction: () => boolean,
  ): () => void {
    const timeout = setTimeout(() => {
      controller.abort(
        new ProviderExecutionError(
          `Provider execution exceeded ${this.#providerTimeoutMs}ms.`,
          "Unknown",
        ),
      );
    }, this.#providerTimeoutMs);
    let stopped = false;
    let poll: NodeJS.Timeout | undefined;
    const check = async () => {
      if (stopped || controller.signal.aborted || cause.type !== "run") {
        return;
      }
      try {
        const projection = await this.#kernel.query(
          { type: "GetRunProjection", runId: cause.run.run.id },
          this.#runtimeContext,
        );
        if (hasProviderTerminalAction()) {
          return;
        }
        const activation = projection.activations.find(
          (candidate) => candidate.id === activationId,
        );
        if (
          !activation ||
          activation.finishedAt !== null ||
          activation.revokedAt !== null ||
          new Date(activation.expiresAt) <= this.#clock() ||
          activation.runActivationGeneration !==
            projection.run.activationGeneration
        ) {
          controller.abort(
            new ProviderExecutionError(
              "Run Activation was superseded while the provider was executing.",
              "Unknown",
            ),
          );
          return;
        }
        if (projection.run.state !== "Active") {
          controller.abort(
            new ProviderExecutionError(
              `Run entered ${projection.run.state} while the provider was executing.`,
              "Unknown",
            ),
          );
          return;
        }
      } catch (error) {
        controller.abort(
          new ProviderExecutionError(
            `Cancellation monitor failed: ${errorMessage(error)}`,
            "Unknown",
          ),
        );
        return;
      }
      poll = setTimeout(() => {
        void check();
      }, this.#cancellationPollMs);
    };
    poll = setTimeout(() => {
      void check();
    }, this.#cancellationPollMs);
    return () => {
      stopped = true;
      clearTimeout(timeout);
      if (poll) {
        clearTimeout(poll);
      }
    };
  }

  async #findProviderAttemptStatus(
    providerAttemptId: string,
  ): Promise<ProviderAttemptStatus> {
    const attempt = await this.#kernel.query(
      {
        type: "GetProviderAttempt",
        providerAttemptId,
      },
      this.#runtimeContext,
    );
    return attempt.status;
  }

  async #settleProviderAttempt(input: {
    readonly providerAttemptId: string;
    readonly idempotencyKey: string;
    readonly status: "Completed" | "Failed" | "Unknown";
    readonly detail?: string;
  }): Promise<ProviderAttemptStatus> {
    try {
      if (input.status === "Failed") {
        await this.#kernel.execute(
          {
            type: "FailProviderAttempt",
            idempotencyKey: input.idempotencyKey,
            providerAttemptId: input.providerAttemptId,
            error: input.detail ?? "Provider execution failed.",
          },
          this.#runtimeContext,
        );
      } else {
        await this.#kernel.execute(
          {
            type: "FinishProviderAttempt",
            idempotencyKey: input.idempotencyKey,
            providerAttemptId: input.providerAttemptId,
            status: input.status,
            ...(input.detail === undefined ? {} : { detail: input.detail }),
          },
          this.#runtimeContext,
        );
      }
      return input.status;
    } catch (error) {
      if (!(error instanceof KernelError && error.code === "Conflict")) {
        throw error;
      }
      const status = await this.#findProviderAttemptStatus(
        input.providerAttemptId,
      );
      if (!isTerminalProviderStatus(status)) {
        throw error;
      }
      return status;
    }
  }

  async #settleUncertainAttempt(
    projection: RunProjection,
    activationId: string,
    status: ProviderAttemptStatus,
  ): Promise<void> {
    const attempt = projection.providerAttempts.find(
      (candidate) => candidate.activationId === activationId,
    );
    if (!attempt || isTerminalProviderStatus(attempt.status)) {
      return;
    }
    await this.#kernel.execute(
      {
        type: "FinishProviderAttempt",
        idempotencyKey: `${attempt.id}:recovered-unknown`,
        providerAttemptId: attempt.id,
        status: "Unknown",
        detail: `Runtime recovered an unfinished ${status} attempt for a non-idempotent adapter.`,
      },
      this.#runtimeContext,
    );
    const activation = requireActivation(projection, activationId);
    if (activation.finishedAt === null) {
      await this.#kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: `${activationId}:recovered-expired`,
          activationId,
          outcome: "Expired",
          detail: "The owning runtime process was replaced.",
        },
        this.#runtimeContext,
      );
    }
  }

  async #parkRunAfterDeliveryFailure(
    projection: RunProjection,
    event: OutboxEventView,
    status: "Failed" | "Unknown",
  ): Promise<void> {
    const attempt = projection.providerAttempts
      .filter(
        (candidate) =>
          candidate.requestIdempotencyKey ===
          `outbox:${event.id}:provider`,
      )
      .at(-1);
    if (!attempt) {
      throw new Error(
        `Outbox delivery ${event.id} has no ProviderAttempt to park.`,
      );
    }
    const hookInput = {
      runId: projection.run.id,
      providerAttemptId: attempt.id,
      outboxEventId: event.id,
    };
    await this.#hooks.beforeFailureParking?.(hookInput);
    await this.#kernel.execute(
      {
        type: "ParkRunAfterProviderAttemptFailure",
        idempotencyKey: `outbox:${event.id}:delivery-${status.toLowerCase()}-park`,
        runId: projection.run.id,
        providerAttemptId: attempt.id,
        expectedRunRevision: projection.run.revision,
        expectedActivationGeneration: projection.run.activationGeneration,
        reason:
          status === "Unknown"
            ? "Provider delivery outcome is unknown and requires explicit resumption."
            : "Provider delivery failed and requires explicit resumption.",
      },
      this.#runtimeContext,
    );
    await this.#hooks.afterFailureParking?.(hookInput);
  }

  async #reconcileRunProjection(projection: RunProjection): Promise<void> {
    for (const activation of projection.activations) {
      if (activation.finishedAt !== null) {
        continue;
      }
      const attempt = projection.providerAttempts.find(
        (candidate) => candidate.activationId === activation.id,
      );
      let outcome: "Completed" | "Failed" | "Expired" = "Expired";
      let detail = "The owning runtime process was replaced.";
      if (attempt?.status === "Completed") {
        outcome = "Completed";
        detail = "Recovered a completed ProviderAttempt.";
      } else if (attempt?.status === "Failed") {
        outcome = "Failed";
        detail = attempt.detail ?? "Recovered a failed ProviderAttempt.";
      } else if (
        attempt &&
        (attempt.status === "Started" || attempt.status === "Acknowledged")
      ) {
        await this.#kernel.execute(
          {
            type: "FinishProviderAttempt",
            idempotencyKey: `${attempt.id}:reconciled-unknown`,
            providerAttemptId: attempt.id,
            status: "Unknown",
            detail:
              "Runtime recovered an unfinished ProviderAttempt after its Run stopped being Active.",
          },
          this.#runtimeContext,
        );
        detail = "Recovered an uncertain ProviderAttempt.";
      }
      await this.#kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: `${activation.id}:reconciled-${outcome.toLowerCase()}`,
          activationId: activation.id,
          outcome,
          detail,
        },
        this.#runtimeContext,
      );
    }
  }

  async #reconcileOrphanedAttentionExecutions(): Promise<void> {
    let afterCursor:
      | {
          readonly startedAt: string;
          readonly activationId: string;
        }
      | undefined;
    for (;;) {
      const page = await this.#kernel.query(
        {
          type: "ListRecoverableAttentionExecutions",
          ...(afterCursor ? { afterCursor } : {}),
          limit: 100,
        },
        this.#runtimeContext,
      );
      for (const execution of page.items) {
        if (
          execution.activation.finishedAt === null &&
          new Date(execution.activation.expiresAt) > this.#clock()
        ) {
          continue;
        }
        let outcome: "Completed" | "Failed" | "Expired" = "Expired";
        let detail =
          "The Attention Activation expired before it was reconciled.";
        const latestAttempt = execution.providerAttempts.at(-1);
        let latestStatus = latestAttempt?.status;
        for (const attempt of execution.providerAttempts) {
          if (
            attempt.status !== "Started" &&
            attempt.status !== "Acknowledged"
          ) {
            continue;
          }
          await this.#hooks.beforeAttentionRecoverySettlement?.({
            activationId: execution.activation.id,
            providerAttemptId: attempt.id,
          });
          const settledStatus = await this.#settleProviderAttempt({
            providerAttemptId: attempt.id,
            idempotencyKey: `${attempt.id}:attention-reconciled-unknown`,
            status: "Unknown",
            detail:
              "Runtime recovered an unfinished expired Attention ProviderAttempt.",
          });
          if (attempt.id === latestAttempt?.id) {
            latestStatus = settledStatus;
          }
          detail = "Recovered an uncertain expired Attention ProviderAttempt.";
        }
        if (latestStatus === "Completed") {
          outcome = "Completed";
          detail = "Recovered a completed Attention ProviderAttempt.";
        } else if (latestStatus === "Failed") {
          outcome = "Failed";
          detail = "Recovered a failed Attention ProviderAttempt.";
        }
        if (execution.activation.finishedAt === null) {
          await this.#kernel.execute(
            {
              type: "FinishActivation",
              idempotencyKey: `${execution.activation.id}:attention-reconciled-${outcome.toLowerCase()}`,
              activationId: execution.activation.id,
              outcome,
              detail,
            },
            this.#runtimeContext,
          );
        }
      }
      if (!page.hasMore || !page.nextCursor) {
        break;
      }
      afterCursor = page.nextCursor;
    }
  }
}

interface AttentionSchedulerOptions {
  readonly concurrency: number;
  readonly bufferLimit: number;
  readonly domainLimit: number;
  readonly dispatch: (
    attention: AttentionView,
  ) => Promise<AttentionDispatchResult>;
  readonly onBufferChanged?: (input: {
    readonly size: number;
    readonly limit: number;
  }) => void;
}

class AttentionScheduler {
  readonly #queues = new Map<
    string,
    Array<{
      readonly attention: AttentionView;
    }>
  >();
  readonly #activeDomains = new Set<string>();
  readonly #domainDeferred = new Map<string, number>();
  readonly #readyDomains: string[] = [];
  readonly #readyDomainSet = new Set<string>();
  readonly #drainWaiters = new Set<() => void>();
  #buffered = 0;
  #dispatched = 0;
  #deferred = 0;
  #firstError: unknown;

  constructor(private readonly options: AttentionSchedulerOptions) {}

  enqueue(attention: AttentionView): boolean {
    const key = attentionConflictDomain(attention);
    const queue = this.#queues.get(key);
    if (this.#buffered >= this.options.bufferLimit) {
      this.#deferred += 1;
      return false;
    }
    if ((queue?.length ?? 0) >= this.options.domainLimit) {
      this.#deferred += 1;
      this.#domainDeferred.set(
        key,
        (this.#domainDeferred.get(key) ?? 0) + 1,
      );
      return false;
    }
    if (queue) {
      queue.push({ attention });
    } else {
      this.#queues.set(key, [{ attention }]);
    }
    this.#buffered += 1;
    this.#markReady(key);
    this.#pump();
    this.#notifyRetainedChanged();
    return true;
  }

  async drain(): Promise<{
    readonly dispatched: number;
    readonly deferred: number;
  }> {
    if (this.#buffered > 0) {
      await new Promise<void>((resolve) => {
        this.#drainWaiters.add(resolve);
      });
    }
    if (this.#firstError !== undefined) {
      throw this.#firstError;
    }
    return {
      dispatched: this.#dispatched,
      deferred: this.#deferred,
    };
  }

  #markReady(key: string): void {
    if (
      this.#readyDomainSet.has(key) ||
      this.#activeDomains.has(key)
    ) {
      return;
    }
    this.#readyDomainSet.add(key);
    this.#readyDomains.push(key);
  }

  #pump(): void {
    while (
      this.#activeDomains.size < this.options.concurrency &&
      this.#readyDomains.length > 0
    ) {
      const key = this.#readyDomains.shift()!;
      this.#readyDomainSet.delete(key);
      const queued = this.#queues.get(key)?.[0];
      if (queued === undefined) {
        continue;
      }
      this.#activeDomains.add(key);
      void this.#run(key, queued);
    }
  }

  async #run(
    key: string,
    queued: {
      readonly attention: AttentionView;
    },
  ): Promise<void> {
    let result: AttentionDispatchResult | "error" = "error";
    try {
      result = await this.options.dispatch(queued.attention);
      if (result === "dispatched") {
        this.#dispatched += 1;
      }
    } catch (error) {
      this.#firstError ??= error;
    } finally {
      this.#activeDomains.delete(key);
      const queue = this.#queues.get(key);
      if (result === "dispatched" && queue?.[0] === queued) {
        queue.shift();
        if (queue.length === 0) {
          this.#queues.delete(key);
          this.#domainDeferred.delete(key);
        }
        this.#buffered -= 1;
      } else if (queue !== undefined) {
        this.#queues.delete(key);
        this.#buffered -= queue.length;
        const domainDeferred = this.#domainDeferred.get(key) ?? 0;
        if (result === "blocked") {
          this.#deferred -= domainDeferred;
        } else if (result === "retry" && domainDeferred === 0) {
          this.#deferred += 1;
        }
        this.#domainDeferred.delete(key);
      }
      if (this.#queues.has(key)) {
        this.#markReady(key);
      }
      this.#pump();
      this.#notifyRetainedChanged();
    }
  }

  #notifyRetainedChanged(): void {
    if (this.#buffered === 0) {
      for (const resolve of this.#drainWaiters) {
        resolve();
      }
      this.#drainWaiters.clear();
    }
    try {
      this.options.onBufferChanged?.({
        size: this.#buffered,
        limit: this.options.bufferLimit,
      });
    } catch (error) {
      this.#firstError ??= error;
    }
  }
}

function attentionConflictDomain(attention: AttentionView): string {
  return `${attention.targetAgentId}\u0000${attention.threadRootId}`;
}

function requirePayloadString(payload: JsonValue, key: string): string {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error(`Event payload is missing ${key}.`);
  }
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Event payload ${key} must be a non-empty string.`);
  }
  return value;
}

function requireActivation(
  projection: RunProjection,
  activationId: string,
): ActivationAttemptView {
  const activation = projection.activations.find(
    (candidate) => candidate.id === activationId,
  );
  if (!activation) {
    throw new Error(
      `Run projection ${projection.run.id} does not contain Activation ${activationId}.`,
    );
  }
  return activation;
}

function providerStatusForActivation(
  projection: RunProjection,
  activationId: string,
): ProviderAttemptStatus | null {
  return (
    projection.providerAttempts.find(
      (attempt) => attempt.activationId === activationId,
    )?.status ?? null
  );
}

function isTerminalProviderStatus(status: ProviderAttemptStatus): boolean {
  return status === "Completed" || status === "Failed" || status === "Unknown";
}

function isActivationUsable(
  activation: ActivationAttemptView,
  projection: RunProjection,
  now: Date,
): boolean {
  return (
    activation.finishedAt === null &&
    activation.revokedAt === null &&
    new Date(activation.expiresAt) > now &&
    projection.run.state === "Active" &&
    activation.runActivationGeneration === projection.run.activationGeneration
  );
}

function providerCapabilitiesJson(adapter: ProviderAdapter): JsonValue {
  return {
    accepts_input_while_running:
      adapter.capabilities.acceptsInputWhileRunning,
    supports_cancel: adapter.capabilities.supportsCancel,
    supports_resume: adapter.capabilities.supportsResume,
    supports_session_continuation:
      adapter.capabilities.supportsSessionContinuation,
    supports_graceful_pause:
      adapter.capabilities.supportsGracefulPause,
    supports_idempotent_requests:
      adapter.capabilities.supportsIdempotentRequests,
  };
}

function requireProviderStatus(payload: JsonValue): ProviderAttemptStatus {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("ProviderAttempt event payload is invalid.");
  }
  const status = payload.status;
  if (
    status !== "Started" &&
    status !== "Acknowledged" &&
    status !== "Completed" &&
    status !== "Failed" &&
    status !== "Unknown"
  ) {
    throw new Error("ProviderAttempt event payload has an invalid status.");
  }
  return status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeWithAbort<T>(
  execution: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });
  try {
    return await Promise.race([execution, aborted]);
  } finally {
    removeAbortListener();
    void execution.catch(() => {});
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new ProviderExecutionError("Provider execution was aborted.", "Unknown");
}
