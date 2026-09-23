import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "success";
const privateValue = "synthetic-private-provider-data";
const sessionId = "synthetic-private-session";
const fixturePath = fileURLToPath(import.meta.url);
const lines = createInterface({ input: process.stdin });
let promptId;
let descendant;

const send = (message) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};
const result = (id, value) => send({ id, result: value });
const update = (value) => send({
  method: "session/update",
  params: { sessionId, update: value },
});
const text = (value) => update({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
});

function beginRun() {
  const worktreePath = process.cwd();
  const resultPath = join(worktreePath, "native-result.txt");
  update({
    sessionUpdate: "tool_call",
    toolCallId: process.execPath,
    status: "in_progress",
    kind: "execute",
    title: fixturePath,
    rawInput: {
      command: process.execPath,
      cwd: worktreePath,
      fixturePath,
      args: ["--test", "synthetic.test.cjs"],
      resultPath,
      privateValue,
    },
    content: [{ text: resultPath }],
  });
  if (mode !== "success") {
    descendant = spawn(process.execPath, [
      "--input-type=commonjs",
      "-e",
      "setInterval(() => {}, 1000)",
    ], { cwd: process.cwd(), env: {}, stdio: "ignore" });
    writeFileSync(
      "owned-processes.json",
      JSON.stringify([process.pid, descendant.pid]),
    );
    return;
  }
  writeFileSync("native-result.txt", "Synthetic native edit.\n");
  execFileSync(process.execPath, ["--test", "synthetic.test.cjs"], {
    cwd: process.cwd(),
    env: {},
    stdio: "ignore",
    timeout: 10_000,
  });
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: process.execPath,
    status: "completed",
    rawOutput: {
      command: process.execPath,
      cwd: worktreePath,
      fixturePath,
      resultPath,
      text: privateValue,
    },
  });
  text(JSON.stringify({
    actions: [
      {
        type: "publish_reply",
        body: "Synthetic trusted-local edit and test completed.",
      },
      { type: "complete" },
    ],
  }));
  result(promptId, { stopReason: "end_turn" });
}

function stopSafely() {
  if (!descendant) {
    process.exit(0);
  }
  descendant.once("close", () => process.exit(0));
  descendant.kill("SIGTERM");
  setTimeout(() => {
    descendant?.kill("SIGKILL");
  }, 250).unref();
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    result(request.id, { protocolVersion: 1, agentCapabilities: {} });
  } else if (request.method === "session/new") {
    if (request.params.cwd.toLowerCase() !== process.cwd().toLowerCase()) {
      process.exit(7);
    }
    if (Object.keys(process.env).some((name) =>
      name.toUpperCase().startsWith("TORSOR_") ||
      ["COPILOT_ALLOW_ALL", "COPILOT_ASSISTED_APPROVAL"].includes(name.toUpperCase())
    )) {
      process.exit(8);
    }
    result(request.id, {
      sessionId,
      modes: {
        currentModeId: "interactive",
        availableModes: [{ id: "interactive", name: "Interactive" }],
      },
    });
  } else if (request.method === "session/prompt") {
    promptId = request.id;
    const state = JSON.parse(request.params.prompt[0].text.split("\n").at(-1));
    if (state.cause === "attention") {
      text(JSON.stringify({ actions: [{ type: "create_run" }] }));
      result(promptId, { stopReason: "end_turn" });
    } else {
      beginRun();
    }
  } else if (request.method === "session/cancel" && promptId !== undefined) {
    if (mode === "stubborn-hang") return;
    result(promptId, { stopReason: "cancelled" });
  }
});

lines.on("close", () => {
  if (mode === "stubborn-hang") {
    setInterval(() => {}, 1000);
    return;
  }
  stopSafely();
});
