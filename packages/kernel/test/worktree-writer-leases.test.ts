import { describe, expect, it } from "vitest";

import { TorsorKernel } from "../src/index.js";
import {
  humanContext,
  openMemoryKernel,
  runtimeContext,
} from "./helpers.js";

describe("Worktree writer leases", () => {
  it("acquires, renews, releases, and advances generation and fencing", async () => {
    let current = new Date("2026-09-22T08:00:00.000Z");
    const kernel = openMemoryKernel(() => current);
    try {
      const acquired = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "lease-acquire-1",
          worktreeId: "worktree-alpha",
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      expect(acquired).toMatchObject({
        leaseGeneration: 1,
        fencingToken: 1,
        authorityObservedAt: "2026-09-22T08:00:00.000Z",
        leaseExpiresAt: "2026-09-22T08:00:30.000Z",
        worktreeWriterLease: {
          status: "Active",
          generation: 1,
          fencingToken: 1,
          holderPrincipalId: "principal-runtime",
        },
      });
      expect(acquired.leaseToken).toMatch(/^wlt_[A-Za-z0-9_-]{43}$/);

      current = new Date("2026-09-22T08:00:10.000Z");
      const renewed = await kernel.execute(
        {
          type: "RenewWorktreeWriterLease",
          idempotencyKey: "lease-renew-1",
          worktreeId: "worktree-alpha",
          generation: acquired.leaseGeneration!,
          fencingToken: acquired.fencingToken!,
          leaseToken: acquired.leaseToken!,
          leaseDurationMs: 45_000,
        },
        runtimeContext,
      );
      expect(renewed).toMatchObject({
        leaseGeneration: 1,
        fencingToken: 1,
        leaseExpiresAt: "2026-09-22T08:00:55.000Z",
        worktreeWriterLease: {
          revision: 2,
          renewedAt: "2026-09-22T08:00:10.000Z",
        },
      });

      const released = await kernel.execute(
        {
          type: "ReleaseWorktreeWriterLease",
          idempotencyKey: "lease-release-1",
          worktreeId: "worktree-alpha",
          generation: renewed.leaseGeneration!,
          fencingToken: renewed.fencingToken!,
          leaseToken: renewed.leaseToken!,
        },
        runtimeContext,
      );
      expect(released.worktreeWriterLease).toMatchObject({
        status: "Released",
        generation: 1,
        fencingToken: 1,
      });

      const reacquired = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "lease-acquire-2",
          worktreeId: "worktree-alpha",
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      expect(reacquired).toMatchObject({
        leaseGeneration: 2,
        fencingToken: 2,
        worktreeWriterLease: { status: "Active", revision: 4 },
      });
      await expect(
        kernel.execute(
          {
            type: "RenewWorktreeWriterLease",
            idempotencyKey: "stale-lease-renew",
            worktreeId: "worktree-alpha",
            generation: acquired.leaseGeneration!,
            fencingToken: acquired.fencingToken!,
            leaseToken: acquired.leaseToken!,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "ConditionalCheckFailed" });

      const events = await kernel.query(
        {
          type: "ListWorktreeWriterLeaseEvents",
          worktreeId: "worktree-alpha",
        },
        runtimeContext,
      );
      expect(events.items.map((event) => event.type)).toEqual([
        "WorktreeWriterLeaseAcquired",
        "WorktreeWriterLeaseRenewed",
        "WorktreeWriterLeaseReleased",
        "WorktreeWriterLeaseAcquired",
      ]);
    } finally {
      kernel.close();
    }
  });

  it("expires at the exact boundary and never revives cached authority", async () => {
    let current = new Date("2026-09-22T09:00:00.000Z");
    const kernel = openMemoryKernel(() => current);
    try {
      const acquired = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "expiry-acquire",
          worktreeId: "worktree-expiry",
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      current = new Date("2026-09-22T09:00:01.000Z");

      await expect(
        kernel.execute(
          {
            type: "RenewWorktreeWriterLease",
            idempotencyKey: "expiry-renew-at-boundary",
            worktreeId: "worktree-expiry",
            generation: acquired.leaseGeneration!,
            fencingToken: acquired.fencingToken!,
            leaseToken: acquired.leaseToken!,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      current = new Date("2026-09-22T09:00:00.500Z");
      await expect(
        kernel.execute(
          {
            type: "RenewWorktreeWriterLease",
            idempotencyKey: "expiry-renew-after-clock-rollback",
            worktreeId: "worktree-expiry",
            generation: acquired.leaseGeneration!,
            fencingToken: acquired.fencingToken!,
            leaseToken: acquired.leaseToken!,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      await expect(
        kernel.execute(
          {
            type: "AcquireWorktreeWriterLease",
            idempotencyKey: "expiry-acquire",
            worktreeId: "worktree-expiry",
            leaseDurationMs: 1_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });

      const expired = await kernel.query(
        {
          type: "GetWorktreeWriterLease",
          worktreeId: "worktree-expiry",
        },
        runtimeContext,
      );
      expect(expired).toMatchObject({
        status: "Expired",
        revision: 2,
        generation: 1,
        fencingToken: 1,
        holderPrincipalId: null,
        expiresAt: null,
      });

      const reacquired = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "expiry-reacquire",
          worktreeId: "worktree-expiry",
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      expect(reacquired).toMatchObject({
        leaseGeneration: 2,
        fencingToken: 2,
        worktreeWriterLease: { revision: 3 },
      });
      const visibleState = await kernel.query(
        {
          type: "GetWorktreeWriterLease",
          worktreeId: "worktree-expiry",
        },
        runtimeContext,
      );
      expect(visibleState).not.toHaveProperty("leaseToken");
      await expect(
        kernel.execute(
          {
            type: "RenewWorktreeWriterLease",
            idempotencyKey: "stale-writer-adopts-visible-state",
            worktreeId: "worktree-expiry",
            generation: visibleState.generation,
            fencingToken: visibleState.fencingToken,
            leaseToken: acquired.leaseToken!,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "ConditionalCheckFailed" });

      current = new Date("2026-09-22T09:00:30.500Z");
      await expect(
        kernel.execute(
          {
            type: "QuarantineWorktreeWriterLease",
            idempotencyKey: "stale-quarantine-at-expiry",
            worktreeId: "worktree-expiry",
            expectedGeneration: 999,
            expectedFencingToken: reacquired.fencingToken!,
            reason: "Synthetic stale reconciliation observation.",
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "ConditionalCheckFailed" });
      current = new Date("2026-09-22T09:00:30.000Z");
      await expect(
        kernel.execute(
          {
            type: "RenewWorktreeWriterLease",
            idempotencyKey: "renew-after-quarantine-clock-rollback",
            worktreeId: "worktree-expiry",
            generation: reacquired.leaseGeneration!,
            fencingToken: reacquired.fencingToken!,
            leaseToken: reacquired.leaseToken!,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });

  it("quarantines uncertain state behind a new fencing barrier", async () => {
    let current = new Date("2026-09-21T08:00:00.000Z");
    const kernel = openMemoryKernel(() => current);
    try {
      const acquired = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "quarantine-acquire",
          worktreeId: "worktree-quarantine",
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      const visibleActiveState = await kernel.query(
        {
          type: "GetWorktreeWriterLease",
          worktreeId: "worktree-quarantine",
        },
        runtimeContext,
      );
      await expect(
        kernel.execute(
          {
            type: "QuarantineWorktreeWriterLease",
            idempotencyKey: "quarantine-without-authority",
            worktreeId: "worktree-quarantine",
            expectedGeneration: visibleActiveState.generation,
            expectedFencingToken: visibleActiveState.fencingToken,
            reason: "A stale process must not quarantine the current writer.",
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "ConditionalCheckFailed" });
      const quarantined = await kernel.execute(
        {
          type: "QuarantineWorktreeWriterLease",
          idempotencyKey: "quarantine",
          worktreeId: "worktree-quarantine",
          expectedGeneration: acquired.leaseGeneration!,
          expectedFencingToken: acquired.fencingToken!,
          leaseToken: acquired.leaseToken!,
          reason: "Writer outcome is uncertain after an interrupted handoff.",
          evidence: { source: "synthetic-reconciliation" },
        },
        runtimeContext,
      );
      expect(quarantined.worktreeWriterLease).toMatchObject({
        status: "Quarantined",
        generation: 1,
        fencingToken: 2,
        holderPrincipalId: null,
        quarantineReason:
          "Writer outcome is uncertain after an interrupted handoff.",
        quarantineEvidence: { source: "synthetic-reconciliation" },
      });
      expect(quarantined.quarantineToken).toMatch(
        /^wqt_[A-Za-z0-9_-]{43}$/,
      );
      const visibleQuarantine = await kernel.query(
        {
          type: "GetWorktreeWriterLease",
          worktreeId: "worktree-quarantine",
        },
        runtimeContext,
      );
      expect(visibleQuarantine).not.toHaveProperty("quarantineToken");
      await expect(
        kernel.execute(
          {
            type: "ReleaseWorktreeWriterLease",
            idempotencyKey: "quarantine-stale-release",
            worktreeId: "worktree-quarantine",
            generation: acquired.leaseGeneration!,
            fencingToken: acquired.fencingToken!,
            leaseToken: acquired.leaseToken!,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "ConditionalCheckFailed" });
      await expect(
        kernel.execute(
          {
            type: "AcquireWorktreeWriterLease",
            idempotencyKey: "quarantine-blocked-acquire",
            worktreeId: "worktree-quarantine",
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "DomainBusy" });
      await expect(
        kernel.execute(
          {
            type: "ResolveWorktreeWriterLeaseQuarantine",
            idempotencyKey: "quarantine-stale-resolve",
            worktreeId: "worktree-quarantine",
            expectedRevision: visibleQuarantine.revision,
            expectedFencingToken: visibleQuarantine.fencingToken,
            quarantineToken: "wqt_invalid",
            resolution: "A stale process must not clear quarantine.",
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "ConditionalCheckFailed" });

      const resolved = await kernel.execute(
        {
          type: "ResolveWorktreeWriterLeaseQuarantine",
          idempotencyKey: "quarantine-resolve",
          worktreeId: "worktree-quarantine",
          expectedRevision: quarantined.revision!,
          expectedFencingToken: quarantined.fencingToken!,
          quarantineToken: quarantined.quarantineToken!,
          resolution: "Reconciliation confirmed no writer remains active.",
        },
        runtimeContext,
      );
      expect(resolved.worktreeWriterLease).toMatchObject({
        status: "Released",
        fencingToken: 2,
        quarantineResolvedAt: "2026-09-21T08:00:00.000Z",
        quarantineResolution:
          "Reconciliation confirmed no writer remains active.",
      });

      const reacquired = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "quarantine-reacquire",
          worktreeId: "worktree-quarantine",
          leaseDurationMs: 1_000,
        },
        runtimeContext,
      );
      expect(reacquired).toMatchObject({
        leaseGeneration: 2,
        fencingToken: 3,
      });
      current = new Date("2026-09-21T08:00:01.000Z");
      await expect(
        kernel.execute(
          {
            type: "QuarantineWorktreeWriterLease",
            idempotencyKey: "quarantine",
            worktreeId: "worktree-quarantine",
            expectedGeneration: acquired.leaseGeneration!,
            expectedFencingToken: acquired.fencingToken!,
            leaseToken: acquired.leaseToken!,
            reason: "Writer outcome is uncertain after an interrupted handoff.",
            evidence: { source: "synthetic-reconciliation" },
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      current = new Date("2026-09-21T08:00:00.500Z");
      await expect(
        kernel.execute(
          {
            type: "RenewWorktreeWriterLease",
            idempotencyKey: "quarantine-replay-clock-rollback-renew",
            worktreeId: "worktree-quarantine",
            generation: reacquired.leaseGeneration!,
            fencingToken: reacquired.fencingToken!,
            leaseToken: reacquired.leaseToken!,
            leaseDurationMs: 30_000,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      kernel.close();
    }
  });

  it("restricts writer lease state to Runtime principals", async () => {
    const kernel = openMemoryKernel();
    try {
      await expect(
        kernel.execute(
          {
            type: "AcquireWorktreeWriterLease",
            idempotencyKey: "human-acquire",
            worktreeId: "worktree-forbidden",
            leaseDurationMs: 30_000,
          },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
      await expect(
        kernel.query(
          {
            type: "GetWorktreeWriterLease",
            worktreeId: "worktree-forbidden",
          },
          humanContext,
        ),
      ).rejects.toMatchObject({ code: "Forbidden" });
    } finally {
      kernel.close();
    }
  });
});
