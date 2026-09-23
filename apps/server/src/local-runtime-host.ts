import {
  AgentRuntime,
  type AgentRuntimeHooks,
  type ProviderAdapter,
  type RuntimePassResult,
  type WorktreeExecutor,
} from "@torsor/agent-runtime";
import {
  TorsorKernel,
  type KernelBootstrap,
  type KernelOpenOptions,
  type ArtifactStorage,
} from "@torsor/kernel";

import {
  createTorsorHttpService,
  type LocalCredential,
  type TorsorHttpService,
} from "./server.js";

export interface LocalRuntimeHostOptions {
  readonly databasePath: string;
  readonly artifactStorage?: ArtifactStorage;
  readonly bootstrap?: KernelBootstrap;
  readonly credentials: readonly LocalCredential[];
  readonly runtimePrincipalId: string;
  readonly projectIds: readonly string[];
  readonly adapter: ProviderAdapter;
  readonly host?: string;
  readonly port?: number;
  readonly bodyLimitBytes?: number;
  readonly eventBatchSize?: number;
  readonly eventPollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly sessionDurationMs?: number;
  readonly runtimePollIntervalMs?: number;
  readonly attentionLeaseMs?: number;
  readonly attentionConcurrency?: number;
  readonly activationDurationMs?: number;
  readonly outboxLeaseMs?: number;
  readonly providerTimeoutMs?: number;
  readonly cancellationPollMs?: number;
  readonly leaseSafetyMs?: number;
  readonly runtimeHooks?: AgentRuntimeHooks;
  readonly clock?: () => Date;
  readonly idFactory?: (prefix: string) => string;
  readonly worktreeExecutorFactory?: (kernel: TorsorKernel) => WorktreeExecutor;
}

export interface LocalRuntimeHost {
  readonly origin: string | null;
  readonly finished: Promise<void>;
  start(): Promise<string>;
  close(): Promise<void>;
}

class Host implements LocalRuntimeHost {
  readonly #kernel: TorsorKernel;
  readonly #service: TorsorHttpService;
  readonly #runtime: AgentRuntime;
  readonly #runtimePollIntervalMs: number;
  readonly #worktreeExecutor: WorktreeExecutor | undefined;
  readonly #started = deferred<string>();
  readonly #finished = deferred<void>();
  readonly #stopController = new AbortController();
  #state: "created" | "starting" | "running" | "closing" | "closed" =
    "created";
  #lifecyclePromise: Promise<void> | null = null;
  #closeBeforeStartPromise: Promise<void> | null = null;
  #serviceClosePromise: Promise<void> | null = null;
  #cleanupPromise: Promise<void> | null = null;
  #cleanupFailed = false;
  #cleanupRetried = false;

  constructor(
    kernel: TorsorKernel,
    service: TorsorHttpService,
    runtime: AgentRuntime,
    runtimePollIntervalMs: number,
    worktreeExecutor?: WorktreeExecutor,
  ) {
    this.#kernel = kernel;
    this.#service = service;
    this.#runtime = runtime;
    this.#worktreeExecutor = worktreeExecutor;
    this.#runtimePollIntervalMs = positiveInteger(
      runtimePollIntervalMs,
      "runtimePollIntervalMs",
    );
    void this.#finished.promise.catch(() => undefined);
  }

  get origin(): string | null {
    return this.#service.origin;
  }

  get finished(): Promise<void> {
    return this.#finished.promise;
  }

  async start(): Promise<string> {
    if (this.#state === "closing" || this.#state === "closed") {
      throw new Error("The local runtime host is closed.");
    }
    if (!this.#lifecyclePromise) {
      this.#state = "starting";
      this.#lifecyclePromise = this.#runLifecycle();
      void this.#lifecyclePromise.catch(() => undefined);
    }
    return this.#started.promise;
  }

  async close(): Promise<void> {
    if (this.#cleanupFailed || this.#cleanupRetried) {
      this.#cleanupRetried = true;
      return this.#closeResources();
    }
    if (this.#state === "created") {
      if (!this.#closeBeforeStartPromise) {
        this.#state = "closing";
        this.#closeBeforeStartPromise = this.#closeBeforeStart();
      }
      return this.#closeBeforeStartPromise;
    }
    if (this.#state !== "closed") {
      this.#state = "closing";
      this.#requestStop();
      this.#beginServiceClose();
    }
    if (this.#lifecyclePromise) {
      return this.#lifecyclePromise;
    }
    return this.#closeBeforeStartPromise ?? Promise.resolve();
  }

  async #runLifecycle(): Promise<void> {
    let failure: { readonly error: unknown } | null = null;
    try {
      if (this.#worktreeExecutor) await this.#worktreeExecutor.recover();
      if (this.#stopController.signal.aborted) {
        this.#started.reject(new Error("The local runtime host closed during recovery."));
      } else {
        const origin = await this.#service.listen();
        this.#state = "running";
        this.#started.resolve(origin);
        await this.#runRuntimeLoop();
      }
    } catch (error) {
      failure = { error };
      this.#started.reject(error);
    } finally {
      this.#state = "closing";
      this.#requestStop();
      try {
        await this.#closeResources();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) {
      this.#finished.reject(failure.error);
      throw failure.error;
    }
    this.#finished.resolve();
  }

  async #runRuntimeLoop(): Promise<void> {
    const signal = this.#stopController.signal;
    while (!signal.aborted) {
      const result = await this.#runtime.runOnce();
      if (signal.aborted) {
        return;
      }
      if (isIdle(result)) {
        await interruptibleDelay(this.#runtimePollIntervalMs, signal);
      } else {
        await yieldToEventLoop();
      }
    }
  }

  async #closeBeforeStart(): Promise<void> {
    this.#requestStop();
    try {
      await this.#closeResources();
    } catch (error) {
      this.#finished.reject(error);
      throw error;
    }
    this.#finished.resolve();
  }

  #closeResources(): Promise<void> {
    return this.#cleanupPromise ??= this.#tryCloseResources().catch((error: unknown) => {
      this.#cleanupPromise = null;
      this.#cleanupFailed = true;
      throw error;
    });
  }

  async #tryCloseResources(): Promise<void> {
    this.#state = "closing";
    const results = await Promise.allSettled([
      this.#beginServiceClose(),
      this.#worktreeExecutor?.close(),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    this.#kernel.close();
    this.#cleanupFailed = false;
    this.#state = "closed";
  }

  #requestStop(): void {
    if (!this.#stopController.signal.aborted) {
      this.#stopController.abort();
    }
  }

  #beginServiceClose(): Promise<void> {
    if (!this.#serviceClosePromise) {
      this.#serviceClosePromise = this.#service.close().catch((error: unknown) => {
        this.#serviceClosePromise = null;
        throw error;
      });
      void this.#serviceClosePromise.catch(() => undefined);
    }
    return this.#serviceClosePromise;
  }
}

export function createLocalRuntimeHost(
  options: LocalRuntimeHostOptions,
): LocalRuntimeHost {
  const runtimePollIntervalMs = positiveInteger(
    options.runtimePollIntervalMs ?? 250,
    "runtimePollIntervalMs",
  );
  const kernelOptions: KernelOpenOptions = {
    databasePath: options.databasePath,
    ...(options.artifactStorage ? { artifactStorage: options.artifactStorage } : {}),
    ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    ...(options.activationDurationMs
      ? { activationDurationMs: options.activationDurationMs }
      : {}),
  };
  const kernel = TorsorKernel.open(kernelOptions);
  try {
    const worktreeExecutor = options.worktreeExecutorFactory?.(kernel);
    const service = createTorsorHttpService({
      kernel,
      credentials: options.credentials,
      ...(options.host ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.bodyLimitBytes
        ? { bodyLimitBytes: options.bodyLimitBytes }
        : {}),
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
    const runtime = new AgentRuntime({
      kernel,
      runtimePrincipalId: options.runtimePrincipalId,
      projectIds: options.projectIds,
      adapter: options.adapter,
      ...(worktreeExecutor ? { worktreeExecutor } : {}),
      ...(options.attentionLeaseMs
        ? { attentionLeaseMs: options.attentionLeaseMs }
        : {}),
      ...(options.attentionConcurrency
        ? { attentionConcurrency: options.attentionConcurrency }
        : {}),
      ...(options.activationDurationMs
        ? { activationDurationMs: options.activationDurationMs }
        : {}),
      ...(options.outboxLeaseMs
        ? { outboxLeaseMs: options.outboxLeaseMs }
        : {}),
      ...(options.providerTimeoutMs
        ? { providerTimeoutMs: options.providerTimeoutMs }
        : {}),
      ...(options.cancellationPollMs
        ? { cancellationPollMs: options.cancellationPollMs }
        : {}),
      ...(options.leaseSafetyMs !== undefined
        ? { leaseSafetyMs: options.leaseSafetyMs }
        : {}),
      ...(options.runtimeHooks ? { hooks: options.runtimeHooks } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
    return new Host(
      kernel,
      service,
      runtime,
      runtimePollIntervalMs,
      worktreeExecutor,
    );
  } catch (error) {
    kernel.close();
    throw error;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value: T) {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    },
    reject(error: unknown) {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    },
  };
}

function isIdle(result: RuntimePassResult): boolean {
  return (
    result.attentionsDispatched === 0 &&
    result.outboxEventsProcessed === 0
  );
}

async function interruptibleDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      finish();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    timer.unref();
  });
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
