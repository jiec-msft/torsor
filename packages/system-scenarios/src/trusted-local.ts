import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  CopilotAcpAdapter,
  LocalWorktreeExecutor,
} from "@torsor/agent-runtime";
import {
  type CommandResult,
  type KernelCommand,
  TorsorKernel,
  type KernelBootstrap,
  type PhysicalWorktreeView,
  type PrincipalContext,
  type RunProjection,
  type WorktreeLeaseAuthority,
} from "@torsor/kernel";
import {
  createLocalRuntimeHost,
  type LocalRuntimeHost,
} from "@torsor/server";
import { WebController } from "@torsor/web/controller";

import { trackHandles } from "./resources.js";
import { HttpEventSource, HttpTransport } from "./transport.js";

const projectId = "project-trusted-local";
const channelId = "channel-trusted-local";
const humanPrincipalId = "human-trusted-local";
const runtimePrincipalId = "runtime-trusted-local";
const agentId = "agent-trusted-local";

const bootstrap: KernelBootstrap = {
  principals: [
    { id: humanPrincipalId, kind: "human", displayName: "Synthetic Human" },
    { id: runtimePrincipalId, kind: "runtime", displayName: "Synthetic Runtime" },
    { id: "principal-trusted-local", kind: "agent", displayName: "Synthetic Agent" },
  ],
  projects: [{ id: projectId, name: "Synthetic Trusted Local" }],
  channels: [{ id: channelId, projectId, name: "synthetic" }],
  agents: [{
    id: agentId,
    principalId: "principal-trusted-local",
    projectId,
    name: "Synthetic Agent",
    configRevision: 1,
    config: {},
  }],
};

export type TrustedLocalProviderMode =
  | "success"
  | "safe-hang"
  | "stubborn-hang";

export interface TrustedLocalScenarioOptions {
  readonly providerMode: TrustedLocalProviderMode;
  readonly stopGraceMs?: number;
  readonly forceGraceMs?: number;
  readonly cancellationPollMs?: number;
}

interface OwnedPaths {
  readonly directory: string;
  readonly databasePath: string;
  readonly repositoryPath: string;
  readonly rootPath: string;
  readonly baseRevision: string;
}

interface LeaseAuthorityCapture {
  current?: WorktreeLeaseAuthority;
}

export class TrustedLocalScenario {
  readonly human = { principalId: humanPrincipalId };
  readonly runtimePrincipal = { principalId: runtimePrincipalId };
  readonly projectId = projectId;
  readonly channelId = channelId;
  readonly agentId = agentId;
  readonly web: WebController;
  readonly http: HttpTransport;
  readonly host: LocalRuntimeHost;
  readonly kernel: TorsorKernel;
  readonly executor: LocalWorktreeExecutor;
  readonly paths: OwnedPaths;
  readonly #leaseAuthority: LeaseAuthorityCapture;
  readonly #sources: HttpEventSource[] = [];
  readonly #finished: Promise<{ readonly error?: unknown }>;
  #consumedHostFailure: unknown;
  #hostSettled = false;
  #onlineClosed = false;
  #ownedProcessIds: readonly number[] | undefined;
  #ownedProcessesGone = false;
  #recoveryKernel: TorsorKernel | undefined;
  #recoveryExecutor: LocalWorktreeExecutor | undefined;

  private constructor(
    paths: OwnedPaths,
    host: LocalRuntimeHost,
    kernel: TorsorKernel,
    executor: LocalWorktreeExecutor,
    origin: string,
    leaseAuthority: LeaseAuthorityCapture,
  ) {
    this.paths = paths;
    this.host = host;
    this.kernel = kernel;
    this.executor = executor;
    this.#leaseAuthority = leaseAuthority;
    this.#finished = host.finished.then(
      () => {
        this.#hostSettled = true;
        return {};
      },
      (error: unknown) => {
        this.#hostSettled = true;
        return { error };
      },
    );
    this.http = new HttpTransport(origin);
    const storage = new Map<string, string>();
    this.web = new WebController({
      apiBase: origin,
      fetch: this.http.fetch,
      sessionStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => { storage.set(key, value); },
        removeItem: (key) => { storage.delete(key); },
      },
      eventSourceFactory: (url) => {
        const source = new HttpEventSource(url, this.http);
        this.#sources.push(source);
        return source;
      },
      broadcastChannelFactory: () => Object.assign(new EventTarget(), {
        name: "trusted-local-scenario",
        onmessage: null,
        onmessageerror: null,
        postMessage() {},
        close() {},
      }),
    });
  }

  static async open(options: TrustedLocalScenarioOptions): Promise<TrustedLocalScenario> {
    const paths = createRepository();
    let kernel: TorsorKernel | undefined;
    let executor: LocalWorktreeExecutor | undefined;
    let host: LocalRuntimeHost | undefined;
    let scenario: TrustedLocalScenario | undefined;
    const leaseAuthority: LeaseAuthorityCapture = {};
    const token = `synthetic-trusted-local-${randomUUID()}`;
    try {
      const fixture = fileURLToPath(new URL(
        "../test/fixtures/trusted-local-provider.mjs",
        import.meta.url,
      ));
      host = createLocalRuntimeHost({
        databasePath: paths.databasePath,
        bootstrap,
        port: 0,
        credentials: [{
          token,
          principalContext: { principalId: humanPrincipalId },
        }],
        runtimePrincipalId,
        projectIds: [projectId],
        runtimePollIntervalMs: 1,
        providerTimeoutMs: 120_000,
        activationDurationMs: 125_000,
        attentionLeaseMs: 125_000,
        outboxLeaseMs: 125_000,
        cancellationPollMs: options.cancellationPollMs ?? 5,
        adapter: new CopilotAcpAdapter({
          policy: { kind: "trusted-local", permissionMode: "allow-all" },
          command: process.execPath,
          commandArgs: [fixture, options.providerMode],
          unsafeAllowCustomCommandArgs: true,
          userEnvironment: {},
        }),
        worktreeExecutorFactory: (ownedKernel) => {
          kernel = ownedKernel;
          const executorKernel = observeLeaseAuthority(
            ownedKernel,
            leaseAuthority,
          );
          executor = new LocalWorktreeExecutor({
            kernel: executorKernel,
            runtimePrincipalId,
            repositoryPath: paths.repositoryPath,
            rootPath: paths.rootPath,
            baseRevision: paths.baseRevision,
            leaseDurationMs: 125_000,
            ...(options.stopGraceMs !== undefined
              ? { stopGraceMs: options.stopGraceMs }
              : {}),
            ...(options.forceGraceMs !== undefined
              ? { forceGraceMs: options.forceGraceMs }
              : {}),
          });
          return executor;
        },
      });
      const origin = await host.start();
      if (!kernel || !executor) {
        throw new Error("Trusted-local Host did not create its production Worktree executor.");
      }
      scenario = new TrustedLocalScenario(
        paths,
        host,
        kernel,
        executor,
        origin,
        leaseAuthority,
      );
      await scenario.web.exchangeSession(token, projectId);
      if (scenario.web.getSnapshot().session !== "ready") {
        throw new Error("Trusted-local Web session did not open.");
      }
      return scenario;
    } catch (error) {
      if (scenario) await scenario.close();
      else {
        await Promise.allSettled([host?.close(), executor?.close()]);
        kernel?.close();
        await rm(paths.directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  get events() {
    return this.#sources.flatMap((source) => source.received);
  }

  async startThread(): Promise<void> {
    await this.web.startThread({
      channelId,
      body: "Perform the disposable synthetic trusted-local task.",
      targetAgentIds: [agentId],
    });
  }

  async waitForTree(
    predicate: (tree: PhysicalWorktreeView) => boolean,
    description: string,
  ): Promise<PhysicalWorktreeView> {
    return waitFor(async () => {
      const page = await this.kernel.query(
        { type: "ListPhysicalWorktrees", limit: 2 },
        this.runtimePrincipal,
      );
      if (page.hasMore || page.items.length > 1) {
        throw new Error("Trusted-local scenario created ambiguous physical Worktrees.");
      }
      return page.items[0];
    }, (tree): tree is PhysicalWorktreeView => tree !== undefined && predicate(tree), description);
  }

  async waitForRun(
    runId: string,
    predicate: (run: RunProjection) => boolean,
    description: string,
  ): Promise<RunProjection> {
    return waitFor(
      () => this.kernel.query({ type: "GetRunProjection", runId }, this.human),
      predicate,
      description,
    );
  }

  async sync(): Promise<string | null> {
    const bootstrapProjection = await this.kernel.query(
      { type: "GetBootstrap", projectId },
      this.human,
    );
    const source = this.#sources.at(-1);
    if (!source) throw new Error("Trusted-local Web event subscription was not created.");
    await source.sync(bootstrapProjection.latestEventId);
    await this.http.settle();
    const snapshot = this.web.getSnapshot();
    if (snapshot.queryError) throw new Error(snapshot.queryError);
    return bootstrapProjection.latestEventId;
  }

  async readOwnedProcessIds(tree: PhysicalWorktreeView): Promise<readonly number[]> {
    const path = join(tree.directoryPath, "owned-processes.json");
    await waitFor(
      () => Promise.resolve(existsSync(path)),
      (recorded) => recorded,
      "synthetic Provider process identities",
    );
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value) || value.length !== 2 ||
        value.some((pid) => !Number.isSafeInteger(pid) || pid < 1)) {
      throw new Error("Synthetic Provider recorded invalid process identities.");
    }
    this.#ownedProcessIds = value as number[];
    return this.#ownedProcessIds;
  }

  async waitForProcessesGone(pids: readonly number[]): Promise<void> {
    await waitFor(
      () => Promise.resolve(pids.every((pid) => !processExists(pid))),
      (gone) => gone,
      "owned Provider process tree to stop",
    );
    if (
      this.#ownedProcessIds &&
      this.#ownedProcessIds.length === pids.length &&
      this.#ownedProcessIds.every((pid) => pids.includes(pid))
    ) {
      this.#ownedProcessesGone = true;
    }
  }

  async quarantineActiveWriter(worktreeId: string): Promise<CommandResult> {
    const authority = this.#leaseAuthority.current;
    if (!authority || authority.worktreeId !== worktreeId) {
      throw new Error("Trusted-local Writer Lease authority was not observed.");
    }
    return this.kernel.execute({
      type: "QuarantineWorktreeWriterLease",
      idempotencyKey: "independent-system-scenario-fence",
      ...authority,
      expectedGeneration: authority.generation,
      expectedFencingToken: authority.fencingToken,
      reason: "Synthetic independent fencing incident.",
      evidence: { source: "system-scenario" },
    }, this.runtimePrincipal);
  }

  async expectHostFailure(
    assertion: (error: unknown) => void | Promise<void>,
  ): Promise<unknown> {
    const result = await this.#finished;
    if (result.error === undefined) {
      throw new Error("Expected the trusted-local Host to fail.");
    }
    this.#consumedHostFailure = result.error;
    await assertion(result.error);
    return result.error;
  }

  async recoverWithFreshExecutor(): Promise<{
    readonly kernel: TorsorKernel;
    readonly executor: LocalWorktreeExecutor;
  }> {
    await this.#closeOnline();
    if (this.#recoveryKernel || this.#recoveryExecutor) {
      throw new Error("Trusted-local recovery was already opened.");
    }
    const kernel = TorsorKernel.open({ databasePath: this.paths.databasePath });
    const executor = new LocalWorktreeExecutor({
      kernel,
      runtimePrincipalId,
      repositoryPath: this.paths.repositoryPath,
      rootPath: this.paths.rootPath,
      baseRevision: this.paths.baseRevision,
      leaseDurationMs: 125_000,
    });
    this.#recoveryKernel = kernel;
    this.#recoveryExecutor = executor;
    await executor.recover();
    return { kernel, executor };
  }

  async close(allowCleanupCancellation = false): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.#recoveryExecutor?.close();
    } catch (error) {
      errors.push(error);
    } finally {
      this.#recoveryKernel?.close();
      this.#recoveryExecutor = undefined;
      this.#recoveryKernel = undefined;
    }
    try {
      await this.#closeOnline(allowCleanupCancellation);
    } catch (error) {
      errors.push(error);
    }
    if (this.#ownedProcessIds && !this.#ownedProcessesGone) {
      try {
        await this.waitForProcessesGone(this.#ownedProcessIds);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.#removeOwnedState();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Trusted-local scenario cleanup failed.");
  }

  async #closeOnline(allowCleanupCancellation = false): Promise<void> {
    if (this.#onlineClosed) return;
    this.#onlineClosed = true;
    const cleanupMayCancelProvider = allowCleanupCancellation &&
      !this.#hostSettled;
    const errors: unknown[] = [];
    this.web.dispose();
    for (const source of this.#sources) source.close();
    for (const cleanup of [
      () => Promise.all(this.#sources.map((source) => source.finished())),
      () => this.http.settle(),
      () => this.host.close(),
      () => this.http.assertConsumed(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        if (
          error !== this.#consumedHostFailure &&
          !(cleanupMayCancelProvider && isProviderCancelled(error))
        ) {
          errors.push(error);
        }
      }
    }
    await setImmediate();
    if (errors.length) throw new AggregateError(errors, "Trusted-local Host cleanup failed.");
  }

  async #removeOwnedState(): Promise<void> {
    let kernel: TorsorKernel | undefined;
    try {
      kernel = TorsorKernel.open({ databasePath: this.paths.databasePath });
      const page = await kernel.query(
        { type: "ListPhysicalWorktrees", limit: 100 },
        this.runtimePrincipal,
      );
      const hasUnsafeWriter = page.hasMore || page.items.some((tree) => {
        const state = tree.latestExecution?.state;
        return state !== undefined &&
          state !== "StopConfirmed" &&
          state !== "ForceTerminated" &&
          !this.#ownedProcessesGone;
      });
      if (hasUnsafeWriter) {
        throw new Error(
          `Preserved trusted-local scenario state at ${this.paths.directory} because physical Writer stop is unconfirmed.`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Preserved trusted-local scenario state at ")
      ) {
        throw error;
      }
      throw new Error(
        `Preserved trusted-local scenario state at ${this.paths.directory} because cleanup safety could not be verified.`,
        { cause: error },
      );
    } finally {
      kernel?.close();
    }
    await rm(this.paths.directory, { recursive: true, force: true });
  }
}

export async function runTrustedLocalScenario(
  options: TrustedLocalScenarioOptions,
  scenario: (system: TrustedLocalScenario) => Promise<void>,
): Promise<void> {
  const assertHandlesClosed = trackHandles();
  const errors: unknown[] = [];
  let system: TrustedLocalScenario | undefined;
  try {
    system = await TrustedLocalScenario.open(options);
    await scenario(system);
  } catch (error) {
    errors.push(error);
  }
  try {
    await system?.close(errors.length > 0);
  } catch (error) {
    errors.push(error);
  }
  try { await assertHandlesClosed(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) {
    throw new AggregateError(errors, "Trusted-local scenario and cleanup failed.");
  }
}

function createRepository(): OwnedPaths {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "torsor-trusted-local-")),
  );
  const repositoryPath = join(directory, "repository");
  const rootPath = join(directory, "managed");
  const hooksPath = join(directory, "empty-hooks");
  const configPath = join(directory, "empty-gitconfig");
  for (const path of [repositoryPath, rootPath, hooksPath]) mkdirSync(path);
  writeFileSync(configPath, "");
  const environment = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (...args: string[]) => execFileSync(
    "git",
    ["--no-pager", "-c", `core.hooksPath=${hooksPath}`, ...args],
    {
      cwd: repositoryPath,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  git("init", "--quiet", "--template=");
  writeFileSync(
    join(repositoryPath, "synthetic.test.cjs"),
    "require('node:assert/strict').equal(require('node:fs').readFileSync('native-result.txt','utf8'),'Synthetic native edit.\\n');\n",
  );
  git("add", "--", "synthetic.test.cjs");
  git(
    "-c", "user.name=Synthetic",
    "-c", "user.email=synthetic@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "Synthetic trusted-local base",
  );
  return {
    directory,
    databasePath: join(directory, "state.sqlite"),
    repositoryPath,
    rootPath,
    baseRevision: git("rev-parse", "HEAD"),
  };
}

async function waitFor<T, U extends T>(
  read: () => Promise<T>,
  predicate: (value: T) => value is U,
  description: string,
): Promise<U>;
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
): Promise<T>;
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  let latest: T;
  while (true) {
    latest = await read();
    if (predicate(latest)) return latest;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await delay(10);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function observeLeaseAuthority(
  kernel: TorsorKernel,
  capture: LeaseAuthorityCapture,
): TorsorKernel {
  const execute = async <C extends KernelCommand>(
    command: C,
    context: PrincipalContext,
  ): Promise<CommandResult> => {
    const result = await kernel.execute(command, context);
    if (
      command.type === "AcquireWorktreeWriterLease" &&
      result.leaseGeneration !== undefined &&
      result.fencingToken !== undefined &&
      result.leaseToken !== undefined
    ) {
      capture.current = {
        worktreeId: command.worktreeId,
        generation: result.leaseGeneration,
        fencingToken: result.fencingToken,
        leaseToken: result.leaseToken,
      };
    }
    return result;
  };
  return new Proxy(kernel, {
    get(target, property) {
      if (property === "execute") return execute;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function isProviderCancelled(error: unknown): boolean {
  return error instanceof Error &&
    "diagnosticCode" in error &&
    error.diagnosticCode === "provider_cancelled";
}
