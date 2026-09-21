import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "mock-acp", version: "1" },
        authMethods: [],
      },
    });
    return;
  }
  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "diagnostic-session" },
    });
    return;
  }
  if (message.method === "session/prompt") {
    const actions =
      process.env.MOCK_ACP_PLAN === "invalid"
        ? [
            { type: "complete" },
            {
              type: "report_status",
              status: "too-late",
            },
          ]
        : [
            {
              type: "report_status",
              status: "working",
              detail: "Mock ACP status.",
            },
            {
              type: "complete",
              finalReply: { body: "Mock ACP completed the Run." },
            },
          ];
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "diagnostic-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-1",
          content: {
            type: "text",
            text: JSON.stringify({ actions }),
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
