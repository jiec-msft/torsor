import { randomBytes } from "node:crypto";

import * as db from "./database.js";
import { DurableKernelError, KernelError } from "./errors.js";
import { assertPhysicalWorktreeIdle } from "./physical-worktrees.js";
import {
  mapWorktreeWriterLease,
  mapWorktreeWriterLeaseEvent,
} from "./mappings.js";
import type {
  CommandResult,
  JsonValue,
  KernelCommand,
  WorktreeWriterLeaseEventPage,
  WorktreeWriterLeaseEventType,
  WorktreeWriterLeaseView,
  WorktreeLeaseAuthority,
} from "./types.js";
import {
  boundedDuration,
  integer,
  optionalText,
  requireNonEmpty,
  text,
  type Row,
} from "./values.js";

type AcquireCommand = Extract<
  KernelCommand,
  { type: "AcquireWorktreeWriterLease" }
>;
type RenewCommand = Extract<
  KernelCommand,
  { type: "RenewWorktreeWriterLease" }
>;
type ReleaseCommand = Extract<
  KernelCommand,
  { type: "ReleaseWorktreeWriterLease" }
>;
type QuarantineCommand = Extract<
  KernelCommand,
  { type: "QuarantineWorktreeWriterLease" }
>;
type ResolveQuarantineCommand = Extract<
  KernelCommand,
  { type: "ResolveWorktreeWriterLeaseQuarantine" }
>;

export function acquireWorktreeWriterLease(
  kernel: db.KernelContext,
  command: AcquireCommand,
  principal: Row,
  correlationId: string,
): CommandResult {
  requireRuntime(principal);
  requireNonEmpty(command.worktreeId, "worktreeId");
  const durationMs = boundedDuration(command.leaseDurationMs, "leaseDurationMs");
  const observedAt = db.now(kernel);
  const previous = getLease(kernel, command.worktreeId);
  const existing = expireIfNeeded(
    kernel,
    previous,
    text(principal.id),
    correlationId,
    observedAt,
  );
  assertPhysicalWorktreeIdle(kernel, command.worktreeId,
    previous?.status === "Active" && existing?.status === "Expired");
  if (existing && text(existing.status) === "Active") {
    throw new KernelError(
      "DomainBusy",
      "The Worktree already has an active writer lease.",
    );
  }
  if (existing && text(existing.status) === "Quarantined") {
    throw new KernelError(
      "DomainBusy",
      "The Worktree writer state is quarantined and must be resolved before acquisition.",
    );
  }

  const revision = existing ? integer(existing.revision) + 1 : 1;
  const generation = existing ? integer(existing.generation) + 1 : 1;
  const fencingToken = existing ? integer(existing.fencing_token) + 1 : 1;
  const leaseToken = secretToken("wlt");
  const expiresAt = new Date(
    new Date(observedAt).getTime() + durationMs,
  ).toISOString();
  db.run(
    kernel,
    `INSERT INTO worktree_writer_leases
      (worktree_id, revision, generation, fencing_token, status,
       holder_principal_id, lease_token, acquired_at, renewed_at, expires_at,
       released_at, quarantine_reason, quarantine_evidence_json,
       quarantine_token, quarantined_at, quarantine_resolved_at,
       quarantine_resolution,
       updated_at)
     VALUES (?, ?, ?, ?, 'Active', ?, ?, ?, NULL, ?, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, ?)
     ON CONFLICT(worktree_id) DO UPDATE SET
       revision = excluded.revision,
       generation = excluded.generation,
       fencing_token = excluded.fencing_token,
       status = excluded.status,
       holder_principal_id = excluded.holder_principal_id,
       lease_token = excluded.lease_token,
       acquired_at = excluded.acquired_at,
       renewed_at = NULL,
       expires_at = excluded.expires_at,
       released_at = NULL,
       quarantine_reason = NULL,
       quarantine_token = NULL,
       quarantine_evidence_json = NULL,
       quarantined_at = NULL,
       quarantine_resolved_at = NULL,
       quarantine_resolution = NULL,
       updated_at = excluded.updated_at`,
    command.worktreeId,
    revision,
    generation,
    fencingToken,
    text(principal.id),
    leaseToken,
    observedAt,
    expiresAt,
    observedAt,
  );
  const lease = requireLease(kernel, command.worktreeId);
  appendEvent(
    kernel,
    lease,
    "WorktreeWriterLeaseAcquired",
    text(principal.id),
    correlationId,
  );
  return authorityResult(command.type, lease, observedAt);
}

export function renewWorktreeWriterLease(
  kernel: db.KernelContext,
  command: RenewCommand,
  principal: Row,
  correlationId: string,
): CommandResult {
  requireRuntime(principal);
  const durationMs = boundedDuration(command.leaseDurationMs, "leaseDurationMs");
  const observedAt = db.now(kernel);
  const lease = requireLiveAuthority(
    kernel,
    command,
    principal,
    observedAt,
    correlationId,
  );
  const revision = integer(lease.revision) + 1;
  const expiresAt = new Date(
    new Date(observedAt).getTime() + durationMs,
  ).toISOString();
  db.run(
    kernel,
    `UPDATE worktree_writer_leases
        SET revision = ?,
            renewed_at = ?,
            expires_at = ?,
            updated_at = ?
      WHERE worktree_id = ?`,
    revision,
    observedAt,
    expiresAt,
    observedAt,
    command.worktreeId,
  );
  const renewed = requireLease(kernel, command.worktreeId);
  appendEvent(
    kernel,
    renewed,
    "WorktreeWriterLeaseRenewed",
    text(principal.id),
    correlationId,
  );
  return authorityResult(command.type, renewed, observedAt);
}

export function releaseWorktreeWriterLease(
  kernel: db.KernelContext,
  command: ReleaseCommand,
  principal: Row,
  correlationId: string,
): CommandResult {
  requireRuntime(principal);
  const observedAt = db.now(kernel);
  const lease = requireLiveAuthority(
    kernel,
    command,
    principal,
    observedAt,
    correlationId,
  );
  assertPhysicalWorktreeIdle(kernel, command.worktreeId);
  db.run(
    kernel,
    `UPDATE worktree_writer_leases
        SET revision = ?,
            status = 'Released',
            holder_principal_id = NULL,
            lease_token = NULL,
            expires_at = NULL,
            released_at = ?,
            updated_at = ?
      WHERE worktree_id = ?`,
    integer(lease.revision) + 1,
    observedAt,
    observedAt,
    command.worktreeId,
  );
  const released = requireLease(kernel, command.worktreeId);
  appendEvent(
    kernel,
    released,
    "WorktreeWriterLeaseReleased",
    text(principal.id),
    correlationId,
  );
  return stateResult(command.type, released);
}

export function quarantineWorktreeWriterLease(
  kernel: db.KernelContext,
  command: QuarantineCommand,
  principal: Row,
  correlationId: string,
): CommandResult {
  requireRuntime(principal);
  requireNonEmpty(command.worktreeId, "worktreeId");
  requireNonEmpty(command.reason, "reason");
  const observedAt = db.now(kernel);
  const current = getLease(kernel, command.worktreeId);
  const materializedExpiry =
    current !== undefined &&
    text(current.status) === "Active" &&
    optionalText(current.expires_at) !== null &&
    text(current.expires_at) <= observedAt;
  const existing = expireIfNeeded(
    kernel,
    current,
    text(principal.id),
    correlationId,
    observedAt,
  );
  if (existing && text(existing.status) === "Quarantined") {
    throw new KernelError(
      "Conflict",
      "The Worktree writer state is already quarantined.",
    );
  }
  requireQuarantineAuthority(command, existing, principal, observedAt);
  if (
    command.expectedGeneration !== undefined &&
    (!existing ||
      integer(existing.generation) !== command.expectedGeneration)
  ) {
    throw staleAuthority(
      command.expectedGeneration,
      command.expectedFencingToken,
      existing,
      materializedExpiry,
    );
  }
  if (
    command.expectedFencingToken !== undefined &&
    (!existing ||
      integer(existing.fencing_token) !== command.expectedFencingToken)
  ) {
    throw staleAuthority(
      command.expectedGeneration,
      command.expectedFencingToken,
      existing,
      materializedExpiry,
    );
  }

  const revision = existing ? integer(existing.revision) + 1 : 1;
  const generation = existing ? integer(existing.generation) : 0;
  const fencingToken = existing ? integer(existing.fencing_token) + 1 : 1;
  const quarantineToken = secretToken("wqt");
  db.run(
    kernel,
    `INSERT INTO worktree_writer_leases
      (worktree_id, revision, generation, fencing_token, status,
       holder_principal_id, lease_token, acquired_at, renewed_at, expires_at,
       released_at, quarantine_reason, quarantine_token,
       quarantine_evidence_json, quarantined_at, quarantine_resolved_at,
       quarantine_resolution,
       updated_at)
     VALUES (?, ?, ?, ?, 'Quarantined', NULL, NULL, NULL, NULL, NULL, NULL,
             ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(worktree_id) DO UPDATE SET
       revision = excluded.revision,
       generation = excluded.generation,
       fencing_token = excluded.fencing_token,
       status = excluded.status,
       holder_principal_id = NULL,
       lease_token = NULL,
       expires_at = NULL,
       released_at = NULL,
       quarantine_reason = excluded.quarantine_reason,
       quarantine_token = excluded.quarantine_token,
       quarantine_evidence_json = excluded.quarantine_evidence_json,
       quarantined_at = excluded.quarantined_at,
       quarantine_resolved_at = NULL,
       quarantine_resolution = NULL,
       updated_at = excluded.updated_at`,
    command.worktreeId,
    revision,
    generation,
    fencingToken,
    command.reason,
    quarantineToken,
    command.evidence === undefined ? null : JSON.stringify(command.evidence),
    observedAt,
    observedAt,
  );
  const quarantined = requireLease(kernel, command.worktreeId);
  appendEvent(
    kernel,
    quarantined,
    "WorktreeWriterLeaseQuarantined",
    text(principal.id),
    correlationId,
    command.reason,
    command.evidence,
  );
  return stateResult(command.type, quarantined, quarantineToken);
}

export function resolveWorktreeWriterLeaseQuarantine(
  kernel: db.KernelContext,
  command: ResolveQuarantineCommand,
  principal: Row,
  correlationId: string,
): CommandResult {
  requireRuntime(principal);
  assertPhysicalWorktreeIdle(kernel, command.worktreeId);
  requireNonEmpty(command.worktreeId, "worktreeId");
  requireNonEmpty(command.quarantineToken, "quarantineToken");
  requireNonEmpty(command.resolution, "resolution");
  const lease = requireLease(kernel, command.worktreeId);
  if (
    integer(lease.revision) !== command.expectedRevision ||
    integer(lease.fencing_token) !== command.expectedFencingToken ||
    optionalText(lease.quarantine_token) !== command.quarantineToken
  ) {
    throw new KernelError(
      "ConditionalCheckFailed",
      "The Worktree writer quarantine expectation is stale.",
      {
        expectedRevision: command.expectedRevision,
        actualRevision: integer(lease.revision),
        expectedFencingToken: command.expectedFencingToken,
        actualFencingToken: integer(lease.fencing_token),
      },
    );
  }
  if (text(lease.status) !== "Quarantined") {
    throw new KernelError(
      "Conflict",
      "The Worktree writer state is not quarantined.",
    );
  }
  const observedAt = db.now(kernel);
  db.run(
    kernel,
    `UPDATE worktree_writer_leases
        SET revision = ?,
            status = 'Released',
            quarantine_reason = NULL,
            quarantine_token = NULL,
            quarantine_evidence_json = NULL,
            quarantined_at = NULL,
            quarantine_resolved_at = ?,
            quarantine_resolution = ?,
            updated_at = ?
      WHERE worktree_id = ?`,
    integer(lease.revision) + 1,
    observedAt,
    command.resolution,
    observedAt,
    command.worktreeId,
  );
  const resolved = requireLease(kernel, command.worktreeId);
  appendEvent(
    kernel,
    resolved,
    "WorktreeWriterLeaseQuarantineResolved",
    text(principal.id),
    correlationId,
    command.resolution,
  );
  return stateResult(command.type, resolved);
}

export function getWorktreeWriterLease(
  kernel: db.KernelContext,
  worktreeId: string,
  principal: Row,
): WorktreeWriterLeaseView {
  requireRuntime(principal);
  requireNonEmpty(worktreeId, "worktreeId");
  const observedAt = db.now(kernel);
  const lease = expireIfNeeded(
    kernel,
    requireLease(kernel, worktreeId),
    text(principal.id),
    kernel.idFactory("corr"),
    observedAt,
  );
  return mapWorktreeWriterLease(lease!);
}

export function listWorktreeWriterLeaseEvents(
  kernel: db.KernelContext,
  worktreeId: string,
  afterCursor: number,
  limit: number,
  principal: Row,
): WorktreeWriterLeaseEventPage {
  requireRuntime(principal);
  requireNonEmpty(worktreeId, "worktreeId");
  const rows = db.allRows(
    kernel,
    `SELECT *
       FROM worktree_writer_lease_events
      WHERE worktree_id = ?
        AND sequence > ?
      ORDER BY sequence
      LIMIT ?`,
    worktreeId,
    afterCursor,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapWorktreeWriterLeaseEvent);
  return {
    items,
    nextCursor: items.at(-1)?.cursor ?? null,
    hasMore,
  };
}

export function resolveCachedWorktreeWriterLeaseAuthority(
  kernel: db.KernelContext,
  command: AcquireCommand | RenewCommand,
  result: CommandResult,
  principal: Row,
): CommandResult {
  const cached = result.worktreeWriterLease;
  if (!cached || !result.leaseToken) {
    throw new KernelError(
      "Conflict",
      "The cached Worktree writer lease result is invalid.",
    );
  }
  const lease = requireLease(kernel, command.worktreeId);
  const observedAt = db.now(kernel);
  if (
    text(lease.status) === "Active" &&
    optionalText(lease.expires_at) &&
    text(lease.expires_at) <= observedAt
  ) {
    expireIfNeeded(
      kernel,
      lease,
      text(principal.id),
      kernel.idFactory("corr"),
      observedAt,
    );
    throw new DurableKernelError(
      "Conflict",
      "The cached Worktree writer lease has expired.",
    );
  }
  if (
    text(lease.status) !== "Active" ||
    optionalText(lease.holder_principal_id) !== text(principal.id) ||
    optionalText(lease.lease_token) !== result.leaseToken ||
    integer(lease.generation) !== result.leaseGeneration ||
    integer(lease.fencing_token) !== result.fencingToken ||
    !optionalText(lease.expires_at) ||
    text(lease.expires_at) <= observedAt
  ) {
    throw new KernelError(
      "Conflict",
      "The cached Worktree writer lease no longer grants live authority.",
    );
  }
  return authorityResult(command.type, lease, observedAt);
}

export function resolveCachedWorktreeWriterLeaseQuarantine(
  kernel: db.KernelContext,
  command: QuarantineCommand,
  result: CommandResult,
  principal: Row,
): CommandResult {
  if (
    !result.quarantineToken ||
    result.revision === undefined ||
    result.fencingToken === undefined
  ) {
    throw new KernelError(
      "Conflict",
      "The cached Worktree writer quarantine result is invalid.",
    );
  }
  const lease = requireLease(kernel, command.worktreeId);
  const observedAt = db.now(kernel);
  if (
    text(lease.status) === "Active" &&
    optionalText(lease.expires_at) &&
    text(lease.expires_at) <= observedAt
  ) {
    expireIfNeeded(
      kernel,
      lease,
      text(principal.id),
      kernel.idFactory("corr"),
      observedAt,
    );
    throw new DurableKernelError(
      "Conflict",
      "The cached Worktree writer quarantine is no longer current.",
    );
  }
  if (
    text(lease.status) !== "Quarantined" ||
    integer(lease.revision) !== result.revision ||
    integer(lease.fencing_token) !== result.fencingToken ||
    optionalText(lease.quarantine_token) !== result.quarantineToken
  ) {
    throw new KernelError(
      "Conflict",
      "The cached Worktree writer quarantine is no longer current.",
    );
  }
  return stateResult(command.type, lease, result.quarantineToken);
}

function requireQuarantineAuthority(
  command: QuarantineCommand,
  lease: Row | undefined,
  principal: Row,
  observedAt: string,
): void {
  if (!lease || text(lease.status) !== "Active") {
    return;
  }
  if (
    command.expectedGeneration === undefined ||
    command.expectedFencingToken === undefined ||
    command.leaseToken === undefined
  ) {
    throw new KernelError(
      "ConditionalCheckFailed",
      "Quarantining an active Worktree writer lease requires its exact live authority.",
    );
  }
  requireNonEmpty(command.leaseToken, "leaseToken");
  if (
    integer(lease.generation) !== command.expectedGeneration ||
    integer(lease.fencing_token) !== command.expectedFencingToken ||
    optionalText(lease.lease_token) !== command.leaseToken
  ) {
    throw staleAuthority(
      command.expectedGeneration,
      command.expectedFencingToken,
      lease,
    );
  }
  if (
    optionalText(lease.holder_principal_id) !== text(principal.id) ||
    !optionalText(lease.expires_at) ||
    text(lease.expires_at) <= observedAt
  ) {
    throw new KernelError(
      "Conflict",
      "The Worktree writer lease is not live authority held by this Runtime.",
    );
  }
}

export function requireLiveAuthority(
  kernel: db.KernelContext,
  command: WorktreeLeaseAuthority,
  principal: Row,
  observedAt: string,
  correlationId: string,
): Row {
  requireNonEmpty(command.worktreeId, "worktreeId");
  requireNonEmpty(command.leaseToken, "leaseToken");
  const lease = requireLease(kernel, command.worktreeId);
  if (
    text(lease.status) === "Active" &&
    optionalText(lease.expires_at) &&
    text(lease.expires_at) <= observedAt
  ) {
    expireIfNeeded(
      kernel,
      lease,
      text(principal.id),
      correlationId,
      observedAt,
    );
    throw new DurableKernelError(
      "Conflict",
      "The Worktree writer lease has expired.",
    );
  }
  if (text(lease.status) === "Expired") {
    throw new KernelError(
      "Conflict",
      "The Worktree writer lease has expired.",
    );
  }
  if (
    integer(lease.generation) !== command.generation ||
    integer(lease.fencing_token) !== command.fencingToken ||
    optionalText(lease.lease_token) !== command.leaseToken
  ) {
    throw staleAuthority(command.generation, command.fencingToken, lease);
  }
  if (
    text(lease.status) !== "Active" ||
    optionalText(lease.holder_principal_id) !== text(principal.id)
  ) {
    throw new KernelError(
      "Conflict",
      "The Worktree writer lease is not held by this Runtime.",
    );
  }
  const expiresAt = optionalText(lease.expires_at);
  if (!expiresAt || expiresAt <= observedAt) {
    throw new KernelError(
      "Conflict",
      "The Worktree writer lease has expired.",
    );
  }
  return lease;
}

function expireIfNeeded(
  kernel: db.KernelContext,
  lease: Row | undefined,
  actorPrincipalId: string,
  correlationId: string,
  observedAt: string,
): Row | undefined {
  if (
    !lease ||
    text(lease.status) !== "Active" ||
    !optionalText(lease.expires_at) ||
    text(lease.expires_at) > observedAt
  ) {
    return lease;
  }
  db.run(
    kernel,
    `UPDATE worktree_writer_leases
        SET revision = revision + 1,
            status = 'Expired',
            holder_principal_id = NULL,
            lease_token = NULL,
            expires_at = NULL,
            updated_at = ?
      WHERE worktree_id = ?`,
    observedAt,
    text(lease.worktree_id),
  );
  const expired = requireLease(kernel, text(lease.worktree_id));
  appendEvent(
    kernel,
    expired,
    "WorktreeWriterLeaseExpired",
    actorPrincipalId,
    correlationId,
    "lease_expired",
  );
  return expired;
}

function appendEvent(
  kernel: db.KernelContext,
  lease: Row,
  type: WorktreeWriterLeaseEventType,
  actorPrincipalId: string,
  correlationId: string,
  reason?: string,
  evidence?: JsonValue,
): void {
  db.run(
    kernel,
    `INSERT INTO worktree_writer_lease_events
      (id, worktree_id, type, revision, generation, fencing_token,
       actor_principal_id, holder_principal_id, expires_at, reason,
       evidence_json, correlation_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    kernel.idFactory("worktree_writer_lease_event"),
    text(lease.worktree_id),
    type,
    integer(lease.revision),
    integer(lease.generation),
    integer(lease.fencing_token),
    actorPrincipalId,
    optionalText(lease.holder_principal_id),
    optionalText(lease.expires_at),
    reason ?? null,
    evidence === undefined ? null : JSON.stringify(evidence),
    correlationId,
    db.now(kernel),
  );
}

function authorityResult(
  commandType: AcquireCommand["type"] | RenewCommand["type"],
  lease: Row,
  observedAt: string,
): CommandResult {
  const view = mapWorktreeWriterLease(lease);
  return {
    commandType,
    entityId: view.worktreeId,
    revision: view.revision,
    leaseToken: text(lease.lease_token),
    leaseExpiresAt: text(lease.expires_at),
    authorityObservedAt: observedAt,
    leaseGeneration: view.generation,
    fencingToken: view.fencingToken,
    worktreeWriterLease: view,
  };
}

function stateResult(
  commandType:
    | ReleaseCommand["type"]
    | QuarantineCommand["type"]
    | ResolveQuarantineCommand["type"],
  lease: Row,
  quarantineToken?: string,
): CommandResult {
  const view = mapWorktreeWriterLease(lease);
  return {
    commandType,
    entityId: view.worktreeId,
    revision: view.revision,
    leaseGeneration: view.generation,
    fencingToken: view.fencingToken,
    ...(quarantineToken ? { quarantineToken } : {}),
    worktreeWriterLease: view,
  };
}

function secretToken(prefix: "wlt" | "wqt"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function getLease(
  kernel: db.KernelContext,
  worktreeId: string,
): Row | undefined {
  return db.getRow(
    kernel,
    "SELECT * FROM worktree_writer_leases WHERE worktree_id = ?",
    worktreeId,
  );
}

function requireLease(kernel: db.KernelContext, worktreeId: string): Row {
  const lease = getLease(kernel, worktreeId);
  if (!lease) {
    throw new KernelError(
      "NotFound",
      `Worktree writer lease ${worktreeId} does not exist.`,
    );
  }
  return lease;
}

function requireRuntime(principal: Row): void {
  if (text(principal.kind) !== "runtime") {
    throw new KernelError(
      "Forbidden",
      "This command requires a runtime principal.",
    );
  }
}

function staleAuthority(
  expectedGeneration: number | undefined,
  expectedFencingToken: number | undefined,
  lease: Row | undefined,
  durable = false,
): KernelError {
  const ErrorType = durable ? DurableKernelError : KernelError;
  return new ErrorType(
    "ConditionalCheckFailed",
    "The Worktree writer lease authority is stale.",
    {
      expectedGeneration: expectedGeneration ?? null,
      actualGeneration: lease ? integer(lease.generation) : null,
      expectedFencingToken: expectedFencingToken ?? null,
      actualFencingToken: lease ? integer(lease.fencing_token) : null,
    },
  );
}
