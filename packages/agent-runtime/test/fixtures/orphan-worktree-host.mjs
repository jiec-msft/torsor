import { spawn } from "node:child_process";
import { TorsorKernel } from "@torsor/kernel";
import { LocalWorktreeExecutor } from "../../dist/index.js";

// A deliberate crash fixture. Unlike the shipped child, this child survives IPC loss.
// It is never selected by a production provider or executor configuration.
const input = JSON.parse(process.argv[2]);
const kernel = TorsorKernel.open({ databasePath: input.databasePath });
const driver = {
  start({ cwd }) {
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", `
      process.on("message", () => {});
      process.on("disconnect", () => {});
      setInterval(() => {}, 1000);
      process.send("ready");
    `], { cwd, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    return {
      pid: child.pid,
      result: new Promise((resolve, reject) => {
        child.once("message", () => resolve("ready"));
        child.once("error", reject);
      }),
      closed: new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, error: null }))),
      requestStop() {},
      forceStop: () => child.kill("SIGKILL"),
    };
  },
};
const executor = new LocalWorktreeExecutor({
  kernel, runtimePrincipalId: "runtime", rootPath: input.rootPath, repositoryPath: input.repositoryPath,
  driver, leaseDurationMs: 120000,
});
await executor.register({
  worktreeId: "first", directoryName: "first", runId: input.runId, baseRevision: input.baseRevision,
});
const execution = await executor.start({ worktreeId: "first", activationId: input.activationId });
await execution.result;
const physical = await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, { principalId: "runtime" });
process.send({ pid: physical.latestExecution.pid });
