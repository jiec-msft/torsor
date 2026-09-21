import * as db from "./database.js";
import { KernelError } from "./errors.js";
import * as invariants from "./invariants.js";
import {
  mapOutboxEvent
} from "./mappings.js";
import type {
  CommandResult,
  KernelCommand
} from "./types.js";
import {
  boundedDuration,
  boundedLimit,
  integer,
  optionalText,
  requireNonEmpty,
  text,
  unique,
  type Row
} from "./values.js";

export function claimOutboxEvents(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "ClaimOutboxEvents";
}>, principal: Row, _correlationId: string): CommandResult {
  invariants.requireKind(kernel, principal, "runtime");
  const limit = boundedLimit(command.limit);
  const leaseDurationMs = boundedDuration(command.leaseDurationMs, "leaseDurationMs");
  const now = kernel.clock();
  const leaseToken = kernel.idFactory("outbox_lease");
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
  const candidates = db.allRows(kernel, `SELECT id, lease_expires_at
         FROM outbox_events
        WHERE acknowledged_at IS NULL
        ORDER BY sequence
        LIMIT ?`, limit);
  const claimable: Row[] = [];
  for (const candidate of candidates) {
    const currentExpiry = optionalText(candidate.lease_expires_at);
    if (currentExpiry && new Date(currentExpiry) > now) {
      break;
    }
    claimable.push(candidate);
  }
  for (const candidate of claimable) {
    db.run(kernel, `UPDATE outbox_events
            SET lease_holder_principal_id = ?,
                lease_token = ?,
                lease_expires_at = ?,
                delivery_attempts = delivery_attempts + 1
          WHERE id = ?`, text(principal.id), leaseToken, leaseExpiresAt, text(candidate.id));
  }
  const outboxEvents = claimable.map((candidate) => mapOutboxEvent(invariants.requireOutboxEvent(kernel, text(candidate.id))));
  return {
    commandType: command.type,
    entityId: leaseToken,
    leaseToken,
    ...(outboxEvents.length > 0 ? { leaseExpiresAt } : {}),
    outboxEvents,
  };
}

export function acknowledgeOutboxEvents(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "AcknowledgeOutboxEvents";
}>, principal: Row, correlationId: string): CommandResult {
  invariants.requireKind(kernel, principal, "runtime");
  if (command.outboxEventIds.length === 0) {
    throw new KernelError("InvalidCommand", "At least one OutboxEvent is required.");
  }
  const ids = unique(command.outboxEventIds);
  if (ids.length !== command.outboxEventIds.length) {
    throw new KernelError("InvalidCommand", "Outbox acknowledgement must not contain duplicate event IDs.");
  }
  requireNonEmpty(command.leaseToken, "leaseToken");
  const now = db.now(kernel);
  const leasedRows = db.allRows(kernel, `SELECT id, sequence
         FROM outbox_events
        WHERE acknowledged_at IS NULL
          AND lease_holder_principal_id = ?
          AND lease_token = ?
        ORDER BY sequence`, text(principal.id), command.leaseToken);
  const leasedIds = leasedRows.map((row) => text(row.id));
  if (leasedIds.length !== ids.length ||
    leasedIds.some((id, index) => id !== ids[index])) {
    throw new KernelError("InvalidCommand", "Outbox acknowledgement must include the entire leased batch in cursor order.");
  }
  const pendingPrefix = db.allRows(kernel, `SELECT id, sequence
         FROM outbox_events
        WHERE acknowledged_at IS NULL
        ORDER BY sequence
        LIMIT ?`, leasedRows.length);
  if (pendingPrefix.length !== leasedRows.length ||
    pendingPrefix.some((row, index) => text(row.id) !== text(leasedRows[index]!.id) ||
      integer(row.sequence) !== integer(leasedRows[index]!.sequence))) {
    throw new KernelError("Conflict", "Outbox acknowledgement must exactly advance the oldest pending prefix.");
  }
  const events = ids.map((id) => invariants.requireOutboxEvent(kernel, id));
  for (const event of events) {
    const id = text(event.id);
    if (event.acknowledged_at !== null) {
      throw new KernelError("Conflict", `OutboxEvent ${id} is already acknowledged.`);
    }
    if (optionalText(event.lease_holder_principal_id) !== text(principal.id) ||
      optionalText(event.lease_token) !== command.leaseToken ||
      !optionalText(event.lease_expires_at) ||
      new Date(text(event.lease_expires_at)) <= kernel.clock()) {
      throw new KernelError("Conflict", `OutboxEvent ${id} is not held by the current live lease.`);
    }
  }
  for (const event of events) {
    db.run(kernel, `UPDATE outbox_events
            SET acknowledged_at = ?,
                acknowledged_by_principal_id = ?,
                lease_holder_principal_id = NULL,
                lease_token = NULL,
                lease_expires_at = NULL
          WHERE id = ?`, now, text(principal.id), text(event.id));
  }
  return {
    commandType: command.type,
    entityId: command.leaseToken,
    relatedIds: {
      acknowledgedCount: String(ids.length),
      correlationId,
    },
  };
}

export function resolveCachedOutboxClaim(kernel: db.KernelContext, command: Extract<KernelCommand, {
  type: "ClaimOutboxEvents";
}>, result: CommandResult, principal: Row): CommandResult {
  if (!result.leaseToken ||
    !result.outboxEvents ||
    result.outboxEvents.length === 0) {
    return result;
  }
  const now = kernel.clock();
  const originalIds = result.outboxEvents.map((event) => event.id);
  const rows = originalIds.map((id) => db.getRow(kernel, "SELECT * FROM outbox_events WHERE id = ?", id));
  if (rows.some((row) => row === undefined ||
    row.acknowledged_at !== null)) {
    return result;
  }
  const typedRows = rows as Row[];
  const originalLeaseIsLive = typedRows.every((row) => optionalText(row.lease_holder_principal_id) === text(principal.id) &&
    optionalText(row.lease_token) === result.leaseToken &&
    optionalText(row.lease_expires_at) !== null &&
    new Date(text(row.lease_expires_at)) > now);
  if (originalLeaseIsLive) {
    const persistedExpiry = text(typedRows[0]!.lease_expires_at);
    if (
      !typedRows.every(
        (row) => text(row.lease_expires_at) === persistedExpiry,
      )
    ) {
      throw new Error("A persisted Outbox claim has inconsistent lease expiry.");
    }
    return {
      ...result,
      leaseExpiresAt: persistedExpiry,
      outboxEvents: typedRows.map(mapOutboxEvent),
    };
  }
  const anotherLiveLease = typedRows.some((row) => {
    const expiry = optionalText(row.lease_expires_at);
    return expiry !== null && new Date(expiry) > now;
  });
  if (anotherLiveLease) {
    return result;
  }
  const frontier = db.allRows(kernel, `SELECT id
         FROM outbox_events
        WHERE acknowledged_at IS NULL
        ORDER BY sequence
        LIMIT ?`, originalIds.length).map((row) => text(row.id));
  if (frontier.length !== originalIds.length ||
    frontier.some((id, index) => id !== originalIds[index])) {
    return result;
  }
  const leaseDurationMs = boundedDuration(command.leaseDurationMs, "leaseDurationMs");
  const leaseToken = kernel.idFactory("outbox_lease");
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
  for (const id of originalIds) {
    db.run(kernel, `UPDATE outbox_events
            SET lease_holder_principal_id = ?,
                lease_token = ?,
                lease_expires_at = ?,
                delivery_attempts = delivery_attempts + 1
          WHERE id = ?`, text(principal.id), leaseToken, leaseExpiresAt, id);
  }
  return {
    ...result,
    entityId: leaseToken,
    leaseToken,
    leaseExpiresAt,
    outboxEvents: originalIds.map((id) => mapOutboxEvent(invariants.requireOutboxEvent(kernel, id))),
  };
}
