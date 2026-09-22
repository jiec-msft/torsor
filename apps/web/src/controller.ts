import { ApiError, readApiResponse } from "./api";
import type {
  AgentStatus,
  Attention,
  AttentionPage,
  Bootstrap,
  PublicEvent,
  RunProjection,
  ThreadProjection,
} from "./types";

type Fetch = typeof fetch;
type EventSourceFactory = (url: string) => EventSource;
type BroadcastChannelFactory = (name: string) => BroadcastChannel;

export type SessionState =
  | "signed-out"
  | "exchanging"
  | "loading"
  | "ready"
  | "expired";
export type ConnectionState = "offline" | "connecting" | "live" | "reconnecting";

export interface WebState {
  readonly session: SessionState;
  readonly connection: ConnectionState;
  readonly authError: string | null;
  readonly bootstrap: Bootstrap | null;
  readonly threads: readonly ThreadProjection[];
  readonly threadsChannelId: string | null;
  readonly thread: ThreadProjection | null;
  readonly runs: readonly RunProjection[];
  readonly run: RunProjection | null;
  readonly agents: readonly AgentStatus[];
  readonly attentions: readonly Attention[];
  readonly loadingThreads: boolean;
  readonly loadingThread: boolean;
  readonly loadingRun: boolean;
  readonly commandPending: boolean;
  readonly queryError: string | null;
  readonly lastEventId: string | null;
}

export interface WebControllerOptions {
  readonly apiBase?: string;
  readonly fetch?: Fetch;
  readonly eventSourceFactory?: EventSourceFactory;
  readonly broadcastChannelFactory?: BroadcastChannelFactory;
  readonly sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly reconnectProbeDelayMs?: number;
  readonly agentLivenessRefreshMs?: number;
}

interface ProjectionPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly snapshotEventId: string | null;
}

type WindowMessage =
  | { readonly kind: "event"; readonly event: PublicEvent }
  | {
      readonly kind: "session";
      readonly csrfToken: string;
      readonly principalId: string;
    }
  | { readonly kind: "session-cleared"; readonly session: "signed-out" | "expired" };

const csrfStorageKey = "torsor.session.csrf";
const principalStorageKey = "torsor.session.principal";

interface PendingInvalidation {
  readonly event: PublicEvent;
  retryCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingReply {
  readonly request: {
    readonly idempotencyKey: string;
    readonly threadRootId: string;
    readonly expectedThreadCursor: number;
    readonly body: string;
    readonly targetAgentIds?: readonly string[];
  };
}

interface DeferredBoolean {
  readonly promise: Promise<boolean>;
  readonly resolve: (value: boolean) => void;
}

interface CoalescedRefresh {
  inFlight: Promise<boolean> | null;
  followUp: DeferredBoolean | null;
  refresh: () => Promise<boolean>;
}

export class WebController {
  readonly #apiBase: string;
  readonly #fetch: Fetch;
  readonly #eventSourceFactory: EventSourceFactory;
  readonly #broadcastChannel: BroadcastChannel | null;
  readonly #storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly #reconnectProbeDelayMs: number;
  readonly #agentLivenessRefreshMs: number;
  readonly #listeners = new Set<() => void>();
  #state: WebState = {
    session: "signed-out",
    connection: "offline",
    authError: null,
    bootstrap: null,
    threads: [],
    threadsChannelId: null,
    thread: null,
    runs: [],
    run: null,
    agents: [],
    attentions: [],
    loadingThreads: false,
    loadingThread: false,
    loadingRun: false,
    commandPending: false,
    queryError: null,
    lastEventId: null,
  };
  #csrfToken: string | null = null;
  #principalId: string | null = null;
  #csrfRevision = 0;
  #csrfWaiters = new Set<() => void>();
  #projectId: string | null = null;
  #channelId: string | null = null;
  #threadId: string | null = null;
  #runId: string | null = null;
  #events: EventSource | null = null;
  #probeTimer: ReturnType<typeof setTimeout> | null = null;
  #livenessTimer: ReturnType<typeof setTimeout> | null = null;
  #seenEventIds: string[] = [];
  #processingEventIds = new Set<string>();
  #pendingInvalidations = new Map<string, PendingInvalidation>();
  #coalescedRefreshes = new Map<string, CoalescedRefresh>();
  #latestProjectionRequests = new Map<string, Promise<boolean>>();
  #projectionErrors = new Map<string, string>();
  #pendingStartThread: {
    readonly fingerprint: string;
    readonly idempotencyKey: string;
  } | null = null;
  #pendingReplies = new Map<string, PendingReply>();
  #sessionGeneration = 0;
  #threadsRequestGeneration = 0;
  #threadRequestGeneration = 0;
  #runRequestGeneration = 0;
  #runsRefreshGeneration = 0;
  #attentionRefreshGeneration = 0;
  #bootstrapRefreshGeneration = 0;
  #disposed = false;

  constructor(options: WebControllerOptions = {}) {
    this.#apiBase = options.apiBase ?? "";
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#eventSourceFactory =
      options.eventSourceFactory ?? ((url) => new EventSource(url));
    this.#storage = options.sessionStorage ?? sessionStorage;
    this.#reconnectProbeDelayMs = options.reconnectProbeDelayMs ?? 1_500;
    this.#agentLivenessRefreshMs = options.agentLivenessRefreshMs ?? 30_000;
    if (
      !Number.isInteger(this.#agentLivenessRefreshMs) ||
      this.#agentLivenessRefreshMs <= 0
    ) {
      throw new Error("agentLivenessRefreshMs must be a positive integer.");
    }
    const createBroadcastChannel =
      options.broadcastChannelFactory ??
      (typeof BroadcastChannel === "undefined"
        ? null
        : (name: string) => new BroadcastChannel(name));
    this.#broadcastChannel = createBroadcastChannel
      ? createBroadcastChannel("torsor.server-facts")
      : null;
    if (this.#broadcastChannel) {
      this.#broadcastChannel.onmessage = (
        message: MessageEvent<WindowMessage>,
      ) => {
        if (message.data?.kind === "event") {
          if (this.#state.session === "ready") {
            void this.#applyEvent(message.data.event, false);
          }
        } else if (message.data?.kind === "session") {
          if (
            this.#principalId &&
            this.#principalId !== message.data.principalId
          ) {
            this.#clearSession("expired", false);
            return;
          }
          this.#setCsrfToken(
            message.data.csrfToken,
            message.data.principalId,
          );
        } else if (message.data?.kind === "session-cleared") {
          this.#clearSession(message.data.session, false);
        }
      };
    }
  }

  getSnapshot = (): WebState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async resume(projectId: string): Promise<void> {
    const csrfToken = this.#storage.getItem(csrfStorageKey);
    const principalId = this.#storage.getItem(principalStorageKey);
    if (!csrfToken || !principalId) {
      this.#storage.removeItem(csrfStorageKey);
      this.#storage.removeItem(principalStorageKey);
      return;
    }
    this.#setCsrfToken(csrfToken, principalId);
    await this.#bootstrap(projectId);
  }

  async exchangeSession(token: string, projectId: string): Promise<void> {
    this.#setState({ session: "exchanging", authError: null });
    try {
      const response = await this.#fetch(`${this.#apiBase}/api/v1/session`, {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await readApiResponse<{
        readonly authenticated: true;
        readonly principalId: string;
        readonly csrfToken: string;
      }>(response);
      this.#setCsrfToken(body.csrfToken, body.principalId);
      this.#broadcastChannel?.postMessage({
        kind: "session",
        csrfToken: body.csrfToken,
        principalId: body.principalId,
      } satisfies WindowMessage);
      await this.#bootstrap(projectId);
    } catch (error) {
      this.#clearSession("signed-out", false);
      this.#setState({
        authError:
          error instanceof ApiError
            ? error.message
            : "The browser session could not be created.",
      });
      throw error;
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.#fetch(`${this.#apiBase}/api/v1/session`, {
        method: "DELETE",
        credentials: "include",
      });
    } finally {
      this.#clearSession("signed-out");
    }
  }

  async loadThreads(channelId: string): Promise<boolean> {
    if (!this.#projectId) {
      return true;
    }
    const projectId = this.#projectId;
    const sessionGeneration = this.#sessionGeneration;
    const requestGeneration = ++this.#threadsRequestGeneration;
    const projectionKey = `threads:${channelId}`;
    this.#channelId = channelId;
    this.#setState({
      threads: [],
      threadsChannelId: null,
      loadingThreads: true,
    });
    let request!: Promise<boolean>;
    request = (async () => {
      try {
        const items = await this.#readAllProjectionPages<ThreadProjection>(
          `/api/v1/channels/${encodeURIComponent(channelId)}/threads?projectId=${encodeURIComponent(projectId)}`,
          sessionGeneration,
        );
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#threadsRequestGeneration === requestGeneration &&
          this.#channelId === channelId
        ) {
          this.#projectionSucceeded(projectionKey, {
            threads: items,
            threadsChannelId: channelId,
            loadingThreads: false,
          });
          return true;
        }
        return this.#replacementResult(projectionKey, request);
      } catch (error) {
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#threadsRequestGeneration === requestGeneration
        ) {
          this.#projectionFailed(projectionKey, error, {
            loadingThreads: false,
          });
          return false;
        }
        return this.#replacementResult(projectionKey, request);
      }
    })();
    this.#latestProjectionRequests.set(projectionKey, request);
    return request;
  }

  async loadThread(threadId: string): Promise<boolean> {
    const sessionGeneration = this.#sessionGeneration;
    const requestGeneration = ++this.#threadRequestGeneration;
    const projectionKey = `thread:${threadId}`;
    const changedThread = this.#threadId !== threadId;
    this.#threadId = threadId;
    this.#setState({
      ...(changedThread ? { thread: null } : {}),
      loadingThread: true,
    });
    let request!: Promise<boolean>;
    request = (async () => {
      try {
        const body = await this.#request<{ readonly thread: ThreadProjection }>(
          `/api/v1/threads/${encodeURIComponent(threadId)}`,
          {},
          sessionGeneration,
        );
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#threadRequestGeneration === requestGeneration &&
          this.#threadId === threadId
        ) {
          this.#projectionSucceeded(projectionKey, {
            thread: body.thread,
            loadingThread: false,
          });
          return true;
        }
        return this.#replacementResult(projectionKey, request);
      } catch (error) {
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#threadRequestGeneration === requestGeneration
        ) {
          this.#projectionFailed(projectionKey, error, {
            loadingThread: false,
          });
          return false;
        }
        return this.#replacementResult(projectionKey, request);
      }
    })();
    this.#latestProjectionRequests.set(projectionKey, request);
    return request;
  }

  clearThread(): void {
    this.#threadRequestGeneration += 1;
    this.#runRequestGeneration += 1;
    this.#threadId = null;
    this.#runId = null;
    this.#clearProjectionErrors(["thread:", "run:"]);
    this.#setState({
      thread: null,
      run: null,
      loadingThread: false,
      loadingRun: false,
      queryError: this.#currentProjectionError(),
    });
  }

  async loadRun(runId: string): Promise<boolean> {
    const sessionGeneration = this.#sessionGeneration;
    const requestGeneration = ++this.#runRequestGeneration;
    const projectionKey = `run:${runId}`;
    const changedRun = this.#runId !== runId;
    this.#runId = runId;
    this.#setState({
      ...(changedRun ? { run: null } : {}),
      loadingRun: true,
    });
    let request!: Promise<boolean>;
    request = (async () => {
      try {
        const body = await this.#request<{ readonly run: RunProjection }>(
          `/api/v1/runs/${encodeURIComponent(runId)}`,
          {},
          sessionGeneration,
        );
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#runRequestGeneration === requestGeneration &&
          this.#runId === runId
        ) {
          this.#projectionSucceeded(projectionKey, {
            run: body.run,
            loadingRun: false,
          });
          return true;
        }
        return this.#replacementResult(projectionKey, request);
      } catch (error) {
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#runRequestGeneration === requestGeneration
        ) {
          this.#projectionFailed(projectionKey, error, {
            loadingRun: false,
          });
          return false;
        }
        return this.#replacementResult(projectionKey, request);
      }
    })();
    this.#latestProjectionRequests.set(projectionKey, request);
    return request;
  }

  clearRun(): void {
    this.#runRequestGeneration += 1;
    this.#runId = null;
    this.#clearProjectionErrors(["run:"]);
    this.#setState({
      run: null,
      loadingRun: false,
      queryError: this.#currentProjectionError(),
    });
  }

  async startThread(input: {
    readonly channelId: string;
    readonly body: string;
    readonly targetAgentIds?: readonly string[];
  }): Promise<void> {
    if (!this.#projectId) {
      throw new Error("A project must be loaded before starting a thread.");
    }
    const fingerprint = JSON.stringify({
      projectId: this.#projectId,
      channelId: input.channelId,
      body: input.body,
      targetAgentIds: input.targetAgentIds ?? [],
    });
    const pending =
      this.#pendingStartThread?.fingerprint === fingerprint
        ? this.#pendingStartThread
        : {
            fingerprint,
            idempotencyKey: crypto.randomUUID(),
          };
    this.#pendingStartThread = pending;
    const selectedChannelId = this.#channelId;
    try {
      await this.#command("start-thread", {
        idempotencyKey: pending.idempotencyKey,
        projectId: this.#projectId,
        channelId: input.channelId,
        body: input.body,
        ...(input.targetAgentIds?.length
          ? { targetAgentIds: input.targetAgentIds }
          : {}),
      });
      if (this.#pendingStartThread === pending) {
        this.#pendingStartThread = null;
      }
    } catch (error) {
      if (
        this.#pendingStartThread === pending &&
        !isUncertainCommandError(error)
      ) {
        this.#pendingStartThread = null;
      }
      throw error;
    }
    if (
      selectedChannelId === input.channelId &&
      this.#channelId === input.channelId
    ) {
      await this.loadThreads(input.channelId);
    }
  }

  async replyToThread(input: {
    readonly threadRootId: string;
    readonly body: string;
    readonly expectedThreadCursor: number;
    readonly targetAgentIds?: readonly string[];
  }): Promise<void> {
    const fingerprint = JSON.stringify({
      threadRootId: input.threadRootId,
      body: input.body,
      targetAgentIds: input.targetAgentIds ?? [],
    });
    const pending =
      this.#pendingReplies.get(fingerprint) ??
      ({
        request: {
          idempotencyKey: crypto.randomUUID(),
          threadRootId: input.threadRootId,
          expectedThreadCursor: input.expectedThreadCursor,
          body: input.body,
          ...(input.targetAgentIds?.length
            ? { targetAgentIds: [...input.targetAgentIds] }
            : {}),
        },
      } satisfies PendingReply);
    this.#pendingReplies.set(fingerprint, pending);
    const selectedThreadId = this.#threadId;
    try {
      await this.#command("reply-to-thread", pending.request);
      if (this.#pendingReplies.get(fingerprint) === pending) {
        this.#pendingReplies.delete(fingerprint);
      }
    } catch (error) {
      if (
        this.#pendingReplies.get(fingerprint) === pending &&
        !isUncertainCommandError(error)
      ) {
        this.#pendingReplies.delete(fingerprint);
      }
      throw error;
    }
    if (
      selectedThreadId === input.threadRootId &&
      this.#threadId === input.threadRootId
    ) {
      await this.loadThread(input.threadRootId);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearLivenessRefresh();
    this.#clearPendingInvalidations();
    this.#clearCoalescedRefreshes();
    this.#closeEvents();
    this.#broadcastChannel?.close();
    this.#listeners.clear();
  }

  async #bootstrap(projectId: string): Promise<void> {
    const sessionGeneration = ++this.#sessionGeneration;
    this.#clearLivenessRefresh();
    this.#clearPendingInvalidations();
    this.#clearCoalescedRefreshes();
    this.#closeEvents();
    this.#projectId = projectId;
    this.#channelId = null;
    this.#threadId = null;
    this.#runId = null;
    this.#pendingStartThread = null;
    this.#seenEventIds = [];
    this.#processingEventIds.clear();
    this.#latestProjectionRequests.clear();
    this.#projectionErrors.clear();
    this.#threadsRequestGeneration += 1;
    this.#threadRequestGeneration += 1;
    this.#runRequestGeneration += 1;
    this.#setState({
      session: "loading",
      connection: "connecting",
      authError: null,
      queryError: null,
      bootstrap: null,
      threads: [],
      threadsChannelId: null,
      thread: null,
      runs: [],
      run: null,
      agents: [],
      attentions: [],
      loadingThreads: false,
      loadingThread: false,
      loadingRun: false,
      commandPending: false,
      lastEventId: null,
    });
    try {
      const body = await this.#request<{ readonly bootstrap: Bootstrap }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/bootstrap`,
        {},
        sessionGeneration,
      );
      const [runs, agents, attentions] = await Promise.all([
        this.#readAllProjectionPages<RunProjection>(
          `/api/v1/projects/${encodeURIComponent(projectId)}/runs`,
          sessionGeneration,
        ),
        this.#request<{ readonly items: readonly AgentStatus[] }>(
          `/api/v1/projects/${encodeURIComponent(projectId)}/agents`,
          {},
          sessionGeneration,
        ),
        this.#readAllAttentions(projectId, sessionGeneration),
      ]);
      if (this.#sessionGeneration !== sessionGeneration) {
        return;
      }
      this.#setState({
        session: "ready",
        bootstrap: body.bootstrap,
        runs,
        agents: agents.items,
        attentions,
        lastEventId: body.bootstrap.latestEventId,
      });
      this.#connectEvents(projectId, body.bootstrap.latestEventId);
      this.#scheduleLivenessRefresh();
    } catch (error) {
      if (this.#sessionGeneration !== sessionGeneration) {
        return;
      }
      if (!(error instanceof ApiError && error.status === 401)) {
        this.#setState({
          session: "signed-out",
          connection: "offline",
          authError:
            error instanceof Error
              ? error.message
              : "The project could not be loaded.",
        });
      }
      throw error;
    }
  }

  async #command(
    slug: "start-thread" | "reply-to-thread",
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (!this.#csrfToken) {
      this.#clearSession("expired");
      throw new ApiError(
        401,
        "session_expired",
        "The browser session has expired. Exchange the local credential again.",
      );
    }
    this.#setState({ commandPending: true });
    const sessionGeneration = this.#sessionGeneration;
    const csrfRevision = this.#csrfRevision;
    try {
      await this.#sendCommand(slug, body, this.#csrfToken, sessionGeneration);
      if (this.#sessionGeneration === sessionGeneration) {
        this.#setState({ commandPending: false });
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 403 &&
        error.code === "invalid_csrf_token"
      ) {
        const rotated = await this.#waitForCsrfRotation(csrfRevision);
        if (
          rotated &&
          this.#csrfToken &&
          this.#sessionGeneration === sessionGeneration
        ) {
          try {
            await this.#sendCommand(
              slug,
              body,
              this.#csrfToken,
              sessionGeneration,
            );
            this.#setState({ commandPending: false });
            return;
          } catch (retryError) {
            if (
              retryError instanceof ApiError &&
              retryError.status === 403 &&
              retryError.code === "invalid_csrf_token"
            ) {
              this.#clearSession("expired", false);
            } else if (this.#sessionGeneration === sessionGeneration) {
              this.#setState({ commandPending: false });
            }
            throw retryError;
          }
        }
        this.#clearSession("expired", false);
      } else if (this.#sessionGeneration === sessionGeneration) {
        this.#setState({ commandPending: false });
      }
      throw error;
    }
  }

  async #sendCommand(
    slug: "start-thread" | "reply-to-thread",
    body: Readonly<Record<string, unknown>>,
    csrfToken: string,
    sessionGeneration: number,
  ): Promise<void> {
    await this.#request(
      `/api/v1/commands/${slug}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Torsor-CSRF": csrfToken,
        },
        body: JSON.stringify(body),
      },
      sessionGeneration,
    );
  }

  async #request<T>(
    path: string,
    init: RequestInit = {},
    sessionGeneration = this.#sessionGeneration,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      ...init,
      credentials: "include",
    });
    if (
      response.status === 401 &&
      this.#sessionGeneration === sessionGeneration
    ) {
      this.#clearSession("expired");
    }
    return readApiResponse<T>(response);
  }

  async #readAllProjectionPages<T>(
    path: string,
    sessionGeneration = this.#sessionGeneration,
  ): Promise<readonly T[]> {
    const items: T[] = [];
    let nextPath: string | null = withLimit(path, 100);
    let snapshot: string | null = null;
    while (nextPath) {
      const page: ProjectionPage<T> =
        await this.#request<ProjectionPage<T>>(
          nextPath,
          {},
          sessionGeneration,
        );
      items.push(...page.items);
      snapshot ??= page.snapshotEventId;
      nextPath =
        page.hasMore && page.nextCursor
          ? addPageCursor(path, page.nextCursor, snapshot)
          : null;
    }
    return items;
  }

  async #readAllAttentions(
    projectId: string,
    sessionGeneration = this.#sessionGeneration,
  ): Promise<readonly Attention[]> {
    const items: Attention[] = [];
    let afterCursor: number | null = null;
    let snapshotEventId: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (afterCursor !== null) {
        query.set("afterCursor", String(afterCursor));
      }
      if (snapshotEventId) {
        query.set("snapshotEventId", snapshotEventId);
      }
      const page = await this.#request<AttentionPage>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/attentions?${query.toString()}`,
        {},
        sessionGeneration,
      );
      items.push(...page.items);
      snapshotEventId ??= page.snapshotEventId;
      afterCursor = page.hasMore ? page.nextCursor : null;
    } while (afterCursor !== null);
    return items;
  }

  #connectEvents(projectId: string, cursor: string | null): void {
    this.#closeEvents();
    const query = new URLSearchParams({ projectId });
    if (cursor) {
      query.set("cursor", cursor);
    }
    const events = this.#eventSourceFactory(
      `${this.#apiBase}/api/v1/events?${query.toString()}`,
    );
    this.#events = events;
    events.onopen = () => {
      if (this.#events === events) {
        this.#clearProbe();
        this.#setState({ connection: "live" });
        this.#retryPendingInvalidations();
      }
    };
    events.onerror = () => {
      if (this.#events === events) {
        this.#setState({ connection: "reconnecting" });
        this.#scheduleSessionProbe();
      }
    };
    events.addEventListener("torsor", (message) => {
      const eventMessage = message as MessageEvent<string>;
      try {
        const event = JSON.parse(eventMessage.data) as PublicEvent;
        void this.#applyEvent(event, true);
      } catch {
        this.#projectionErrors.set(
          "events",
          "A server event could not be read. Live updates may be stale.",
        );
        this.#setState({ queryError: this.#currentProjectionError() });
      }
    });
  }

  async #applyEvent(event: PublicEvent, broadcast: boolean): Promise<void> {
    if (this.#disposed || event.projectId !== this.#projectId) {
      return;
    }
    if (
      this.#seenEventIds.includes(event.eventId) ||
      this.#processingEventIds.has(event.eventId)
    ) {
      return;
    }
    const pending = this.#pendingInvalidations.get(event.eventId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    this.#processingEventIds.add(event.eventId);
    this.#setState({
      lastEventId: event.eventId,
      ...(broadcast ? { connection: "live" as const } : {}),
    });
    if (broadcast && !pending) {
      this.#broadcastChannel?.postMessage({
        kind: "event",
        event,
      } satisfies WindowMessage);
    }

    const work: Promise<boolean>[] = [];
    if (event.channelId && event.channelId === this.#channelId) {
      const channelId = event.channelId;
      work.push(
        this.#coalesceProjectionRefresh(
          `threads:${channelId}`,
          () => this.loadThreads(channelId),
        ),
      );
    }
    if (event.threadRootId && event.threadRootId === this.#threadId) {
      const threadRootId = event.threadRootId;
      work.push(
        this.#coalesceProjectionRefresh(
          `thread:${threadRootId}`,
          () => this.loadThread(threadRootId),
        ),
      );
    }

    const runId = eventRunId(event);
    if (runId && runId === this.#runId) {
      work.push(
        this.#coalesceProjectionRefresh(
          `run:${runId}`,
          () => this.loadRun(runId),
        ),
      );
    } else if (
      affectsSelectedRunDetail(event) &&
      event.threadRootId === this.#threadId &&
      this.#runId
    ) {
      const selectedRunId = this.#runId;
      work.push(
        this.#coalesceProjectionRefresh(
          `run:${selectedRunId}`,
          () => this.loadRun(selectedRunId),
        ),
      );
    }

    if (affectsRuns(event)) {
      work.push(
        this.#coalesceProjectionRefresh("runs", () => this.#refreshRuns()),
      );
    }
    if (affectsAttentionOrAgents(event)) {
      work.push(
        this.#coalesceProjectionRefresh(
          "attention-agents",
          () => this.#refreshAttentionAndAgents(),
        ),
      );
    }
    if (event.entityType === "Channel" || event.entityType === "Project") {
      work.push(
        this.#coalesceProjectionRefresh(
          "bootstrap",
          () => this.#refreshBootstrap(),
        ),
      );
    }
    try {
      const results = await Promise.all(work);
      if (results.every(Boolean)) {
        this.#pendingInvalidations.delete(event.eventId);
        this.#rememberEvent(event.eventId);
        this.#projectionSucceeded("events", {});
      } else {
        this.#scheduleInvalidationRetry(event);
      }
    } catch (error) {
      this.#projectionFailed("events", error, {});
      this.#scheduleInvalidationRetry(event);
    } finally {
      this.#processingEventIds.delete(event.eventId);
    }
  }

  async #refreshRuns(): Promise<boolean> {
    if (!this.#projectId) {
      return true;
    }
    const projectId = this.#projectId;
    const sessionGeneration = this.#sessionGeneration;
    const requestGeneration = ++this.#runsRefreshGeneration;
    const projectionKey = "runs";
    let request!: Promise<boolean>;
    request = (async () => {
      try {
        const runs = await this.#readAllProjectionPages<RunProjection>(
          `/api/v1/projects/${encodeURIComponent(projectId)}/runs`,
          sessionGeneration,
        );
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#runsRefreshGeneration === requestGeneration &&
          this.#projectId === projectId
        ) {
          this.#projectionSucceeded(projectionKey, { runs });
          return true;
        }
        return this.#replacementResult(projectionKey, request);
      } catch (error) {
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#runsRefreshGeneration === requestGeneration
        ) {
          this.#projectionFailed(projectionKey, error, {});
          return false;
        }
        return this.#replacementResult(projectionKey, request);
      }
    })();
    this.#latestProjectionRequests.set(projectionKey, request);
    return request;
  }

  async #refreshAttentionAndAgents(): Promise<boolean> {
    if (!this.#projectId) {
      return true;
    }
    const projectId = this.#projectId;
    const sessionGeneration = this.#sessionGeneration;
    const requestGeneration = ++this.#attentionRefreshGeneration;
    const projectionKey = "attention-agents";
    let request!: Promise<boolean>;
    request = (async () => {
      try {
        const [agents, attentions] = await Promise.all([
          this.#request<{ readonly items: readonly AgentStatus[] }>(
            `/api/v1/projects/${encodeURIComponent(projectId)}/agents`,
            {},
            sessionGeneration,
          ),
          this.#readAllAttentions(projectId, sessionGeneration),
        ]);
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#attentionRefreshGeneration === requestGeneration &&
          this.#projectId === projectId
        ) {
          this.#projectionSucceeded(projectionKey, {
            agents: agents.items,
            attentions,
          });
          return true;
        }
        return this.#replacementResult(projectionKey, request);
      } catch (error) {
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#attentionRefreshGeneration === requestGeneration
        ) {
          this.#projectionFailed(projectionKey, error, {});
          return false;
        }
        return this.#replacementResult(projectionKey, request);
      }
    })();
    this.#latestProjectionRequests.set(projectionKey, request);
    return request;
  }

  async #refreshBootstrap(): Promise<boolean> {
    if (!this.#projectId) {
      return true;
    }
    const projectId = this.#projectId;
    const sessionGeneration = this.#sessionGeneration;
    const requestGeneration = ++this.#bootstrapRefreshGeneration;
    const projectionKey = "bootstrap";
    let request!: Promise<boolean>;
    request = (async () => {
      try {
        const body = await this.#request<{ readonly bootstrap: Bootstrap }>(
          `/api/v1/projects/${encodeURIComponent(projectId)}/bootstrap`,
          {},
          sessionGeneration,
        );
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#bootstrapRefreshGeneration === requestGeneration &&
          this.#projectId === projectId
        ) {
          this.#projectionSucceeded(projectionKey, {
            bootstrap: body.bootstrap,
          });
          return true;
        }
        return this.#replacementResult(projectionKey, request);
      } catch (error) {
        if (
          this.#sessionGeneration === sessionGeneration &&
          this.#bootstrapRefreshGeneration === requestGeneration
        ) {
          this.#projectionFailed(projectionKey, error, {});
          return false;
        }
        return this.#replacementResult(projectionKey, request);
      }
    })();
    this.#latestProjectionRequests.set(projectionKey, request);
    return request;
  }

  #rememberEvent(eventId: string): void {
    this.#seenEventIds.push(eventId);
    if (this.#seenEventIds.length > 200) {
      this.#seenEventIds = this.#seenEventIds.slice(-100);
    }
  }

  #scheduleInvalidationRetry(event: PublicEvent): void {
    const existing = this.#pendingInvalidations.get(event.eventId);
    const pending = existing ?? {
      event,
      retryCount: 0,
      timer: null,
    };
    this.#pendingInvalidations.set(event.eventId, pending);
    if (pending.timer) {
      return;
    }
    const delay = Math.min(
      this.#reconnectProbeDelayMs * 2 ** Math.min(pending.retryCount, 4),
      30_000,
    );
    pending.retryCount += 1;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void this.#applyEvent(pending.event, false);
    }, delay);
  }

  #retryPendingInvalidations(): void {
    for (const pending of this.#pendingInvalidations.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      void this.#applyEvent(pending.event, false);
    }
  }

  #clearPendingInvalidations(): void {
    for (const pending of this.#pendingInvalidations.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.#pendingInvalidations.clear();
    this.#processingEventIds.clear();
  }

  #coalesceProjectionRefresh(
    key: string,
    refresh: () => Promise<boolean>,
  ): Promise<boolean> {
    const existing = this.#coalescedRefreshes.get(key);
    if (existing) {
      existing.refresh = refresh;
      if (!existing.inFlight) {
        return this.#startCoalescedRefresh(key, existing);
      }
      existing.followUp ??= deferredBoolean();
      return existing.followUp.promise;
    }
    const entry: CoalescedRefresh = {
      inFlight: null,
      followUp: null,
      refresh,
    };
    this.#coalescedRefreshes.set(key, entry);
    return this.#startCoalescedRefresh(key, entry);
  }

  #startCoalescedRefresh(
    key: string,
    entry: CoalescedRefresh,
  ): Promise<boolean> {
    const request = entry.refresh().catch((error: unknown) => {
      this.#projectionFailed(key, error, {});
      return false;
    });
    entry.inFlight = request;
    void request.then(() => {
      if (
        this.#coalescedRefreshes.get(key) !== entry ||
        entry.inFlight !== request
      ) {
        return;
      }
      const followUp = entry.followUp;
      entry.followUp = null;
      entry.inFlight = null;
      if (!followUp) {
        this.#coalescedRefreshes.delete(key);
        return;
      }
      void this.#startCoalescedRefresh(key, entry).then(followUp.resolve);
    });
    return request;
  }

  #clearCoalescedRefreshes(): void {
    for (const entry of this.#coalescedRefreshes.values()) {
      entry.followUp?.resolve(false);
    }
    this.#coalescedRefreshes.clear();
  }

  #scheduleLivenessRefresh(): void {
    this.#clearLivenessRefresh();
    const projectId = this.#projectId;
    const sessionGeneration = this.#sessionGeneration;
    if (!projectId || this.#state.session !== "ready") {
      return;
    }
    this.#livenessTimer = setTimeout(async () => {
      this.#livenessTimer = null;
      if (
        this.#disposed ||
        this.#state.session !== "ready" ||
        this.#projectId !== projectId ||
        this.#sessionGeneration !== sessionGeneration
      ) {
        return;
      }
      await this.#refreshAttentionAndAgents();
      if (
        !this.#disposed &&
        this.#state.session === "ready" &&
        this.#projectId === projectId &&
        this.#sessionGeneration === sessionGeneration
      ) {
        this.#scheduleLivenessRefresh();
      }
    }, this.#agentLivenessRefreshMs);
  }

  #clearLivenessRefresh(): void {
    if (this.#livenessTimer) {
      clearTimeout(this.#livenessTimer);
      this.#livenessTimer = null;
    }
  }

  #scheduleSessionProbe(): void {
    this.#clearProbe();
    const sessionGeneration = this.#sessionGeneration;
    this.#probeTimer = setTimeout(() => {
      this.#probeTimer = null;
      if (!this.#projectId || this.#state.connection !== "reconnecting") {
        return;
      }
      void this.#request(
        `/api/v1/projects/${encodeURIComponent(this.#projectId)}/bootstrap`,
        {},
        sessionGeneration,
      ).catch((error: unknown) => {
        if (
          this.#sessionGeneration === sessionGeneration &&
          !(error instanceof ApiError && error.status === 401)
        ) {
          this.#setState({ connection: "reconnecting" });
        }
      });
    }, this.#reconnectProbeDelayMs);
  }

  #replacementResult(
    projectionKey: string,
    request: Promise<boolean>,
  ): Promise<boolean> | false {
    const replacement = this.#latestProjectionRequests.get(projectionKey);
    return replacement && replacement !== request ? replacement : false;
  }

  #projectionSucceeded(
    projectionKey: string,
    partial: Partial<WebState>,
  ): void {
    this.#projectionErrors.delete(projectionKey);
    this.#setState({
      ...partial,
      queryError: this.#currentProjectionError(),
    });
  }

  #projectionFailed(
    projectionKey: string,
    error: unknown,
    partial: Partial<WebState>,
  ): void {
    if (error instanceof ApiError && error.status === 401) {
      return;
    }
    this.#projectionErrors.set(
      projectionKey,
      error instanceof Error
        ? error.message
        : "The projection could not be loaded.",
    );
    this.#setState({
      ...partial,
      queryError: this.#currentProjectionError(),
    });
  }

  #clearProjectionErrors(prefixes: readonly string[]): void {
    for (const key of this.#projectionErrors.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        this.#projectionErrors.delete(key);
      }
    }
  }

  #currentProjectionError(): string | null {
    return this.#projectionErrors.values().next().value ?? null;
  }

  #clearSession(
    session: "signed-out" | "expired",
    broadcast = true,
  ): void {
    this.#sessionGeneration += 1;
    this.#csrfToken = null;
    this.#principalId = null;
    this.#csrfRevision += 1;
    this.#resolveCsrfWaiters();
    this.#storage.removeItem(csrfStorageKey);
    this.#storage.removeItem(principalStorageKey);
    this.#clearLivenessRefresh();
    this.#clearPendingInvalidations();
    this.#clearCoalescedRefreshes();
    this.#closeEvents();
    this.#projectId = null;
    this.#channelId = null;
    this.#threadId = null;
    this.#runId = null;
    this.#pendingStartThread = null;
    this.#seenEventIds = [];
    this.#latestProjectionRequests.clear();
    this.#projectionErrors.clear();
    if (broadcast) {
      this.#broadcastChannel?.postMessage({
        kind: "session-cleared",
        session,
      } satisfies WindowMessage);
    }
    this.#setState({
      session,
      connection: "offline",
      bootstrap: null,
      threads: [],
      threadsChannelId: null,
      thread: null,
      runs: [],
      run: null,
      agents: [],
      attentions: [],
      loadingThreads: false,
      loadingThread: false,
      loadingRun: false,
      commandPending: false,
      queryError: null,
      lastEventId: null,
    });
  }

  #setCsrfToken(csrfToken: string, principalId: string): void {
    this.#csrfToken = csrfToken;
    this.#principalId = principalId;
    this.#csrfRevision += 1;
    this.#storage.setItem(csrfStorageKey, csrfToken);
    this.#storage.setItem(principalStorageKey, principalId);
    this.#resolveCsrfWaiters();
  }

  async #waitForCsrfRotation(revision: number): Promise<boolean> {
    if (this.#csrfRevision !== revision) {
      return this.#csrfToken !== null;
    }
    return new Promise((resolve) => {
      const complete = () => {
        clearTimeout(timeout);
        this.#csrfWaiters.delete(complete);
        resolve(
          this.#csrfRevision !== revision && this.#csrfToken !== null,
        );
      };
      const timeout = setTimeout(complete, 750);
      this.#csrfWaiters.add(complete);
    });
  }

  #resolveCsrfWaiters(): void {
    for (const waiter of [...this.#csrfWaiters]) {
      waiter();
    }
  }

  #closeEvents(): void {
    this.#clearProbe();
    this.#events?.close();
    this.#events = null;
  }

  #clearProbe(): void {
    if (this.#probeTimer) {
      clearTimeout(this.#probeTimer);
      this.#probeTimer = null;
    }
  }

  #setState(partial: Partial<WebState>): void {
    this.#state = { ...this.#state, ...partial };
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

function withLimit(path: string, limit: number): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}limit=${limit}`;
}

function addPageCursor(
  path: string,
  cursor: string,
  snapshot: string | null,
): string {
  const separator = path.includes("?") ? "&" : "?";
  const query = new URLSearchParams({ after: cursor, limit: "100" });
  if (snapshot) {
    query.set("snapshot", snapshot);
  }
  return `${path}${separator}${query.toString()}`;
}

function eventRunId(event: PublicEvent): string | null {
  if (event.entityType === "Run") {
    return event.entityId;
  }
  if (
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload) &&
    typeof event.payload.runId === "string"
  ) {
    return event.payload.runId;
  }
  return null;
}

function affectsRuns(event: PublicEvent): boolean {
  return [
    "Run",
    "RunInput",
    "ActivationAttempt",
    "ProviderAttempt",
    "RunActivityEvent",
    "Artifact",
  ].includes(event.entityType);
}

function affectsAttentionOrAgents(event: PublicEvent): boolean {
  return ["Attention", "Run", "ActivationAttempt"].includes(event.entityType);
}

function affectsSelectedRunDetail(event: PublicEvent): boolean {
  return [
    "RunInput",
    "ActivationAttempt",
    "ProviderAttempt",
    "RunActivityEvent",
    "Artifact",
  ].includes(event.entityType);
}

function deferredBoolean(): DeferredBoolean {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function isUncertainCommandError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}
