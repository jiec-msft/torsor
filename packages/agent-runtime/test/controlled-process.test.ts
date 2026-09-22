import type { SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nodeProbeDriver } from "../src/controlled-process.js";
import { syntheticRepository } from "./fixtures/worktree-fixture.js";

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
