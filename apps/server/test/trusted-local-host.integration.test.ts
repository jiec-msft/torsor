import { fileURLToPath } from "node:url";

import { CopilotAcpAdapter, LocalWorktreeExecutor } from "@torsor/agent-runtime";
import { TorsorKernel } from "@torsor/kernel";
import { describe, expect, it, vi } from "vitest";
import { createLocalRuntimeHost } from "../src/local-runtime-host.js";
import { bootstrap, syntheticRepository } from "../../../packages/agent-runtime/test/fixtures/worktree-fixture.js";
import { deferred } from "../../../packages/agent-runtime/test/fixtures/deferred.js";

const fixture = fileURLToPath(new URL(
  "../../../packages/agent-runtime/test/fixtures/native-acp-provider.mjs", import.meta.url,
));
const headers = { Authorization: "Bearer synthetic-human-token", "Content-Type": "application/json" };

describe("trusted-local HTTP Host", () => {
  it.each(["success", "hang"])("publishes safe Timeline facts and closes its owned process: %s", async (scenario) => {
    const repo = syntheticRepository();
    const observed = deferred<string>();
    let runId: string | undefined;
    const host = createLocalRuntimeHost({
      databasePath: repo.databasePath, bootstrap, port: 0,
      credentials: [{ token: "synthetic-human-token", principalContext: { principalId: "human" } }],
      runtimePrincipalId: "runtime", projectIds: ["project"], runtimePollIntervalMs: 1,
      adapter: new CopilotAcpAdapter({
        policy: { kind: "trusted-local", permissionMode: "allow-all" },
        command: process.execPath, commandArgs: [fixture, scenario], unsafeAllowCustomCommandArgs: true,
        userEnvironment: {},
      }),
      worktreeExecutorFactory: (kernel) => {
        const execute = kernel.execute.bind(kernel);
        vi.spyOn(kernel, "execute").mockImplementation(async (command, context) => {
          const result = await execute(command, context);
          if (command.type === "AppendRunActivity" && command.kind === "tool_started") {
            runId = command.runId;
            if (scenario === "hang") observed.resolve(runId);
          }
          if (command.type === "FinishProviderAttempt" && command.status === "Completed" && runId) {
            observed.resolve(runId);
          }
          return result;
        });
        return new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...repo });
      },
    });
    try {
      const origin = await host.start();
      const response = await fetch(`${origin}/api/v1/commands/start-thread`, {
        method: "POST", headers,
        body: JSON.stringify({
          idempotencyKey: "native-http", projectId: "project", channelId: "channel",
          body: "Edit and test the disposable synthetic Worktree.", targetAgentIds: ["orbit"],
        }),
      });
      expect(response.status).toBe(200);
      const id = await observed.promise;
      const projected = await fetch(`${origin}/api/v1/runs/${id}`, { headers });
      expect(projected.status).toBe(200);
      const body = await projected.text();
      expect(body).toContain("tool_started");
      expect(body).not.toContain("synthetic-private");
      expect(body).not.toContain("diagnosticSessionId");
      if (scenario === "success") expect(body).toContain("tool_completed");
      if (scenario === "hang") await expect(host.close()).rejects.toMatchObject({ diagnosticCode: "provider_cancelled" });
      else await host.close();
      const reopened = TorsorKernel.open({ databasePath: repo.databasePath });
      try {
        const tree = (await reopened.query({ type: "ListPhysicalWorktrees" }, { principalId: "runtime" })).items[0]!;
        expect(tree.latestExecution).toMatchObject({ state: "StopConfirmed", authorityRevokedAt: expect.any(String) });
        const run = await reopened.query({ type: "GetRunProjection", runId: id }, { principalId: "human" });
        if (scenario === "success") expect(run.run.state).toBe("Completed");
        else expect(run.run.state).not.toBe("Completed");
        expect(JSON.stringify(run)).not.toContain("synthetic-private");
      } finally { reopened.close(); }
    } finally {
      if (scenario === "hang") await expect(host.close()).rejects.toMatchObject({ diagnosticCode: "provider_cancelled" });
      else await host.close();
      vi.restoreAllMocks(); repo.dispose();
    }
  }, 30_000);
});
