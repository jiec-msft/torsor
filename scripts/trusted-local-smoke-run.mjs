import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, CopilotAcpAdapter, LocalWorktreeExecutor } from "@torsor/agent-runtime";
import { TorsorKernel } from "@torsor/kernel";

export async function runSmoke(fixture) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "torsor-native-smoke-")));
  let kernel;
  let executor;
  let runtime;
  try {
    const repositoryPath = join(directory, "repository");
    const rootPath = join(directory, "managed");
    const hooks = join(directory, "empty-hooks");
    const config = join(directory, "empty-gitconfig");
    for (const path of [repositoryPath, rootPath, hooks]) mkdirSync(path);
    writeFileSync(config, "");
    const env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (...args) => execFileSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], {
      cwd: repositoryPath, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    git("init", "--quiet", "--template=");
    writeFileSync(join(repositoryPath, "synthetic.test.cjs"),
      "require('node:assert/strict').equal(require('node:fs').readFileSync('native-result.txt','utf8'), 'Synthetic native edit.\\n');\n");
    git("add", "--", "synthetic.test.cjs");
    git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic smoke base");
    const baseRevision = git("rev-parse", "HEAD");
    const bootstrap = {
      principals: [
        { id: "human", kind: "human", displayName: "Avery" },
        { id: "runtime", kind: "runtime", displayName: "Runtime" },
        { id: "agent", kind: "agent", displayName: "Orbit" },
      ],
      projects: [{ id: "project", name: "Synthetic" }],
      channels: [{ id: "channel", projectId: "project", name: "general" }],
      agents: [{ id: "orbit", principalId: "agent", projectId: "project", name: "Orbit", configRevision: 1, config: {} }],
    };
    kernel = TorsorKernel.open({
      databasePath: join(directory, "kernel.sqlite"), bootstrap, activationDurationMs: 125_000,
    });
    executor = new LocalWorktreeExecutor({
      kernel, runtimePrincipalId: "runtime", repositoryPath, rootPath, baseRevision,
      leaseDurationMs: 125_000,
    });
    const adapter = new CopilotAcpAdapter({
      policy: { kind: "trusted-local", permissionMode: "allow-all" },
      ...(fixture ? { command: process.execPath, commandArgs: [fixture], unsafeAllowCustomCommandArgs: true,
        userEnvironment: {} } : {
        ...(process.env.TORSOR_COPILOT_COMMAND ? { command: process.env.TORSOR_COPILOT_COMMAND } : {}),
      }),
    });
    runtime = new AgentRuntime({
      kernel, runtimePrincipalId: "runtime", projectIds: ["project"], adapter,
      worktreeExecutor: executor, providerTimeoutMs: 120_000, activationDurationMs: 125_000,
      attentionLeaseMs: 125_000, outboxLeaseMs: 125_000,
    });
    await kernel.execute({
      type: "StartThread", idempotencyKey: "smoke", projectId: "project", channelId: "channel",
      targetAgentIds: ["orbit"],
      body: "Create a Run. In its assigned Worktree, write native-result.txt containing exactly Synthetic native edit. followed by a newline. Run node --test synthetic.test.cjs. Do not modify the test. Complete only after it passes. Publish no paths, tool output, credentials or private text.",
    }, { principalId: "human" });
    await runtime.drainUntilIdle(10);
    const trees = await kernel.query({ type: "ListPhysicalWorktrees" }, { principalId: "runtime" });
    assert.equal(trees.items.length, 1);
    const tree = trees.items[0];
    assert.equal(tree.latestExecution.state, "StopConfirmed");
    assert.equal(readFileSync(join(tree.directoryPath, "native-result.txt"), "utf8"), "Synthetic native edit.\n");
    execFileSync(process.execPath, ["--test", "synthetic.test.cjs"], {
      cwd: tree.directoryPath, env: {}, timeout: 10_000, stdio: "ignore",
    });
    const run = await kernel.query({ type: "GetRunProjection", runId: tree.runId }, { principalId: "runtime" });
    assert.equal(run.run.state, "Completed");
    assert.ok(run.activity.items.some((item) => item.kind === "tool_completed" && item.payload.kind === "execute"));
    assert.ok(!JSON.stringify(await kernel.readEvents(null, 500)).includes("synthetic-private"));
  } finally {
    runtime?.stop();
    let stopped = !executor;
    try {
      await executor?.close();
      const trees = kernel ? await kernel.query({ type: "ListPhysicalWorktrees" }, { principalId: "runtime" }) : undefined;
      stopped = !trees || trees.items.every((tree) => !tree.latestExecution ||
        ["StopConfirmed", "ForceTerminated"].includes(tree.latestExecution.state));
      if (!stopped) throw new Error("Smoke cleanup requires confirmed physical stop; synthetic directory remains quarantined.");
    }
    finally {
      kernel?.close();
      if (stopped) rmSync(directory, { recursive: true, force: true });
    }
  }
}
