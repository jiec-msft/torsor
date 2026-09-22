import { readFile } from "node:fs/promises";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { ConfigurationError, loadScenario, runSuite, toJsonl } from "@torsor/acp-conformance";

const basic = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));

describe("canonical scenario contract (spec section 3)", () => {
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
