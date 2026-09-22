import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { loadScenario, runScenario, toJsonl } from "@torsor/acp-conformance";

const basic = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));
const secret = "SYNTHETIC_PRIVATE_TOOL_DATA";

function toolScenario() {
  const data = structuredClone(basic);
  const tool = (toolCallId: string) => ({
    toolCallId, title: secret, kind: "read", status: "pending",
    rawInput: { [secret]: secret }, rawOutput: secret,
    locations: [{ path: secret }],
    content: [{ type: "content", content: { type: "text", text: secret } }],
  });
  const notify = (update: unknown) => ({
    type: "notify", method: "session/update", params: { sessionId: "synthetic-session", update },
  });
  data.mock.handlers[2].actions = [
    notify({ sessionUpdate: "tool_call", ...tool(`${secret}-one`) }),
    {
      type: "request", method: "session/request_permission",
      params: {
        sessionId: "synthetic-session", toolCall: { ...tool(`${secret}-one`), status: "in_progress" },
        options: [{ optionId: secret, name: secret, kind: "allow_once" }],
      },
      expect: [{ path: "/outcome/outcome", equals: "cancelled" }],
    },
    notify({ sessionUpdate: "tool_call", ...tool(`${secret}-two`) }),
    notify({ sessionUpdate: "tool_call_update", ...tool(`${secret}-one`), kind: "edit", status: "completed" }),
    { type: "reply", result: { stopReason: "end_turn" } },
  ];
  return data;
}

describe("safe protocol artifacts (spec sections 4-5)", () => {
  it("correlates tool updates and denied permissions without retaining opaque tool fields", async () => {
    const result = await runScenario(loadScenario(JSON.stringify(toolScenario()), { format: "json" }));
    expect(result).toMatchObject({ status: "passed", diagnostics: [] });
    const projected = result.transcript.filter((event) =>
      event.direction === "provider" && ["session/update", "session/request_permission"].includes(String(event.message.method)),
    ).map((event) => event.message.params);
    expect(projected).toEqual([
      { sessionId: "session-1", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", kind: "read", status: "pending" } },
      { sessionId: "session-1", toolCall: { toolCallId: "tool-1", kind: "read", status: "in_progress" } },
      { sessionId: "session-1", update: { sessionUpdate: "tool_call", toolCallId: "tool-2", kind: "read", status: "pending" } },
      { sessionId: "session-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", kind: "edit", status: "completed" } },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const key of ["rawInput", "rawOutput", "locations", "title", "options", "content"]) {
      expect(toJsonl(result)).not.toContain(`"${key}"`);
    }
    const repeated = await runScenario(loadScenario(JSON.stringify(toolScenario()), { format: "json" }));
    expect(toJsonl(repeated)).toBe(toJsonl(result));
  });

  it.each([
    ["toolCallId", `${secret}-two`], ["kind", "search"], ["status", "failed"],
  ])("distinguishes tool %s changes in normalized transcripts", async (key, value) => {
    const data = toolScenario();
    const first = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    data.mock.handlers[2].actions[3].params.update[key] = value;
    const changed = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(first.status).toBe("passed");
    expect(changed.status).toBe("passed");
    expect(toJsonl(changed)).not.toBe(toJsonl(first));
    expect(JSON.stringify(changed)).not.toContain(secret);
  });

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
    ["additional directories", 2, { cwd: { $ref: "workspace" }, mcpServers: [], additionalDirectories: ["/synthetic-outside"] }],
    ["malformed additional directories", 2, { cwd: { $ref: "workspace" }, mcpServers: [], additionalDirectories: "/synthetic-outside" }, "protocol_result"],
    ["MCP", 2, { cwd: { $ref: "workspace" }, mcpServers: [{ name: "synthetic", command: "synthetic", args: [], env: [] }] }],
  ])("refuses scenario %s that expands the client safety boundary", async (_name, index, params, code = "protocol_state") => {
    const data = structuredClone(basic);
    data.steps[index].params = params;
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.diagnostics[0]?.code).toBe(code);
  });
});
