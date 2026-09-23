import { ApiError } from "./api";
import type { Run } from "./types";

export interface RunCommandRequest {
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly expectedRunRevision: number;
}

export interface SendToRunRequest extends RunCommandRequest {
  readonly body: string;
}

export interface RunCommandEntry<Request extends RunCommandRequest, Receipt> {
  readonly draft: string;
  readonly status: "draft" | "submitting" | "unknown" | "auth-required" | "rejected" | "submitted";
  readonly request: Request | null;
  readonly principalId: string | null;
  readonly uncertain: boolean;
  readonly error: string | null;
  readonly rejectionCode: string | null;
  readonly rejectedRevision: number | null;
  readonly reviewRequired: boolean;
  readonly acknowledged: {
    readonly request: Request;
    readonly principalId: string;
    readonly receipt: Receipt;
  } | null;
  readonly projectionStatus: "idle" | "refreshing" | "failed";
}

export type RunComposerEntry = RunCommandEntry<SendToRunRequest, SendToRunReceipt>;

interface SendToRunReceipt {
  readonly messageId: string;
  readonly messageRevisionId: string;
  readonly runInputId: string;
  readonly runId: string;
  readonly revision: number;
}

export const emptyRunCommand: RunCommandEntry<never, never> = {
  draft: "",
  status: "draft",
  request: null,
  principalId: null,
  uncertain: false,
  error: null,
  rejectionCode: null,
  rejectedRevision: null,
  reviewRequired: false,
  acknowledged: null,
  projectionStatus: "idle",
};

export const emptyRunComposer: RunComposerEntry = emptyRunCommand;

export function isTerminalRun(run: Run): boolean {
  return ["Completed", "Failed", "Cancelled"].includes(run.state);
}

export function needsRunRefresh(entry: Pick<RunComposerEntry, "rejectionCode" | "rejectedRevision">, run: Run): boolean {
  return entry.rejectionCode === "stale_revision" && entry.rejectedRevision === run.revision;
}

/** Shared immutable request, receipt, and recovery lifecycle for Human Run commands. */
export class RunCommandModel<Request extends RunCommandRequest, Receipt> {
  readonly #listeners = new Set<() => void>();
  #entries: Readonly<Record<string, RunCommandEntry<Request, Receipt>>> = {};
  readonly #refreshVersions = new Map<string, number>();

  constructor(readonly receipt: (value: unknown, request: Request) => Receipt) {}

  getSnapshot = (): Readonly<Record<string, RunCommandEntry<Request, Receipt>>> => this.#entries;

  protected restore(entries: Readonly<Record<string, RunCommandEntry<Request, Receipt>>>): void {
    this.#entries = entries;
  }

  protected changed(): void {}

  protected assertWritable(): void {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  edit(runId: string, draft: string): void {
    const entry = this.#entries[runId] ?? emptyRunCommand;
    if (entry.request) {
      throw new Error("Recover the original submission before editing its draft.");
    }
    this.set(runId, {
      ...entry,
      draft,
      ...(entry.status === "submitted" ? { status: "draft", error: null } as const : {}),
    });
  }

  beginRefresh(runId: string): (succeeded: boolean) => void {
    const version = (this.#refreshVersions.get(runId) ?? 0) + 1;
    this.#refreshVersions.set(runId, version);
    this.set(runId, {
      ...(this.#entries[runId] ?? emptyRunCommand), projectionStatus: "refreshing",
    });
    return (succeeded) => {
      if (this.#refreshVersions.get(runId) !== version) return;
      this.set(runId, {
        ...this.#entries[runId]!, projectionStatus: succeeded ? "idle" : "failed",
        ...(succeeded ? { reviewRequired: false } : {}),
      });
    };
  }

  protected async submitRequest(
    key: string,
    principalId: string,
    create: () => Request | string,
    send: (request: Request) => Promise<unknown>,
  ): Promise<boolean> {
    this.assertWritable();
    const entry = this.#entries[key] ?? emptyRunCommand;
    if (entry.status === "submitting") return false;
    if (entry.request && entry.principalId !== principalId) {
      this.set(key, {
        ...entry,
        error: "Reconnect as the original Human to recover this submission.",
      });
      return false;
    }
    const request = entry.request ?? create();
    if (typeof request === "string") {
      this.set(key, { ...entry, error: request });
      return false;
    }
    const pending: RunCommandEntry<Request, Receipt> = {
      ...entry, request, principalId, status: "submitting", error: null,
      rejectionCode: null, rejectedRevision: null,
    };
    this.set(key, pending);
    try {
      this.assertWritable();
    } catch (error) {
      this.set(key, entry);
      throw error;
    }
    try {
      const response = await send(request);
      const receipt = this.receipt(response, request);
      this.#refreshVersions.set(key, (this.#refreshVersions.get(key) ?? 0) + 1);
      this.set(key, {
        ...emptyRunCommand, status: "submitted",
        acknowledged: { request, principalId, receipt },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The submission response could not be read.";
      const authentication = error instanceof ApiError &&
        (error.status === 401 || (error.status === 403 && error.code === "invalid_csrf_token"));
      // These domain checks run after the idempotency lookup. An exact replay
      // that had committed would instead have returned its stored receipt.
      const domainRejection = error instanceof ApiError && error.requestId &&
        ["stale_revision", "terminal_run", "invalid_command"].includes(error.code);
      const initialRejection = !pending.uncertain && error instanceof ApiError &&
        error.requestId && error.status >= 400 && error.status < 500 &&
        (["forbidden", "not_found", "invalid_request", "conflict"].includes(error.code) ||
          (error.status === 413 && error.code === "payload_too_large"));
      if (domainRejection || initialRejection) {
        this.set(key, {
          ...pending, status: "rejected", request: null, uncertain: false,
          error: message, rejectionCode: error.code,
          rejectedRevision: request.expectedRunRevision,
          reviewRequired: true,
        });
      } else {
        const uncertain = pending.uncertain || !authentication;
        this.set(key, {
          ...pending, status: uncertain ? "unknown" : "auth-required",
          uncertain, error: message,
        });
      }
      return false;
    }
  }

  protected set(runId: string, entry: RunCommandEntry<Request, Receipt>): void {
    this.#entries = { ...this.#entries, [runId]: entry };
    this.changed();
    for (const listener of this.#listeners) listener();
  }
}

/** Window-local drafts outlive the mounted pane and browser authentication. */
export class RunComposerModel extends RunCommandModel<SendToRunRequest, SendToRunReceipt> {
  constructor() {
    super(requireSendToRunReceipt);
  }

  submit(run: Run, principalId: string, send: (request: SendToRunRequest) => Promise<unknown>): Promise<boolean> {
    return this.submitRequest(run.id, principalId, () => {
      const entry = this.getSnapshot()[run.id] ?? emptyRunComposer;
      if (isTerminalRun(run)) return "This Run is terminal. Request follow-up in the public Thread.";
      if (needsRunRefresh(entry, run)) return "Refresh the Run revision and review it before sending again.";
      if (!entry.draft.trim()) return "Enter a Run input before sending.";
      return {
        idempotencyKey: crypto.randomUUID(), runId: run.id,
        body: entry.draft.trim(), expectedRunRevision: run.revision,
      };
    }, send);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireSendToRunReceipt(value: unknown, request: SendToRunRequest): SendToRunReceipt {
  const result = isRecord(value) ? value.result : null;
  const related = isRecord(result) ? result.relatedIds : null;
  if (
    !isRecord(result) || result.commandType !== "SendToRun" ||
    typeof result.entityId !== "string" || !result.entityId ||
    typeof result.revision !== "number" || result.revision !== request.expectedRunRevision + 1 ||
    !isRecord(related) || related.runId !== request.runId ||
    typeof related.messageRevisionId !== "string" || !related.messageRevisionId ||
    typeof related.runInputId !== "string" || !related.runInputId
  ) {
    throw new Error("The server response did not confirm both Message and RunInput.");
  }
  return {
    messageId: result.entityId,
    messageRevisionId: related.messageRevisionId,
    runInputId: related.runInputId,
    runId: related.runId,
    revision: result.revision,
  };
}
