import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [marker, mode] = process.argv.slice(2);
let sessions = 0;
let permissions = 0;
const pending = new Map();
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const send = (...messages) => process.stdout.write(messages.map((message) => JSON.stringify(message) + "\n").join(""));

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.method) {
    await appendFile(marker, "permission-response\n");
    if (message.result?.outcome?.outcome !== "cancelled") throw new Error("Expected cancellation.");
    if (pending.has(message.id)) {
      send(reply(pending.get(message.id), { stopReason: "end_turn" }));
      pending.delete(message.id);
    }
  } else if (message.method === "initialize") {
    await appendFile(marker, "initialize\n");
    send(reply(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }));
  } else if (message.method === "session/new") {
    send(reply(message.id, { sessionId: `synthetic-session-${++sessions}` }));
  } else if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    const announcement = {
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "synthetic-tool", title: "Synthetic tool" } },
    };
    const permission = {
      jsonrpc: "2.0", id: `permission-${++permissions}`, method: "session/request_permission",
      params: {
        sessionId, toolCall: { toolCallId: "synthetic-tool" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    };
    if (mode === "permission-race") {
      send(announcement, permission, reply(message.id, { stopReason: "end_turn" }));
    } else {
      pending.set(permission.id, message.id);
      if (mode !== "foreign-tool" || sessionId === "synthetic-session-1") send(announcement);
      send(permission);
    }
  }
}
