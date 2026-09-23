import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const scenario = process.argv[2] ?? "success";
const sessionId = "synthetic-private-session";
const privateValue = "synthetic-private-tool-data";
let promptId;
let permissionPending = false;
let modeSelected = false;
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const result = (id, value) => send({ id, result: value });
const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
const text = (value) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
const final = () => {
  text(JSON.stringify({ actions: [
    { type: "publish_reply", body: "Synthetic Worktree edit and test completed." },
    { type: "complete" },
  ] }));
  result(promptId, { stopReason: "end_turn" });
};
const work = () => {
  text(privateValue);
  update({
    sessionUpdate: "tool_call", toolCallId: `shell-${privateValue}`, status: "in_progress",
    kind: "execute", title: privateValue, rawInput: { command: privateValue }, content: [{ text: privateValue }],
  });
  if (scenario === "hang") return;
  writeFileSync("native-result.txt", "Synthetic native edit.\n");
  execFileSync(process.execPath, ["-e",
    "require('node:assert/strict').equal(require('node:fs').readFileSync('native-result.txt','utf8'),'Synthetic native edit.\\n')",
  ], { cwd: process.cwd(), env: {}, stdio: "ignore" });
  update({
    sessionUpdate: "tool_call_update", toolCallId: `shell-${privateValue}`,
    status: "completed", rawOutput: { text: privateValue },
  });
  update({
    sessionUpdate: "tool_call", toolCallId: `mcp-${privateValue}`, status: "in_progress",
    kind: "other", title: "Synthetic private MCP server", rawInput: { token: privateValue },
  });
  update({
    sessionUpdate: "tool_call_update", toolCallId: `mcp-${privateValue}`,
    status: scenario === "tool-failed" ? "failed" : "completed", rawOutput: { error: privateValue },
  });
  final();
};

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    result(request.id, { protocolVersion: 1, agentCapabilities: {} });
  } else if (request.method === "session/new") {
    if (request.params.cwd.toLowerCase() !== process.cwd().toLowerCase()) process.exit(7);
    if (Object.keys(process.env).some((name) => name.toUpperCase().startsWith("TORSOR_") ||
      ["COPILOT_ALLOW_ALL", "COPILOT_ASSISTED_APPROVAL"].includes(name.toUpperCase()))) process.exit(8);
    result(request.id, {
      sessionId,
      ...(scenario === "config-mode" ? { configOptions: [{
        id: "mode", type: "select", currentValue: "plan",
        options: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }],
      }] } : {}),
      modes: { currentModeId: scenario === "legacy-mode" ? "plan" : "interactive", availableModes: [
        { id: "interactive", name: "Interactive" }, { id: "autopilot", name: "Autopilot" },
      ] },
    });
  } else if (request.method === "session/set_mode" || request.method === "session/set_config_option") {
    modeSelected = (scenario === "legacy-mode" && request.params.modeId === "interactive") ||
      (scenario === "config-mode" && request.params.configId === "mode" && request.params.value === "agent");
    if (!modeSelected) process.exit(9);
    result(request.id, {});
  } else if (request.method === "session/prompt") {
    promptId = request.id;
    const state = JSON.parse(request.params.prompt[0].text.split("\n").at(-1));
    if (state.cause === "attention") {
      text(JSON.stringify({ actions: [{ type: "create_run" }] }));
      result(request.id, { stopReason: "end_turn" });
      return;
    }
    if (["config-mode", "legacy-mode"].includes(scenario) && !modeSelected) process.exit(9);
    if (scenario === "permission") {
      permissionPending = true;
      send({ id: 500, method: "session/request_permission", params: {
        sessionId, toolCall: { toolCallId: privateValue, title: privateValue },
        options: [
          { optionId: "once-choice", kind: "allow_once", name: privateValue },
          { optionId: "always-choice", kind: "allow_always", name: privateValue },
        ],
      } });
    } else work();
  } else if (request.id === 500 && permissionPending) {
    permissionPending = false;
    if (request.result?.outcome?.outcome === "selected" &&
        request.result.outcome.optionId === "always-choice") work();
    else result(promptId, { stopReason: "cancelled" });
  } else if (request.method === "session/cancel" && promptId !== undefined) {
    final();
  }
});
lines.on("close", () => process.exit(0));
