import { join } from "node:path";
import { AgentRuntime, DeterministicFakeAdapter } from "@torsor/agent-runtime";
import { LocalArtifactStorage, TorsorKernel } from "@torsor/kernel";

const [directory, timestamp] = process.argv.slice(2);
if (!directory || !timestamp) throw new Error("The owned crash fixture requires its directory and logical time.");
const local = await LocalArtifactStorage.open(join(directory, "artifacts"));
const clock = () => new Date(timestamp);
const kernel = TorsorKernel.open({
  databasePath: join(directory, "state.sqlite"), clock,
  artifactStorage: {
    read: local.read.bind(local),
    async put(digest, content) {
      await local.put(digest, content);
      // SS-3.7: real bytes exist, but no descriptor transaction has committed.
      process.exit(77);
    },
  },
});
const runtime = new AgentRuntime({
  kernel, runtimePrincipalId: "runtime-scenario", projectIds: ["project-scenario"], clock,
  adapter: new DeterministicFakeAdapter(async ({ cause, capabilities }) => {
    if (cause.type === "attention") {
      await capabilities.createRunFromAttention();
    } else {
      await capabilities.appendActivity("synthetic_checkpoint", { durable: true });
      await capabilities.publishReport({ idempotencyKey: "crash-report", text: "Synthetic crash report.\n" });
    }
  }),
});
try {
  await runtime.drainUntilIdle();
  throw new Error("Crash fixture did not reach the finalization boundary.");
} finally {
  kernel.close();
}
