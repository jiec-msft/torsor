import { createInterface } from "node:readline";
import { closeSync } from "node:fs";

const mode = process.argv[2] ?? "valid";
const permissionId = mode === "permission-string" ? "synthetic-permission" : 900;
const parameter = Number(process.argv[3] ?? "0");
const lines = createInterface({ input: process.stdin });
let promptId;
let promptCount = 0;

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
    if (mode === "close-after-initialize") {
      setImmediate(() => process.exit(0));
    }
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
    promptId = message.id;
    promptCount += 1;
    if (mode === "recover-action-envelope" || mode === "unrecoverable-action-envelope") {
      const text = message.params?.prompt?.[0]?.text;
      if (promptCount === 2 &&
          (typeof text !== "string" || !text.includes('"type"') ||
           text.includes("SYNTHETIC_PRIVATE_OUTPUT"))) {
        process.stderr.write("Correction prompt leaked output or omitted the required action type.");
        process.exit(2);
      }
      if (promptCount > 2) {
        process.stderr.write("Unexpected third prompt.");
        process.exit(2);
      }
    }
    handlePrompt();
    return;
  }
  if (message.id === permissionId &&
      (mode === "permission" || mode === "permission-string" || mode === "permission-then-malformed")) {
    if (
      message.result?.outcome?.outcome !== "cancelled"
    ) {
      process.stderr.write("permission was not cancelled");
      process.exit(2);
    }
    if (mode === "permission-then-malformed") {
      sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: '{"actions":[{"action":"create_run"}]}' },
      });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    } else sendActions(validRunActions());
  }
});

function handlePrompt() {
  switch (mode) {
    case "valid":
      sendActions(validRunActions());
      return;
    case "recover-action-envelope":
    case "unrecoverable-action-envelope":
      if (promptCount === 2 && mode === "recover-action-envelope") {
        sendActions([{ type: "create_run" }]);
        return;
      }
      sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: 'SYNTHETIC_PRIVATE_OUTPUT {"actions":[{"action":"create_run"}]}',
        },
      });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      return;
    case "forbidden-action-then-valid":
      sendActions(promptCount === 1
        ? [{ type: "publish_artifact", location: "file:///synthetic" }]
        : [{ type: "create_run" }]);
      return;
    case "permission-then-malformed":
      if (promptCount === 2) {
        sendActions([{ type: "create_run" }]);
        return;
      }
      send({
        jsonrpc: "2.0", id: permissionId, method: "session/request_permission",
        params: {
          sessionId: "diagnostic-session",
          options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
          toolCall: { toolCallId: "forbidden", title: "Forbidden tool", kind: "execute" },
        },
      });
      return;
    case "invalid-plan":
      sendActions([
        { type: "complete" },
        { type: "report_status", status: "too-late" },
      ]);
      return;
    case "permission":
    case "permission-string":
      send({
        jsonrpc: "2.0",
        id: permissionId,
        method: "session/request_permission",
        params: {
          sessionId: "diagnostic-session",
          options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
          toolCall: {
            toolCallId: "forbidden",
            title: "Forbidden shell",
            kind: "execute",
            rawInput: { command: "echo forbidden" },
          },
        },
      });
      return;
    case "permission-close-stdin":
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "session/request_permission",
        params: {
          sessionId: "diagnostic-session",
          options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
          toolCall: {
            toolCallId: "closed-permission",
            title: "Closed permission pipe",
            kind: "execute",
            rawInput: { command: "echo forbidden" },
          },
        },
      });
      setImmediate(() => process.exit(0));
      return;
    case "cancel-close-stdin":
      sendUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "cancellation-ready",
        content: { type: "text", text: "{" },
      });
      closeInputAndHold();
      return;
    case "tool-activity":
      sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "forbidden",
        title: "Forbidden tool",
        status: "in_progress",
      });
      return;
    case "trailing-tool":
      sendActionsWithTrailingTool();
      return;
    case "delayed-trailing-tool":
      sendActionsWithDelayedTrailingTool();
      return;
    case "trailing-permission":
      sendActionsWithTrailingPermission();
      return;
    case "artifact":
      sendActions([
        {
          type: "publish_artifact",
          digest: "sha256:model-supplied",
          location: "file:///does/not/exist",
        },
        { type: "complete" },
      ]);
      return;
    case "report":
    case "forged-report":
      sendActions([
        {
          type: "publish_report",
          idempotencyKey: "investigation-report",
          text: "Synthetic ACP report.\n",
          ...(mode === "forged-report" ? { storageLocation: "file:///private/report" } : {}),
        },
        { type: "complete" },
      ]);
      return;
    case "malformed":
      process.stdout.write("{not-json}\n");
      return;
    case "oversized-frame":
      process.stdout.write(`${"x".repeat(parameter || 1024)}\n`);
      return;
    case "oversized-stdout": {
      const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} })}\n`;
      process.stdout.write(frame.repeat(Math.ceil((parameter || 1024) / frame.length)));
      return;
    }
    case "oversized-stderr":
      process.stderr.write(
        `SYNTHETIC_PRIVATE_STDERR_${"x".repeat(parameter || 1024)}`,
      );
      return;
    case "deep-json":
      sendActions([
        {
          type: "append_activity",
          kind: "deep",
          payload: nested(parameter || 20),
        },
        { type: "complete" },
      ]);
      return;
    case "many-actions":
      sendActions(
        Array.from({ length: parameter || 5 }, (_, index) => ({
          type: "report_status",
          status: `status-${index}`,
        })),
      );
      return;
    case "many-targets":
      sendActions([
        {
          type: "publish_reply",
          body: "targets",
          targetAgentIds: Array.from(
            { length: parameter || 5 },
            (_, index) => `agent-${index}`,
          ),
        },
        { type: "complete" },
      ]);
      return;
    case "long-field":
      sendActions([
        { type: "report_status", status: "x".repeat(parameter || 1024) },
        { type: "complete" },
      ]);
      return;
    case "split-actions":
      sendActions(validRunActions(), parameter || 3);
      return;
    case "slow-split":
      sendActionsSlowly(validRunActions(), parameter || 2);
      return;
    case "prompt-error":
      send({
        jsonrpc: "2.0",
        id: promptId,
        error: {
          code: -32000,
          message: "SYNTHETIC_PRIVATE_PROVIDER_ERROR",
          data: {
            prompt: "synthetic private prompt",
            modelOutput: "synthetic private model output",
          },
        },
      });
      return;
    case "exit":
      process.exit(7);
      return;
    case "private-diagnostics-exit":
      process.stderr.write([
        "SYNTHETIC_PRIVATE_MARKER",
        "C:\\synthetic-private\\workspace\\provider.log",
        "ghp_SYNTHETIC_TOKEN_VALUE",
        "COPILOT_PROVIDER_API_KEY=synthetic-provider-credential",
        "prompt=synthetic private prompt",
        "model_output=synthetic private model output",
      ].join("\n"));
      process.exit(7);
      return;
    case "wait":
      return;
    default:
      process.stderr.write(`unknown mock mode ${mode}`);
      process.exit(3);
  }
}

function validRunActions() {
  return [
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
}

function sendActions(actions, chunkCount = 1) {
  const output = JSON.stringify({ actions });
  const chunkSize = Math.max(1, Math.ceil(output.length / chunkCount));
  for (let offset = 0; offset < output.length; offset += chunkSize) {
    sendUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: `message-${offset}`,
      content: { type: "text", text: output.slice(offset, offset + chunkSize) },
    });
  }
  send({
    jsonrpc: "2.0",
    id: promptId,
    result: { stopReason: "end_turn" },
  });
}

function sendActionsSlowly(actions, delayMs) {
  const output = JSON.stringify({ actions });
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= output.length) {
      clearInterval(timer);
      send({
        jsonrpc: "2.0",
        id: promptId,
        result: { stopReason: "end_turn" },
      });
      return;
    }
    sendUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: `message-${offset}`,
      content: { type: "text", text: output[offset] },
    });
    offset += 1;
  }, delayMs);
}

function sendActionsWithTrailingTool() {
  const output = JSON.stringify({ actions: validRunActions() });
  const messages = [
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "diagnostic-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-valid",
          content: { type: "text", text: output },
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: "end_turn" },
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "diagnostic-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "trailing-forbidden",
          title: "Trailing forbidden tool",
          status: "in_progress",
        },
      },
    },
  ];
  process.stdout.write(
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
}

function sendActionsWithDelayedTrailingTool() {
  const output = JSON.stringify({ actions: validRunActions() });
  sendUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "message-valid",
    content: { type: "text", text: output },
  });
  send({
    jsonrpc: "2.0",
    id: promptId,
    result: { stopReason: "end_turn" },
  });
  setTimeout(() => {
    sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "delayed-forbidden",
      title: "Delayed forbidden tool",
      status: "in_progress",
    });
  }, 100);
}

function sendActionsWithTrailingPermission() {
  const output = JSON.stringify({ actions: validRunActions() });
  const messages = [
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "diagnostic-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-valid",
          content: { type: "text", text: output },
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: "end_turn" },
    },
    {
      jsonrpc: "2.0",
      id: 901,
      method: "session/request_permission",
      params: {
        sessionId: "diagnostic-session",
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        ],
        toolCall: {
          toolCallId: "trailing-permission",
          title: "Trailing permission",
          kind: "execute",
          rawInput: { command: "echo forbidden" },
        },
      },
    },
  ];
  process.stdout.write(
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
}

function sendUpdate(update) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "diagnostic-session",
      update,
    },
  });
}

function nested(depth) {
  let value = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = { value };
  }
  return value;
}

function closeInputAndHold() {
  lines.close();
  process.stdin.destroy();
  try {
    closeSync(0);
  } catch {
    // The descriptor may already be closed by destroy().
  }
  setInterval(() => {}, 1_000);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
