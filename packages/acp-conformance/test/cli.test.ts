import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { loadScenario, runScenario } from "@torsor/acp-conformance";

const example = fileURLToPath(new URL("../examples/basic.json", import.meta.url));
const cli = fileURLToPath(new URL("../bin/acp-conformance.mjs", import.meta.url));
const basic = JSON.parse(await readFile(example, "utf8"));

function invoke(args: string[], closeInput = false) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [cli, ...args], { timeout: 40_000, maxBuffer: 65_536 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
    if (closeInput) child.stdin?.end();
  });
}

describe("CLI and opt-in contract (spec sections 2 and 6)", () => {
  it.each(["result.json", "transcript.jsonl"])("preserves existing %s without creating a partial pair and permits clean retry", async (extension) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-cli-pair-"));
    const existing = join(directory, "basic.artifacts");
    try {
      await mkdir(existing);
      await writeFile(join(existing, extension), "synthetic-existing-content\n");
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await invoke(["run", example, "--out", directory])).code).toBe(2);
        expect(await readdir(directory)).toEqual(["basic.artifacts"]);
        expect(await readdir(existing)).toEqual([extension]);
        expect(await readFile(join(existing, extension), "utf8")).toBe("synthetic-existing-content\n");
      }
      await rm(existing, { recursive: true });
      expect((await invoke(["run", example, "--out", directory])).code).toBe(0);
      expect(await readdir(directory)).toEqual(["basic.artifacts"]);
      const summary = await readFile(join(existing, "result.json"), "utf8");
      const transcript = await readFile(join(existing, "transcript.jsonl"), "utf8");
      expect(JSON.parse(summary)).toMatchObject({ status: "passed", schemaVersion: 1 });
      expect(transcript.trim().split("\n").map((line) => JSON.parse(line))).not.toHaveLength(0);
      expect((await invoke(["run", example, "--out", directory])).code).toBe(2);
      expect(await readFile(join(existing, "result.json"), "utf8")).toBe(summary);
      expect(await readFile(join(existing, "transcript.jsonl"), "utf8")).toBe(transcript);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("allows only one concurrent writer to publish a complete artifact pair", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-cli-concurrent-pair-"));
    try {
      const results = await Promise.all([
        invoke(["run", example, "--out", directory]), invoke(["run", example, "--out", directory]),
      ]);
      expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
      expect(await readdir(directory)).toEqual(["basic.artifacts"]);
      expect(JSON.parse(await readFile(join(directory, "basic.artifacts", "result.json"), "utf8")).status).toBe("passed");
      const transcript = await readFile(join(directory, "basic.artifacts", "transcript.jsonl"), "utf8");
      expect(JSON.parse(transcript.trim().split("\n").at(-1)!)).toMatchObject({ direction: "harness", kind: "closed" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("fails standalone mock actions with a fixed diagnostic and nonzero exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-cli-mock-failure-"));
    try {
      const path = join(directory, "failure.json");
      const data = structuredClone(basic);
      data.mock.onStdinClose = [{ type: "reply", errorCode: -32123 }];
      await writeFile(path, JSON.stringify(data));
      const result = await invoke(["mock", path], true);
      expect(result).toEqual({ code: 2, stdout: "", stderr: "Mock action or assertion failed.\n" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not launch an external command or profile without explicit opt-in", async () => {
    const command = await invoke(["run", example, "--", "nonexistent-synthetic-provider"]);
    expect(command.code).toBe(3);
    expect(command.stdout).toContain("SKIPPED basic");
    expect(command.stdout).not.toContain("nonexistent-synthetic-provider");
    const profile = await invoke(["run", example, "--profile", "copilot-cli-v1"]);
    expect(profile.code).toBe(3);
    const result = await runScenario(loadScenario(JSON.stringify(basic), { format: "json" }), {
      provider: { command: "nonexistent-synthetic-provider", args: [] },
    });
    expect(result.status).toBe("skipped");
    expect(result.transcript).toEqual([]);
  });

  it("runs YAML and refuses to overwrite existing artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-cli-contract-"));
    try {
      const scenario = join(directory, "basic.yaml");
      await writeFile(scenario, stringify(basic));
      expect((await invoke(["run", scenario, "--out", directory])).code).toBe(0);
      const resultPath = join(directory, "basic.artifacts", "result.json");
      const before = await readFile(resultPath, "utf8");
      expect((await invoke(["run", scenario, "--out", directory])).code).toBe(2);
      expect(await readFile(resultPath, "utf8")).toBe(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("distinguishes scenario failure from invalid configuration without private paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-cli-diagnostic-"));
    try {
      const path = join(directory, "failure.json");
      const data = structuredClone(basic);
      data.steps[5].expect[0].equals = "refusal";
      await writeFile(path, JSON.stringify(data));
      const failed = await invoke(["run", path]);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toContain("step 5: assertion_failed");
      expect(failed.stdout + failed.stderr).not.toContain(directory);
      await writeFile(path, '{"schemaVersion":99}');
      const invalid = await invoke(["run", path]);
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).toContain("$.schemaVersion");
      expect(invalid.stderr).not.toContain(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
