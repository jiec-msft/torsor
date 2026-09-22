import {
  AgentRuntime,
  type ProviderAdapter,
  type RuntimePassResult,
} from "@torsor/agent-runtime";
import {
  TorsorKernel,
  type KernelBootstrap,
  type KernelOpenOptions,
} from "@torsor/kernel";

import {
  createTorsorHttpService,
  type LocalCredential,
  type TorsorHttpService,
} from "./server.js";

export interface LocalRuntimeHostOptions {
  readonly databasePath: string;
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
  readonly clock?: () => Date;
  readonly idFactory?: (prefix: string) => string;
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
  readonly #started = deferred<string>();
  readonly #stopped = deferred<void>();
  readonly #finished = deferred<void>();
  #state: "created" | "starting" | "running" | "closing" | "closed" =
    "created";
  #lifecyclePromise: Promise<void> | null = null;
  #closeBeforeStartPromise: Promise<void> | null = null;
  #serviceClosePromise: Promise<void> | null = null;

  constructor(
    kernel: TorsorKernel,
    service: TorsorHttpService,
    runtime: AgentRuntime,
    runtimePollIntervalMs: number,
  ) {
    this.#kernel = kernel;
    this.#service = service;
    this.#runtime = runtime;
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
    if (this.#state === "created") {
      if (!this.#closeBeforeStartPromise) {
        this.#state = "closing";
        this.#closeBeforeStartPromise = this.#closeBeforeStart();
      }
      return this.#closeBeforeStartPromise;
    }
    if (this.#state !== "closed") {
      this.#state = "closing";
      this.#stopped.resolve();
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
      const origin = await this.#service.listen();
      this.#state = "running";
      this.#started.resolve(origin);
      await this.#runRuntimeLoop();
    } catch (error) {
      failure = { error };
      this.#started.reject(error);
    } finally {
      this.#state = "closing";
      this.#stopped.resolve();
      try {
        await this.#beginServiceClose();
      } catch (error) {
        failure ??= { error };
      }
      try {
        this.#kernel.close();
      } catch (error) {
        failure ??= { error };
      }
      this.#state = "closed";
    }
    if (failure) {
      this.#finished.reject(failure.error);
      throw failure.error;
    }
    this.#finished.resolve();
  }

  async #runRuntimeLoop(): Promise<void> {
    while (!this.#stopped.settled) {
      const result = await this.#runtime.runOnce();
      if (isIdle(result)) {
        await Promise.race([
          delay(this.#runtimePollIntervalMs),
          this.#stopped.promise,
        ]);
      }
    }
  }

  async #closeBeforeStart(): Promise<void> {
    let failure: { readonly error: unknown } | null = null;
    this.#stopped.resolve();
    try {
      await this.#beginServiceClose();
    } catch (error) {
      failure = { error };
    }
    try {
      this.#kernel.close();
    } catch (error) {
      failure ??= { error };
    }
    this.#state = "closed";
    if (failure) {
      this.#finished.reject(failure.error);
      throw failure.error;
    }
    this.#finished.resolve();
  }

  #beginServiceClose(): Promise<void> {
    if (!this.#serviceClosePromise) {
      this.#serviceClosePromise = this.#service.close();
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
    ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    ...(options.activationDurationMs
      ? { activationDurationMs: options.activationDurationMs }
      : {}),
  };
  const kernel = TorsorKernel.open(kernelOptions);
  try {
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
      ...(options.clock ? { clock: options.clock } : {}),
    });
    return new Host(
      kernel,
      service,
      runtime,
      runtimePollIntervalMs,
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
