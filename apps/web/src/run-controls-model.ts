import { emptyRunCommand, isTerminalRun, needsRunRefresh, RunCommandModel, type RunCommandEntry, type RunCommandRequest } from "./run-composer-model";
import type { Run, RunInput } from "./types";

export type RunControlRequest = RunCommandRequest & (
  | { readonly kind: "cancel"; readonly reason: "Cancelled by Human from Run controls." }
  | {
    readonly kind: "withdraw";
    readonly runInputId: string;
    readonly expectedDispositionRevision: number;
    readonly reason: "Withdrawn by Human from Run controls.";
  }
);

interface RunControlReceipt {
  readonly commandType: "CancelRun" | "WithdrawRunInput";
  readonly entityId: string;
  readonly revision: number;
  readonly relatedIds?: { readonly runId: string; readonly runRevision: string };
}

export type RunControlEntry = RunCommandEntry<RunControlRequest, RunControlReceipt>;
const storageKey = "torsor.run-controls.v1";
type RecoveryStorage = Pick<Storage, "getItem" | "setItem">;

export function controlKey(runId: string, inputId?: string): string {
  return JSON.stringify([runId, inputId ?? null]);
}

export function controlUnavailable(run: Run, principalId: string | null, input?: RunInput): string | null {
  if (!principalId) return "Reconnect as a Human to use Run controls.";
  if (isTerminalRun(run)) return `Run is ${run.state}; new controls are unavailable.`;
  if (input && (input.runId !== run.id || input.disposition !== "Pending")) {
    return `Input is ${input.disposition}; only Pending input in this Run can be withdrawn.`;
  }
  if (input && input.assignedByPrincipalId !== principalId) return "Only the assigning Human can withdraw this input.";
  return null;
}

export class RunControlsModel extends RunCommandModel<RunControlRequest, RunControlReceipt> {
  recoveryError: string | null = null;

  constructor(readonly storage: RecoveryStorage) {
    super(requireControlReceipt);
    try {
      const saved = storage.getItem(storageKey);
      if (saved !== null) this.restore(readRecovery(saved));
    } catch {
      this.recoveryError = "Run control recovery could not be loaded. Controls are disabled; preserve this window's recovery storage.";
    }
  }

  protected override assertWritable(): void {
    if (this.recoveryError) throw new Error(this.recoveryError);
  }

  protected override changed(): void {
    if (this.recoveryError) return;
    // Whitelist recovery metadata: never persist drafts, server errors or payloads.
    const saved = Object.entries(this.getSnapshot()).flatMap(([key, entry]) => {
      const known = entry.acknowledged;
      const request = entry.request ?? known?.request;
      const principalId = entry.request ? entry.principalId : known?.principalId;
      return request ? [{
        key, request, principalId,
        ...(entry.request ? {} : { receipt: known!.receipt }),
      }] : [];
    });
    try {
      this.storage.setItem(storageKey, JSON.stringify(saved));
    } catch {
      this.recoveryError = "Run control recovery could not be saved. Controls are disabled; restore storage availability before reloading this window.";
    }
  }

  submit(
    run: Run,
    principalId: string,
    inputId: string | undefined,
    input: RunInput | undefined,
    available: boolean,
    send: (request: RunControlRequest) => Promise<unknown>,
  ): Promise<boolean> {
    const key = controlKey(run.id, inputId);
    return this.submitRequest(key, principalId, () => {
      const entry = this.getSnapshot()[key] ?? emptyRunCommand;
      if (entry.acknowledged) return "This action already committed. Refresh to read the durable outcome.";
      if (!available) return "Wait for the selected Run to finish refreshing.";
      if (entry.reviewRequired || needsRunRefresh(entry, run)) return "Refresh and review the Run and input before a new action.";
      const reason = controlUnavailable(run, principalId, input);
      if (reason) return reason;
      if (inputId !== undefined && !input) return "The selected input is unavailable. Refresh and review.";
      const common = { idempotencyKey: crypto.randomUUID(), runId: run.id, expectedRunRevision: run.revision };
      return input ? {
        ...common, kind: "withdraw", runInputId: input.id,
        expectedDispositionRevision: input.dispositionRevision,
        reason: "Withdrawn by Human from Run controls.",
      } : { ...common, kind: "cancel", reason: "Cancelled by Human from Run controls." };
    }, send);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireControlReceipt(value: unknown, request: RunControlRequest): RunControlReceipt {
  const result = record(value) ? value.result : null;
  if (record(result)) {
    if (request.kind === "cancel" && result.commandType === "CancelRun" &&
      result.entityId === request.runId && result.revision === request.expectedRunRevision + 1) {
      return { commandType: "CancelRun", entityId: request.runId, revision: result.revision };
    }
    if (request.kind === "withdraw" && result.commandType === "WithdrawRunInput" &&
      result.entityId === request.runInputId && result.revision === request.expectedDispositionRevision + 1 &&
      record(result.relatedIds) && result.relatedIds.runId === request.runId &&
      result.relatedIds.runRevision === String(request.expectedRunRevision + 1)) {
      return {
        commandType: "WithdrawRunInput", entityId: request.runInputId, revision: result.revision,
        relatedIds: { runId: request.runId, runRevision: result.relatedIds.runRevision },
      };
    }
  }
  throw new Error("The server response did not confirm the requested Run control action.");
}

function requireRequest(value: unknown): RunControlRequest {
  if (record(value) && typeof value.idempotencyKey === "string" && value.idempotencyKey &&
    typeof value.runId === "string" && value.runId &&
    typeof value.expectedRunRevision === "number" && Number.isSafeInteger(value.expectedRunRevision) && value.expectedRunRevision >= 1) {
    const common = { idempotencyKey: value.idempotencyKey, runId: value.runId, expectedRunRevision: value.expectedRunRevision };
    if (value.kind === "cancel" && value.reason === "Cancelled by Human from Run controls.") {
      return { ...common, kind: "cancel", reason: value.reason };
    }
    if (value.kind === "withdraw" && value.reason === "Withdrawn by Human from Run controls." &&
      typeof value.runInputId === "string" && value.runInputId &&
      typeof value.expectedDispositionRevision === "number" && Number.isSafeInteger(value.expectedDispositionRevision) && value.expectedDispositionRevision >= 1) {
      return { ...common, kind: "withdraw", runInputId: value.runInputId, expectedDispositionRevision: value.expectedDispositionRevision, reason: value.reason };
    }
  }
  throw new Error("Invalid Run control recovery request.");
}

function readRecovery(saved: string): Readonly<Record<string, RunControlEntry>> {
  const values: unknown = JSON.parse(saved);
  if (!Array.isArray(values)) throw new Error("Invalid Run control recovery data.");
  const entries: Record<string, RunControlEntry> = {};
  for (const value of values) {
    if (!record(value) || typeof value.principalId !== "string" || !value.principalId) throw new Error("Invalid recovery principal.");
    const request = requireRequest(value.request);
    const key = controlKey(request.runId, request.kind === "withdraw" ? request.runInputId : undefined);
    if (value.key !== key || entries[key]) throw new Error("Invalid recovery target.");
    entries[key] = value.receipt === undefined ? {
      ...emptyRunCommand, request, principalId: value.principalId, status: "unknown", uncertain: true,
    } : {
      ...emptyRunCommand, status: "submitted",
      acknowledged: { request, principalId: value.principalId, receipt: requireControlReceipt({ result: value.receipt }, request) },
    };
  }
  return entries;
}
