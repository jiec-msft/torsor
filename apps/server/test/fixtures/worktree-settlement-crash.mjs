import { AgentRuntime, DeterministicFakeAdapter, LocalWorktreeExecutor, ProviderExecutionError } from "@torsor/agent-runtime";
import { LocalArtifactStorage, TorsorKernel } from "@torsor/kernel";

// Exit after a real committed ProviderAttempt but before Activation/outbox settlement.
const input = JSON.parse(process.argv[2]);
const kernel = TorsorKernel.open({
  databasePath: input.databasePath,
  artifactStorage: await LocalArtifactStorage.open(input.artifactRoot),
});
const executor = new LocalWorktreeExecutor({ kernel, runtimePrincipalId: "runtime", ...input });
let sourceActivation;
let admission;
const execute = kernel.execute.bind(kernel);
kernel.execute = async (command, context) => {
  const result = await execute(command, context);
  if (command.type === "StartProviderAttempt" && command.outboxEventId) {
    admission = { outboxEventId: command.outboxEventId, outboxLeaseToken: command.outboxLeaseToken };
  }
  if (sourceActivation && (command.type === "FinishProviderAttempt" || command.type === "FailProviderAttempt")) {
    if (input.outcome === "Waiting-stale") {
      const physical = await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, { principalId: "runtime" });
      const run = await kernel.query({ type: "GetRunProjection", runId: physical.runId }, { principalId: "runtime" });
      await execute({
        type: "StartActivation", idempotencyKey: "synthetic-replacement", runId: physical.runId,
        expectedRunRevision: run.run.revision, ...admission,
      }, { principalId: "runtime" });
    }
    process.exit(77);
  }
  return result;
};
const adapter = new DeterministicFakeAdapter(async (context) => {
  if (context.cause.type === "attention") {
    const runId = await context.capabilities.createRunFromAttention();
    await executor.register({
      worktreeId: "first", directoryName: "first", baseRevision: input.baseRevision, runId,
    });
    return;
  }
  await context.worktree.probe("first");
  await context.capabilities.publishReport({ idempotencyKey: "crash-report", text: "Synthetic committed report." });
  await context.capabilities.appendActivity("status", { text: "Synthetic committed activity." });
  await context.capabilities.publishReply({ body: "Synthetic committed reply." });
  sourceActivation = context.activationId;
  if (input.outcome === "Failed") {
    await context.capabilities.fail("Synthetic Run failure.");
    throw new ProviderExecutionError("Synthetic Provider failure.", "Failed");
  } else if (input.outcome === "Unknown") {
    await context.capabilities.wait("Synthetic uncertain work.");
    throw new ProviderExecutionError("Synthetic uncertain Provider.", "Unknown");
  } else if (input.outcome.startsWith("Waiting")) {
    await context.capabilities.wait("Synthetic explicit waiting.");
  } else {
    await context.capabilities.complete({ incorporatedThroughInputSequence: 1 });
  }
});
const runtime = new AgentRuntime({
  kernel, adapter, runtimePrincipalId: "runtime", projectIds: ["project"], worktreeExecutor: executor,
  outboxLeaseMs: 30000, leaseSafetyMs: 1,
});
await executor.recover();
for (let pass = 0; pass < 20; pass++) await runtime.runOnce();
throw new Error("Crash fixture did not reach its committed window.");
