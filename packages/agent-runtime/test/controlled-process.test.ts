import type { SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { TorsorKernel } from "@torsor/kernel";

import { nodeProbeDriver, type ControlledChild } from "../src/controlled-process.js";
import { LocalWorktreeExecutor } from "../src/worktree-executor.js";
import { activeRun, bootstrap, runtimeContext, syntheticRepository } from "./fixtures/worktree-fixture.js";
import { holdSqliteWriter } from "./fixtures/sqlite-lock.js";

const fixture = vi.hoisted((): {
  source: string | undefined;
  calls: { command: string; args: readonly string[]; options: SpawnOptions }[];
} => ({ source: undefined, calls: [] }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
      fixture.calls.push({ command, args, options });
      return original.spawn(command, fixture.source ? ["--input-type=commonjs", "-e", fixture.source] : args, options);
    },
  };
});

afterEach(() => {
  fixture.source = undefined;
  fixture.calls.length = 0;
  vi.unstubAllEnvs();
});

describe("fixed probe transport bounds and privacy (MVP 22.2)", () => {
  it("stops on real output overflow while SQLite is locked and retries revoked disposition", async () => {
    const repo = syntheticRepository();
    repo.addWorktree("first");
    const timeoutKey = Symbol.for("torsor.kernel.test-sqlite-busy-timeout-ms");
    Reflect.set(globalThis, timeoutKey, 100);
    const kernel = TorsorKernel.open({ databasePath: repo.databasePath, bootstrap });
    Reflect.deleteProperty(globalThis, timeoutKey);
    const run = await activeRun(kernel, "overflow-lock");
    let actual!: ControlledChild;
    let release: (() => Promise<void>) | undefined;
    fixture.source = `
      const {createHash} = require("node:crypto");
      const lines = require("node:readline").createInterface({input: process.stdin});
      lines.once("line", line => process.stdout.write(createHash("sha256").update(JSON.parse(line).content).digest("hex")+"\\n"));
      process.stdin.on("end", () => process.stdout.write("Synthetic excess output."));
      setInterval(() => {}, 1000);
    `;
    const executor = new LocalWorktreeExecutor({
      kernel, runtimePrincipalId: "runtime", ...repo,
      driver: { start: (input) => {
        actual = nodeProbeDriver.start(input);
        return { ...actual, result: actual.result.then(async (digest) => {
          release = await holdSqliteWriter(repo.databasePath);
          return digest;
        }) };
      } },
    });
    try {
      await executor.register({
        worktreeId: "first", directoryName: "first", baseRevision: repo.baseRevision, runId: run.runId,
      });
      await expect(executor.probe({ worktreeId: "first", activationId: run.activationId }))
        .rejects.toMatchObject({ outcome: "Unknown" });
      expect((await actual.closed).error).toBe("Controlled child exceeded its output limit.");
      await release!();
      await executor.close();
      expect((await kernel.query({ type: "GetPhysicalWorktree", worktreeId: "first" }, runtimeContext))
        .latestExecution?.authorityRevokedAt).not.toBeNull();
      expect(() => process.kill(actual.pid!, 0)).toThrow();
    } finally {
      await release?.();
      actual?.forceStop();
      if (actual) await actual.closed;
      await executor.close();
      kernel.close(); repo.dispose();
    }
  });

  it("uses exact executable/argv and a minimal environment, without inherited injection or credentials", async () => {
    const repo = syntheticRepository();
    vi.stubEnv("NODE_OPTIONS", "--require=synthetic-must-not-load");
    vi.stubEnv("SYNTHETIC_SECRET", "must-not-inherit");
    const child = nodeProbeDriver.start({ cwd: repo.repositoryPath, content: "Synthetic fixture." });
    try {
      expect(await child.result).toBe(createHash("sha256").update("Synthetic fixture.").digest("hex"));
      child.requestStop();
      expect(await child.closed).toEqual({ code: 0, signal: null, error: null });
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]).toMatchObject({
        command: process.execPath, args: ["--input-type=commonjs", "-e", expect.any(String)],
        options: { cwd: repo.repositoryPath, shell: false, stdio: ["pipe", "pipe", "pipe"] },
      });
      expect(fixture.calls[0]!.options.env).toEqual(
        process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
      );
    } finally { child.forceStop(); await child.closed; repo.dispose(); }
  });

  it.each([
    ["oversized stdout", 'process.stdout.write("x".repeat(66));'],
    ["oversized stderr", 'process.stderr.write("Synthetic private diagnostic.".repeat(100));'],
    ["malformed digest", 'process.stdout.write("x".repeat(64) + "\\n");'],
    ["non-ASCII digest", 'process.stdout.write(Buffer.alloc(65, 225));'],
  ])("rejects %s without retaining process data", async (_name, source) => {
    const repo = syntheticRepository();
    fixture.source = `${source} setInterval(() => {}, 1000);`;
    const child = nodeProbeDriver.start({ cwd: repo.repositoryPath, content: "Synthetic fixture." });
    try {
      await expect(child.result).rejects.toThrow(/Controlled child|Invalid controlled child/);
      const evidence = await child.closed;
      expect(evidence.error).toMatch(/Controlled child|Invalid controlled child/);
      expect(JSON.stringify(evidence)).not.toContain("Synthetic private diagnostic");
      expect(JSON.stringify(evidence)).not.toContain(repo.directory);
    } finally { child.forceStop(); await child.closed; repo.dispose(); }
  });

  it("does not turn a valid first frame followed by extra output into clean close evidence", async () => {
    const repo = syntheticRepository();
    fixture.source = `process.stdout.write("${"a".repeat(64)}\\n");
      setTimeout(() => process.stdout.write("extra"), 10); setInterval(() => {}, 1000);`;
    const child = nodeProbeDriver.start({ cwd: repo.repositoryPath, content: "Synthetic fixture." });
    try {
      await child.result.catch(() => undefined);
      expect((await child.closed).error).toBe("Controlled child exceeded its output limit.");
    } finally { child.forceStop(); await child.closed; repo.dispose(); }
  });
});
