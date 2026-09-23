import { randomUUID } from "node:crypto";

import {
  createOpaqueId,
  type OperationalErrorCode,
  type OperationalEventInput,
  type OperationalLogger,
  type OperationalOutcome,
} from "@torsor/operational-logging";
import {
  KernelError,
  type ActivationAttemptView,
  type AttentionView,
  type BootstrapAgent,
  type JsonValue,
  type KernelOperationContext,
  type OperationalCorrelationEntityType,
  type OutboxEventView,
  type ProviderAttemptStatus,
  type RecoverableAttentionExecutionView,
  type RunProjection,
  type TorsorKernel,
} from "@torsor/kernel";

import { KernelActivationCapabilityBridge } from "./capability-bridge.js";
import {
  NativeRunCancellationInterruption,
  isNativeRunCancellationInterruption,
} from "./native-run-cancellation.js";
import type { ControlledWorktreeProcess, WorktreeExecutor } from "./worktree-executor.js";
import { parseProviderPolicy, resolveProviderPolicy, type ProviderPolicy } from "./provider-policy.js";
import {
  normalizeProviderExecutionError,
  providerPublicDiagnostic,
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
  readonly beforeRunActivationStarted?: (input: {
    readonly runId: string;
    readonly outboxEventId: string;
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
  readonly afterAttentionRecoveryPage?: (input: {
    readonly itemCount: number;
    readonly hasMore: boolean;
    readonly nextCursor: {
      readonly startedAt: string;
      readonly activationId: string;
    } | null;
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
  readonly worktreeExecutor?: WorktreeExecutor;
  readonly operationalLogger?: OperationalLogger;
}

export interface RuntimePassResult {
  readonly attentionsDispatched: number;
  readonly outboxEventsProcessed: number;
}

interface RuntimePassExecution extends RuntimePassResult {
  readonly attentionsDeferred: number;
  readonly attentionRecoveries: number;
}

type AttentionDispatchResult = "dispatched" | "blocked" | "retry";
type AttentionAdmissionResult =
  | "admitted"
  | "deferred"
  | "global-full";

interface AttentionProjectDiscoveryContinuation {
  readonly afterCursor: number;
  readonly snapshotEventId: string | null;
}

const ATTENTION_PAGE_SIZE = 100;
const ATTENTION_PROJECT_QUEUE_RESERVE = 1;
const ATTENTION_RECOVERY_SWEEP_LIMIT = 10_000;
const DEFAULT_ACTIVATION_DURATION_MS = 300_000;
const PROVIDER_NOT_STARTED_DETAIL =
  providerPublicDiagnostic("provider_not_started");
const PROVIDER_RECOVERED_FAILED_DETAIL =
  providerPublicDiagnostic("provider_recovered_failed");
const PROVIDER_RECOVERED_UNKNOWN_DETAIL =
  providerPublicDiagnostic("provider_recovered_unknown");

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
  readonly #worktreeExecutor: WorktreeExecutor | undefined;
  readonly #operationalLogger: OperationalLogger | undefined;
  readonly #agents = new Map<string, BootstrapAgent>();
  readonly #attentionProjectDiscoveryContinuations = new Map<
    string,
    AttentionProjectDiscoveryContinuation
  >();
  #attentionProjectOffset = 0;
  readonly #executions = new Set<AbortController>();
  #stopped = false;

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
    this.#worktreeExecutor = options.worktreeExecutor;
    this.#operationalLogger = options.operationalLogger;
    requireIntegerAtLeast(
      this.#attentionLeaseMs,
      1,
      "attentionLeaseMs",
    );
    requireIntegerAtLeast(this.#outboxLeaseMs, 1, "outboxLeaseMs");
    requireIntegerAtLeast(
      this.#providerTimeoutMs,
      1,
      "providerTimeoutMs",
    );
    requireIntegerAtLeast(
      this.#cancellationPollMs,
      1,
      "cancellationPollMs",
    );
    requireIntegerAtLeast(this.#leaseSafetyMs, 0, "leaseSafetyMs");
    if (this.#activationDurationMs !== undefined) {
      requireIntegerAtLeast(
        this.#activationDurationMs,
        1,
        "activationDurationMs",
      );
    }
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
      attentionRecoveries: _attentionRecoveries,
      ...result
    } = await this.#runPass();
    return result;
  }

  stop(): void {
    this.#stopped = true;
    for (const controller of this.#executions) {
      controller.abort(new ProviderExecutionError("provider_cancelled", "Unknown"));
    }
  }

  async #runPass(): Promise<RuntimePassExecution> {
    if (this.#stopped) {
      return { attentionsDispatched: 0, attentionsDeferred: 0, attentionRecoveries: 0, outboxEventsProcessed: 0 };
    }
    await this.#refreshAgents();
    const attentionRecoveries =
      await this.#reconcileOrphanedAttentionExecutions();
    const attentionResult = await this.#dispatchOpenAttentions();
    const outboxEventsProcessed = this.#stopped ? 0 : await this.#drainOutboxBatch();
    return {
      attentionsDispatched: attentionResult.dispatched,
      attentionsDeferred: attentionResult.deferred,
      attentionRecoveries,
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
        result.attentionRecoveries === 0 &&
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
    let dispatched = 0;
    let deferred = 0;
    const bufferLimit = this.#attentionConcurrency * ATTENTION_PAGE_SIZE;
    const projectLimit = Math.max(
      1,
      Math.min(
        this.#attentionConcurrency + ATTENTION_PROJECT_QUEUE_RESERVE,
        Math.floor(bufferLimit / this.#projectIds.size),
      ),
    );
    for (
      let round = 0;
      round < this.#attentionConcurrency * ATTENTION_PAGE_SIZE;
      round += 1
    ) {
      const scheduler = new AttentionScheduler({
        concurrency: this.#attentionConcurrency,
        bufferLimit,
        projectLimit,
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
      const producerError = await this.#enqueueOpenAttentions(
        scheduler,
        this.#attentionConcurrency * ATTENTION_PAGE_SIZE,
      );
      const result = await scheduler.drain();
      if (producerError !== undefined) {
        throw producerError;
      }
      dispatched += result.dispatched;
      deferred = result.deferred;
      if (deferred === 0) {
        return { dispatched, deferred };
      }
    }
    return { dispatched, deferred };
  }

  async #enqueueOpenAttentions(
    scheduler: AttentionScheduler,
    leasedDomainLimit: number,
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
    let states = orderedProjectIds.map((projectId, orderedIndex) => {
      const continuation =
        this.#attentionProjectDiscoveryContinuations.get(projectId);
      return {
        projectId,
        projectIndex: (offset + orderedIndex) % projectIds.length,
        afterCursor: continuation?.afterCursor,
        snapshotEventId: continuation?.snapshotEventId,
      };
    });
    const leasedDomains = new Set<string>();
    let firstError: unknown;
    let globallyDeferredProjectIndex: number | undefined;
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
                limit: ATTENTION_PAGE_SIZE,
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
      for (const { state, page } of pages) {
        this.#attentionProjectDiscoveryContinuations.set(
          state.projectId,
          {
            afterCursor: state.afterCursor ?? 0,
            snapshotEventId: page.snapshotEventId,
          },
        );
      }
      for (let index = 0; index < ATTENTION_PAGE_SIZE; index += 1) {
        for (const { state, page } of pages) {
          const attention = page.items[index];
          if (attention === undefined) {
            continue;
          }
          if (
            attention.handlerLeaseExpiresAt !== null &&
            new Date(attention.handlerLeaseExpiresAt) > this.#clock()
          ) {
            if (leasedDomains.size < leasedDomainLimit) {
              leasedDomains.add(attentionConflictDomain(attention));
            }
            continue;
          }
          const domain = attentionConflictDomain(attention);
          if (leasedDomains.has(domain)) {
            continue;
          }
          if (
            leasedDomains.size >= leasedDomainLimit &&
            (await this.#hasEarlierOpenAttention(attention))
          ) {
            continue;
          }
          const admission = scheduler.enqueue(attention);
          if (admission === "global-full") {
            globallyDeferredProjectIndex = state.projectIndex;
            break;
          }
        }
        if (globallyDeferredProjectIndex !== undefined) {
          break;
        }
      }
      if (globallyDeferredProjectIndex !== undefined) {
        break;
      }
      for (const { state, page } of pages) {
        if (page.hasMore && page.nextCursor !== null) {
          const continuation = {
            afterCursor: page.nextCursor,
            snapshotEventId: page.snapshotEventId,
          };
          this.#attentionProjectDiscoveryContinuations.set(
            state.projectId,
            continuation,
          );
          states.push({
            projectId: state.projectId,
            projectIndex: state.projectIndex,
            ...continuation,
          });
        } else {
          this.#attentionProjectDiscoveryContinuations.delete(
            state.projectId,
          );
        }
      }
    }
    if (globallyDeferredProjectIndex !== undefined) {
      this.#attentionProjectOffset = globallyDeferredProjectIndex;
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
    const correlationId = await this.#operationalCorrelation("Attention", attention.id);
    const operationContext = this.#operationContext(correlationId);
    if (await this.#hasEarlierOpenAttention(attention)) {
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
        operationContext,
      );
    } catch (error) {
      if (error instanceof KernelError && error.code === "DomainBusy") {
        return "blocked";
      }
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
    const leaseExpiresAt = claim.leaseExpiresAt;
    if (
      !handlerLeaseToken ||
      claim.revision === undefined ||
      leaseExpiresAt === undefined
    ) {
      throw new Error(`Attention claim ${attention.id} returned no live lease.`);
    }
    const activation = await this.#kernel.execute(
      {
        type: "StartActivation",
        idempotencyKey: `attention:${attention.id}:activation:${handlerLeaseToken}`,
        attentionId: attention.id,
        handlerLeaseToken,
        durationMs: Math.max(
          this.#activationDurationMs ?? 0,
          DEFAULT_ACTIVATION_DURATION_MS,
          this.#attentionLeaseMs,
        ),
      },
      this.#runtimeContext,
    );
    const thread = await this.#kernel.query(
      {
        type: "GetThreadProjection",
        threadRootId: attention.threadRootId,
      },
      { principalId: agent.principalId, activationId: activation.entityId },
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
    const providerStarted = await this.#executeProvider({
      activationId: activation.entityId,
      agent,
      cause,
      attentionRevision: claim.revision,
      handlerLeaseToken,
      authorityLeaseExpiresAt: leaseExpiresAt,
      runInputIds: [],
      requestIdempotencyKey: `attention:${attention.id}:${handlerLeaseToken}`,
      correlationId,
    });
    return providerStarted ? "dispatched" : "blocked";
  }

  async #hasEarlierOpenAttention(
    attention: AttentionView,
  ): Promise<boolean> {
    const projection = await this.#kernel.query(
      {
        type: "GetThreadProjection",
        threadRootId: attention.threadRootId,
      },
      this.#runtimeContext,
    );
    return projection.attentions.some(
      (candidate) =>
        candidate.targetAgentId === attention.targetAgentId &&
        candidate.status === "Open" &&
        candidate.cursor < attention.cursor,
    );
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
    const leaseToken = claim.leaseToken;
    const leaseExpiresAt = claim.leaseExpiresAt;
    if (!leaseToken || !leaseExpiresAt) {
      throw new Error("Non-empty Outbox claim returned no live lease.");
    }
    if (this.#providerExecutionBudget(leaseExpiresAt) <= 0) {
      return 0;
    }
    for (const event of events) {
      if (
        !(
          await this.#processOutboxEvent(
            event,
            leaseToken,
            leaseExpiresAt,
          )
        )
      ) {
        return 0;
      }
    }
    await this.#hooks.beforeOutboxAcknowledge?.(events);
    if (this.#providerExecutionBudget(leaseExpiresAt) <= 0) {
      return 0;
    }
    await this.#kernel.execute(
      {
        type: "AcknowledgeOutboxEvents",
        idempotencyKey: `outbox-ack:${leaseToken}`,
        outboxEventIds: events.map((event) => event.id),
        leaseToken,
      },
      this.#runtimeContext,
    );
    return events.length;
  }

  async #processOutboxEvent(
    event: OutboxEventView,
    authorityLeaseToken: string,
    authorityLeaseExpiresAt: string,
  ): Promise<boolean> {
    if (event.topic === "message.published") {
      const threadRootId = requirePayloadString(event.payload, "threadRootId");
      const thread = await this.#kernel.query(
        { type: "GetThreadProjection", threadRootId },
        this.#runtimeContext,
      );
      await this.#loadProject(thread.projectId);
      return true;
    }
    if (
      event.topic !== "run.activation-requested" &&
      event.topic !== "run-input.available"
    ) {
      return true;
    }
    const projection = await this.#kernel.query(
      { type: "GetRunProjection", runId: event.aggregateId },
      this.#runtimeContext,
    );
    const triggeringInputId = requirePayloadString(
      event.payload,
      "runInputId",
    );
    const correlationId = await this.#operationalCorrelation("RunInput", triggeringInputId);
    const operationContext = this.#operationContext(correlationId);
    if (
      !projection.inputs.some(
        (input) =>
          input.id === triggeringInputId &&
          input.disposition === "Pending",
      )
    ) {
      await this.#reconcileRunProjection(projection);
      return true;
    }
    const requestIdempotencyKey = `outbox:${event.id}:provider`;
    let currentProjection = projection;
    let activationView: ActivationAttemptView | undefined;
    const priorAttempt = currentProjection.providerAttempts
      .filter(
        (candidate) =>
          candidate.requestIdempotencyKey === requestIdempotencyKey,
      )
      .at(-1);
    const priorAttemptDidNotStart =
      priorAttempt?.status === "Failed" &&
      priorAttempt.detail === PROVIDER_NOT_STARTED_DETAIL;
    let startNewActivation =
      priorAttempt === undefined || priorAttemptDidNotStart;
    if (priorAttempt && !priorAttemptDidNotStart) {
      activationView = requireActivation(
        currentProjection,
        priorAttempt.activationId,
      );
      if (priorAttempt.status === "Completed") {
        await this.#reconcileRunProjection(currentProjection);
        return true;
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
            operationContext,
          );
        }
        await this.#reconcileRunProjection(currentProjection);
        return true;
      }
      await this.#settleUncertainAttempt(
        currentProjection,
        activationView.id,
      );
      currentProjection = await this.#kernel.query(
        { type: "GetRunProjection", runId: currentProjection.run.id },
        this.#runtimeContext,
      );
      if (!this.#adapter.capabilities.supportsIdempotentRequests) {
        if (currentProjection.run.state === "Active") {
          await this.#parkRunAfterDeliveryFailure(
            currentProjection,
            event,
            "Unknown",
            operationContext,
          );
          await this.#reconcileRunProjection(currentProjection);
        } else {
          await this.#reconcileRunProjection(currentProjection);
        }
        return true;
      }
      startNewActivation = true;
    }
    if (startNewActivation) {
      if (
        currentProjection.run.state !== "Active" &&
        !(
          event.topic === "run-input.available" &&
          currentProjection.run.state === "Waiting"
        )
      ) {
        await this.#reconcileRunProjection(currentProjection);
        return true;
      }
      await this.#hooks.beforeRunActivationStarted?.({
        runId: currentProjection.run.id,
        outboxEventId: event.id,
      });
      const activation = await this.#kernel.execute(
        {
          type: "StartActivation",
          idempotencyKey: `outbox:${event.id}:activation:${authorityLeaseToken}:${currentProjection.run.revision}`,
          runId: currentProjection.run.id,
          expectedRunRevision: currentProjection.run.revision,
          outboxEventId: event.id,
          outboxLeaseToken: authorityLeaseToken,
          durationMs: Math.max(
            this.#activationDurationMs ?? 0,
            DEFAULT_ACTIVATION_DURATION_MS,
            this.#outboxLeaseMs,
          ),
        },
        this.#runtimeContext,
        operationContext,
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
    if (!activationView) {
      throw new Error(
        `Outbox delivery ${event.id} has no current Activation.`,
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
      { principalId: agent.principalId, activationId: activationView.id },
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
      await this.#finishRecoveredActivation(
        currentProjection.run.id,
        {
          type: "FinishActivation",
          idempotencyKey: `${activationView.id}:no-pending-input`,
          activationId: activationView.id,
          outcome: "Completed",
          detail: "The outbox wake-up had no Pending RunInput to deliver.",
        },
        operationContext,
      );
      return true;
    }
    return this.#executeProvider({
      activationId: activationView.id,
      agent,
      cause,
      outboxEvent: event,
      outboxLeaseToken: authorityLeaseToken,
      authorityLeaseExpiresAt,
      runInputIds: deliveryInputIds,
      requestIdempotencyKey,
      correlationId,
    });
  }

  async #executeProvider(input: {
    readonly activationId: string;
    readonly agent: BootstrapAgent;
    readonly cause: ProviderCause;
    readonly attentionRevision?: number;
    readonly handlerLeaseToken?: string;
    readonly outboxEvent?: OutboxEventView;
    readonly outboxLeaseToken?: string;
    readonly authorityLeaseExpiresAt: string;
    readonly runInputIds: readonly string[];
    readonly requestIdempotencyKey: string;
    readonly correlationId: string;
  }): Promise<boolean> {
    const executionStartedAt = performance.now();
    const operationContext = this.#operationContext(input.correlationId);
    const policy = input.cause.type === "attention"
      ? resolveProviderPolicy()
      : parseProviderPolicy(this.#adapter.policy ?? resolveProviderPolicy());
    let nativeHandle: ControlledWorktreeProcess | undefined;
    let nativeLaunch: Promise<ControlledWorktreeProcess> | undefined;
    let nativeStartRequested = false;
    const assertPublication = () => {
      if (policy.kind !== "trusted-local") return;
      if (!nativeHandle) throw new ProviderExecutionError("provider_worktree_authority_lost", "Unknown");
      nativeHandle.assertPublication();
    };
    if (this.#stopped || this.#providerExecutionBudget(input.authorityLeaseExpiresAt) <= 0) {
      await this.#finishActivationBeforeProvider(input.activationId, operationContext);
      return false;
    }
    const admissionCommand = {
      type: "StartProviderAttempt",
      idempotencyKey: `${input.activationId}:provider-attempt`,
      activationId: input.activationId,
      ...(input.cause.type === "run"
        ? {
            outboxEventId: input.outboxEvent!.id,
            outboxLeaseToken: input.outboxLeaseToken!,
          }
        : {}),
      adapter: this.#adapter.name,
      adapterVersion: this.#adapter.version,
      capabilitySnapshot: providerCapabilitiesJson(this.#adapter, policy),
      runInputIds: input.runInputIds,
      requestIdempotencyKey: input.requestIdempotencyKey,
    } as const;
    const attempt = await this.#kernel.execute(
      admissionCommand,
      this.#runtimeContext,
      operationContext,
    );
    await this.#logOperational({
      event: "runtime.activation",
      outcome: "started",
      correlationId: input.correlationId,
      ...(input.cause.type === "run" ? { runId: input.cause.run.run.id } : {}),
      activationId: input.activationId,
      providerAttemptId: attempt.entityId,
    });
    await this.#logOperational({
      event: "runtime.provider_attempt",
      outcome: "started",
      correlationId: input.correlationId,
      ...(input.cause.type === "run" ? { runId: input.cause.run.run.id } : {}),
      activationId: input.activationId,
      providerAttemptId: attempt.entityId,
    });
    await this.#hooks.afterProviderAttemptStarted?.({
      activationId: input.activationId,
      providerAttemptId: attempt.entityId,
      causeType: input.cause.type,
    });
    const existingStatus = await this.#findProviderAttemptStatus(
      attempt.entityId,
    );
    if (existingStatus && isTerminalProviderStatus(existingStatus)) {
      if (input.cause.type === "attention") {
        return false;
      }
      const latest = await this.#kernel.query(
        {
          type: "GetRunProjection",
          runId: input.cause.run.run.id,
        },
        this.#runtimeContext,
      );
      if (existingStatus === "Completed") {
        await this.#reconcileRunProjection(latest);
        return true;
      }
      const terminalAttempt = latest.providerAttempts.find(
        (candidate) => candidate.id === attempt.entityId,
      );
      if (!terminalAttempt) {
        throw new Error(
          `Run ${latest.run.id} does not contain ProviderAttempt ${attempt.entityId}.`,
        );
      }
      const activation = requireActivation(
        latest,
        terminalAttempt.activationId,
      );
      if (
        latest.run.state === "Active" &&
        activation.runActivationGeneration ===
          latest.run.activationGeneration
      ) {
        if (!input.outboxEvent) {
          throw new Error(
            `Run ProviderAttempt ${attempt.entityId} has no OutboxEvent authority.`,
          );
        }
        await this.#parkRunAfterDeliveryFailure(
          latest,
          input.outboxEvent,
          existingStatus,
          operationContext,
        );
        await this.#reconcileRunProjection(latest);
      } else {
        await this.#reconcileRunProjection(latest);
      }
      return true;
    }
    const bridge =
      input.cause.type === "attention"
        ? new KernelActivationCapabilityBridge({
            kernel: this.#kernel,
            agent: input.agent,
            activationId: input.activationId,
            providerAttemptId: attempt.entityId,
            correlationId: input.correlationId,
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
            correlationId: input.correlationId,
            causeType: "run",
            projection: input.cause.run,
            assertPublication,
          });
    const admission = await this.#kernel.execute(
      admissionCommand,
      this.#runtimeContext,
      operationContext,
    );
    if (admission.entityId !== attempt.entityId) {
      throw new Error(
        `ProviderAttempt admission changed from ${attempt.entityId} to ${admission.entityId}.`,
      );
    }
    const admittedLeaseExpiresAt = admission.leaseExpiresAt;
    const authorityObservedAt = admission.authorityObservedAt;
    if (!admittedLeaseExpiresAt || !authorityObservedAt) {
      throw new Error(
        `ProviderAttempt ${attempt.entityId} returned no authoritative admission window.`,
      );
    }
    const executionBudgetMs = this.#providerExecutionBudget(
      admittedLeaseExpiresAt,
      authorityObservedAt,
    );
    if (executionBudgetMs <= 0) {
      await this.#settleProviderAttempt({
        providerAttemptId: attempt.entityId,
        idempotencyKey: `${attempt.entityId}:lease-budget-exhausted`,
        status: "Failed",
        detail: PROVIDER_NOT_STARTED_DETAIL,
      }, operationContext);
      await this.#logOperational({
        event: "runtime.provider_attempt",
        outcome: "failed",
        correlationId: input.correlationId,
        ...(input.cause.type === "run" ? { runId: input.cause.run.run.id } : {}),
        activationId: input.activationId,
        providerAttemptId: attempt.entityId,
        errorCode: "provider_not_started",
        durationMs: performance.now() - executionStartedAt,
      });
      await this.#finishActivationBeforeProvider(input.activationId, operationContext);
      return false;
    }
    const controller = new AbortController();
    this.#executions.add(controller);
    if (this.#stopped) controller.abort(new ProviderExecutionError("provider_cancelled", "Unknown"));
    let worktreeScopeOpen = true;
    let worktreeStop: Promise<void> | undefined;
    const nativeRunCancellation = policy.kind === "trusted-local" && input.cause.type === "run"
      ? new NativeRunCancellationInterruption(
          input.cause.run.run.id,
          input.activationId,
          input.cause.run.run.activationGeneration,
        )
      : undefined;
    const stopMonitor = this.#monitorExecution(
      input.cause,
      input.activationId,
      executionBudgetMs,
      controller,
      () => bridge.terminalAction !== null,
      nativeRunCancellation,
    );
    try {
      await executeWithAbort(
        this.#adapter.execute({
          activationId: input.activationId,
          providerAttemptId: attempt.entityId,
          requestIdempotencyKey: input.requestIdempotencyKey,
          agent: input.agent,
          cause: input.cause,
          capabilities: bridge,
          signal: controller.signal,
          ...(policy.kind === "trusted-local" && input.cause.type === "run" ? {
            nativeExecution: {
              policy,
              start: async (start: (cwd: string) => import("./controlled-process.js").ControlledChild) => {
                if (!worktreeScopeOpen || nativeStartRequested || controller.signal.aborted ||
                    !this.#worktreeExecutor?.startProvider || input.cause.type !== "run") {
                  throw new ProviderExecutionError("provider_worktree_authority_lost", "Unknown");
                }
                nativeStartRequested = true;
                nativeLaunch = this.#worktreeExecutor.startProvider({
                  runId: input.cause.run.run.id, activationId: input.activationId,
                  providerAttemptId: attempt.entityId, correlationId: input.correlationId,
                  policy, start,
                  ...(nativeRunCancellation
                    ? { cancellationInterruption: nativeRunCancellation }
                    : {}),
                  signal: controller.signal,
                });
                nativeHandle = await nativeLaunch;
                return nativeHandle;
              },
            },
          } : {}),
          ...(input.cause.type === "run" && this.#worktreeExecutor ? {
            worktree: {
              probe: (worktreeId: string) => {
                if (!worktreeScopeOpen || controller.signal.aborted) {
                  return Promise.reject(new Error("Worktree execution scope is closed."));
                }
                return this.#worktreeExecutor!.probe({
                  worktreeId, activationId: input.activationId, signal: controller.signal,
                });
              },
            },
          } : {}),
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
      }, operationContext);
      await this.#logOperational({
        event: "runtime.provider_attempt",
        outcome: "succeeded",
        correlationId: input.correlationId,
        ...(input.cause.type === "run" ? { runId: input.cause.run.run.id } : {}),
        activationId: input.activationId,
        providerAttemptId: attempt.entityId,
        durationMs: performance.now() - executionStartedAt,
      });
      if (input.cause.type === "run") {
        await this.#kernel.execute(
          {
            type: "FinishActivation",
            idempotencyKey: `${input.activationId}:completed`,
            activationId: input.activationId,
            outcome: "Completed",
          },
          this.#runtimeContext,
          operationContext,
        );
        await this.#logOperational({
          event: "runtime.activation",
          outcome: "succeeded",
          correlationId: input.correlationId,
          runId: input.cause.run.run.id,
          activationId: input.activationId,
          providerAttemptId: attempt.entityId,
          durationMs: performance.now() - executionStartedAt,
        });
        if (bridge.terminalAction === "complete" || bridge.terminalAction === "fail") {
          await this.#logOperational({
            event: "runtime.run_terminal",
            outcome: bridge.terminalAction === "complete" ? "succeeded" : "failed",
            correlationId: input.correlationId,
            runId: input.cause.run.run.id,
            activationId: input.activationId,
            providerAttemptId: attempt.entityId,
            ...(bridge.terminalAction === "fail" ? { errorCode: "run_failed" } : {}),
            durationMs: performance.now() - executionStartedAt,
          });
        }
      }
      return true;
    } catch (error) {
      worktreeScopeOpen = false;
      if (policy.kind === "trusted-local") {
        controller.abort(error);
        // The executor owns children even before launch returns or Running is
        // persisted. Start every physical stop before awaiting launch or SQLite.
        worktreeStop = this.#worktreeExecutor?.stopActivation(input.activationId);
        // Observe rejection now, and propagate this same stop promise in finally.
        void worktreeStop?.catch(() => undefined);
      }
      let providerError = normalizeWorktreeProviderError(error);
      if (nativeLaunch) {
        try {
          // The abort race may finish before native admission returns. Observe
          // that launch before settlement; late failures must not become success.
          nativeHandle ??= await nativeLaunch;
        } catch (launchError) {
          const launchFailure = normalizeWorktreeProviderError(launchError);
          if (!isNativeRunCancellation(launchFailure, nativeRunCancellation)) {
            providerError = launchFailure;
          }
        }
        const authorityClassificationError =
          await nativeHandle?.authorityClassificationError();
        if (authorityClassificationError !== undefined) {
          providerError = normalizeWorktreeProviderError(
            authorityClassificationError,
          );
        }
      }
      let cancelledNativeRun = false;
      if (input.cause.type === "run" && bridge.terminalAction === null) {
        const latest = await this.#kernel.query(
          { type: "GetRunProjection", runId: input.cause.run.run.id },
          this.#runtimeContext,
        );
        const activation = latest.activations.find(
          (candidate) => candidate.id === input.activationId,
        );
        const authoritativeCancellation = policy.kind === "trusted-local" && !this.#stopped &&
          latest.run.state === "Cancelled" && activation?.revocationReason === "run_cancelled" &&
          activation.runActivationGeneration === latest.run.activationGeneration &&
          activation.runActivationGeneration === input.cause.run.run.activationGeneration &&
          isNativeRunCancellation(providerError, nativeRunCancellation);
        if (authoritativeCancellation && nativeRunCancellation) {
          const identity = nativeRunCancellation.executionIdentity();
          if (!identity) {
            cancelledNativeRun = true;
          } else {
            try {
              await worktreeStop;
              const [tree, lease] = await Promise.all([
                this.#kernel.query(
                  { type: "GetPhysicalWorktree", worktreeId: identity.worktreeId },
                  this.#runtimeContext,
                ),
                this.#kernel.query(
                  { type: "GetWorktreeWriterLease", worktreeId: identity.worktreeId },
                  this.#runtimeContext,
                ),
              ]);
              cancelledNativeRun =
                nativeRunCancellation.ownsPhysicalStop(identity) &&
                tree.latestExecution?.id === identity.executionId &&
                tree.latestExecution.generation === identity.leaseGeneration &&
                tree.latestExecution.fencingToken === identity.fencingToken &&
                lease.status !== "Quarantined" &&
                lease.generation === identity.leaseGeneration &&
                lease.fencingToken === identity.fencingToken;
              if (!cancelledNativeRun) {
                providerError = nativeRunCancellation.providerExitPrecededStop(identity)
                  ? new ProviderExecutionError("provider_process_exited", "Unknown")
                  : new ProviderExecutionError("provider_worktree_authority_lost", "Unknown");
              }
            } catch (stopError) {
              providerError = normalizeWorktreeProviderError(stopError);
            }
          }
        }
        if (
          latest.run.state === "Active" &&
          activation?.finishedAt === null &&
          activation.revokedAt === null &&
          activation.runActivationGeneration === latest.run.activationGeneration
        ) {
          try {
            await bridge.wait(providerError.message);
          } catch (waitError) {
            if (
              !(
                waitError instanceof KernelError &&
                (waitError.code === "StaleRevision" ||
                  waitError.code === "Conflict" ||
                  waitError.code === "WriterAuthorityLost" ||
                  waitError.code === "TerminalRun")
                || waitError instanceof ProviderExecutionError &&
                  waitError.diagnosticCode === "provider_worktree_authority_lost"
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
        }, operationContext);
      } else {
        await this.#settleProviderAttempt({
          providerAttemptId: attempt.entityId,
          idempotencyKey: `${attempt.entityId}:failed`,
          status: "Failed",
          detail: providerError.message,
        }, operationContext);
      }
      await this.#logOperational({
        event: "runtime.provider_attempt",
        outcome: providerError.outcome === "Unknown" ? "unknown" : "failed",
        correlationId: input.correlationId,
        ...(input.cause.type === "run" ? { runId: input.cause.run.run.id } : {}),
        activationId: input.activationId,
        providerAttemptId: attempt.entityId,
        errorCode: providerError.diagnosticCode,
        durationMs: performance.now() - executionStartedAt,
      });
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
          operationContext,
        );
      }
      // A committed Human cancellation is handled work, not a successful
      // Provider attempt and not a reason to tear down the observation Host.
      if (cancelledNativeRun) {
        await this.#logOperational({
          event: "runtime.run_terminal",
          outcome: "cancelled",
          correlationId: input.correlationId,
          ...(input.cause.type === "run" ? { runId: input.cause.run.run.id } : {}),
          activationId: input.activationId,
          providerAttemptId: attempt.entityId,
          errorCode: "run_cancelled",
          durationMs: performance.now() - executionStartedAt,
        });
        return true;
      }
      await this.#logOperational({
        event: "runtime.activation",
        outcome: providerError.outcome === "Unknown" ? "unknown" : "failed",
        correlationId: input.correlationId,
        ...(input.cause.type === "run" ? { runId: input.cause.run.run.id } : {}),
        activationId: input.activationId,
        providerAttemptId: attempt.entityId,
        errorCode: providerError.diagnosticCode,
        durationMs: performance.now() - executionStartedAt,
      });
      throw providerError;
    } finally {
      worktreeScopeOpen = false;
      stopMonitor();
      this.#executions.delete(controller);
      await (worktreeStop ?? this.#worktreeExecutor?.stopActivation(input.activationId));
    }
  }

  #monitorExecution(
    cause: ProviderCause,
    activationId: string,
    executionBudgetMs: number,
    controller: AbortController,
    hasProviderTerminalAction: () => boolean,
    nativeRunCancellation?: NativeRunCancellationInterruption,
  ): () => void {
    const timeout = setTimeout(() => {
      controller.abort(
        new ProviderExecutionError(
          "provider_timeout",
          "Unknown",
        ),
      );
    }, executionBudgetMs);
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
          nativeRunCancellation &&
          projection.run.id === nativeRunCancellation.runId &&
          projection.run.state === "Cancelled" &&
          activation?.revocationReason === "run_cancelled" &&
          activation.runActivationGeneration === projection.run.activationGeneration &&
          activation.runActivationGeneration === nativeRunCancellation.runActivationGeneration
        ) {
          controller.abort(nativeRunCancellation);
          return;
        }
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
              "provider_cancelled",
              "Unknown",
            ),
          );
          return;
        }
        if (projection.run.state !== "Active") {
          controller.abort(
            new ProviderExecutionError(
              "provider_cancelled",
              "Unknown",
            ),
          );
          return;
        }
      } catch (error) {
        controller.abort(
          new ProviderExecutionError(
            "provider_runtime_monitor_failed",
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

  #providerExecutionBudget(
    leaseExpiresAt: string,
    authorityObservedAt?: string,
  ): number {
    const leaseExpiryMs = Date.parse(leaseExpiresAt);
    if (!Number.isFinite(leaseExpiryMs)) {
      throw new Error(`Invalid authoritative lease expiry ${leaseExpiresAt}.`);
    }
    const nowMs = this.#clock().getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("Runtime clock returned a non-finite time.");
    }
    const localBudgetMs =
      leaseExpiryMs - this.#leaseSafetyMs - nowMs;
    const authoritativeBudgetMs =
      authorityObservedAt === undefined
        ? Number.POSITIVE_INFINITY
        : (() => {
            const observedAtMs = Date.parse(authorityObservedAt);
            if (!Number.isFinite(observedAtMs)) {
              throw new Error(
                `Invalid authority observation time ${authorityObservedAt}.`,
              );
            }
            return (
              leaseExpiryMs -
              this.#leaseSafetyMs -
              observedAtMs
            );
          })();
    const budget = Math.min(
      this.#providerTimeoutMs,
      localBudgetMs,
      authoritativeBudgetMs,
    );
    if (!Number.isFinite(budget)) {
      throw new Error("Provider execution budget is non-finite.");
    }
    return budget;
  }

  async #finishActivationBeforeProvider(
    activationId: string,
    operationContext: KernelOperationContext,
  ): Promise<void> {
    await this.#kernel.execute(
      {
        type: "FinishActivation",
        idempotencyKey: `${activationId}:lease-budget-exhausted`,
        activationId,
        outcome: "Expired",
        detail: PROVIDER_NOT_STARTED_DETAIL,
      },
      this.#runtimeContext,
      operationContext,
    );
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
  }, operationContext?: KernelOperationContext): Promise<ProviderAttemptStatus> {
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
          operationContext,
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
          operationContext,
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
  ): Promise<void> {
    const attempt = projection.providerAttempts.find(
      (candidate) => candidate.activationId === activationId,
    );
    if (!attempt || isTerminalProviderStatus(attempt.status)) {
      return;
    }
    const correlationId = await this.#operationalCorrelation("ProviderAttempt", attempt.id);
    const operationContext = this.#operationContext(correlationId);
    await this.#logOperational({
      event: "recovery.pass",
      outcome: "started",
      correlationId,
      runId: projection.run.id,
      activationId,
      providerAttemptId: attempt.id,
    });
    await this.#kernel.execute(
      {
        type: "FinishProviderAttempt",
        idempotencyKey: `${attempt.id}:recovered-unknown`,
        providerAttemptId: attempt.id,
        status: "Unknown",
        detail: PROVIDER_RECOVERED_UNKNOWN_DETAIL,
      },
      this.#runtimeContext,
      operationContext,
    );
    const activation = requireActivation(projection, activationId);
    if (activation.finishedAt === null) {
      await this.#kernel.execute(
        {
          type: "FinishActivation",
          idempotencyKey: `${activationId}:recovered-expired`,
          activationId,
          outcome: "Expired",
          detail: PROVIDER_RECOVERED_UNKNOWN_DETAIL,
        },
        this.#runtimeContext,
        operationContext,
      );
    }
    await this.#logOperational({
      event: "recovery.pass",
      outcome: "succeeded",
      correlationId,
      runId: projection.run.id,
      activationId,
      providerAttemptId: attempt.id,
    });
  }

  async #parkRunAfterDeliveryFailure(
    projection: RunProjection,
    event: OutboxEventView,
    status: "Failed" | "Unknown",
    operationContext: KernelOperationContext,
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
      operationContext,
    );
    await this.#hooks.afterFailureParking?.(hookInput);
  }

  async #reconcileRunProjection(projection: RunProjection): Promise<void> {
    const correlationId = await this.#operationalCorrelation("Run", projection.run.id);
    const operationContext = this.#operationContext(correlationId);
    for (const activation of projection.activations) {
      if (activation.finishedAt !== null) {
        continue;
      }
      await this.#logOperational({
        event: "recovery.pass",
        outcome: "started",
        correlationId,
        runId: projection.run.id,
        activationId: activation.id,
      });
      const attempt = projection.providerAttempts.find(
        (candidate) => candidate.activationId === activation.id,
      );
      let outcome: "Completed" | "Failed" | "Expired" = "Expired";
      let detail = PROVIDER_RECOVERED_UNKNOWN_DETAIL;
      if (attempt?.status === "Completed") {
        outcome = "Completed";
        detail = "Recovered a completed ProviderAttempt.";
      } else if (attempt?.status === "Failed") {
        outcome = "Failed";
        detail = PROVIDER_RECOVERED_FAILED_DETAIL;
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
            detail: PROVIDER_RECOVERED_UNKNOWN_DETAIL,
          },
          this.#runtimeContext,
          operationContext,
        );
        detail = PROVIDER_RECOVERED_UNKNOWN_DETAIL;
      }
      await this.#finishRecoveredActivation(
        projection.run.id,
        {
          type: "FinishActivation",
          idempotencyKey: `${activation.id}:reconciled-${outcome.toLowerCase()}`,
          activationId: activation.id,
          outcome,
          detail,
        },
        operationContext,
      );
      await this.#logOperational({
        event: "recovery.pass",
        outcome: "succeeded",
        correlationId,
        runId: projection.run.id,
        activationId: activation.id,
        ...(attempt ? { providerAttemptId: attempt.id } : {}),
      });
    }
  }

  async #finishRecoveredActivation(runId: string, command: {
    readonly type: "FinishActivation";
    readonly idempotencyKey: string;
    readonly activationId: string;
    readonly outcome: "Completed" | "Failed" | "Expired";
    readonly detail: string;
  }, operationContext?: KernelOperationContext): Promise<void> {
    try {
      await this.#kernel.execute(command, this.#runtimeContext, operationContext);
    } catch (error) {
      if (!(error instanceof KernelError && error.code === "WriterAuthorityLost") ||
          command.outcome !== "Completed") throw error;
      // A committed result survives its Writer; recovery must not republish success.
      try {
        await this.#kernel.execute({
          type: "FinishActivation",
          idempotencyKey: `${command.activationId}:reconciled-authority-lost`,
          activationId: command.activationId,
          outcome: "Expired",
          detail: providerPublicDiagnostic(
            "provider_recovered_worktree_authority_lost",
          ),
        }, this.#runtimeContext, operationContext);
      } catch (settlementError) {
        if (!(settlementError instanceof KernelError && settlementError.code === "Conflict" &&
            settlementError.message === "The Activation is already finished.")) throw settlementError;
        const current = await this.#kernel.query({ type: "GetRunProjection", runId }, this.#runtimeContext);
        const activation = current.activations.find((candidate) => candidate.id === command.activationId);
        if (!activation || activation.finishedAt === null) throw settlementError;
        // Another Host won settlement. Preserve its outcome; only delivery acknowledgement remains.
      }
    }
  }

  async #reconcileOrphanedAttentionExecutions(): Promise<number> {
    let recoveries = 0;
    for (
      let sweep = 0;
      sweep < ATTENTION_RECOVERY_SWEEP_LIMIT;
      sweep += 1
    ) {
      const before = await this.#kernel.query(
        { type: "GetAttentionRecoverySnapshot" },
        this.#runtimeContext,
      );
      let afterCursor:
        | {
            readonly startedAt: string;
            readonly activationId: string;
          }
        | undefined;
      try {
        for (;;) {
          const page = await this.#kernel.query(
            {
              type: "ListRecoverableAttentionExecutions",
              ...(afterCursor ? { afterCursor } : {}),
              recoveryRevision: before.revision,
              limit: 100,
            },
            this.#runtimeContext,
          );
          for (const execution of page.items) {
            recoveries +=
              await this.#reconcileAttentionExecution(
                execution,
                before.revision,
              );
          }
          await this.#hooks.afterAttentionRecoveryPage?.({
            itemCount: page.items.length,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
          });
          if (!page.hasMore || !page.nextCursor) {
            break;
          }
          afterCursor = page.nextCursor;
        }
      } catch (error) {
        if (error instanceof KernelError && error.code === "StaleRevision") {
          continue;
        }
        throw error;
      }
      const after = await this.#kernel.query(
        { type: "GetAttentionRecoverySnapshot" },
        this.#runtimeContext,
      );
      if (after.revision === before.revision) {
        return recoveries;
      }
    }
    throw new Error(
      `Attention recovery did not reach a stable revision after ${ATTENTION_RECOVERY_SWEEP_LIMIT} sweeps.`,
    );
  }

  async #reconcileAttentionExecution(
    execution: RecoverableAttentionExecutionView,
    recoveryRevision: number,
  ): Promise<number> {
    const correlationId = await this.#operationalCorrelation(
      "Attention",
      execution.attention.id,
    );
    const operationContext = this.#operationContext(correlationId);
    await this.#logOperational({
      event: "recovery.pass",
      outcome: "started",
      correlationId,
      activationId: execution.activation.id,
    });
    let recoveries = 0;
    let outcome: "Completed" | "Failed" | "Expired" = "Expired";
    let detail = PROVIDER_RECOVERED_UNKNOWN_DETAIL;
    const latestAttempt = execution.providerAttempts.at(-1);
    let latestStatus = latestAttempt?.status;
    const unsettledAttempts = execution.providerAttempts.filter(
      (attempt) =>
        attempt.status === "Started" ||
        attempt.status === "Acknowledged",
    );
    if (
      latestAttempt &&
      (latestAttempt.status === "Started" ||
        latestAttempt.status === "Acknowledged")
    ) {
      latestStatus = "Unknown";
    }
    if (latestStatus === "Completed") {
      outcome = "Completed";
      detail = "Recovered a completed Attention ProviderAttempt.";
    } else if (latestStatus === "Failed") {
      outcome = "Failed";
      detail = PROVIDER_RECOVERED_FAILED_DETAIL;
    }
    if (execution.activation.finishedAt === null) {
      if (unsettledAttempts.length === 0) {
        const current = await this.#kernel.query(
          { type: "GetAttentionRecoverySnapshot" },
          this.#runtimeContext,
        );
        if (current.revision !== recoveryRevision) {
          throw new KernelError(
            "StaleRevision",
            "Attention recovery authority changed before Activation settlement.",
          );
        }
      }
      try {
        await this.#kernel.execute(
          {
            type: "FinishActivation",
            idempotencyKey: `${execution.activation.id}:attention-reconciled-${outcome.toLowerCase()}`,
            activationId: execution.activation.id,
            outcome,
            detail,
          },
          this.#runtimeContext,
          operationContext,
        );
      } catch (error) {
        if (!(error instanceof KernelError && error.code === "Conflict")) {
          throw error;
        }
      }
      recoveries += 1;
    }
    for (const attempt of unsettledAttempts) {
      await this.#hooks.beforeAttentionRecoverySettlement?.({
        activationId: execution.activation.id,
        providerAttemptId: attempt.id,
      });
      const settledStatus = await this.#settleProviderAttempt({
        providerAttemptId: attempt.id,
        idempotencyKey: `${attempt.id}:attention-reconciled-unknown`,
        status: "Unknown",
        detail: PROVIDER_RECOVERED_UNKNOWN_DETAIL,
      }, operationContext);
      recoveries += 1;
      if (attempt.id === latestAttempt?.id) {
        latestStatus = settledStatus;
      }
    }
    await this.#logOperational({
      event: "recovery.pass",
      outcome: "succeeded",
      correlationId,
      activationId: execution.activation.id,
      ...(latestAttempt ? { providerAttemptId: latestAttempt.id } : {}),
    });
    return recoveries;
  }

  async #operationalCorrelation(
    entityType: OperationalCorrelationEntityType,
    entityId: string,
  ): Promise<string> {
    return (await this.#kernel.query(
      { type: "GetOperationalCorrelation", entityType, entityId },
      this.#runtimeContext,
    )).correlationId;
  }

  #operationContext(correlationId: string): KernelOperationContext {
    return { correlationId };
  }

  async #logOperational(input: {
    readonly event: OperationalEventInput["event"];
    readonly outcome: OperationalOutcome;
    readonly correlationId?: string;
    readonly runId?: string;
    readonly activationId?: string;
    readonly providerAttemptId?: string;
    readonly errorCode?: OperationalErrorCode;
    readonly durationMs?: number;
  }): Promise<void> {
    if (!this.#operationalLogger) return;
    await this.#operationalLogger.emit({
      event: input.event,
      outcome: input.outcome,
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: boundedOperationalDuration(input.durationMs) }),
      ...(input.correlationId === undefined
        ? {}
        : { correlationId: createOpaqueId(input.correlationId) }),
      ...(input.runId === undefined ? {} : { runId: createOpaqueId(input.runId) }),
      ...(input.activationId === undefined
        ? {}
        : { activationId: createOpaqueId(input.activationId) }),
      ...(input.providerAttemptId === undefined
        ? {}
        : { providerAttemptId: createOpaqueId(input.providerAttemptId) }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    });
  }
}

interface AttentionSchedulerOptions {
  readonly concurrency: number;
  readonly bufferLimit: number;
  readonly projectLimit: number;
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
    {
      readonly attention: AttentionView;
      readonly projectId: string;
    }
  >();
  readonly #activeDomains = new Set<string>();
  readonly #domainDeferred = new Map<string, number>();
  readonly #projectRetained = new Map<string, number>();
  readonly #projectReadyDomains = new Map<string, string[]>();
  readonly #projectReadyDomainSets = new Map<string, Set<string>>();
  readonly #readyProjects: string[] = [];
  readonly #readyProjectSet = new Set<string>();
  readonly #drainWaiters = new Set<() => void>();
  #buffered = 0;
  #dispatched = 0;
  #deferred = 0;
  #firstError: unknown;

  constructor(private readonly options: AttentionSchedulerOptions) {}

  enqueue(attention: AttentionView): AttentionAdmissionResult {
    const key = attentionConflictDomain(attention);
    if (this.#queues.has(key) || this.#activeDomains.has(key)) {
      this.#deferred += 1;
      this.#domainDeferred.set(
        key,
        (this.#domainDeferred.get(key) ?? 0) + 1,
      );
      return "deferred";
    }
    const projectId = attention.projectId;
    if (
      (this.#projectRetained.get(projectId) ?? 0) >=
      this.options.projectLimit
    ) {
      if (!this.#evictQueuedCandidate(projectId)) {
        this.#deferred += 1;
        return "deferred";
      }
    } else if (this.#buffered >= this.options.bufferLimit) {
      const projectRetained =
        this.#projectRetained.get(projectId) ?? 0;
      const madeRoom =
        projectRetained === 0
          ? this.#evictForNewProject(projectId)
          : this.#evictQueuedCandidate(projectId);
      if (!madeRoom) {
        this.#deferred += 1;
        return "global-full";
      }
    }
    this.#queues.set(key, { attention, projectId });
    this.#buffered += 1;
    this.#changeProjectRetained(projectId, 1);
    this.#markReady(projectId, key);
    this.#pump();
    this.#notifyRetainedChanged();
    return "admitted";
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

  #markReady(projectId: string, key: string): void {
    if (this.#activeDomains.has(key)) {
      return;
    }
    let readySet = this.#projectReadyDomainSets.get(projectId);
    if (!readySet) {
      readySet = new Set<string>();
      this.#projectReadyDomainSets.set(projectId, readySet);
    }
    if (!readySet.has(key)) {
      readySet.add(key);
      let readyDomains = this.#projectReadyDomains.get(projectId);
      if (!readyDomains) {
        readyDomains = [];
        this.#projectReadyDomains.set(projectId, readyDomains);
      }
      readyDomains.push(key);
    }
    this.#markProjectReady(projectId);
  }

  #markProjectReady(projectId: string): void {
    if (
      this.#readyProjectSet.has(projectId) ||
      (this.#projectReadyDomainSets.get(projectId)?.size ?? 0) === 0
    ) {
      return;
    }
    this.#readyProjectSet.add(projectId);
    this.#readyProjects.push(projectId);
  }

  #pump(): void {
    while (
      this.#activeDomains.size < this.options.concurrency &&
      this.#readyProjects.length > 0
    ) {
      const projectId = this.#readyProjects.shift()!;
      if (!this.#readyProjectSet.delete(projectId)) {
        continue;
      }
      const key = this.#takeReadyDomain(projectId);
      this.#markProjectReady(projectId);
      if (key === undefined) {
        continue;
      }
      const queued = this.#queues.get(key);
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
      readonly projectId: string;
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
      if (queue === queued) {
        this.#queues.delete(key);
        this.#buffered -= 1;
        this.#changeProjectRetained(queued.projectId, -1);
        const domainDeferred = this.#domainDeferred.get(key) ?? 0;
        if (result === "blocked") {
          this.#deferred -= domainDeferred;
        } else if (result === "retry" && domainDeferred === 0) {
          this.#deferred += 1;
        }
        this.#domainDeferred.delete(key);
      }
      this.#pump();
      this.#notifyRetainedChanged();
    }
  }

  #takeReadyDomain(projectId: string): string | undefined {
    const readyDomains = this.#projectReadyDomains.get(projectId);
    const readySet = this.#projectReadyDomainSets.get(projectId);
    while (readyDomains && readyDomains.length > 0) {
      const key = readyDomains.shift()!;
      if (!readySet?.delete(key)) {
        continue;
      }
      return key;
    }
    if (readySet?.size === 0) {
      this.#projectReadyDomainSets.delete(projectId);
      this.#projectReadyDomains.delete(projectId);
    }
    return undefined;
  }

  #evictQueuedCandidate(projectId: string): boolean {
    const key = this.#takeReadyDomain(projectId);
    if (key === undefined) {
      return false;
    }
    const queued = this.#queues.get(key);
    if (!queued || this.#activeDomains.has(key)) {
      return false;
    }
    this.#queues.delete(key);
    this.#buffered -= 1;
    this.#changeProjectRetained(projectId, -1);
    this.#deferred += 1;
    this.#domainDeferred.delete(key);
    return true;
  }

  #evictForNewProject(projectId: string): boolean {
    const candidates = [...this.#projectRetained.entries()]
      .filter(
        ([candidateProjectId, retained]) =>
          candidateProjectId !== projectId && retained > 1,
      )
      .sort((left, right) => right[1] - left[1]);
    for (const [candidateProjectId] of candidates) {
      if (this.#evictQueuedCandidate(candidateProjectId)) {
        return true;
      }
    }
    return this.#evictQueuedCandidate(projectId);
  }

  #changeProjectRetained(projectId: string, delta: number): void {
    const next = (this.#projectRetained.get(projectId) ?? 0) + delta;
    if (next === 0) {
      this.#projectRetained.delete(projectId);
    } else {
      this.#projectRetained.set(projectId, next);
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

function isTerminalProviderStatus(
  status: ProviderAttemptStatus,
): status is Extract<
  ProviderAttemptStatus,
  "Completed" | "Failed" | "Unknown"
> {
  return status === "Completed" || status === "Failed" || status === "Unknown";
}

function providerCapabilitiesJson(adapter: ProviderAdapter, policy: ProviderPolicy): JsonValue {
  return {
    ...(adapter.policy ? { policy } : {}),
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

function requireIntegerAtLeast(
  value: number,
  minimum: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
}

function normalizeWorktreeProviderError(error: unknown): ProviderExecutionError {
  if (isNativeRunCancellationInterruption(error)) {
    return error;
  }
  return error instanceof KernelError && error.code === "WriterAuthorityLost"
    ? new ProviderExecutionError("provider_worktree_authority_lost", "Unknown")
    : normalizeProviderExecutionError(error);
}

function boundedOperationalDuration(value: number): number {
  return Math.min(86_400_000, Math.max(0, Math.round(value)));
}

function isNativeRunCancellation(
  error: ProviderExecutionError,
  expected: NativeRunCancellationInterruption | undefined,
): boolean {
  return expected !== undefined && error === expected;
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
  if (signal.reason === undefined) {
    return new ProviderExecutionError("provider_cancelled", "Unknown");
  }
  if (isNativeRunCancellationInterruption(signal.reason)) {
    return signal.reason;
  }
  return normalizeProviderExecutionError(signal.reason, "Unknown");
}
