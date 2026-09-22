import { ApiError } from "./api";
import type { Run } from "./types";

export interface SendToRunRequest {
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly body: string;
  readonly expectedRunRevision: number;
}

export interface RunComposerEntry {
  readonly draft: string;
  readonly status: "draft" | "submitting" | "unknown" | "auth-required" | "rejected" | "submitted";
  readonly request: SendToRunRequest | null;
  readonly principalId: string | null;
  readonly uncertain: boolean;
  readonly error: string | null;
  readonly rejectionCode: string | null;
  readonly rejectedRevision: number | null;
  readonly acknowledged: {
    readonly request: SendToRunRequest;
    readonly principalId: string;
    readonly receipt: SendToRunReceipt;
  } | null;
  readonly projectionStatus: "idle" | "refreshing" | "failed";
}

interface SendToRunReceipt {
  readonly messageId: string;
  readonly messageRevisionId: string;
  readonly runInputId: string;
  readonly runId: string;
  readonly revision: number;
}

export const emptyRunComposer: RunComposerEntry = {
  draft: "",
  status: "draft",
  request: null,
  principalId: null,
  uncertain: false,
  error: null,
  rejectionCode: null,
  rejectedRevision: null,
  acknowledged: null,
  projectionStatus: "idle",
};

export function isTerminalRun(run: Run): boolean {
  return ["Completed", "Failed", "Cancelled"].includes(run.state);
}

export function needsRunRefresh(entry: RunComposerEntry, run: Run): boolean {
  return entry.rejectionCode === "stale_revision" && entry.rejectedRevision === run.revision;
}

/** Window-local drafts outlive the mounted pane and browser authentication. */
export class RunComposerModel {
  readonly #listeners = new Set<() => void>();
  #entries: Readonly<Record<string, RunComposerEntry>> = {};
  readonly #refreshVersions = new Map<string, number>();

  getSnapshot = (): Readonly<Record<string, RunComposerEntry>> => this.#entries;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  edit(runId: string, draft: string): void {
    const entry = this.#entries[runId] ?? emptyRunComposer;
    if (entry.request) {
      throw new Error("Recover the original submission before editing its draft.");
    }
    this.#set(runId, {
      ...entry,
      draft,
      ...(entry.status === "submitted" ? { status: "draft", error: null } as const : {}),
    });
  }

  beginRefresh(runId: string): (succeeded: boolean) => void {
    const version = (this.#refreshVersions.get(runId) ?? 0) + 1;
    this.#refreshVersions.set(runId, version);
    this.#set(runId, {
      ...(this.#entries[runId] ?? emptyRunComposer), projectionStatus: "refreshing",
    });
    return (succeeded) => {
      if (this.#refreshVersions.get(runId) !== version) return;
      this.#set(runId, {
        ...this.#entries[runId]!, projectionStatus: succeeded ? "idle" : "failed",
      });
    };
  }

  async submit(
    run: Run,
    principalId: string,
    send: (request: SendToRunRequest) => Promise<unknown>,
  ): Promise<boolean> {
    const entry = this.#entries[run.id] ?? emptyRunComposer;
    if (entry.status === "submitting") return false;
    if (entry.request && entry.principalId !== principalId) {
      this.#set(run.id, {
        ...entry,
        error: "Reconnect as the original Human to recover this submission.",
      });
      return false;
    }
    if (!entry.request && (isTerminalRun(run) || needsRunRefresh(entry, run) || !entry.draft.trim())) {
      this.#set(run.id, {
        ...entry,
        error: isTerminalRun(run)
          ? "This Run is terminal. Request follow-up in the public Thread."
          : needsRunRefresh(entry, run)
            ? "Refresh the Run revision and review it before sending again."
            : "Enter a Run input before sending.",
      });
      return false;
    }
    const request = entry.request ?? {
      idempotencyKey: crypto.randomUUID(),
      runId: run.id,
      body: entry.draft.trim(),
      expectedRunRevision: run.revision,
    };
    const pending: RunComposerEntry = {
      ...entry, request, principalId, status: "submitting", error: null,
      rejectionCode: null, rejectedRevision: null,
    };
    this.#set(run.id, pending);
    try {
      const response = await send(request);
      const receipt = requireSendToRunReceipt(response, request);
      this.#refreshVersions.set(run.id, (this.#refreshVersions.get(run.id) ?? 0) + 1);
      this.#set(run.id, {
        ...emptyRunComposer, status: "submitted",
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
        this.#set(run.id, {
          ...pending, status: "rejected", request: null, uncertain: false,
          error: message, rejectionCode: error.code,
          rejectedRevision: request.expectedRunRevision,
        });
      } else {
        const uncertain = pending.uncertain || !authentication;
        this.#set(run.id, {
          ...pending, status: uncertain ? "unknown" : "auth-required",
          uncertain, error: message,
        });
      }
      return false;
    }
  }

  #set(runId: string, entry: RunComposerEntry): void {
    this.#entries = { ...this.#entries, [runId]: entry };
    for (const listener of this.#listeners) listener();
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
