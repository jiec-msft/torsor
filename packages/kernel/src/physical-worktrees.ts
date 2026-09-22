import { randomBytes } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

import * as db from "./database.js";
import { DurableKernelError, KernelError } from "./errors.js";
import { assertActivationScopeCurrent, requireLiveActivation, requireRun } from "./invariants.js";
import { requireLiveAuthority } from "./worktree-writer-leases.js";
import type {
  CommandResult, KernelCommand, PhysicalWorktreeView, WorktreeExecutionReceipt,
  WorktreeExecutionState, WorktreeMutationAuthority,
} from "./types.js";
import { integer, optionalText, requireNonEmpty, text, type Row } from "./values.js";

type PhysicalCommand = Extract<KernelCommand, {
  type: "RegisterPhysicalWorktree" | "StartWorktreeExecution" |
    "RecordWorktreeExecution" | "RecoverWorktreeExecution";
}>;

export function physicalWorktreeCommand(
  kernel: db.KernelContext, command: PhysicalCommand, principal: Row, correlationId: string,
): CommandResult {
  requireRuntime(principal);
  if (command.type === "RegisterPhysicalWorktree") {
    for (const key of ["worktreeId", "repositoryId", "repositoryPath", "directoryPath", "directoryIdentity"] as const) {
      requireNonEmpty(command[key], key);
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(command.baseRevision)) {
      throw new KernelError("InvalidCommand", "A full immutable Git commit ID is required.");
    }
    requireRun(kernel, command.runId);
    for (const existing of db.allRows(kernel, "SELECT directory_path FROM physical_worktrees")) {
      if (contains(text(existing.directory_path), command.directoryPath) ||
          contains(command.directoryPath, text(existing.directory_path))) {
        throw new KernelError("Conflict", "Physical Worktree directories must be disjoint.");
      }
    }
    // Registration is a trusted local executor attestation, never an Agent path API.
    db.run(kernel, `INSERT INTO physical_worktrees
      (worktree_id, run_id, repository_id, repository_path, base_revision,
       directory_path, directory_identity, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Ready', ?)`,
    command.worktreeId, command.runId, command.repositoryId, command.repositoryPath,
    command.baseRevision, command.directoryPath, command.directoryIdentity, db.now(kernel));
    return { commandType: command.type, entityId: command.worktreeId };
  }
  if (command.type === "StartWorktreeExecution") {
    requireNonEmpty(command.executorId, "executorId");
    assertPhysicalWorktreeIdle(kernel, command.worktreeId);
    const worktree = requireWorktree(kernel, command.worktreeId);
    requireSourceActivation(kernel, text(worktree.run_id), command.activationId);
    requireLiveAuthority(kernel, command, principal, db.now(kernel), correlationId);
    const id = kernel.idFactory("worktree_execution");
    const token = randomBytes(32).toString("base64url");
    db.run(kernel, `INSERT INTO worktree_executions
      (id, worktree_id, activation_id, runtime_principal_id, executor_id, execution_token,
       generation, fencing_token, operation, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'write-probe-v1', 'Starting', ?)`,
    id, command.worktreeId, command.activationId, text(principal.id), command.executorId,
    token, command.generation, command.fencingToken, db.now(kernel));
    appendEvent(kernel, id, "Starting", "Durable intent before any file or process effect.");
    return { commandType: command.type, entityId: id, executionToken: token };
  }
  const execution = requireExecution(kernel, command.executionId);
  if (command.type === "RecoverWorktreeExecution") {
    requireNonEmpty(command.reason, "reason");
    if (!isStopped(text(execution.state)) && text(execution.state) !== "Uncertain") {
      recordState(kernel, execution, "Uncertain", command.reason);
    }
  } else {
    requireReceipt(execution, command, principal);
    requireNonEmpty(command.evidence, "evidence");
    const previous = text(execution.state);
    const allowed: Record<WorktreeExecutionState, readonly WorktreeExecutionState[]> = {
      Starting: ["Running", "StopRequested", "StopConfirmed", "Uncertain"],
      Running: ["StopRequested", "StopConfirmed", "Uncertain"],
      StopRequested: ["StopConfirmed", "ForceTerminated", "Uncertain"],
      Uncertain: ["StopConfirmed", "ForceTerminated"],
      StopConfirmed: [],
      ForceTerminated: [],
    };
    if (!allowed[previous as WorktreeExecutionState].includes(command.state)) {
      throw new KernelError("Conflict", `Invalid physical execution transition: ${previous} -> ${command.state}.`);
    }
    if (command.pid !== undefined) {
      if (!Number.isSafeInteger(command.pid) || command.pid < 1 ||
          (execution.pid !== null && integer(execution.pid) !== command.pid)) {
        throw new KernelError("Conflict", "Process identity cannot be replaced.");
      }
      db.run(kernel, "UPDATE worktree_executions SET pid = ? WHERE id = ?", command.pid, command.executionId);
    }
    recordState(kernel, execution, command.state, command.evidence);
  }
  return { commandType: command.type, entityId: command.executionId };
}

export function assertPhysicalWorktreeIdle(kernel: db.KernelContext, worktreeId: string, durable = false): void {
  const worktree = db.getRow(kernel, "SELECT state FROM physical_worktrees WHERE worktree_id = ?", worktreeId);
  const unsettled = db.getRow(kernel, `SELECT id FROM worktree_executions
    WHERE worktree_id = ? AND state NOT IN ('StopConfirmed', 'ForceTerminated')`, worktreeId);
  if (worktree?.state === "Quarantined" || unsettled) {
    const ErrorType = durable ? DurableKernelError : KernelError;
    throw new ErrorType("DomainBusy", "Physical Worktree stop is unconfirmed; lease reassignment or release is unsafe.");
  }
}

export function assertWorktreeMutation(
  kernel: db.KernelContext, authority: WorktreeMutationAuthority, principal: Row,
): void {
  requireRuntime(principal);
  const execution = requireExecution(kernel, authority.executionId);
  requireReceipt(execution, authority, principal);
  const worktree = requireWorktree(kernel, authority.worktreeId);
  if (text(execution.worktree_id) !== authority.worktreeId ||
      integer(execution.generation) !== authority.generation ||
      integer(execution.fencing_token) !== authority.fencingToken ||
      !["Starting", "Running"].includes(text(execution.state)) ||
      text(worktree.state) !== "Ready") {
    throw new KernelError("Conflict", "Physical execution no longer grants mutation authority.");
  }
  requireSourceActivation(kernel, text(worktree.run_id), text(execution.activation_id));
  requireLiveAuthority(kernel, authority, principal, db.now(kernel), kernel.idFactory("corr"));
}

export function resolveCachedWorktreeExecution(
  kernel: db.KernelContext, command: Extract<KernelCommand, { type: "StartWorktreeExecution" }>,
  result: CommandResult, principal: Row,
): CommandResult {
  assertWorktreeMutation(kernel, {
    ...command, executionId: result.entityId, executionToken: result.executionToken ?? "",
  }, principal);
  return result;
}

export function getPhysicalWorktree(
  kernel: db.KernelContext, worktreeId: string, principal: Row,
): PhysicalWorktreeView {
  requireRuntime(principal);
  const row = requireWorktree(kernel, worktreeId);
  const execution = db.getRow(kernel, `SELECT * FROM worktree_executions
    WHERE worktree_id = ? ORDER BY sequence DESC LIMIT 1`, worktreeId);
  return {
    worktreeId, runId: text(row.run_id), repositoryId: text(row.repository_id),
    repositoryPath: text(row.repository_path), baseRevision: text(row.base_revision),
    directoryPath: text(row.directory_path), directoryIdentity: text(row.directory_identity),
    state: text(row.state) as PhysicalWorktreeView["state"],
    latestExecution: execution ? {
      id: text(execution.id), activationId: text(execution.activation_id),
      executorId: text(execution.executor_id), runtimePrincipalId: text(execution.runtime_principal_id),
      generation: integer(execution.generation), fencingToken: integer(execution.fencing_token),
      state: text(execution.state) as WorktreeExecutionState,
      pid: execution.pid === null ? null : integer(execution.pid),
      events: db.allRows(kernel, `SELECT * FROM worktree_execution_events
        WHERE execution_id = ? ORDER BY sequence`, text(execution.id)).map((event) => ({
        state: text(event.state) as WorktreeExecutionState,
        evidence: text(event.evidence), occurredAt: text(event.occurred_at),
      })),
    } : null,
  };
}

function requireRuntime(principal: Row): void {
  if (text(principal.kind) !== "runtime") {
    throw new KernelError("Forbidden", "Physical Worktree operations require a trusted Runtime.");
  }
}

function requireSourceActivation(kernel: db.KernelContext, runId: string, activationId: string): void {
  const activation = requireLiveActivation(kernel, activationId);
  if (optionalText(activation.run_id) !== runId) {
    throw new KernelError("Forbidden", "Physical Worktree belongs to a different Run.");
  }
  assertActivationScopeCurrent(kernel, activation);
}

function requireReceipt(execution: Row, receipt: WorktreeExecutionReceipt, principal: Row): void {
  if (text(execution.executor_id) !== receipt.executorId ||
      text(execution.execution_token) !== receipt.executionToken ||
      text(execution.runtime_principal_id) !== text(principal.id)) {
    throw new KernelError("Forbidden", "Original executor receipt is required.");
  }
}

function requireWorktree(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM physical_worktrees WHERE worktree_id = ?", id);
  if (!row) throw new KernelError("NotFound", "Physical Worktree is not registered.");
  return row;
}

function requireExecution(kernel: db.KernelContext, id: string): Row {
  const row = db.getRow(kernel, "SELECT * FROM worktree_executions WHERE id = ?", id);
  if (!row) throw new KernelError("NotFound", "Physical execution does not exist.");
  return row;
}

function isStopped(state: string): boolean {
  return state === "StopConfirmed" || state === "ForceTerminated";
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function recordState(kernel: db.KernelContext, execution: Row, state: WorktreeExecutionState, evidence: string): void {
  db.run(kernel, "UPDATE worktree_executions SET state = ? WHERE id = ?", state, text(execution.id));
  if (state === "Uncertain" || isStopped(state)) {
    db.run(kernel, "UPDATE physical_worktrees SET state = ? WHERE worktree_id = ?",
      state === "Uncertain" ? "Quarantined" : "Ready", text(execution.worktree_id));
  }
  appendEvent(kernel, text(execution.id), state, evidence);
}

function appendEvent(kernel: db.KernelContext, id: string, state: WorktreeExecutionState, evidence: string): void {
  db.run(kernel, `INSERT INTO worktree_execution_events (execution_id, state, evidence, occurred_at)
    VALUES (?, ?, ?, ?)`, id, state, evidence, db.now(kernel));
}
