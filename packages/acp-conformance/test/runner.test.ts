import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { loadScenario, runScenario, toJsonl } from "@torsor/acp-conformance";

describe("public conformance runner (spec sections 2-5)", () => {
  it("loads and runs the stdio initialize/session/prompt tracer bullet", async () => {
    const text = await readFile(new URL("../examples/basic.json", import.meta.url), "utf8");
    const scenario = loadScenario(text, { format: "json" });
    const result = await runScenario(scenario);

    expect(result).toMatchObject({ schemaVersion: 1, id: "basic", status: "passed", diagnostics: [] });
    const transcript = toJsonl(result).trim().split("\n").map((line) => JSON.parse(line));
    expect(transcript.filter((entry) => entry.kind === "request").map((entry) => entry.message.method))
      .toEqual(["initialize", "session/new", "session/prompt"]);
    expect(transcript.filter((entry) => entry.kind === "response")).toHaveLength(3);
    expect(toJsonl(result)).not.toContain("Synthetic reply.");
    expect(toJsonl(result)).not.toContain("Reply briefly");
  });

  it("runs the CLI and retains safe machine-readable artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-cli-test-"));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../bin/acp-conformance.mjs", import.meta.url)),
        "run", fileURLToPath(new URL("../examples/basic.json", import.meta.url)),
        "--out", directory,
      ], { timeout: 40_000 });
      expect(stdout).toContain("PASSED basic");
      expect(JSON.parse(await readFile(join(directory, "basic.result.json"), "utf8")))
        .toMatchObject({ schemaVersion: 1, status: "passed" });
      const lines = await readFile(join(directory, "basic.transcript.jsonl"), "utf8");
      expect(lines).toContain('"method":"session/prompt"');
      expect(lines).not.toContain(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
