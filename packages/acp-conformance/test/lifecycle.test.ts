import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadScenario, runScenario, toJsonl } from "@torsor/acp-conformance";

const basic = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));
const cancel = JSON.parse(JSON.stringify(loadScenario(
  await readFile(new URL("../examples/cancel.yaml", import.meta.url), "utf8"), { format: "yaml" },
)));
const turnUpdates = [
  ...["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].map((sessionUpdate) => ({
    sessionUpdate, content: { type: "text", text: "Synthetic turn content." },
  })),
  { sessionUpdate: "tool_call", toolCallId: "synthetic-update-tool", title: "Synthetic tool", kind: "read", status: "pending" },
  { sessionUpdate: "tool_call_update", toolCallId: "synthetic-update-tool", status: "completed" },
];
const sessionUpdates = [
  { sessionUpdate: "available_commands_update", availableCommands: [] },
  { sessionUpdate: "current_mode_update", currentModeId: "synthetic-mode" },
  { sessionUpdate: "config_option_update", configOptions: [] },
  { sessionUpdate: "session_info_update", title: "Synthetic title" },
  { sessionUpdate: "usage_update", used: 1, size: 100 },
];
const unsafeParams = [
  { cwd: "/synthetic-outside", mcpServers: [] },
  { cwd: { $ref: "workspace" }, mcpServers: [], additionalDirectories: ["/synthetic-outside"] },
  { cwd: { $ref: "workspace" }, mcpServers: [{ name: "synthetic", command: "synthetic", args: [], env: [] }] },
];

describe("session lifecycle fences (spec section 4)", () => {
  it.each([false, true])("rejects duplicate session IDs with concurrent creation: %s", async (concurrent) => {
    const data = structuredClone(basic);
    const second = { ...data.steps[2], id: "second" };
    data.steps = concurrent
      ? [...data.steps.slice(0, 3), second, data.steps[3], { type: "response", id: "second" }]
      : [...data.steps.slice(0, 4), second, { type: "response", id: "second" }];
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("protocol_result");
    expect(toJsonl(result)).not.toContain("synthetic-session");
  });

  it.each([...turnUpdates, ...sessionUpdates])("rejects $sessionUpdate for a never-created session", async (update) => {
    const data = structuredClone(basic);
    data.mock.handlers[2].actions.unshift({
      type: "notify", method: "session/update", params: { sessionId: "synthetic-unknown", update },
    });
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("protocol_state");
  });

  it.each(["end_turn", "cancelled"].flatMap((stopReason) => turnUpdates.map((update) => ({ stopReason, update }))))(
    "rejects late $update.sessionUpdate after $stopReason, including drain",
    async ({ stopReason, update }) => {
      const data = structuredClone(stopReason === "cancelled" ? cancel : basic);
      data.mock.onStdinClose = [{
        type: "notify", method: "session/update", params: { sessionId: "synthetic-session", update },
      }];
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("protocol_state");
      }
    },
  );

  it("permits turn updates while cancellation is pending and session metadata after completion", async () => {
    const data = structuredClone(cancel);
    data.mock.handlers[2].actions.splice(-1, 0, ...turnUpdates.map((update) => ({
      type: "notify", method: "session/update", params: { sessionId: "synthetic-session", update },
    })));
    data.mock.onStdinClose = sessionUpdates.map((update) => ({
      type: "notify", method: "session/update", params: { sessionId: "synthetic-session", update },
    }));
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result).toMatchObject({ status: "passed", diagnostics: [] });
    expect(result.transcript.filter((event) => event.message.method === "session/update")).toHaveLength(12);
  });

  it.each(["before-prompt", "after-error"])("requires an active turn %s", async (phase) => {
    const data = structuredClone(basic);
    if (phase === "before-prompt") data.steps = data.steps.slice(0, 4);
    else {
      data.mock.handlers[2].actions = [{ type: "reply", errorCode: -32123 }];
      data.steps[5] = { type: "response", id: "turn", errorCode: -32123 };
    }
    data.mock.onStdinClose = [{
      type: "notify", method: "session/update",
      params: { sessionId: "synthetic-session", update: turnUpdates[0] },
    }];
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.diagnostics[0]?.code).toBe("protocol_state");
  });

  it("rejects overlapping prompts but accepts a new turn after completion", async () => {
    const data = structuredClone(basic);
    const next = { ...data.steps[4], id: "next" };
    data.steps.push(next, { type: "response", id: "next" });
    expect((await runScenario(loadScenario(JSON.stringify(data), { format: "json" }))).status).toBe("passed");
    data.steps = [...data.steps.slice(0, 5), next, data.steps[5], { type: "response", id: "next" }];
    data.mock.handlers[2].actions = [{ type: "fault", fault: { kind: "hang" } }];
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.diagnostics[0]?.code).toBe("protocol_state");
  });

  it.each(["session/load", "session/resume", "session/fork"].flatMap((method) =>
    ["request", "notification"].flatMap((type) => unsafeParams.map((params, index) => ({ method, type, params, index }))),
  ))("blocks $type $method unsafe variant $index before external transmission", async ({ method, type, params }) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-lifecycle-test-"));
    const marker = join(directory, "methods.jsonl");
    try {
      const data = structuredClone(basic);
      data.steps = [basic.steps[0], basic.steps[1],
        type === "request"
          ? { type, id: "lifecycle", method, params: { ...params, sessionId: "synthetic-session" } }
          : { type, method, params: { ...params, sessionId: "synthetic-session" } },
      ];
      if (type === "request") data.steps.push({ type: "response", id: "lifecycle" });
      const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }), {
        allowReal: true,
        provider: {
          command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/lifecycle-provider.mjs", import.meta.url)), marker],
        },
      });
      const received = (await readFile(marker, "utf8")).trim().split("\n");
      expect(received).toEqual(["initialize"]);
      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]?.code).toBe("protocol_state");
      expect(toJsonl(result)).not.toContain("synthetic-outside");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
