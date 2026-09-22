import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  KernelError, type PhysicalWorktreeView, type TorsorKernel,
  type WorktreeExecutionState, type WorktreeMutationAuthority,
} from "@torsor/kernel";

import { nodeProbeDriver, type ChildCloseEvidence, type ControlledChild, type ControlledProcessDriver } from "./controlled-process.js";
import { canonicalDirectory, inspectWorktree, readPlainFile, type WorktreeRegistration } from "./worktree-paths.js";

export interface WorktreeProbeInput {
  readonly worktreeId: string;
  readonly activationId: string;
  readonly signal?: AbortSignal;
}

export interface WorktreeExecutor {
  recover(): Promise<void>;
  probe(input: WorktreeProbeInput): Promise<{ readonly digest: string; readonly stop: WorktreeExecutionState }>;
  stopActivation(activationId: string): Promise<void>;
  close(): Promise<void>;
}

export interface LocalWorktreeExecutorOptions {
  readonly kernel: TorsorKernel;
  readonly runtimePrincipalId: string;
  readonly rootPath: string;
  readonly repositoryPath: string;
  readonly leaseDurationMs?: number;
  readonly stopGraceMs?: number;
  readonly forceGraceMs?: number;
  readonly driver?: ControlledProcessDriver;
}

const probeContent = "Torsor controlled Worktree probe v1.\n";
const stoppedStates = new Set<WorktreeExecutionState>(["StopConfirmed", "ForceTerminated"]);

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
    this.#leaseMs = positive(options.leaseDurationMs ?? 30_000);
    this.#stopMs = positive(options.stopGraceMs ?? 1_000);
    this.#forceMs = positive(options.forceGraceMs ?? 1_000);
  }

  recover(): Promise<void> {
    return this.#recovery ??= this.#recover();
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
        if (execution && execution.executorId !== this.#executorId && !stoppedStates.has(execution.state)) {
          await this.#kernel.execute({
            type: "RecoverWorktreeExecution", idempotencyKey: `${this.#executorId}:recover:${execution.id}`,
            executionId: execution.id, reason: "Executor restarted without the original child handle; PID is not authority.",
          }, this.#context);
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

  async #start(input: WorktreeProbeInput): Promise<ControlledWorktreeProcess> {
    await this.recover();
    input.signal?.throwIfAborted();
    const tree = await this.#kernel.query({ type: "GetPhysicalWorktree", worktreeId: input.worktreeId }, this.#context);
    this.#checkTree(tree);
    const requestId = randomUUID();
    const lease = await this.#kernel.execute({
      type: "AcquireWorktreeWriterLease", idempotencyKey: `${requestId}:acquire`,
      worktreeId: input.worktreeId, leaseDurationMs: this.#leaseMs,
    }, this.#context);
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
      }, this.#context);
    } catch (error) {
      await this.#kernel.execute({
        type: "ReleaseWorktreeWriterLease", idempotencyKey: `${requestId}:unused`, ...leaseAuthority,
      }, this.#context);
      throw error;
    }
    const authority: WorktreeMutationAuthority = {
      ...leaseAuthority, executionId: started.entityId, executorId: this.#executorId,
      executionToken: started.executionToken!,
    };
    const handle = new ControlledWorktreeProcess({
      kernel: this.#kernel, principalId: this.#context.principalId, authority,
      activationId: input.activationId, stopMs: this.#stopMs, forceMs: this.#forceMs,
      leaseBudgetMs: Math.max(1, Date.parse(lease.leaseExpiresAt!) - Date.parse(lease.authorityObservedAt!)),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    this.#handles.set(started.entityId, handle);
    try {
      this.#kernel.performWorktreeMutation(authority, this.#context, () => {
        input.signal?.throwIfAborted();
        this.#checkTree(tree);
        const fd = openSync(join(tree.directoryPath, "torsor-probe.txt"), "wx", 0o600);
        try { writeFileSync(fd, probeContent); } finally { closeSync(fd); }
      });
      this.#kernel.performWorktreeMutation(authority, this.#context, () => {
        input.signal?.throwIfAborted();
        this.#checkTree(tree);
        handle.spawning();
        handle.attach(this.#driver.start({ cwd: tree.directoryPath, content: probeContent }));
      });
      await handle.running();
      return handle;
    } catch (error) {
      await handle.stop(`Controlled start failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async probe(input: WorktreeProbeInput): Promise<{ digest: string; stop: WorktreeExecutionState }> {
    const handle = await this.start(input);
    try {
      const digest = await handle.result;
      const stop = await handle.stop("Controlled probe completed.");
      if (stop === "Uncertain") throw new Error("Controlled probe stop is uncertain; Worktree quarantined.");
      return { digest, stop };
    } finally {
      await handle.stop("Controlled probe scope ended.");
    }
  }

  async stopActivation(activationId: string): Promise<void> {
    await Promise.allSettled([...this.#starts].filter(([, id]) => id === activationId).map(([start]) => start));
    await Promise.all([...this.#handles.values()]
      .filter((handle) => handle.activationId === activationId).map((handle) => handle.stop("Activation scope ended.")));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#starts.keys());
    await Promise.all([...this.#handles.values()].map((handle) => handle.stop("Local executor closing.")));
  }

  #checkRoots(): void {
    if (canonicalDirectory(this.#root.path).identity !== this.#root.identity ||
        canonicalDirectory(this.#repository.path).identity !== this.#repository.identity) {
      throw new Error("Managed root or repository directory identity changed.");
    }
  }

  #checkTree(tree: PhysicalWorktreeView): void {
    this.#checkRoots();
    if (dirname(tree.directoryPath) !== this.#root.path || tree.repositoryPath !== this.#repository.path) {
      throw new Error("Worktree is outside this executor's configured scope.");
    }
    const current = inspectWorktree(this.#root.path, this.#repository.path, {
      ...tree, directoryName: basename(tree.directoryPath),
    });
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
  readonly leaseBudgetMs: number;
  readonly signal?: AbortSignal;
}

export class ControlledWorktreeProcess {
  readonly activationId: string;
  readonly #options: ProcessOptions;
  #child: ControlledChild | undefined;
  #stop: Promise<WorktreeExecutionState> | undefined;
  #state: WorktreeExecutionState = "Starting";
  #forced = false;
  #spawnAttempted = false;
  #monitor: NodeJS.Timeout | undefined;
  #deadline: NodeJS.Timeout | undefined;
  #removeAbort: (() => void) | undefined;
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
    if (!this.#child) return Promise.reject(new Error("Controlled child has not started."));
    return Promise.race([
      this.#child.result,
      this.#finished.then((state) => { throw new Error(`Controlled execution ended: ${state}.`); }),
    ]);
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
        this.#options.kernel.performWorktreeMutation(this.#options.authority, this.#options, () => {});
      } catch (error) {
        // A failed authority check can stop work, never grant a replacement writer.
        void this.stop(`Authority monitor failed: ${error instanceof Error ? error.message : String(error)}`)
          .catch(() => undefined);
      }
    }, 25);
    this.#deadline = setTimeout(() => {
      void this.stop("Writer lease wall-clock budget exhausted.").catch(() => undefined);
    }, this.#options.leaseBudgetMs);
  }

  stop(reason: string): Promise<WorktreeExecutionState> {
    if (!this.#stop) {
      this.#stop = this.#stopProcess(reason);
      void this.#stop.then(this.#resolveFinished, this.#rejectFinished);
    }
    return this.#stop;
  }

  async #stopProcess(reason: string): Promise<WorktreeExecutionState> {
    clearInterval(this.#monitor);
    clearTimeout(this.#deadline);
    this.#removeAbort?.();
    if (!this.#child) {
      await this.#record(this.#spawnAttempted ? "Uncertain" : "StopConfirmed",
        this.#spawnAttempted ? `${reason} Spawn was attempted but no handle returned.` : `${reason} No child was spawned.`);
      if (!this.#spawnAttempted) await this.#release();
      return this.#state;
    }
    const tree = await this.#options.kernel.query({
      type: "GetPhysicalWorktree", worktreeId: this.#options.authority.worktreeId,
    }, this.#options);
    if (tree.latestExecution?.state !== "Uncertain") {
      await this.#record("StopRequested", reason);
    } else {
      this.#state = "Uncertain";
    }
    const requestErrors: string[] = [];
    try { this.#child.requestStop(); } catch (error) { requestErrors.push(String(error)); }
    let evidence = await within(this.#child.closed, this.#options.stopMs);
    if (!evidence) {
      try { this.#forced = this.#child.forceStop(); } catch (error) { requestErrors.push(String(error)); }
      evidence = await within(this.#child.closed, this.#options.forceMs);
    }
    if (evidence) return this.#confirm(evidence);
    if (this.#state !== "Uncertain") {
      await this.#record("Uncertain", `${reason} No original-handle close confirmation by deadline. ${requestErrors.join("; ")}`);
    }
    return this.#state;
  }

  async reconcile(): Promise<WorktreeExecutionState> {
    await this.stop("Reconciliation requested.");
    if (this.#state !== "Uncertain" || !this.#child) return this.#state;
    const evidence = await within(this.#child.closed, 0);
    return evidence ? this.#confirm(evidence) : this.#state;
  }

  async #confirm(evidence: ChildCloseEvidence): Promise<WorktreeExecutionState> {
    await this.#record(this.#forced ? "ForceTerminated" : "StopConfirmed", `Original child close: ${JSON.stringify(evidence)}`);
    await this.#release();
    return this.#state;
  }

  async #record(state: Exclude<WorktreeExecutionState, "Starting">, evidence: string): Promise<void> {
    await this.#options.kernel.execute({
      type: "RecordWorktreeExecution", idempotencyKey: `${this.#options.authority.executionId}:${state}`,
      ...this.#options.authority, state, evidence,
      ...(this.#child?.pid ? { pid: this.#child.pid } : {}),
    }, this.#options);
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
      }, this.#options);
    } catch (error) {
      if (!(error instanceof KernelError && error.code === "Conflict")) throw error;
      const current = await this.#options.kernel.query({
        type: "GetWorktreeWriterLease", worktreeId: this.#options.authority.worktreeId,
      }, this.#options);
      if (current.status !== "Expired") throw error;
    }
  }
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
