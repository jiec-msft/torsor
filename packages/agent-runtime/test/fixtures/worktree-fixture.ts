import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TorsorKernel, type KernelBootstrap } from "@torsor/kernel";

export const bootstrap: KernelBootstrap = {
  principals: [
    { id: "human", kind: "human", displayName: "Avery" },
    { id: "runtime", kind: "runtime", displayName: "Local Runtime" },
    { id: "agent", kind: "agent", displayName: "Orbit" },
  ],
  projects: [{ id: "project", name: "Synthetic" }],
  channels: [{ id: "channel", projectId: "project", name: "general" }],
  agents: [{
    id: "orbit", principalId: "agent", projectId: "project", name: "Orbit",
    configRevision: 1, config: {},
  }],
};
export const runtimeContext = { principalId: "runtime" };

export function syntheticRepository() {
  const directory = mkdtempSync(join(tmpdir(), "torsor-physical-"));
  const repositoryPath = join(directory, "repository");
  const rootPath = join(directory, "managed");
  mkdirSync(repositoryPath);
  mkdirSync(rootPath);
  const configPath = join(directory, "empty-gitconfig");
  const hooksPath = join(directory, "empty-hooks");
  writeFileSync(configPath, "");
  mkdirSync(hooksPath);
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0",
  };
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: repositoryPath, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "--quiet", "--template=");
  writeFileSync(join(repositoryPath, "sample.txt"), "Synthetic repository.\n");
  git("add", "--", "sample.txt");
  git("-c", "user.name=Avery", "-c", "user.email=avery@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${hooksPath}`,
    "commit", "--quiet", "-m", "Synthetic base");
  const baseRevision = git("rev-parse", "HEAD");
  return {
    directory, repositoryPath, rootPath, baseRevision,
    databasePath: join(directory, "kernel.sqlite"),
    addWorktree(name: string) {
      const path = join(rootPath, name);
      git("-c", `core.hooksPath=${hooksPath}`, "worktree", "add", "--quiet", "--detach", path, baseRevision);
      return path;
    },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export async function activeRun(kernel: TorsorKernel, key: string) {
  const thread = await kernel.execute({
    type: "StartThread", idempotencyKey: key, projectId: "project", channelId: "channel",
    body: "Run the controlled synthetic probe.", targetAgentIds: ["orbit"],
  }, { principalId: "human" });
  const projection = await kernel.query({ type: "GetThreadProjection", threadRootId: thread.entityId }, runtimeContext);
  const attention = projection.attentions[0]!;
  const claim = await kernel.execute({
    type: "ClaimAttention", idempotencyKey: `${key}:claim`, attentionId: attention.id,
    expectedAttentionRevision: attention.revision, leaseDurationMs: 120_000,
  }, runtimeContext);
  const attentionActivation = await kernel.execute({
    type: "StartActivation", idempotencyKey: `${key}:attention`, attentionId: attention.id,
    handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
  }, runtimeContext);
  const run = await kernel.execute({
    type: "ResolveAttentionWithRun", idempotencyKey: `${key}:run`, attentionId: attention.id,
    expectedAttentionRevision: claim.revision!, handlerLeaseToken: claim.relatedIds!.handlerLeaseToken!,
  }, { principalId: "agent", activationId: attentionActivation.entityId });
  for (let index = 0; index < 100; index++) {
    const outbox = await kernel.execute({
      type: "ClaimOutboxEvents", idempotencyKey: `${key}:outbox:${index}`, limit: 1, leaseDurationMs: 120_000,
    }, runtimeContext);
    const event = outbox.outboxEvents?.[0];
    if (!event) throw new Error("Synthetic Run admission event is missing.");
    let activationId: string | undefined;
    if (event.aggregateId === run.entityId && event.topic === "run.activation-requested") {
      activationId = (await kernel.execute({
        type: "StartActivation", idempotencyKey: `${key}:activation`, runId: run.entityId,
        expectedRunRevision: 1, outboxEventId: event.id, outboxLeaseToken: outbox.leaseToken!,
      }, runtimeContext)).entityId;
    }
    await kernel.execute({
      type: "AcknowledgeOutboxEvents", idempotencyKey: `${key}:ack:${index}`,
      outboxEventIds: [event.id], leaseToken: outbox.leaseToken!,
    }, runtimeContext);
    if (activationId) {
      const id = activationId;
      return {
        runId: run.entityId, activationId: id,
        async close() {
          await kernel.execute({
            type: "FinishActivation", idempotencyKey: `${key}:finish`, activationId: id, outcome: "Completed",
          }, runtimeContext);
        },
      };
    }
  }
  throw new Error("Synthetic admission exceeded its bounded outbox scan.");
}
