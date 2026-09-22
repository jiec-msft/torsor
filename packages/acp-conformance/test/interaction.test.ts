import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { loadScenario, runScenario, toJsonl } from "@torsor/acp-conformance";

const basic = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));
const permission = {
  sessionId: "synthetic-session",
  toolCall: { toolCallId: "synthetic-tool", title: "Synthetic request" },
  options: [{ optionId: "allow", name: "Allow", kind: "allow_always" }],
};
const deny = {
  type: "request", method: "session/request_permission", params: permission,
  expect: [{ path: "/outcome/outcome", equals: "cancelled" }],
};

describe("coordinated conversations (spec sections 3-4)", () => {
  it.each([false, true])("fails notification assertions independently of explicit exit: %s", async (explicitExit) => {
    const data = structuredClone(basic);
    data.steps.splice(5, 0,
      { type: "update", sessionUpdate: "agent_message_chunk" },
      { type: "notification", method: "session/cancel", params: { sessionId: { $ref: "session#/sessionId" } } },
    );
    data.steps.at(-1).expect[0].equals = "cancelled";
    if (explicitExit) data.steps.push({ type: "close-stdin" }, { type: "exit", code: 0 });
    data.mock.handlers[2].actions = [
      data.mock.handlers[2].actions[0],
      { type: "wait", gate: "cancel" },
      deny,
      { type: "reply", result: { stopReason: "cancelled" } },
    ];
    data.mock.handlers.push({
      kind: "notification", method: "session/cancel", actions: [
        { type: "release", gate: "cancel" },
        { ...deny, expect: [{ path: "/outcome/outcome", equals: "selected" }] },
      ],
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]?.code).toBe("mock_failed");
      expect(JSON.stringify(result)).not.toContain("Synthetic request");
    }
  });

  it("reports EOF action failures without an exit assertion", async () => {
    const data = structuredClone(basic);
    data.mock.onStdinClose = [{ type: "reply", errorCode: -32123 }];
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("mock_failed");
  });

  it("reports request action assertion failures through the same sanitized channel", async () => {
    const data = structuredClone(basic);
    data.expectFailure = "rpc_error";
    data.mock.handlers[2].actions.unshift({
      ...deny, expect: [{ path: "/outcome/outcome", equals: "selected" }],
    });
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("mock_failed");
  });

  it("denies permissions before and after cancel and completes the original prompt", async () => {
    const data = structuredClone(basic);
    data.id = "cancel-permission";
    data.steps.splice(5, 0,
      { type: "update", sessionUpdate: "agent_message_chunk" },
      { type: "notification", method: "session/cancel", params: { sessionId: { $ref: "session#/sessionId" } } },
    );
    data.steps.at(-1).expect[0].equals = "cancelled";
    data.mock.handlers[2].actions = [
      deny,
      data.mock.handlers[2].actions[0],
      { type: "wait", gate: "cancel" },
      deny,
      { type: "reply", result: { stopReason: "cancelled" } },
    ];
    data.mock.handlers.push({
      kind: "notification", method: "session/cancel",
      actions: [{ type: "release", gate: "cancel" }],
    });
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result).toMatchObject({ status: "passed", diagnostics: [] });
    const events = result.transcript;
    const cancelled = events.filter((event) =>
      event.direction === "client" && event.kind === "response",
    );
    expect(cancelled).toHaveLength(2);
    expect(cancelled.map((event) => event.message.result)).toEqual([
      { outcome: { outcome: "cancelled" } }, { outcome: { outcome: "cancelled" } },
    ]);
    expect(toJsonl(result)).not.toContain("Synthetic request");
  });

  it("returns Method Not Found for an unadvertised client tool without executing it", async () => {
    const data = structuredClone(basic);
    data.mock.handlers[2].actions.unshift({
      type: "request", method: "fs/read_text_file",
      params: { sessionId: "synthetic-session", path: "/synthetic/forbidden" },
      errorCode: -32601,
    });
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("passed");
    expect(toJsonl(result)).toContain('\"code\":-32601');
    expect(toJsonl(result)).not.toContain("/synthetic/forbidden");
  });

  it("allows release-before-wait and explicit stdin closure/exit", async () => {
    const data = structuredClone(basic);
    data.mock.handlers[2].actions.unshift(
      { type: "release", gate: "ready" }, { type: "wait", gate: "ready" },
    );
    data.steps.push({ type: "close-stdin" }, { type: "exit", code: 0 });
    expect((await runScenario(loadScenario(JSON.stringify(data), { format: "json" }))).status).toBe("passed");
  });

  it("reports a wrong stop reason after a coordinated cancel", async () => {
    const data = structuredClone(basic);
    data.steps.splice(5, 0,
      { type: "update", sessionUpdate: "agent_message_chunk" },
      { type: "notification", method: "session/cancel", params: { sessionId: { $ref: "session#/sessionId" } } },
    );
    data.mock.handlers[2].actions.splice(1, 0, { type: "wait", gate: "cancel" });
    data.mock.handlers.push({
      kind: "notification", method: "session/cancel", actions: [{ type: "release", gate: "cancel" }],
    });
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("protocol_result");
  });
});
