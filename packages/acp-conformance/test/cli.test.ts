import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      const resultPath = join(directory, "basic.result.json");
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
