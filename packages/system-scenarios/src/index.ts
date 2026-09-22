import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime, DeterministicFakeAdapter, type DeterministicFakeHandler,
} from "@torsor/agent-runtime";
import { LocalArtifactStorage, TorsorKernel, type KernelBootstrap } from "@torsor/kernel";
import { createTorsorHttpService, type TorsorHttpService } from "@torsor/server";
import { WebController } from "@torsor/web/controller";
import { deferred, HttpEventSource, HttpTransport } from "./transport.js";
import { trackHandles } from "./resources.js";

const projectId = "project-scenario";
const channelId = "channel-scenario";
const bootstrap: KernelBootstrap = {
  principals: [
    { id: "human-scenario", kind: "human", displayName: "Synthetic Human" },
    { id: "runtime-scenario", kind: "runtime", displayName: "Synthetic Runtime" },
    ...["orbit", "keel"].map((name) => ({
      id: `principal-${name}`, kind: "agent" as const, displayName: name,
    })),
  ],
  projects: [{ id: projectId, name: "Synthetic Project" }],
  channels: [{ id: channelId, projectId, name: "synthetic" }],
  agents: ["orbit", "keel"].map((name) => ({
    id: `agent-${name}`, principalId: `principal-${name}`, projectId,
    name, configRevision: 1, config: {},
  })),
};

class ScenarioGate {
  readonly #entered = deferred<void>();
  readonly #released = deferred<void>();
  readonly entered = this.#entered.promise;
  async wait(): Promise<void> {
    this.#entered.resolve();
    await this.#released.promise;
  }
  release(): void { this.#released.resolve(); }
}

class ScenarioClock {
  #milliseconds = Date.parse("2026-01-01T00:00:00.000Z");
  readonly now = (): Date => new Date(this.#milliseconds);
  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("Logical clock advances must be nonnegative safe integer milliseconds.");
    }
    this.#milliseconds += milliseconds;
  }
}

class SystemScenario {
  readonly human = { principalId: "human-scenario" };
  readonly runtimePrincipal = { principalId: "runtime-scenario" };
  readonly projectId = projectId;
  readonly channelId = channelId;
  readonly kernel: TorsorKernel;
  readonly web: WebController;
  readonly http: HttpTransport;
  readonly #service: TorsorHttpService;
  readonly #runtime: AgentRuntime;
  readonly #sources: HttpEventSource[] = [];
  readonly #gates: ScenarioGate[] = [];
  readonly #failures: unknown[] = [];
  readonly #work = new Set<Promise<unknown>>();
  #stopped = false;
  #successor: SystemScenario | null = null;
  #handler: DeterministicFakeHandler = async () => {
    throw new Error("A scenario must explicitly script its Provider.");
  };

  private constructor(
    private readonly directory: string,
    kernel: TorsorKernel,
    service: TorsorHttpService,
    origin: string,
    readonly clock: ScenarioClock,
  ) {
    this.kernel = kernel;
    this.#service = service;
    this.#runtime = new AgentRuntime({
      kernel, runtimePrincipalId: this.runtimePrincipal.principalId,
      projectIds: [projectId], clock: clock.now,
      adapter: new DeterministicFakeAdapter(async (context) => {
        try { await this.#handler(context); }
        catch (error) { this.#failures.push(error); throw error; }
      }),
    });
    this.http = new HttpTransport(origin);
    const storage = new Map<string, string>();
    this.web = new WebController({
      apiBase: origin, fetch: this.http.fetch,
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
        name: "scenario", onmessage: null, onmessageerror: null,
        postMessage() {}, close() {},
      }),
    });
  }

  static async open(): Promise<SystemScenario> {
    const directory = await mkdtemp(join(tmpdir(), "torsor-scenario-"));
    return SystemScenario.#openDirectory(directory, new ScenarioClock());
  }

  static async #openDirectory(directory: string, clock: ScenarioClock): Promise<SystemScenario> {
    const token = randomUUID();
    let kernel: TorsorKernel | undefined;
    let service: TorsorHttpService | undefined;
    let system: SystemScenario | undefined;
    try {
      const artifactStorage = await LocalArtifactStorage.open(join(directory, "artifacts"));
      kernel = TorsorKernel.open({
        databasePath: join(directory, "state.sqlite"), bootstrap, clock: clock.now, artifactStorage,
      });
      service = createTorsorHttpService({
        kernel, port: 0,
        credentials: [{ token, principalContext: { principalId: "human-scenario" } }],
      });
      const origin = await service.listen();
      system = new SystemScenario(directory, kernel, service, origin, clock);
      await system.web.exchangeSession(token, projectId);
      if (system.web.getSnapshot().session !== "ready") throw new Error("Scenario session did not open.");
      return system;
    } catch (error) {
      if (system) await system.close();
      else {
        try { await service?.close(); } finally {
          kernel?.close();
          await rm(directory, { recursive: true, force: true });
        }
      }
      throw error;
    }
  }

  provider(handler: DeterministicFakeHandler): void { this.#handler = handler; }

  gate(): ScenarioGate {
    const gate = new ScenarioGate();
    this.#gates.push(gate);
    return gate;
  }

  get events() { return this.#sources.flatMap((source) => source.received); }

  async runs() {
    const page = await this.kernel.query({ type: "ListRunProjections", projectId, limit: 100 }, this.human);
    if (page.hasMore) throw new Error("Scenario Run catalog exceeded its 100-Run bound.");
    return page.items;
  }

  async startThread(targetAgentIds: readonly string[] = ["agent-orbit"]): Promise<string> {
    await this.web.startThread({ channelId, body: "Perform synthetic work.", targetAgentIds });
    await this.web.loadThreads(channelId);
    const thread = this.web.getSnapshot().threads.at(-1);
    if (!thread) throw new Error("Human command did not produce a Thread.");
    return thread.threadRootId;
  }

  drain(): Promise<void> {
    const work = this.#runtime.drainUntilIdle(2_000).then(() => this.#assertProvider());
    this.#work.add(work);
    void work.then(
      () => this.#work.delete(work),
      (error) => { this.#work.delete(work); this.#failures.push(error); },
    );
    return work;
  }

  async cancel(runId: string): Promise<void> {
    const { run } = await this.kernel.query({ type: "GetRunProjection", runId }, this.human);
    await this.kernel.execute({
      type: "CancelRun", idempotencyKey: randomUUID(),
      runId, expectedRunRevision: run.revision, reason: "Synthetic Human cancellation.",
    }, this.human);
  }

  async crashDuringReport(): Promise<void> {
    if (this.#work.size) throw new Error("A crash fixture cannot race an in-process Runtime pass.");
    const child = spawn(process.execPath, [
      "--no-warnings", fileURLToPath(new URL("../dist/crash-provider.js", import.meta.url)),
      this.directory, this.clock.now().toISOString(),
    ], {
      cwd: this.directory, shell: false, stdio: "ignore",
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
      timeout: 10_000,
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 77 && signal === null) resolve();
        else reject(new Error("Synthetic child did not stop at the declared crash boundary."));
      });
    });
    this.#work.add(closed);
    try { await closed; } finally { this.#work.delete(closed); }
  }

  async sync(delivery?: "reverse-duplicate"): Promise<void> {
    const projection = await this.kernel.query({ type: "GetBootstrap", projectId }, this.human);
    const source = this.#sources.at(-1);
    if (!source) throw new Error("No Web event subscription.");
    await source.sync(projection.latestEventId, delivery);
    const state = this.web.getSnapshot();
    if (state.queryError) throw new Error(state.queryError);
  }

  async disconnect(): Promise<void> {
    const source = this.#sources.at(-1);
    if (!source) throw new Error("No Web event subscription.");
    await source.disconnect();
  }

  async replayEvents(order: "reverse-duplicate"): Promise<void> {
    const source = this.#sources.at(-1);
    if (!source) throw new Error("No Web event subscription.");
    await source.replay(order);
  }

  #assertProvider(): void {
    if (this.#failures.length) throw new AggregateError(this.#failures.splice(0), "Scenario Provider failed.");
  }

  async reopen(): Promise<SystemScenario> {
    if (this.#successor) throw new Error("This scenario instance was already replaced.");
    if (this.#work.size) throw new Error("Settle Runtime work before reopening.");
    await this.#stop();
    this.#successor = await SystemScenario.#openDirectory(this.directory, this.clock);
    return this.#successor;
  }

  async #stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const errors: unknown[] = [];
    for (const gate of this.#gates) gate.release();
    const work = await Promise.allSettled(this.#work);
    for (const result of work) if (result.status === "rejected") errors.push(result.reason);
    this.web.dispose();
    for (const source of this.#sources) source.close();
    for (const cleanup of [
      () => Promise.all(this.#sources.map((source) => source.finished())),
      () => this.http.settle(),
      () => this.http.assertConsumed(),
      () => this.#service.close(),
      () => this.kernel.close(),
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    await setImmediate();
    if (this.#service.activeEventStreamCount !== 0) errors.push(new Error("SSE stream leaked."));
    errors.push(...this.#failures.splice(0));
    if (errors.length) throw new AggregateError(errors, "Scenario cleanup failed.");
  }

  async close(): Promise<void> {
    try {
      await this.#stop();
      await this.#successor?.close();
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}

export async function runSystemScenario(
  scenario: (system: SystemScenario) => Promise<void>,
): Promise<void> {
  const assertHandlesClosed = trackHandles();
  const errors: unknown[] = [];
  let system: SystemScenario | undefined;
  try {
    system = await SystemScenario.open();
    await scenario(system);
  } catch (error) { errors.push(error); }
  try { await system?.close(); } catch (error) { errors.push(error); }
  try { await assertHandlesClosed(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Scenario and cleanup failed.");
}

export type { SystemScenario, ScenarioClock, ScenarioGate };
