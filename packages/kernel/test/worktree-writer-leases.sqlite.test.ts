import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TorsorKernel } from "../src/index.js";
import { bootstrap, runtimeContext } from "./helpers.js";

describe("Worktree writer lease SQLite durability", () => {
  it("persists authority, expiry, fencing, and events across restarts", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "torsor-worktree-writer-lease-"),
    );
    const databasePath = join(directory, "kernel.sqlite");
    let current = new Date("2026-09-22T10:00:00.000Z");
    const open = () =>
      TorsorKernel.open({
        databasePath,
        bootstrap,
        clock: () => current,
      });
    let kernel: TorsorKernel | undefined;
    try {
      kernel = open();
      const acquired = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "restart-acquire",
          worktreeId: "worktree-restart",
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      kernel.close();
      kernel = undefined;

      current = new Date("2026-09-22T10:00:10.000Z");
      kernel = open();
      const restored = await kernel.query(
        {
          type: "GetWorktreeWriterLease",
          worktreeId: "worktree-restart",
        },
        runtimeContext,
      );
      expect(restored).toMatchObject({
        status: "Active",
        generation: 1,
        fencingToken: 1,
      });
      expect(restored).not.toHaveProperty("leaseToken");
      const recoveredAuthority = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "restart-acquire",
          worktreeId: "worktree-restart",
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      expect(recoveredAuthority.leaseToken).toBe(acquired.leaseToken);
      const renewed = await kernel.execute(
        {
          type: "RenewWorktreeWriterLease",
          idempotencyKey: "restart-renew",
          worktreeId: "worktree-restart",
          generation: restored.generation,
          fencingToken: restored.fencingToken,
          leaseToken: recoveredAuthority.leaseToken!,
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      kernel.close();
      kernel = undefined;

      current = new Date("2026-09-22T10:00:40.000Z");
      kernel = open();
      const expired = await kernel.query(
        {
          type: "GetWorktreeWriterLease",
          worktreeId: "worktree-restart",
        },
        runtimeContext,
      );
      expect(expired).toMatchObject({
        status: "Expired",
        revision: 3,
        generation: 1,
        fencingToken: 1,
      });
      await expect(
        kernel.execute(
          {
            type: "ReleaseWorktreeWriterLease",
            idempotencyKey: "restart-stale-release",
            worktreeId: "worktree-restart",
            generation: renewed.leaseGeneration!,
            fencingToken: renewed.fencingToken!,
            leaseToken: renewed.leaseToken!,
          },
          runtimeContext,
        ),
      ).rejects.toMatchObject({ code: "Conflict" });
      const reacquired = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "restart-reacquire",
          worktreeId: "worktree-restart",
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      expect(reacquired).toMatchObject({
        leaseGeneration: 2,
        fencingToken: 2,
        worktreeWriterLease: { revision: 4 },
      });
      kernel.close();
      kernel = undefined;

      kernel = open();
      const events = await kernel.query(
        {
          type: "ListWorktreeWriterLeaseEvents",
          worktreeId: "worktree-restart",
        },
        runtimeContext,
      );
      expect(events.items.map((event) => event.type)).toEqual([
        "WorktreeWriterLeaseAcquired",
        "WorktreeWriterLeaseRenewed",
        "WorktreeWriterLeaseExpired",
        "WorktreeWriterLeaseAcquired",
      ]);
      expect(events.items.map((event) => event.fencingToken)).toEqual([
        1, 1, 1, 2,
      ]);
      kernel.close();
      kernel = undefined;
    } finally {
      kernel?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers the secret quarantine capability only through idempotency", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "torsor-worktree-writer-quarantine-"),
    );
    const databasePath = join(directory, "kernel.sqlite");
    const open = () =>
      TorsorKernel.open({
        databasePath,
        bootstrap,
        clock: () => new Date("2026-09-22T11:00:00.000Z"),
      });
    let kernel: TorsorKernel | undefined;
    try {
      kernel = open();
      const acquired = await kernel.execute(
        {
          type: "AcquireWorktreeWriterLease",
          idempotencyKey: "quarantine-restart-acquire",
          worktreeId: "worktree-quarantine-restart",
          leaseDurationMs: 30_000,
        },
        runtimeContext,
      );
      const command = {
        type: "QuarantineWorktreeWriterLease",
        idempotencyKey: "quarantine-restart",
        worktreeId: "worktree-quarantine-restart",
        expectedGeneration: acquired.leaseGeneration!,
        expectedFencingToken: acquired.fencingToken!,
        leaseToken: acquired.leaseToken!,
        reason: "Synthetic uncertain writer outcome.",
      } as const;
      const quarantined = await kernel.execute(command, runtimeContext);
      kernel.close();
      kernel = undefined;

      kernel = open();
      const visible = await kernel.query(
        {
          type: "GetWorktreeWriterLease",
          worktreeId: command.worktreeId,
        },
        runtimeContext,
      );
      expect(visible).not.toHaveProperty("quarantineToken");
      const recovered = await kernel.execute(command, runtimeContext);
      expect(recovered.quarantineToken).toBe(quarantined.quarantineToken);
      const resolved = await kernel.execute(
        {
          type: "ResolveWorktreeWriterLeaseQuarantine",
          idempotencyKey: "quarantine-restart-resolve",
          worktreeId: command.worktreeId,
          expectedRevision: recovered.revision!,
          expectedFencingToken: recovered.fencingToken!,
          quarantineToken: recovered.quarantineToken!,
          resolution: "Synthetic reconciliation completed.",
        },
        runtimeContext,
      );
      expect(resolved.worktreeWriterLease).toMatchObject({
        status: "Released",
        quarantineResolution: "Synthetic reconciliation completed.",
      });
      kernel.close();
      kernel = undefined;
    } finally {
      kernel?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
