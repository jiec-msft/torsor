import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { ConfigurationError, loadScenario, runSuite, toJsonl } from "@torsor/acp-conformance";

const basic = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));

describe("canonical scenario contract (spec section 3)", () => {
  it.each(["fact", "reference"].flatMap((mode) =>
    ["length", "01", "00", "2", "-1", "1e0", "-", "0\n", " 0", "9007199254740993", "0", "1"]
      .map((token) => ({ mode, token, label: JSON.stringify(token) })),
  ))("uses RFC 6901 array indices for $mode token $label in JSON and YAML", async ({ mode, token }) => {
    const data = structuredClone(basic);
    const methods = [{ id: "synthetic-zero", name: "Zero" }, { id: "synthetic-one", name: "One" }];
    data.mock.handlers[0].actions[0].result.authMethods = methods;
    data.steps = data.steps.slice(0, 2);
    const valid = token === "0" || token === "1";
    const path = `/authMethods/${token}`;
    if (mode === "fact") {
      data.steps[1].expect = [
        valid ? { path, equals: structuredClone(methods[Number(token)]) } : { path, kind: token === "length" ? "number" : "object" },
      ];
    } else {
      data.steps.push(
        { type: "request", id: "consume", method: "synthetic/consume", params: { value: { $ref: `init#${path}` } } },
        { type: "response", id: "consume" },
      );
      data.mock.handlers.push({ kind: "request", method: "synthetic/consume", actions: [{ type: "reply", result: {} }] });
    }
    const results = await runSuite([
      loadScenario(JSON.stringify(data), { format: "json" }),
      loadScenario(stringify(data), { format: "yaml" }),
    ]);
    for (const result of results) {
      expect(result.status).toBe(valid ? "passed" : "failed");
      if (!valid) expect(result.diagnostics[0]?.code).toBe("assertion_failed");
    }
    expect(results[1]).toEqual(results[0]);
  });

  it.each(["fact", "reference"])("preserves exact JSON object member lookup for %s", async (mode) => {
    const data = structuredClone(basic);
    data.mock.handlers[0].actions[0].result._meta = { length: 7, "01": "synthetic-member" };
    data.steps = data.steps.slice(0, 2);
    if (mode === "fact") {
      data.steps[1].expect = [{ path: "/_meta/length", equals: 7 }, { path: "/_meta/01", equals: "synthetic-member" }];
    } else {
      data.steps.push(
        { type: "request", id: "consume", method: "synthetic/consume", params: {
          length: { $ref: "init#/_meta/length" }, member: { $ref: "init#/_meta/01" },
        } },
        { type: "response", id: "consume" },
      );
      data.mock.handlers.push({ kind: "request", method: "synthetic/consume", actions: [{ type: "reply", result: {} }] });
    }
    const results = await runSuite([
      loadScenario(JSON.stringify(data), { format: "json" }),
      loadScenario(stringify(data), { format: "yaml" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["passed", "passed"]);
    expect(results[1]).toEqual(results[0]);
  });

  it("gives JSON and YAML identical defaults and observable stdio results", async () => {
    const json = loadScenario(JSON.stringify(basic), { format: "json" });
    const yaml = loadScenario(stringify(basic), { format: "yaml" });
    expect(yaml).toEqual(json);
    const [first, second] = await runSuite([json, yaml]);
    expect(first?.status).toBe("passed");
    expect(second?.status).toBe("passed");
    expect(toJsonl(first!)).toBe(toJsonl(second!));
  });

  it.each([
    ["version", { ...basic, schemaVersion: 2 }, "$.schemaVersion"],
    ["unknown top field", { ...basic, extension: true }, "$"],
    ["unknown step field", { ...basic, steps: [{ type: "response", id: "init", optional: true }] }, "$.steps[0]"],
    ["negative limit", { ...basic, limits: { frameBytes: -1 } }, "$.limits.frameBytes"],
    ["excessive deadline", { ...basic, limits: { runMs: 300001 } }, "$.limits.runMs"],
    ["wrong scalar", { ...basic, limits: { events: "2048" } }, "$.limits.events"],
  ])("rejects %s consistently with source paths", (_name, value, path) => {
    for (const format of ["json", "yaml"] as const) {
      const text = format === "json" ? JSON.stringify(value) : stringify(value);
      expect(() => loadScenario(text, { format })).toThrow(path);
    }
  });

  it.each([
    "schemaVersion: 1\nschemaVersion: 1\n",
    "base: &base { id: synthetic }\ncopy: *base\n",
    "value: !!js/function function() {}\n",
    "value: !unregistered synthetic\n",
    "value: .inf\n",
    "value: { <<: { id: synthetic } }\n",
    "---\nschemaVersion: 1\n---\nschemaVersion: 1\n",
    "? [a, b]\n: value\n",
  ])("rejects ambiguous or non-JSON YAML without echoing source", (text) => {
    expect(() => loadScenario(text, { format: "yaml" })).toThrow(ConfigurationError);
  });

  it("bounds configuration size and depth without exposing source snippets", () => {
    expect(() => loadScenario(" ".repeat(262145), { format: "json" })).toThrow("256 KiB");
    const deep = "[".repeat(40) + '"synthetic-secret"' + "]".repeat(40);
    expect(() => loadScenario(deep, { format: "json" })).toThrow("bounded JSON");
    try { loadScenario('{"synthetic-secret":', { format: "json" }); }
    catch (error) { expect(String(error)).not.toContain("synthetic-secret"); }
  });

  it.each([
    ["flow sequence", "[".repeat(16_384) + '"synthetic-secret"' + "]".repeat(16_384)],
    ["flow mapping", "{key: ".repeat(4096) + '"synthetic-secret"' + "}".repeat(4096)],
    ["block mapping", Array.from({ length: 256 }, (_, index) => `${"  ".repeat(index)}key:\n`).join("")
      + "  ".repeat(256) + "synthetic-secret\n"],
  ])("promptly rejects deeply nested YAML %s with a sanitized configuration error", (_name, text) => {
    expect(Buffer.byteLength(text)).toBeLessThan(262_144);
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { ConfigurationError, loadScenario } from "@torsor/acp-conformance";
      assert.throws(() => loadScenario(readFileSync(0, "utf8"), { format: "yaml" }), (error) => {
        assert(error instanceof ConfigurationError);
        assert.deepEqual(error.paths, ["$"]);
        assert(!error.message.includes("synthetic-secret"));
        assert(!error.message.includes("RangeError"));
        return true;
      });
      console.log("rejected");
    `], { input: text, encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    expect(output).toBe("rejected\n");
  });

  it("accepts explicit JSON-compatible YAML core tags and rejects reserved artifact names", () => {
    const yaml = stringify(basic).replace("id: basic", "id: !!str basic");
    expect(loadScenario(yaml, { format: "yaml" }).id).toBe("basic");
    expect(() => loadScenario(JSON.stringify({ ...basic, id: "CON" }), { format: "json" })).toThrow("$.id");
  });

  it("rejects duplicate labels, response-before-request and duplicate mock handlers before spawning", () => {
    for (const steps of [
      [basic.steps[0], basic.steps[0]],
      [basic.steps[1]],
    ]) {
      expect(() => loadScenario(JSON.stringify({ ...basic, steps }), { format: "json" })).toThrow("$.steps");
    }
    expect(() => loadScenario(JSON.stringify({
      ...basic, mock: { handlers: [basic.mock.handlers[0], basic.mock.handlers[0]] },
    }), { format: "json" })).toThrow("$.mock.handlers");
  });
});
