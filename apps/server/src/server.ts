import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";

import {
  KernelError,
  TorsorKernel,
  type KernelBootstrap,
  type ArtifactStorage,
  type KernelCommand,
  type PrincipalContext,
  type PublicEventEnvelope,
} from "@torsor/kernel";

const apiPrefix = "/api/v1";
const defaultBodyLimitBytes = 1_048_576;
const defaultEventBatchSize = 50;
const maximumPageSize = 100;
const defaultSessionDurationMs = 86_400_000;

const commandTypes = {
  "start-thread": "StartThread",
  "reply-to-thread": "ReplyToThread",
  "edit-message": "EditMessage",
  "delete-message": "DeleteMessage",
  "update-agent-config": "UpdateAgentConfig",
  "adopt-run-config": "AdoptRunConfig",
  "send-to-run": "SendToRun",
  "cancel-run": "CancelRun",
  "withdraw-run-input": "WithdrawRunInput",
} as const satisfies Readonly<Record<string, KernelCommand["type"]>>;

const forbiddenCommandFields = new Set([
  "type",
  "principalId",
  "principalContext",
  "actorPrincipalId",
  "authorPrincipalId",
  "authorAgentId",
  "causedByAttentionId",
  "causedByRunId",
  "activationId",
  "correlationId",
]);

export interface LocalCredential {
  readonly token: string;
  readonly principalContext: PrincipalContext;
}

interface TorsorHttpServiceBaseOptions {
  readonly credentials: readonly LocalCredential[];
  readonly host?: string;
  readonly port?: number;
  readonly bodyLimitBytes?: number;
  readonly eventBatchSize?: number;
  readonly eventPollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly sessionDurationMs?: number;
}

interface OwnedKernelHttpServiceOptions {
  readonly kernel?: never;
  readonly databasePath: string;
  readonly artifactStorage?: ArtifactStorage;
  readonly bootstrap?: KernelBootstrap;
  readonly clock?: () => Date;
  readonly idFactory?: (prefix: string) => string;
}

interface SharedKernelHttpServiceOptions {
  readonly kernel: TorsorKernel;
  readonly databasePath?: never;
  readonly artifactStorage?: never;
  readonly bootstrap?: never;
  readonly clock?: never;
  readonly idFactory?: never;
}

export type TorsorHttpServiceOptions = TorsorHttpServiceBaseOptions &
  (OwnedKernelHttpServiceOptions | SharedKernelHttpServiceOptions);

export interface TorsorHttpService {
  readonly origin: string | null;
  readonly activeEventStreamCount: number;
  listen(): Promise<string>;
  close(): Promise<void>;
}

interface AuthenticatedRequest {
  readonly context: PrincipalContext;
  readonly authentication: "bearer" | "session";
  readonly sessionId?: string;
  readonly sessionExpiresAt?: number;
  readonly sessionCsrfToken?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

class Service implements TorsorHttpService {
  readonly #kernel: TorsorKernel;
  readonly #ownsKernel: boolean;
  readonly #server: Server;
  readonly #credentials = new Map<string, PrincipalContext>();
  readonly #sessions = new Map<
    string,
    Readonly<{
      context: PrincipalContext;
      expiresAt: number;
      csrfToken: string;
    }>
  >();
  readonly #eventStreams = new Set<AbortController>();
  readonly #host: string;
  readonly #port: number;
  readonly #bodyLimitBytes: number;
  readonly #eventBatchSize: number;
  readonly #eventPollIntervalMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #sessionDurationMs: number;
  #origin: string | null = null;
  #state: "created" | "starting" | "listening" | "closing" | "closed" =
    "created";
  #listenPromise: Promise<string> | null = null;
  #listenSettledPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: TorsorHttpServiceOptions) {
    if (options.credentials.length === 0) {
      throw new Error("At least one local credential is required.");
    }
    for (const credential of options.credentials) {
      if (!credential.token) {
        throw new Error("Local credential tokens must not be empty.");
      }
      if (this.#credentials.has(credential.token)) {
        throw new Error("Local credential tokens must be unique.");
      }
      this.#credentials.set(credential.token, credential.principalContext);
    }
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 4317;
    this.#bodyLimitBytes = positiveInteger(
      options.bodyLimitBytes ?? defaultBodyLimitBytes,
      "bodyLimitBytes",
    );
    this.#eventBatchSize = boundedInteger(
      options.eventBatchSize ?? defaultEventBatchSize,
      1,
      maximumPageSize,
      "eventBatchSize",
    );
    this.#eventPollIntervalMs = positiveInteger(
      options.eventPollIntervalMs ?? 250,
      "eventPollIntervalMs",
    );
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? 15_000,
      "heartbeatIntervalMs",
    );
    this.#sessionDurationMs = positiveInteger(
      options.sessionDurationMs ?? defaultSessionDurationMs,
      "sessionDurationMs",
    );
    if (options.kernel) {
      this.#kernel = options.kernel;
      this.#ownsKernel = false;
    } else {
      this.#kernel = TorsorKernel.open({
        databasePath: options.databasePath,
        ...(options.artifactStorage ? { artifactStorage: options.artifactStorage } : {}),
        ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.idFactory ? { idFactory: options.idFactory } : {}),
      });
      this.#ownsKernel = true;
    }
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  get origin(): string | null {
    return this.#origin;
  }

  get activeEventStreamCount(): number {
    return this.#eventStreams.size;
  }

  async listen(): Promise<string> {
    if (this.#state === "closing" || this.#state === "closed") {
      throw new Error("The HTTP service is closed.");
    }
    if (this.#origin) {
      return this.#origin;
    }
    if (!this.#listenPromise) {
      this.#state = "starting";
      const listenPromise = this.#bind();
      this.#listenPromise = listenPromise;
      this.#listenSettledPromise = listenPromise.then(
        () => undefined,
        () => {
          if (!this.#closePromise) {
            this.#state = "closing";
            this.#closePromise = this.#shutdown();
          }
        },
      );
    }
    return this.#listenPromise;
  }

  async close(): Promise<void> {
    if (!this.#closePromise) {
      this.#state = "closing";
      this.#closePromise = (async () => {
        if (this.#listenSettledPromise) {
          await this.#listenSettledPromise;
        }
        await this.#shutdown();
      })();
    }
    return this.#closePromise;
  }

  async #bind(): Promise<string> {
    this.#server.listen(this.#port, this.#host);
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (!address || typeof address === "string") {
      throw new Error("The HTTP service did not bind a TCP address.");
    }
    const origin = `http://${formatHost(address.address)}:${address.port}`;
    this.#origin = origin;
    if (this.#state === "starting") {
      this.#state = "listening";
    }
    return origin;
  }

  async #shutdown(): Promise<void> {
    for (const controller of this.#eventStreams) {
      controller.abort();
    }
    if (this.#server.listening) {
      const closed = once(this.#server, "close");
      this.#server.close();
      this.#server.closeAllConnections();
      await closed;
    }
    this.#sessions.clear();
    if (this.#ownsKernel) {
      this.#kernel.close();
    }
    this.#origin = null;
    this.#state = "closed";
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (
        segments[0] !== "api" ||
        segments[1] !== "v1"
      ) {
        throw new HttpError(404, "not_found", "The endpoint does not exist.");
      }

      if (segments[2] === "session") {
        await this.#handleSession(request, response);
        return;
      }

      const authenticated = this.#authenticate(request);

      if (request.method === "POST" && segments[2] === "commands") {
        await this.#handleCommand(segments[3], request, response, authenticated);
        return;
      }

      if (request.method === "GET" && segments[2] === "events") {
        await this.#handleEventStream(
          request,
          response,
          url,
          authenticated,
        );
        return;
      }

      if (request.method !== "GET") {
        throw new HttpError(
          405,
          "method_not_allowed",
          "The endpoint does not allow this HTTP method.",
        );
      }

      await this.#handleQuery(segments, url, response, authenticated);
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, error, requestId);
      } else if (!response.writableEnded) {
        response.destroy();
      }
    }
  }

  async #handleSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method === "POST") {
      const authorization = bearerToken(request);
      if (!authorization) {
        throw new HttpError(
          401,
          "unauthorized",
          "A local bearer credential is required.",
        );
      }
      const context = this.#credentials.get(authorization);
      if (!context) {
        throw new HttpError(
          401,
          "unauthorized",
          "The local bearer credential is invalid.",
        );
      }
      const now = Date.now();
      this.#pruneSessions(now);
      const currentSessionId = cookieValue(request, "torsor_session");
      const currentSession = currentSessionId
        ? this.#sessions.get(currentSessionId)
        : undefined;
      const reusableEntry =
        currentSessionId &&
        currentSession &&
        sameContext(currentSession.context, context)
          ? ([currentSessionId, currentSession] as const)
          : undefined;
      if (reusableEntry) {
        const [reusableSessionId, reusableSession] = reusableEntry;
        response.setHeader(
          "Set-Cookie",
          `torsor_session=${reusableSessionId}; HttpOnly; SameSite=Strict; Path=${apiPrefix}; Max-Age=${Math.max(1, Math.ceil((reusableSession.expiresAt - now) / 1_000))}`,
        );
        sendJson(response, 201, {
          authenticated: true,
          principalId: context.principalId,
          csrfToken: reusableSession.csrfToken,
        });
        return;
      }
      const sessionId = randomUUID();
      const csrfToken = randomUUID();
      const expiresAt = now + this.#sessionDurationMs;
      this.#sessions.set(sessionId, { context, expiresAt, csrfToken });
      response.setHeader(
        "Set-Cookie",
        `torsor_session=${sessionId}; HttpOnly; SameSite=Strict; Path=${apiPrefix}; Max-Age=${Math.max(1, Math.ceil(this.#sessionDurationMs / 1_000))}`,
      );
      sendJson(response, 201, {
        authenticated: true,
        principalId: context.principalId,
        csrfToken,
      });
      return;
    }
    if (request.method === "DELETE") {
      const sessionId = cookieValue(request, "torsor_session");
      if (sessionId) {
        this.#sessions.delete(sessionId);
      }
      response.setHeader(
        "Set-Cookie",
        `torsor_session=; HttpOnly; SameSite=Strict; Path=${apiPrefix}; Max-Age=0`,
      );
      response.writeHead(204);
      response.end();
      return;
    }
    throw new HttpError(
      405,
      "method_not_allowed",
      "The session endpoint accepts POST or DELETE.",
    );
  }

  #authenticate(request: IncomingMessage): AuthenticatedRequest {
    const bearer = bearerToken(request);
    const bearerContext = bearer ? this.#credentials.get(bearer) : undefined;
    const sessionId = cookieValue(request, "torsor_session");
    const now = Date.now();
    this.#pruneSessions(now);
    const session = sessionId ? this.#sessions.get(sessionId) : undefined;
    const sessionContext =
      session && session.expiresAt > now ? session.context : undefined;
    if (bearer && !bearerContext) {
      throw new HttpError(
        401,
        "unauthorized",
        "The local bearer credential is invalid.",
      );
    }
    if (
      bearerContext &&
      sessionContext &&
      !sameContext(bearerContext, sessionContext)
    ) {
      throw new HttpError(
        400,
        "ambiguous_authentication",
        "Bearer and session credentials identify different principals.",
      );
    }
    const context = bearerContext ?? sessionContext;
    if (!context) {
      throw new HttpError(
        401,
        "unauthorized",
        "Authentication is required.",
      );
    }
    return {
      context,
      authentication: bearerContext ? "bearer" : "session",
      ...(!bearerContext && sessionId && session
        ? {
            sessionId,
            sessionExpiresAt: session.expiresAt,
            sessionCsrfToken: session.csrfToken,
          }
        : {}),
    };
  }

  #pruneSessions(now: number): void {
    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(sessionId);
      }
    }
  }

  async #handleCommand(
    commandSlug: string | undefined,
    request: IncomingMessage,
    response: ServerResponse,
    authenticated: AuthenticatedRequest,
  ): Promise<void> {
    if (!commandSlug || !(commandSlug in commandTypes)) {
      throw new HttpError(
        404,
        "not_found",
        "The command endpoint does not exist.",
      );
    }
    const contentType = singleHeader(request, "content-type");
    if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new HttpError(
        415,
        "unsupported_media_type",
        "Command requests require Content-Type: application/json.",
      );
    }
    if (
      authenticated.authentication === "session" &&
      singleHeader(request, "x-torsor-csrf") !==
        authenticated.sessionCsrfToken
    ) {
      throw new HttpError(
        403,
        "invalid_csrf_token",
        "The browser session CSRF token is missing or invalid.",
      );
    }
    const body = await readJsonObject(request, this.#bodyLimitBytes);
    for (const field of forbiddenCommandFields) {
      if (field in body) {
        throw new HttpError(
          400,
          "invalid_request",
          `Command field ${field} is server-controlled and must not be supplied.`,
        );
      }
    }
    if (typeof body.idempotencyKey !== "string" || body.idempotencyKey === "") {
      throw new HttpError(
        400,
        "invalid_request",
        "A non-empty idempotencyKey is required.",
      );
    }
    const type = commandTypes[commandSlug as keyof typeof commandTypes];
    const command = { ...body, type } as unknown as KernelCommand;
    this.#requireCurrentAuthentication(authenticated);
    const result = await this.#kernel.execute(
      command,
      authenticated.context,
    );
    sendJson(response, 200, { result });
  }

  async #handleQuery(
    segments: readonly string[],
    url: URL,
    response: ServerResponse,
    authenticated: AuthenticatedRequest,
  ): Promise<void> {
    if (segments[2] === "projects" && segments[3]) {
      const projectId = segments[3];
      if (segments[4] === "bootstrap" && segments.length === 5) {
        const bootstrap = await this.#kernel.query(
          { type: "GetBootstrap", projectId },
          authenticated.context,
        );
        sendJson(response, 200, { bootstrap });
        return;
      }
      if (segments[4] === "channels" && segments.length === 5) {
        const bootstrap = await this.#kernel.query(
          { type: "GetBootstrap", projectId },
          authenticated.context,
        );
        sendJson(response, 200, {
          items: bootstrap.channels,
          latestEventId: bootstrap.latestEventId,
        });
        return;
      }
      if (segments[4] === "runs" && segments.length === 5) {
        const page = await this.#kernel.query(
          {
            type: "ListRunProjections",
            projectId,
            ...optionalStringAs(url, "after", "afterEventId"),
            ...optionalStringAs(url, "snapshot", "snapshotEventId"),
            limit: pageSize(url),
          },
          authenticated.context,
        );
        sendJson(response, 200, {
          items: page.items,
          nextCursor: page.nextAfterEventId,
          hasMore: page.hasMore,
          snapshotEventId: page.snapshotEventId,
        });
        return;
      }
      if (segments[4] === "agents" && segments.length === 5) {
        const agents = await this.#listAgents(
          projectId,
          authenticated.context,
        );
        sendJson(response, 200, { items: agents });
        return;
      }
      if (segments[4] === "attentions" && segments.length === 5) {
        const page = await this.#kernel.query(
          {
            type: "ListOpenAttentions",
            projectId,
            ...optionalNumber(url, "afterCursor"),
            ...optionalString(url, "snapshotEventId"),
            limit: pageSize(url),
          },
          authenticated.context,
        );
        sendJson(response, 200, page);
        return;
      }
    }

    if (
      segments[2] === "channels" &&
      segments[3] &&
      segments[4] === "threads" &&
      segments.length === 5
    ) {
      const projectId = requiredQuery(url, "projectId");
      const page = await this.#kernel.query(
        {
          type: "ListThreadProjections",
          projectId,
          channelId: segments[3],
          ...optionalStringAs(url, "after", "afterEventId"),
          ...optionalStringAs(url, "snapshot", "snapshotEventId"),
          limit: pageSize(url),
        },
        authenticated.context,
      );
      sendJson(response, 200, {
        items: page.items,
        nextCursor: page.nextAfterEventId,
        hasMore: page.hasMore,
        snapshotEventId: page.snapshotEventId,
      });
      return;
    }

    if (segments[2] === "artifacts" && segments[3]) {
      if (segments.length === 4) {
        const artifact = await this.#kernel.query(
          { type: "GetArtifact", artifactId: segments[3] }, authenticated.context,
        );
        this.#requireCurrentAuthentication(authenticated);
        sendJson(response, 200, { artifact });
        return;
      }
      if (segments[4] === "content" && segments.length === 5) {
        const { artifact, content } = await this.#kernel.readArtifact(segments[3], authenticated.context);
        this.#requireCurrentAuthentication(authenticated);
        response.writeHead(200, {
          "Content-Type": artifact.mediaType,
          "Content-Length": content.byteLength,
          "Content-Disposition": 'attachment; filename="report.txt"',
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        response.end(content);
        return;
      }
    }

    if (segments[2] === "threads" && segments[3] && segments.length === 4) {
      const thread = await this.#kernel.query(
        { type: "GetThreadProjection", threadRootId: segments[3] },
        authenticated.context,
      );
      sendJson(response, 200, { thread });
      return;
    }

    if (segments[2] === "runs" && segments[3]) {
      if (segments.length === 4) {
        const run = await this.#kernel.query(
          { type: "GetRunProjection", runId: segments[3] },
          authenticated.context,
        );
        sendJson(response, 200, { run });
        return;
      }
      if (segments[4] === "activity" && segments.length === 5) {
        const activity = await this.#kernel.query(
          {
            type: "ListActivity",
            runId: segments[3],
            ...optionalNumber(url, "afterSequence"),
            ...optionalNumber(url, "beforeSequence"),
            limit: pageSize(url),
          },
          authenticated.context,
        );
        sendJson(response, 200, activity);
        return;
      }
    }

    throw new HttpError(404, "not_found", "The endpoint does not exist.");
  }

  async #listAgents(
    projectId: string,
    context: PrincipalContext,
  ): Promise<readonly unknown[]> {
    const [bootstrap, status] = await Promise.all([
      this.#kernel.query({ type: "GetBootstrap", projectId }, context),
      this.#kernel.query({ type: "GetProjectAgentStatus", projectId }, context),
    ]);
    const statusByAgentId = new Map(
      status.agents.map((agentStatus) => [agentStatus.agentId, agentStatus]),
    );
    return bootstrap.agents.map((agent) => ({
      ...agent,
      ...statusByAgentId.get(agent.id),
    }));
  }

  async #handleEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    authenticated: AuthenticatedRequest,
  ): Promise<void> {
    const projectId = requiredQuery(url, "projectId");
    await this.#kernel.query(
      { type: "GetBootstrap", projectId },
      authenticated.context,
    );
    const explicitCursor = url.searchParams.get("cursor");
    const headerCursor = singleHeader(request, "last-event-id");
    let cursor = headerCursor ?? explicitCursor ?? null;
    const requestedBatchSize = optionalInteger(
      url.searchParams.get("batchSize"),
      "batchSize",
    );
    const batchSize =
      requestedBatchSize === undefined
        ? this.#eventBatchSize
        : boundedInteger(
            requestedBatchSize,
            1,
            maximumPageSize,
            "batchSize",
          );
    let page = await this.#kernel.query(
      {
        type: "ReadPublicEvents",
        projectId,
        afterEventId: cursor,
        limit: batchSize,
      },
      authenticated.context,
    );

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();

    const controller = new AbortController();
    this.#eventStreams.add(controller);
    const disconnect = () => controller.abort();
    const expiryTimer =
      authenticated.sessionExpiresAt === undefined
        ? undefined
        : setTimeout(
            () => controller.abort(),
            Math.max(1, authenticated.sessionExpiresAt - Date.now()),
          );
    expiryTimer?.unref();
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    let lastWriteAt = Date.now();
    try {
      while (
        !controller.signal.aborted &&
        this.#authenticationIsCurrent(authenticated)
      ) {
        const previousCursor = cursor;
        cursor = page.scannedThroughEventId;
        for (const event of page.events) {
          if (!this.#authenticationIsCurrent(authenticated)) {
            controller.abort();
            break;
          }
          await writeStreamChunk(
            response,
            encodeSseEvent(event),
            controller.signal,
          );
          lastWriteAt = Date.now();
          if (controller.signal.aborted) {
            break;
          }
        }
        if (controller.signal.aborted || !this.#authenticationIsCurrent(authenticated)) {
          break;
        }
        if (cursor && cursor !== previousCursor && page.events.at(-1)?.eventId !== cursor) {
          await writeStreamChunk(
            response,
            `id: ${cursor}\nevent: checkpoint\ndata: ${JSON.stringify({ cursor })}\n\n`,
            controller.signal,
          );
          lastWriteAt = Date.now();
        }
        if (page.events.length === 0 && !page.hasMore) {
          await delay(
            this.#authenticationDelay(
              authenticated,
              this.#eventPollIntervalMs,
            ),
            controller.signal,
          );
          if (
            !controller.signal.aborted &&
            this.#authenticationIsCurrent(authenticated) &&
            Date.now() - lastWriteAt >= this.#heartbeatIntervalMs
          ) {
            await writeStreamChunk(
              response,
              `: heartbeat ${new Date().toISOString()}\n\n`,
              controller.signal,
            );
            lastWriteAt = Date.now();
          }
          if (
            controller.signal.aborted ||
            !this.#authenticationIsCurrent(authenticated)
          ) {
            break;
          }
          page = await this.#kernel.query(
            {
              type: "ReadPublicEvents",
              projectId,
              afterEventId: cursor,
              limit: batchSize,
            },
            authenticated.context,
          );
          continue;
        }
        if (page.hasMore) {
          await yieldToEventLoop();
        }
        page = await this.#kernel.query(
          {
            type: "ReadPublicEvents",
            projectId,
            afterEventId: cursor,
            limit: batchSize,
          },
          authenticated.context,
        );
      }
    } finally {
      request.off("aborted", disconnect);
      response.off("close", disconnect);
      if (expiryTimer) {
        clearTimeout(expiryTimer);
      }
      this.#eventStreams.delete(controller);
      if (!response.writableEnded) {
        response.end();
      }
    }
  }

  #authenticationIsCurrent(
    authenticated: AuthenticatedRequest,
  ): boolean {
    if (!authenticated.sessionId) {
      return true;
    }
    const session = this.#sessions.get(authenticated.sessionId);
    if (
      !session ||
      session.expiresAt <= Date.now() ||
      session.expiresAt !== authenticated.sessionExpiresAt ||
      session.csrfToken !== authenticated.sessionCsrfToken ||
      !sameContext(session.context, authenticated.context)
    ) {
      this.#sessions.delete(authenticated.sessionId);
      return false;
    }
    return true;
  }

  #requireCurrentAuthentication(
    authenticated: AuthenticatedRequest,
  ): void {
    if (
      authenticated.authentication === "session" &&
      !this.#authenticationIsCurrent(authenticated)
    ) {
      throw new HttpError(
        401,
        "unauthorized",
        "The browser session expired or was revoked.",
      );
    }
  }

  #authenticationDelay(
    authenticated: AuthenticatedRequest,
    maximumMs: number,
  ): number {
    if (authenticated.sessionExpiresAt === undefined) {
      return maximumMs;
    }
    return Math.max(
      1,
      Math.min(maximumMs, authenticated.sessionExpiresAt - Date.now()),
    );
  }

}

export function createTorsorHttpService(
  options: TorsorHttpServiceOptions,
): TorsorHttpService {
  return new Service(options);
}

async function readJsonObject(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      throw new HttpError(
        413,
        "payload_too_large",
        `The request body exceeds ${limitBytes} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new HttpError(
      400,
      "invalid_request",
      "The request body must be a JSON object.",
    );
  }
  return parsed;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  error: unknown,
  requestId: string,
): void {
  if (error instanceof HttpError) {
    if (error.status === 401) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="torsor-local"');
    }
    sendJson(response, error.status, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        requestId,
      },
    });
    return;
  }
  if (error instanceof KernelError) {
    const status = kernelStatus(error.code);
    if (status === 401) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="torsor-local"');
    }
    sendJson(response, status, {
      error: {
        code: snakeCase(error.code),
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        requestId,
      },
    });
    return;
  }
  sendJson(response, 500, {
    error: {
      code: "internal_error",
      message: "The server could not complete the request.",
      requestId,
    },
  });
}

function kernelStatus(code: KernelError["code"]): number {
  switch (code) {
    case "Unauthorized":
      return 401;
    case "Forbidden":
      return 403;
    case "NotFound":
      return 404;
    case "InvalidCommand":
      return 400;
    case "Conflict":
    case "DomainBusy":
    case "WriterAuthorityLost":
    case "CausalLimitExceeded":
    case "StaleRevision":
    case "ConditionalCheckFailed":
    case "TerminalRun":
    case "PendingRunInputs":
      return 409;
  }
  throw new Error(`Unknown Kernel error code: ${code satisfies never}`);
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = singleHeader(request, "authorization");
  if (!authorization) {
    return null;
  }
  const match = /^Bearer (.+)$/i.exec(authorization);
  if (!match?.[1]) {
    throw new HttpError(
      401,
      "unauthorized",
      "The Authorization header must use the Bearer scheme.",
    );
  }
  return match[1];
}

function cookieValue(
  request: IncomingMessage,
  name: string,
): string | null {
  const cookie = singleHeader(request, "cookie");
  if (!cookie) {
    return null;
  }
  for (const entry of cookie.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) {
      return value.join("=") || null;
    }
  }
  return null;
}

function singleHeader(
  request: IncomingMessage,
  name: string,
): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new HttpError(
        400,
        "invalid_header",
        `Header ${name} must have one value.`,
      );
    }
    return value[0] ?? null;
  }
  return value ?? null;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new HttpError(
      400,
      "invalid_request",
      `Query parameter ${name} is required.`,
    );
  }
  return value;
}

function pageSize(url: URL): number {
  const value = optionalInteger(url.searchParams.get("limit"), "limit");
  return value === undefined
    ? 50
    : boundedInteger(value, 1, maximumPageSize, "limit");
}

function optionalNumber(
  url: URL,
  name: string,
): Readonly<Record<string, number>> {
  const value = optionalInteger(url.searchParams.get(name), name);
  return value === undefined ? {} : { [name]: value };
}

function optionalString(
  url: URL,
  name: string,
): Readonly<Record<string, string | null>> {
  if (!url.searchParams.has(name)) {
    return {};
  }
  return { [name]: url.searchParams.get(name) };
}

function optionalStringAs(
  url: URL,
  queryName: string,
  propertyName: string,
): Readonly<Record<string, string | null>> {
  if (!url.searchParams.has(queryName)) {
    return {};
  }
  return { [propertyName]: url.searchParams.get(queryName) };
}

function optionalInteger(
  value: string | null,
  name: string,
): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new HttpError(
      400,
      "invalid_request",
      `${name} must be an integer.`,
    );
  }
  return parsed;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(
      400,
      "invalid_request",
      `${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sameContext(left: PrincipalContext, right: PrincipalContext): boolean {
  return (
    left.principalId === right.principalId &&
    left.activationId === right.activationId
  );
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function encodeSseEvent(event: PublicEventEnvelope): string {
  return `id: ${event.eventId}\nevent: torsor\ndata: ${JSON.stringify(event)}\n\n`;
}

async function writeStreamChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return;
  }
  if (response.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      response.off("drain", finish);
      response.off("close", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted || response.destroyed || response.writableEnded) {
      finish();
    }
  });
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
    timer.unref();
  });
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
