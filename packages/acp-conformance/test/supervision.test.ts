import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { loadScenario, runScenario } from "@torsor/acp-conformance";

describe("owned process lifetime (spec section 4)", () => {
  it.runIf(process.platform === "win32")("establishes ownership without a runtime compiler or PowerShell on PATH", async () => {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error("Windows requires SystemRoot for the ownership test.");
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === "PATH") environment[key] = join(systemRoot, "System32");
    }
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../bin/acp-conformance.mjs", import.meta.url)), "run",
      fileURLToPath(new URL("../examples/basic.json", import.meta.url)),
    ], { env: environment, timeout: 40_000, maxBuffer: 65_536 });
    expect(stdout).toContain("PASSED basic");
  });

  it("uses a separately bounded startup budget before protocol steps", async () => {
    const data = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));
    const defaults = loadScenario(JSON.stringify(data), { format: "json" });
    expect(defaults.limits).toMatchObject({ startupMs: 15000, stepMs: 5000 });
    data.limits = { startupMs: 1 };
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({ code: "timeout", step: -1 });
    expect(result.diagnostics[0]?.message).toMatch(/^Startup exceeded its configured deadline during /);
  });

  it("terminates a descendant after its provider parent exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-descendant-test-"));
    const marker = join(directory, "synthetic.pid");
    let pid: number | undefined;
    try {
      const scenario = loadScenario(JSON.stringify({
        schemaVersion: 1, id: "descendant", steps: [{ type: "exit", code: 0 }],
      }), { format: "json" });
      const result = await runScenario(scenario, {
        allowReal: true,
        provider: {
          command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/descendant.mjs", import.meta.url)), marker],
        },
      });
      pid = Number(await readFile(marker, "utf8"));
      expect(result.status).toBe("passed");
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("does not require voluntary exit unless the scenario asks for it", async () => {
    const data = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));
    data.mock.onStdinClose = [{ type: "fault", fault: { kind: "hang" } }];
    data.limits = { shutdownMs: 1000 };
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result).toMatchObject({ status: "passed", diagnostics: [] });
  });
});
