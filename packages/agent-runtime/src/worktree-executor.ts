import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  KernelError, type PhysicalWorktreeView, type TorsorKernel,
  type KernelOperationContext, type WorktreeExecutionState, type WorktreeMutationAuthority,
} from "@torsor/kernel";
import {
  createOpaqueId,
  type OperationalEventInput,
  type OperationalLogger,
} from "@torsor/operational-logging";

import { nodeProbeDriver, type ChildCloseEvidence, type ControlledChild, type ControlledProcessDriver } from "./controlled-process.js";
import { canonicalDirectory, inspectWorktree, readPlainFile, type WorktreeRegistration } from "./worktree-paths.js";
import { ProviderExecutionError } from "./types.js";
import { parseProviderPolicy, type ProviderPolicy } from "./provider-policy.js";
import { createDetachedWorktree } from "./worktree-provisioning.js";
import {
  NativeRunCancellationInterruption,
  type NativeRunExecutionIdentity,
} from "./native-run-cancellation.js";

export interface WorktreeProbeInput {
  readonly worktreeId: string;
  readonly activationId: string;
  readonly signal?: AbortSignal;
}

export interface WorktreeProviderInput {
  readonly runId: string;
  readonly activationId: string;
  readonly providerAttemptId: string;
  readonly correlationId: string;
  readonly policy: ProviderPolicy;
  readonly cancellationInterruption?: NativeRunCancellationInterruption;
  readonly signal?: AbortSignal;
  readonly start: (cwd: string) => ControlledChild;
}

export interface WorktreeExecutor {
  recover(): Promise<void>;
  probe(input: WorktreeProbeInput): Promise<{ readonly digest: string; readonly stop: WorktreeExecutionState }>;
  startProvider?(input: WorktreeProviderInput): Promise<ControlledWorktreeProcess>;
  stopActivation(activationId: string): Promise<void>;
  close(): Promise<void>;
}

export interface LocalWorktreeExecutorOptions {
  readonly kernel: TorsorKernel;
  readonly runtimePrincipalId: string;
  readonly rootPath: string;
  readonly repositoryPath: string;
  readonly baseRevision?: string;
  readonly leaseDurationMs?: number;
  readonly stopGraceMs?: number;
  readonly forceGraceMs?: number;
  readonly driver?: ControlledProcessDriver;
  readonly operationalLogger?: OperationalLogger;
}

const probeContent = "Torsor controlled Worktree probe v1.\n";
const stoppedStates = new Set<WorktreeExecutionState>(["StopConfirmed", "ForceTerminated"]);
type StopDisposition = "StopConfirmed" | "ForceTerminated" | "Uncertain";

export class LocalWorktreeExecutor implements WorktreeExecutor {
  readonly #kernel: TorsorKernel;
  readonly #context: { readonly principalId: string };
  readonly #root: { path: string; identity: string };
  readonly #repository: { path: string; identity: string };
  readonly #executorId = randomUUID();
  readonly #driver: ControlledProcessDriver;
  readonly #leaseMs: number;
  readonly #stopMs: number;
  readonly #forceMs: number;
  readonly #baseRevision: string | undefined;
  readonly #operationalLogger: OperationalLogger | undefined;
  readonly #handles = new Map<string, ControlledWorktreeProcess>();
  readonly #starts = new Map<Promise<ControlledWorktreeProcess>, string>();
  #recovery: Promise<void> | undefined;
  #closed = false;

  constructor(options: LocalWorktreeExecutorOptions) {
    this.#kernel = options.kernel;
    this.#context = { principalId: options.runtimePrincipalId };
    this.#root = canonicalDirectory(options.rootPath);
    this.#repository = canonicalDirectory(options.repositoryPath);
    this.#driver = options.driver ?? nodeProbeDriver;
    if (options.baseRevision !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.baseRevision)) {
      throw new Error("Native Worktree provisioning requires a full immutable base commit.");
    }
    this.#baseRevision = options.baseRevision;
    this.#operationalLogger = options.operationalLogger;
    this.#leaseMs = positive(options.leaseDurationMs ?? 30_000);
    this.#stopMs = positive(options.stopGraceMs ?? 1_000);
    this.#forceMs = positive(options.forceGraceMs ?? 1_000);
  }

  recover(): Promise<void> {
    return this.#recovery ??= this.#recover().catch((error: unknown) => {
      this.#recovery = undefined;
      throw error;
    });
  }

  async #recover(): Promise<void> {
    const { identity } = await this.#kernel.query({ type: "GetWorktreeStorageIdentity" }, this.#context);
    this.#checkRoots();
    const marker = join(this.#root.path, ".torsor-owner");
    try {
      writeFileSync(marker, identity, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (readPlainFile(marker) !== identity) {
        throw new Error("Managed root belongs to another Kernel storage identity; use a fresh root.");
      }
    }
    let afterWorktreeId: string | undefined;
    while (true) {
      const page = await this.#kernel.query({
        type: "ListPhysicalWorktrees", limit: 100, ...(afterWorktreeId ? { afterWorktreeId } : {}),
      }, this.#context);
      for (const tree of page.items) {
        if (dirname(tree.directoryPath) !== this.#root.path) continue;
        const execution = tree.latestExecution;
        if (execution && execution.executorId !== this.#executorId &&
            (execution.authorityRevokedAt === null || !stoppedStates.has(execution.state))) {
          const correlationId = (await this.#kernel.query({
            type: "GetOperationalCorrelation",
            entityType: execution.provider ? "ProviderAttempt" : "Run",
            entityId: execution.provider?.providerAttemptId ?? tree.runId,
          }, this.#context)).correlationId;
          const operationContext = { correlationId };
          await emitOperational(this.#operationalLogger, {
            event: "recovery.pass",
            outcome: "started",
            correlationId: createOpaqueId(correlationId),
            runId: createOpaqueId(tree.runId),
            activationId: createOpaqueId(execution.activationId),
            ...(execution.provider
              ? { providerAttemptId: createOpaqueId(execution.provider.providerAttemptId) }
              : {}),
            worktreeId: createOpaqueId(tree.worktreeId),
            executionId: createOpaqueId(execution.id),
          });
          await this.#kernel.execute({
            type: "RecoverWorktreeExecution", idempotencyKey: `${this.#executorId}:recover:${execution.id}`,
            executionId: execution.id, reason: "Executor restarted without the original child handle; PID is not authority.",
          }, this.#context, operationContext);
          await emitOperational(this.#operationalLogger, {
            event: "writer_authority.quarantine",
            outcome: "succeeded",
            correlationId: createOpaqueId(correlationId),
            runId: createOpaqueId(tree.runId),
            activationId: createOpaqueId(execution.activationId),
            ...(execution.provider
              ? { providerAttemptId: createOpaqueId(execution.provider.providerAttemptId) }
              : {}),
            worktreeId: createOpaqueId(tree.worktreeId),
            executionId: createOpaqueId(execution.id),
          });
          await emitOperational(this.#operationalLogger, {
            event: "recovery.pass",
            outcome: "succeeded",
            correlationId: createOpaqueId(correlationId),
            runId: createOpaqueId(tree.runId),
            activationId: createOpaqueId(execution.activationId),
            ...(execution.provider
              ? { providerAttemptId: createOpaqueId(execution.provider.providerAttemptId) }
              : {}),
            worktreeId: createOpaqueId(tree.worktreeId),
            executionId: createOpaqueId(execution.id),
          });
        }
      }
      if (!page.hasMore) break;
      afterWorktreeId = page.items.at(-1)!.worktreeId;
    }
  }

  async register(input: WorktreeRegistration): Promise<void> {
    if (this.#closed) throw new Error("Worktree executor is closed.");
    await this.recover();
    this.#checkRoots();
    const binding = inspectWorktree(this.#root.path, this.#repository.path, input);
    await this.#kernel.execute({
      type: "RegisterPhysicalWorktree", idempotencyKey: `register:${input.worktreeId}`, ...binding,
    }, this.#context);
  }

  start(input: WorktreeProbeInput): Promise<ControlledWorktreeProcess> {
    if (this.#closed) return Promise.reject(new Error("Worktree executor is closed."));
    const pending = this.#start(input);
    this.#starts.set(pending, input.activationId);
    void pending.finally(() => this.#starts.delete(pending)).catch(() => undefined);
    return pending;
  }

  startProvider(input: WorktreeProviderInput): Promise<ControlledWorktreeProcess> {
    if (this.#closed) return Promise.reject(new Error("Worktree executor is closed."));
    const pending = this.#prepareProvider(input);
    this.#starts.set(pending, input.activationId);
    void pending.finally(() => this.#starts.delete(pending)).catch(() => undefined);
    return pending;
  }

  async #prepareProvider(input: WorktreeProviderInput): Promise<ControlledWorktreeProcess> {
    const policy = parseProviderPolicy(input.policy);
    if (policy.kind !== "trusted-local") {
      throw new ProviderExecutionError("provider_policy_violation", "Failed");
    }
    input.signal?.throwIfAborted();
    await this.recover();
    const run = await this.#kernel.query({ type: "GetRunProjection", runId: input.runId }, this.#context);
    const activation = run.activations.find((candidate) => candidate.id === input.activationId);
    if (
      input.cancellationInterruption &&
      run.run.state === "Cancelled" &&
      activation?.revocationReason === "run_cancelled" &&
      activation.runActivationGeneration === run.run.activationGeneration &&
      activation.runActivationGeneration === input.cancellationInterruption.runActivationGeneration
    ) {
      throw input.cancellationInterruption;
    }
    if (run.run.state !== "Active" ||
        !activation || activation.finishedAt !== null || activation.revokedAt !== null ||
        !run.providerAttempts.some((attempt) => attempt.id === input.providerAttemptId &&
          attempt.activationId === input.activationId && ["Started", "Acknowledged"].includes(attempt.status))) {
      throw new ProviderExecutionError("provider_worktree_authority_lost", "Unknown");
    }
    const page = await this.#kernel.query({
      type: "ListPhysicalWorktrees", runId: input.runId, limit: 2,
    }, this.#context);
    if (page.hasMore || page.items.length > 1) {
      throw new Error("Run has ambiguous physical Worktree assignments.");
    }
    let tree = page.items[0];
    if (!tree) {
      if (!this.#baseRevision) throw new Error("Native Worktree provisioning requires a pinned baseRevision.");
      this.#checkRoots();
      const directoryName = `run-${createHash("sha256").update(input.runId).digest("hex")}`;
      await createDetachedWorktree({
        rootPath: this.#root.path, repositoryPath: this.#repository.path,
        directoryName, baseRevision: this.#baseRevision,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      await this.register({
        worktreeId: directoryName, runId: input.runId, directoryName, baseRevision: this.#baseRevision,
      });
      tree = await this.#kernel.query({ type: "GetPhysicalWorktree", worktreeId: directoryName }, this.#context);
    }
    if (tree.runId !== input.runId) throw new Error("Physical Worktree belongs to another Run.");
    return this.#start({
      worktreeId: tree.worktreeId, activationId: input.activationId,
      ...(input.signal ? { signal: input.signal } : {}),
    }, { ...input, policy });
  }

  async #start(
    input: WorktreeProbeInput,
    provider?: WorktreeProviderInput & { readonly policy: Extract<ProviderPolicy, { kind: "trusted-local" }> },
  ): Promise<ControlledWorktreeProcess> {
    await this.recover();
    if (this.#closed) throw new Error("Worktree executor is closed.");
    input.signal?.throwIfAborted();
    const tree = await this.#kernel.query({ type: "GetPhysicalWorktree", worktreeId: input.worktreeId }, this.#context);
    this.#checkTree(tree, provider !== undefined);
    const requestId = randomUUID();
    const operationContext: KernelOperationContext | undefined = provider
      ? { correlationId: provider.correlationId }
      : undefined;
    const lease = await this.#kernel.execute({
      type: "AcquireWorktreeWriterLease", idempotencyKey: `${requestId}:acquire`,
      worktreeId: input.worktreeId, leaseDurationMs: this.#leaseMs,
    }, this.#context, operationContext);
    const leaseDeadlineAt = performance.now() +
      Date.parse(lease.leaseExpiresAt!) - Date.parse(lease.authorityObservedAt!);
    const leaseAuthority = {
      worktreeId: input.worktreeId, leaseToken: lease.leaseToken!,
      generation: lease.leaseGeneration!, fencingToken: lease.fencingToken!,
    };
    let started;
    try {
      input.signal?.throwIfAborted();
      started = await this.#kernel.execute({
        type: "StartWorktreeExecution", idempotencyKey: `${requestId}:intent`,
        ...leaseAuthority, activationId: input.activationId, executorId: this.#executorId,
        ...(provider ? { provider: {
          providerAttemptId: provider.providerAttemptId,
          policy: "trusted-local" as const,
          permissionMode: provider.policy.permissionMode,
        } } : {}),
      }, this.#context, operationContext);
    } catch (error) {
      await this.#kernel.execute({
        type: "ReleaseWorktreeWriterLease", idempotencyKey: `${requestId}:unused`, ...leaseAuthority,
      }, this.#context, operationContext);
      throw error;
    }
    const authority: WorktreeMutationAuthority = {
      ...leaseAuthority, executionId: started.entityId, executorId: this.#executorId,
      executionToken: started.executionToken!,
    };
    provider?.cancellationInterruption?.bindExecution({
      worktreeId: authority.worktreeId,
      executionId: authority.executionId,
      leaseGeneration: authority.generation,
      fencingToken: authority.fencingToken,
    });
    const handle = new ControlledWorktreeProcess({
      kernel: this.#kernel, principalId: this.#context.principalId, authority,
      activationId: input.activationId, stopMs: this.#stopMs, forceMs: this.#forceMs,
      leaseDeadlineAt,
      ...(provider
        ? {
            correlationId: provider.correlationId,
            runId: provider.runId,
            providerAttemptId: provider.providerAttemptId,
            worktreeId: input.worktreeId,
          }
        : {}),
      ...(this.#operationalLogger
        ? { operationalLogger: this.#operationalLogger }
        : {}),
      ...(provider?.cancellationInterruption
        ? { runCancellation: provider.cancellationInterruption }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (provider) {
      await emitOperational(this.#operationalLogger, {
        event: "writer_authority.acquire",
        outcome: "succeeded",
        correlationId: createOpaqueId(provider.correlationId),
        runId: createOpaqueId(provider.runId),
        activationId: createOpaqueId(input.activationId),
        providerAttemptId: createOpaqueId(provider.providerAttemptId),
        worktreeId: createOpaqueId(input.worktreeId),
        executionId: createOpaqueId(started.entityId),
      });
    }
    this.#handles.set(started.entityId, handle);
    try {
      if (!provider) {
        this.#kernel.performWorktreeMutation(authority, this.#context, () => {
          handle.assertTimeBudget();
          input.signal?.throwIfAborted();
          this.#checkTree(tree);
          const fd = openSync(join(tree.directoryPath, "torsor-probe.txt"), "wx", 0o600);
          try { writeFileSync(fd, probeContent); } finally { closeSync(fd); }
        });
      }
      this.#kernel.performWorktreeMutation(authority, this.#context, () => {
        handle.assertTimeBudget();
        input.signal?.throwIfAborted();
        if (this.#closed) throw new Error("Worktree executor is closed.");
        this.#checkTree(tree, provider !== undefined);
        handle.spawning();
        handle.attach(provider
          ? provider.start(tree.directoryPath)
          : this.#driver.start({ cwd: tree.directoryPath, content: probeContent }));
      });
      await handle.running();
      if (provider) {
        await emitOperational(this.#operationalLogger, {
          event: "provider_process.spawn",
          outcome: "succeeded",
          correlationId: createOpaqueId(provider.correlationId),
          runId: createOpaqueId(provider.runId),
          activationId: createOpaqueId(input.activationId),
          providerAttemptId: createOpaqueId(provider.providerAttemptId),
          worktreeId: createOpaqueId(input.worktreeId),
          executionId: createOpaqueId(started.entityId),
        });
      }
      return handle;
    } catch (error) {
      await handle.stop("Controlled start failed.");
      throw error;
    }
  }

  async probe(input: WorktreeProbeInput): Promise<{ digest: string; stop: WorktreeExecutionState }> {
    let handle: ControlledWorktreeProcess | undefined;
    try {
      handle = await this.start(input);
      const digest = await handle.result;
      if (digest !== createHash("sha256").update(probeContent).digest("hex")) {
        throw new Error("Controlled probe returned an invalid digest.");
      }
      const stop = await handle.finish();
      return { digest, stop };
    } catch {
      // This is the Provider boundary; local paths and raw child errors stay private.
      await handle?.stop("Controlled probe failed.").catch(() => { throw controlledFailure(); });
      throw controlledFailure();
    }
  }

  async stopActivation(activationId: string): Promise<void> {
    await this.#stopHandles(activationId);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#stopHandles();
  }

  async #stopHandles(activationId?: string): Promise<void> {
    const pending = [...this.#starts].filter(([, id]) => !activationId || id === activationId).map(([start]) => start);
    const stopping = [...this.#handles.values()]
      .filter((handle) => !activationId || handle.activationId === activationId)
      .map((handle) => handle.stop("Execution scope closed."));
    // Start all physical stops before waiting on any pending start or persistence.
    await Promise.allSettled([...pending, ...stopping]);
    const results = await Promise.allSettled([...this.#handles.values()]
      .filter((handle) => !activationId || handle.activationId === activationId)
      .map((handle) => handle.stop("Execution scope closed.")));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  #checkRoots(): void {
    if (canonicalDirectory(this.#root.path).identity !== this.#root.identity ||
        canonicalDirectory(this.#repository.path).identity !== this.#repository.identity) {
      throw new Error("Managed root or repository directory identity changed.");
    }
  }

  #checkTree(tree: PhysicalWorktreeView, allowDetachedCommit = false): void {
    this.#checkRoots();
    if (dirname(tree.directoryPath) !== this.#root.path || tree.repositoryPath !== this.#repository.path) {
      throw new Error("Worktree is outside this executor's configured scope.");
    }
    const current = inspectWorktree(this.#root.path, this.#repository.path, {
      ...tree, directoryName: basename(tree.directoryPath),
    }, allowDetachedCommit);
    if (current.directoryPath !== tree.directoryPath || current.directoryIdentity !== tree.directoryIdentity ||
        current.repositoryId !== tree.repositoryId) {
      throw new Error("Physical Worktree identity changed.");
    }
  }
}

interface ProcessOptions {
  readonly kernel: TorsorKernel;
  readonly principalId: string;
  readonly authority: WorktreeMutationAuthority;
  readonly activationId: string;
  readonly stopMs: number;
  readonly forceMs: number;
  readonly leaseDeadlineAt: number;
  readonly operationalLogger?: OperationalLogger;
  readonly correlationId?: string;
  readonly runId?: string;
  readonly providerAttemptId?: string;
  readonly worktreeId?: string;
  readonly runCancellation?: NativeRunCancellationInterruption;
  readonly signal?: AbortSignal;
}

export class ControlledWorktreeProcess {
  readonly activationId: string;
  readonly #options: ProcessOptions;
  #child: ControlledChild | undefined;
  #physicalStop: Promise<StopDisposition> | undefined;
  #settlement: Promise<WorktreeExecutionState> | undefined;
  #closeEvidence: ChildCloseEvidence | undefined;
  #closeObservation: Promise<ChildCloseEvidence | undefined> | undefined;
  #state: WorktreeExecutionState = "Starting";
  #revocationReason: string | undefined;
  #durablyRevoked = false;
  #durablySettled = false;
  #stopSent = false;
  #forceSent = false;
  #stopErrors: string[] = [];
  #forced = false;
  #spawnAttempted = false;
  #providerExitObserved = false;
  #cancellationCausalityRecorded = false;
  #monitor: NodeJS.Timeout | undefined;
  #deadline: NodeJS.Timeout | undefined;
  #retry: NodeJS.Timeout | undefined;
  #removeAbort: (() => void) | undefined;
  #authorityStop: Promise<void> | undefined;
  #authorityClassificationError: unknown;
  #authorityLossLogged = false;
  #stopLogged = false;
  #quarantineLogged = false;
  readonly #finished: Promise<WorktreeExecutionState>;
  #resolveFinished!: (state: WorktreeExecutionState) => void;
  #rejectFinished!: (error: unknown) => void;

  constructor(options: ProcessOptions) {
    this.#options = options;
    this.activationId = options.activationId;
    this.#finished = new Promise((resolve, reject) => {
      this.#resolveFinished = resolve;
      this.#rejectFinished = reject;
    });
    void this.#finished.catch(() => undefined);
  }

  get result(): Promise<string> {
    if (this.#revocationReason) return Promise.reject(new Error("Controlled execution authority was revoked."));
    if (!this.#child) return Promise.reject(new Error("Controlled child has not started."));
    return Promise.race([
      this.#child.result,
      this.#finished.then((state) => { throw new Error(`Controlled execution ended: ${state}.`); }),
    ]);
  }

  assertTimeBudget(): void {
    if (this.#revocationReason) throw new Error("Controlled execution authority was revoked.");
    if (performance.now() >= this.#options.leaseDeadlineAt) {
      throw new Error("Writer lease wall-clock budget exhausted.");
    }
  }

  assertPublication(): void {
    if (this.#revocationReason || performance.now() >= this.#options.leaseDeadlineAt || this.#options.signal?.aborted) {
      throw new ProviderExecutionError("provider_worktree_authority_lost", "Unknown");
    }
    if (this.#state === "StopConfirmed") {
      this.#options.kernel.checkWorktreePublication(this.#options.authority, this.#options);
    } else {
      this.#options.kernel.checkWorktreeAuthority(this.#options.authority, this.#options);
    }
  }

  spawning(): void {
    if (this.#spawnAttempted || this.#state !== "Starting") throw new Error("Spawn intent cannot be reused.");
    this.#spawnAttempted = true;
  }

  attach(child: ControlledChild): void {
    if (this.#child || !this.#spawnAttempted || this.#state !== "Starting") {
      throw new Error("An original child handle cannot be replaced.");
    }
    this.#child = child;
    if (child.providerExit) {
      void child.providerExit.then(
        () => { this.#providerExitObserved = true; },
        () => { this.#providerExitObserved = true; },
      );
    }
    this.#closeObservation = child.closed.then((evidence) => {
      this.#closeEvidence = evidence;
      return evidence;
    }, () => {
      this.#stopErrors.push("Original child close observation failed.");
      return undefined;
    });
  }

  async running(): Promise<void> {
    if (!this.#child?.pid || this.#state !== "Starting") {
      throw new Error("Controlled child did not report a new process identity.");
    }
    await this.#record("Running", "Original child handle retained.");
    const signal = this.#options.signal;
    const abort = () => { void this.stop("Runtime cancellation requested.").catch(() => undefined); };
    if (signal?.aborted) {
      await this.stop("Runtime cancellation requested.");
      return;
    }
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      this.#removeAbort = () => signal.removeEventListener("abort", abort);
    }
    this.#monitor = setInterval(() => {
      try {
        this.#options.kernel.checkWorktreeAuthority(this.#options.authority, this.#options);
      } catch {
        // A failed authority check can stop work, never grant a replacement writer.
        clearInterval(this.#monitor);
        this.#authorityStop ??= this.#stopAfterAuthorityLoss();
        void this.#authorityStop.catch(() => undefined);
      }
    }, 25);
    this.#deadline = setTimeout(() => {
      void this.stop("Writer lease wall-clock budget exhausted.").catch(() => undefined);
    }, Math.max(1, this.#options.leaseDeadlineAt - performance.now()));
  }

  stop(reason: string): Promise<WorktreeExecutionState> {
    this.#revoke(reason);
    return this.#drain();
  }

  #revoke(reason: string): void {
    if (this.#revocationReason) return;
    this.#revocationReason = reason;
    this.#options.kernel.revokeLocalWorktreeAuthority(this.#options.authority, this.#options);
    this.#rejectFinished(new Error("Controlled execution authority was revoked."));
    clearTimeout(this.#deadline);
    clearInterval(this.#monitor);
    this.#removeAbort?.();
  }

  async finish(): Promise<WorktreeExecutionState> {
    this.assertTimeBudget();
    const state = await this.#drain();
    if (state !== "StopConfirmed" || this.#closeEvidence?.code !== 0 ||
        this.#closeEvidence.signal !== null || this.#closeEvidence.error !== null) {
      throw new Error("Controlled child did not exit normally.");
    }
    this.#options.signal?.throwIfAborted();
    this.assertTimeBudget();
    this.#options.kernel.checkWorktreePublication(this.#options.authority, this.#options);
    return state;
  }

  #drain(): Promise<WorktreeExecutionState> {
    clearTimeout(this.#retry);
    const cancellation = this.#options.runCancellation;
    if (
      cancellation &&
      this.#options.signal?.aborted &&
      this.#options.signal.reason === cancellation &&
      !this.#cancellationCausalityRecorded
    ) {
      this.#cancellationCausalityRecorded = true;
      if (this.#providerExitObserved) {
        cancellation.recordProviderExitPrecededStop(this.#executionIdentity());
      } else if (!this.#physicalStop && !this.#authorityStop) {
        cancellation.recordOwnedStopInitiated(this.#executionIdentity());
      }
    }
    // This promise contains OS operations only, never a Kernel read or write.
    if (!this.#physicalStop) {
      this.#physicalStop = this.#stopProcess();
    }
    return this.#settlement ??= this.#persistStop().then((state) => {
      this.#settlement = undefined;
      return state;
    }, (error: unknown) => {
      this.#settlement = undefined;
      this.#revoke("Controlled stop persistence failed.");
      this.#retry = setTimeout(() => {
        // Each failed attempt rearms this retry; explicit stop/close also returns the error.
        void this.#drain().catch(() => undefined);
      }, 100);
      throw error;
    });
  }

  async #stopProcess(): Promise<StopDisposition> {
    clearInterval(this.#monitor);
    if (!this.#child) {
      return this.#spawnAttempted ? "Uncertain" : "StopConfirmed";
    }
    if (!this.#closeEvidence && !this.#stopSent) {
      this.#stopSent = true;
      try { this.#child.requestStop(); } catch { this.#stopErrors.push("Original process stop request failed."); }
    }
    let evidence = this.#closeEvidence ?? await within(this.#closeObservation!, this.#options.stopMs);
    if (!evidence) {
      if (!this.#forceSent) {
        this.#forceSent = true;
        try { this.#forced = this.#child.forceStop(); } catch { this.#stopErrors.push("Original process force stop failed."); }
      }
      evidence = await within(this.#closeObservation!, this.#options.forceMs);
    }
    if (evidence) this.#closeEvidence = evidence;
    return evidence ? this.#observedStopState() : "Uncertain";
  }

  async reconcile(): Promise<WorktreeExecutionState> {
    return this.stop("Reconciliation requested.");
  }

  providerExitInterruption(): NativeRunCancellationInterruption | undefined {
    const cancellation = this.#options.runCancellation;
    return cancellation?.ownsPhysicalStop(this.#executionIdentity())
      ? cancellation
      : undefined;
  }

  authorityClassificationError(): Promise<unknown> | undefined {
    return this.#authorityStop?.then(() => this.#authorityClassificationError);
  }

  #observedStopState(): "StopConfirmed" | "ForceTerminated" {
    return this.#forced || this.#closeEvidence?.signal != null ? "ForceTerminated" : "StopConfirmed";
  }

  async #stopAfterAuthorityLoss(): Promise<void> {
    const stopSettlement = this.stop("Worktree authority monitor failed.");
    let loggingFailure: unknown;
    if (!this.#authorityLossLogged) {
      this.#authorityLossLogged = true;
      await this.#log({
        event: "writer_authority.loss",
        outcome: "lost",
        errorCode: "writer_authority_lost",
      }).catch((error: unknown) => {
        loggingFailure = error;
      });
    }
    const cancellation = this.#options.runCancellation;
    if (cancellation && !this.#providerExitObserved) {
      try {
        const [run, lease] = await Promise.all([
          this.#options.kernel.query(
            { type: "GetRunProjection", runId: cancellation.runId },
            this.#options,
          ),
          this.#options.kernel.query(
            {
              type: "GetWorktreeWriterLease",
              worktreeId: this.#options.authority.worktreeId,
            },
            this.#options,
          ),
        ]);
        const activation = run.activations.find(
          (candidate) => candidate.id === this.activationId,
        );
        if (
          !this.#providerExitObserved &&
          !this.#cancellationCausalityRecorded &&
          run.run.state === "Cancelled" &&
          activation?.revocationReason === "run_cancelled" &&
          activation.runActivationGeneration === run.run.activationGeneration &&
          activation.runActivationGeneration === cancellation.runActivationGeneration &&
          lease.status === "Active" &&
          lease.generation === this.#options.authority.generation &&
          lease.fencingToken === this.#options.authority.fencingToken
        ) {
          this.#cancellationCausalityRecorded = true;
          cancellation.recordOwnedStopInitiated(this.#executionIdentity());
        }
      } catch (error) {
        this.#authorityClassificationError = error;
      }
    }
    let stopFailure: unknown;
    await stopSettlement.catch((error: unknown) => {
      stopFailure = error;
    });
    if (stopFailure !== undefined && loggingFailure !== undefined) {
      throw new AggregateError(
        [stopFailure, loggingFailure],
        "Authority loss stop and operational logging both failed.",
      );
    }
    if (stopFailure !== undefined) {
      throw stopFailure;
    }
    if (loggingFailure !== undefined) {
      throw loggingFailure;
    }
  }

  async #persistStop(): Promise<WorktreeExecutionState> {
    const initial = await this.#physicalStop!;
    const state = this.#closeEvidence ? this.#observedStopState() : initial;
    if (state === "Uncertain" || state === "ForceTerminated") {
      this.#revoke("Controlled physical stop did not confirm normal completion.");
    }
    await this.#persistRevocation();
    if (!this.#durablySettled || this.#state !== state) {
      const tree = await this.#options.kernel.query({
        type: "GetPhysicalWorktree", worktreeId: this.#options.authority.worktreeId,
      }, this.#options);
      if (tree.latestExecution?.id !== this.#options.authority.executionId) {
        throw new Error("Physical stop receipt does not match the current execution.");
      }
      this.#state = tree.latestExecution.state;
      if (!stoppedStates.has(this.#state) && this.#state !== state) {
        if (this.#child && !["StopRequested", "Uncertain"].includes(this.#state)) {
          await this.#record("StopRequested", "Original-handle stop requested.", true);
        }
        await this.#record(state, this.#closeEvidence
          ? `Original process tree stop confirmed; normal exit: ${
            this.#closeEvidence.code === 0 && this.#closeEvidence.signal === null && this.#closeEvidence.error === null
          }.`
          : this.#spawnAttempted
            ? `No original-handle close confirmation. ${this.#stopErrors.join("; ")}`
            : "No child was spawned.");
      }
      this.#durablySettled = true;
      this.#resolveFinished(this.#state);
    }
    if (!this.#stopLogged) {
      this.#stopLogged = true;
      await this.#log({
        event: "provider_process.stop",
        outcome: this.#state === "Uncertain" ? "unknown" : "succeeded",
        ...(this.#state === "Uncertain"
          ? { errorCode: "provider_cleanup_failed" }
          : {}),
      });
    }
    if (this.#state === "Uncertain" && !this.#quarantineLogged) {
      this.#quarantineLogged = true;
      await this.#log({
        event: "writer_authority.quarantine",
        outcome: "succeeded",
      });
    }
    // Cancellation may have arrived while a normal drain awaited persistence.
    await this.#persistRevocation();
    if (this.#revocationReason && stoppedStates.has(this.#state)) await this.#release();
    return this.#state;
  }

  async #persistRevocation(): Promise<void> {
    if (!this.#revocationReason || this.#durablyRevoked) return;
    await this.#options.kernel.execute({
      type: "RevokeWorktreeExecutionAuthority",
      idempotencyKey: `${this.#options.authority.executionId}:revoke`,
      ...this.#options.authority, reason: this.#revocationReason,
    }, this.#options, this.#operationContext());
    this.#durablyRevoked = true;
  }

  async #record(
    state: Exclude<WorktreeExecutionState, "Starting">, evidence: string, preservePublicationAuthority = false,
  ): Promise<void> {
    await this.#options.kernel.execute({
      type: "RecordWorktreeExecution", idempotencyKey: `${this.#options.authority.executionId}:${state}`,
      ...this.#options.authority, state, evidence, preservePublicationAuthority,
      ...(this.#child?.pid ? { pid: this.#child.pid } : {}),
    }, this.#options, this.#operationContext());
    this.#state = state;
  }

  async #release(): Promise<void> {
    const lease = await this.#options.kernel.query({
      type: "GetWorktreeWriterLease", worktreeId: this.#options.authority.worktreeId,
    }, this.#options);
    if (lease.status !== "Active" || lease.generation !== this.#options.authority.generation) return;
    try {
      await this.#options.kernel.execute({
        type: "ReleaseWorktreeWriterLease", idempotencyKey: `${this.#options.authority.executionId}:release`,
        ...this.#options.authority,
      }, this.#options, this.#operationContext());
    } catch (error) {
      if (!(error instanceof KernelError && error.code === "Conflict")) throw error;
      const current = await this.#options.kernel.query({
        type: "GetWorktreeWriterLease", worktreeId: this.#options.authority.worktreeId,
      }, this.#options);
      if (current.status !== "Expired") throw error;
    }
  }

  #executionIdentity(): NativeRunExecutionIdentity {
    return {
      worktreeId: this.#options.authority.worktreeId,
      executionId: this.#options.authority.executionId,
      leaseGeneration: this.#options.authority.generation,
      fencingToken: this.#options.authority.fencingToken,
    };
  }

  #operationContext(): KernelOperationContext | undefined {
    return this.#options.correlationId
      ? { correlationId: this.#options.correlationId }
      : undefined;
  }

  async #log(
    input: Pick<OperationalEventInput, "event" | "outcome" | "errorCode">,
  ): Promise<void> {
    if (
      !this.#options.operationalLogger ||
      !this.#options.correlationId ||
      !this.#options.runId ||
      !this.#options.providerAttemptId ||
      !this.#options.worktreeId
    ) {
      return;
    }
    await emitOperational(this.#options.operationalLogger, {
      ...input,
      correlationId: createOpaqueId(this.#options.correlationId),
      runId: createOpaqueId(this.#options.runId),
      activationId: createOpaqueId(this.activationId),
      providerAttemptId: createOpaqueId(this.#options.providerAttemptId),
      worktreeId: createOpaqueId(this.#options.worktreeId),
      executionId: createOpaqueId(this.#options.authority.executionId),
    });
  }
}

function controlledFailure(): ProviderExecutionError {
  return new ProviderExecutionError(
    "provider_worktree_execution_failed",
    "Unknown",
  );
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Executor durations must be positive integers.");
  return value;
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function emitOperational(
  logger: OperationalLogger | undefined,
  event: OperationalEventInput,
): Promise<void> {
  if (logger) await logger.emit(event);
}
