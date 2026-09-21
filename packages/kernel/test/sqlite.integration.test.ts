import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TorsorKernel } from "../src/index.js";
import { bootstrap, humanContext } from "./helpers.js";

describe("SQLite persistence", () => {
  it("recovers durable state after close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-kernel-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      const first = TorsorKernel.open({ databasePath, bootstrap });
      const created = await first.execute(
        {
          type: "StartThread",
          idempotencyKey: "persistent-thread",
          projectId: "project-sample",
          channelId: "channel-general",
          body: "Persist this synthetic collaboration state.",
          targetAgentIds: ["agent-orbit"],
        },
        humanContext,
      );
      const eventsBefore = await first.readEvents(null, 100);
      first.close();

      const reopened = TorsorKernel.open({ databasePath, bootstrap });
      try {
        const projection = await reopened.query(
          { type: "GetThreadProjection", threadRootId: created.entityId },
          humanContext,
        );
        const eventsAfter = await reopened.readEvents(null, 100);
        const cached = await reopened.execute(
          {
            type: "StartThread",
            idempotencyKey: "persistent-thread",
            projectId: "project-sample",
            channelId: "channel-general",
            body: "Persist this synthetic collaboration state.",
            targetAgentIds: ["agent-orbit"],
          },
          humanContext,
        );

        expect(projection.messages[0]?.revisions[0]?.body).toBe(
          "Persist this synthetic collaboration state.",
        );
        expect(eventsAfter).toEqual(eventsBefore);
        expect(cached).toEqual(created);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
