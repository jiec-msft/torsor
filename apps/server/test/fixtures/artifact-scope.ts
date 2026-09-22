import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStorage, TorsorKernel } from "@torsor/kernel";
import { seedArtifactScopes, startArtifactRun } from "../../../../packages/kernel/test/artifact-scope-fixture.js";
import { bootstrap, humanContext, runtimeContext } from "../../../../packages/kernel/test/helpers.js";
import { createTorsorHttpService } from "../../src/index.js";

export async function artifactHttpFixture(equalBytes = false) {
  const directory = await mkdtemp(join(tmpdir(), "torsor-artifact-http-"));
  const storage = await LocalArtifactStorage.open(join(directory, "content"));
  let reads = 0;
  let time = new Date();
  const kernel = TorsorKernel.open({
    databasePath: join(directory, "state.sqlite"), clock: () => time,
    bootstrap: {
      ...bootstrap,
      principals: [...bootstrap.principals!, { id: "principal-remote", kind: "agent", displayName: "Remote" }],
      projects: [...bootstrap.projects!, { id: "project-other", name: "Other" }],
      channels: [...bootstrap.channels!, { id: "channel-other", projectId: "project-other", name: "other" }],
      agents: [...bootstrap.agents!, {
        id: "agent-remote", principalId: "principal-remote", projectId: "project-other",
        name: "Remote", configRevision: 1, config: {},
      }],
    },
    artifactStorage: {
      put: storage.put.bind(storage),
      read(digest, size) { reads += 1; return storage.read(digest, size); },
    },
  });
  const scopes = await seedArtifactScopes(kernel);
  const runs = [scopes.parent, scopes.sibling, scopes.child, scopes.unrelated];
  const keys = ["parent", "sibling", "child", "unrelated"];
  const before = (await kernel.query({ type: "GetBootstrap", projectId: "project-sample" }, humanContext)).latestEventId;
  const reports = [];
  for (const [index, run] of runs.entries()) {
    const content = Buffer.from(equalBytes ? "Shared synthetic report." : `Synthetic ${keys[index]} report.`);
    const result = await kernel.finalizeReport({
      runId: run.runId, expectedRunRevision: 1, idempotencyKey: "report", content,
    }, run.context);
    const artifact = await kernel.query({ type: "GetArtifact", artifactId: result.entityId }, humanContext);
    reports.push({ artifact, content, run, token: `synthetic-${keys[index]}` });
  }
  const end = (await kernel.query({ type: "GetBootstrap", projectId: "project-sample" }, humanContext)).latestEventId;
  const otherThread = await kernel.execute({
    type: "StartThread", idempotencyKey: "remote-project", projectId: "project-other", channelId: "channel-other",
    body: "A separate synthetic Project.", targetAgentIds: ["agent-remote"],
  }, humanContext);
  const remote = await startArtifactRun(kernel, otherThread, "remote", "remote-project");
  const remoteContent = Buffer.from(equalBytes ? "Shared synthetic report." : "Foreign Project synthetic report.");
  const remoteResult = await kernel.finalizeReport({
    runId: remote.runId, expectedRunRevision: 1, idempotencyKey: "remote-report", content: remoteContent,
  }, remote.context);
  const foreignProject = {
    artifact: await kernel.query({ type: "GetArtifact", artifactId: remoteResult.entityId }, humanContext),
    content: remoteContent, run: remote, token: "synthetic-remote",
  };
  const service = createTorsorHttpService({
    kernel, port: 0, eventBatchSize: 1, eventPollIntervalMs: 5, heartbeatIntervalMs: 20,
    credentials: [
      { token: "synthetic-human", principalContext: humanContext },
      { token: "synthetic-runtime", principalContext: runtimeContext },
      { token: "synthetic-unscoped", principalContext: { principalId: "principal-orbit" } },
      { token: foreignProject.token, principalContext: remote.context },
      ...reports.map((report) => ({ token: report.token, principalContext: report.run.context })),
    ],
  });
  const origin = await service.listen();
  return {
    kernel, service, origin, scopes, reports, foreignProject, before, end,
    get reads() { return reads; },
    expire() { time = new Date(time.getTime() + 300_001); },
    async close() {
      await service.close();
      kernel.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function readSseUntil(
  origin: string,
  token: string,
  cursor: string | null,
  until: (frames: readonly string[]) => boolean,
  headerCursor?: string,
) {
  const url = new URL("/api/v1/events", origin);
  url.searchParams.set("projectId", "project-sample");
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ...(headerCursor ? { "Last-Event-ID": headerCursor } : {}) },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || !response.body) throw new Error(`Unexpected SSE status ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  try {
    while (!until(frames)) {
      const next = await reader.read();
      if (next.done) throw new Error("SSE ended before the expected frame.");
      buffer += decoder.decode(next.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        frames.push(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    return frames;
  } finally {
    await reader.cancel();
  }
}
