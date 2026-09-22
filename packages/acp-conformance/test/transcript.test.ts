import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { loadScenario, runScenario, toJsonl } from "@torsor/acp-conformance";

const basic = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));

describe("safe protocol artifacts (spec sections 4-5)", () => {
  it("omits opaque prose, metadata, keys, stderr and paths before serialization", async () => {
    const data = structuredClone(basic);
    const secret = "SYNTHETIC_PRIVATE_MATERIAL";
    data.steps[4].params.prompt[0].text = secret;
    data.mock.handlers[0].actions[0].result.agentInfo = { name: secret, version: secret };
    data.mock.handlers[0].actions[0].result._meta = { [secret]: secret };
    data.mock.handlers[2].actions[0].params.update.content.text = secret;
    data.mock.handlers[2].actions[0].params.update.messageId = secret;
    data.mock.handlers[2].actions[0].params._meta = { [secret]: secret };
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("passed");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(process.cwd());
    const lines = toJsonl(result).trim().split("\n");
    for (const [index, line] of lines.entries()) {
      expect(JSON.parse(line)).toMatchObject({
        schemaVersion: 1, sequence: index, timestamp: new Date(index).toISOString(),
      });
    }
  });

  it("rejects malformed notifications before SDK logging can disclose payloads", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const data = structuredClone(basic);
      data.mock.handlers[2].actions = [{
        type: "fault", fault: {
          kind: "wire", message: {
            jsonrpc: "2.0", method: "session/update",
            params: { sessionId: "synthetic-session", update: { sessionUpdate: "agent_message_chunk", content: "SYNTHETIC_SECRET" } },
          },
        },
      }];
      const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]?.code).toBe("protocol_result");
      expect(output).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
    } finally { output.mockRestore(); }
  });

  it("rejects invalid protocol state and unresolved references without exposing values", async () => {
    const data = structuredClone(basic);
    data.steps[4].params.sessionId = { $ref: "missing#/sessionId" };
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.diagnostics[0]?.code).toBe("invalid_reference");
    data.steps = data.steps.slice(2, 4);
    const state = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(state.diagnostics[0]?.code).toBe("protocol_state");
  });

  it.each([
    ["capabilities", 0, { protocolVersion: 1, clientCapabilities: { terminal: true } }],
    ["workspace", 2, { cwd: "/synthetic-outside", mcpServers: [] }],
    ["MCP", 2, { cwd: { $ref: "workspace" }, mcpServers: [{ name: "synthetic", command: "synthetic", args: [], env: [] }] }],
  ])("refuses scenario %s that expands the client safety boundary", async (_name, index, params) => {
    const data = structuredClone(basic);
    data.steps[index].params = params;
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.diagnostics[0]?.code).toBe("protocol_state");
  });
});
