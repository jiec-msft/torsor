import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const rounds = Number(process.argv[2] ?? 5);
if (process.argv.length > 3 || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) {
  throw new Error("Usage: npm run repeat:system-scenarios -- <1..100>");
}
const directory = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const state = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  cwd: directory, encoding: "utf8",
});
const before = state();
let expectedCount;
const measurements = [];
for (let round = 1; round <= rounds; round += 1) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "torsor-scenario-repeat-"));
  const outputFile = join(outputDirectory, "result.json");
  const started = performance.now();
  let result;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        vitest, "run", "--reporter=default", "--reporter=json", `--outputFile=${outputFile}`,
      ], {
        cwd: directory, shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      });
      let stdout = "";
      let stderr = "";
      let overflow = false;
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length + stderr.length > 4_194_304) { overflow = true; child.kill(); }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
        if (stdout.length + stderr.length > 4_194_304) { overflow = true; child.kill(); }
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code !== 0 || signal || overflow) {
          reject(new Error(`Scenario repeat ${round} failed (exit ${code}, signal ${signal}, overflow ${overflow}).\n${stdout}\n${stderr}`));
          return;
        }
        resolve();
      });
    });
    result = JSON.parse(await readFile(outputFile, "utf8"));
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
  if (!result.success || result.numFailedTests || !result.numTotalTests || result.numPendingTests) {
    throw new Error(`Repeat ${round} did not pass a nonempty, unskipped catalog.`);
  }
  expectedCount ??= result.numTotalTests;
  if (expectedCount !== result.numTotalTests) throw new Error("Scenario count changed between fresh processes.");
  if (state() !== before) throw new Error("Scenario repeat left dirty generated state.");
  const elapsedMs = Math.round(performance.now() - started);
  measurements.push(elapsedMs);
  console.log(JSON.stringify({
    round, tests: result.numTotalTests, elapsedMs, targetMet: elapsedMs < 10_000,
    scenarios: result.testResults.flatMap((file) => file.assertionResults.map((test) => ({
      name: test.fullName, elapsedMs: Math.round(test.duration ?? 0),
    }))),
  }));
}
console.log(JSON.stringify({
  rounds, testsPerRound: expectedCount,
  minMs: Math.min(...measurements), maxMs: Math.max(...measurements),
  meanMs: Math.round(measurements.reduce((sum, value) => sum + value, 0) / rounds),
}));
