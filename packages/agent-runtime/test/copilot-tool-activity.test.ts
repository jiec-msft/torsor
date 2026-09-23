import { describe, expect, it } from "vitest";

import { CopilotToolActivity } from "../src/copilot-tool-activity.js";
import { ProviderProtocolError } from "../src/types.js";

const kinds = [
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch",
  "switch_mode", "other",
] as const;

function call(
  toolCallId = "synthetic-private-tool",
  status: unknown = "pending",
  kind: unknown = "execute",
) {
  return { sessionUpdate: "tool_call", toolCallId, status, kind };
}

function update(toolCallId: unknown, status: unknown) {
  return { sessionUpdate: "tool_call_update", toolCallId, status };
}

function fact(
  kind: "tool_started" | "tool_completed" | "tool_failed",
  toolCallId = "tool-1",
  toolKind: (typeof kinds)[number] = "execute",
) {
  return {
    kind,
    payload: {
      toolCallId,
      kind: toolKind,
      status: kind === "tool_started" ? "in_progress"
        : kind === "tool_completed" ? "completed" : "failed",
    },
  };
}

function protocolError(action: () => unknown, code = "provider_protocol_error") {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProviderProtocolError);
  expect(failure).toMatchObject({ diagnosticCode: code, outcome: "Failed" });
  expect(String(failure)).not.toContain("synthetic-private");
}

describe("bounded Copilot tool observation", () => {
  it("ignores unrelated notifications without consuming the tool budget", () => {
    const activity = new CopilotToolActivity(1, 1);
    for (const input of [
      null, undefined, "synthetic-private", [], {},
      { sessionUpdate: "agent_message_chunk", content: { text: "synthetic-private" } },
      { sessionUpdate: "available_commands_update" },
    ]) {
      expect(activity.accept(input)).toEqual([]);
    }
    expect(activity.accept(call())).toEqual([fact("tool_started")]);
  });

  it.each(["pending", "in_progress"])("starts %s once and preserves event ordering", (status) => {
    const activity = new CopilotToolActivity();
    expect(activity.accept(call("synthetic-private-one", status))).toEqual([fact("tool_started")]);
    expect(activity.accept(call("synthetic-private-one", status))).toEqual([]);
    expect(activity.accept(update("synthetic-private-one", "in_progress"))).toEqual([]);
    expect(activity.accept(call("synthetic-private-two", "in_progress", "read"))).toEqual([
      fact("tool_started", "tool-2", "read"),
    ]);
    expect(activity.accept(update("synthetic-private-two", "completed"))).toEqual([
      fact("tool_completed", "tool-2", "read"),
    ]);
    expect(activity.accept(update("synthetic-private-one", "failed"))).toEqual([fact("tool_failed")]);
  });

  it.each(["completed", "failed"] as const)("starts a terminal initial %s before its terminal fact", (status) => {
    const activity = new CopilotToolActivity();
    const terminal = status === "completed" ? "tool_completed" : "tool_failed";
    expect(activity.accept(call("synthetic-private-tool", status))).toEqual([
      fact("tool_started"), fact(terminal),
    ]);
    expect(activity.accept(update("synthetic-private-tool", status))).toEqual([]);
    expect(activity.accept(call("synthetic-private-tool", status))).toEqual([]);
  });

  it("defaults omitted initial fields and preserves omitted update fields", () => {
    const activity = new CopilotToolActivity();
    expect(activity.accept({
      sessionUpdate: "tool_call", toolCallId: "synthetic-private-tool",
    })).toEqual([fact("tool_started", "tool-1", "other")]);
    expect(activity.accept({
      sessionUpdate: "tool_call_update", toolCallId: "synthetic-private-tool",
      content: [{ type: "text", text: "synthetic-private-text" }],
    })).toEqual([]);
    expect(activity.accept({
      ...update("synthetic-private-tool", "in_progress"), kind: "execute",
    })).toEqual([]);
    expect(activity.accept(update("synthetic-private-tool", "completed"))).toEqual([
      fact("tool_completed"),
    ]);
    expect(activity.accept({
      sessionUpdate: "tool_call_update", toolCallId: "synthetic-private-tool",
    })).toEqual([]);
  });

  it.each(kinds)("retains only the ACP %s kind", (kind) => {
    expect(new CopilotToolActivity().accept(call("synthetic-private-tool", "completed", kind))).toEqual([
      fact("tool_started", "tool-1", kind), fact("tool_completed", "tool-1", kind),
    ]);
  });

  it.each(["synthetic-private-shell", "constructor", "__proto__", null, 7, {}])(
    "normalizes unknown kind %j without echoing it", (kind) => {
      expect(new CopilotToolActivity().accept(call("synthetic-private-tool", "pending", kind))).toEqual([
        fact("tool_started", "tool-1", "other"),
      ]);
    },
  );

  it("publishes no private IDs, titles, arguments, results, paths, MCP names, or diagnostic text", () => {
    const activity = new CopilotToolActivity();
    const privatePayload = {
      title: "synthetic-private-title",
      command: "synthetic-private-command",
      path: "C:\\synthetic-private\\workspace",
      mcpServerName: "synthetic-private-mcp",
      rawInput: { token: "synthetic-private-token", arguments: "synthetic-private-args" },
      rawOutput: { result: "synthetic-private-result" },
      content: [{ type: "text", text: "synthetic-private-content" }],
      locations: [{ path: "C:\\synthetic-private\\file", line: 1 }],
      error: "synthetic-private-error",
    };
    const initial = { ...call(), ...privatePayload };
    const before = JSON.stringify(initial);
    const events = [
      ...activity.accept(initial),
      ...activity.accept({ ...update("synthetic-private-tool", "failed"), ...privatePayload }),
    ];
    expect(events).toEqual([fact("tool_started"), fact("tool_failed")]);
    expect(JSON.stringify(events)).not.toContain("synthetic-private");
    expect(JSON.stringify(initial)).toBe(before);
  });

  it("does not inspect private payload accessors or retain a caller-owned output object", () => {
    const activity = new CopilotToolActivity();
    const input = call();
    Object.defineProperty(input, "rawOutput", {
      get() { throw new Error("synthetic-private-accessor"); },
    });
    const events = activity.accept(input);
    try {
      (events[0]!.payload as { toolCallId: string }).toolCallId = "synthetic-private-mutated";
    } catch {
      // Frozen public facts may reject mutation; mutable facts must still be detached from state.
    }
    expect(activity.accept(update("synthetic-private-tool", "completed"))).toEqual([
      fact("tool_completed"),
    ]);
  });

  it.each([
    ["completed", "pending"], ["completed", "in_progress"], ["completed", "failed"],
    ["failed", "pending"], ["failed", "in_progress"], ["failed", "completed"],
  ])("rejects terminal state change %s -> %s", (initial, next) => {
    const activity = new CopilotToolActivity();
    activity.accept(call("synthetic-private-tool", initial));
    protocolError(() => activity.accept(update("synthetic-private-tool", next)));
  });

  it("rejects unknown updates without allocating a public ID", () => {
    const activity = new CopilotToolActivity();
    protocolError(() => activity.accept(update("synthetic-private-unknown", "completed")));
    expect(activity.accept(call())).toEqual([fact("tool_started")]);
  });

  it.each([null, true, 1, "", "synthetic-private-status", "COMPLETED"])(
    "rejects invalid status %j", (status) => {
      protocolError(() => new CopilotToolActivity().accept(call("synthetic-private-tool", status)));
      const activity = new CopilotToolActivity();
      activity.accept(call());
      protocolError(() => activity.accept(update("synthetic-private-tool", status)));
    },
  );

  it.each([undefined, null, 1, "", "synthetic-private".repeat(17)])(
    "rejects invalid or overlong raw tool ID %j", (toolCallId) => {
      protocolError(() => new CopilotToolActivity().accept({ ...call(), toolCallId }));
    },
  );

  it("accepts the exact 256-character raw ID limit without publishing it", () => {
    const rawId = "x".repeat(256);
    const activity = new CopilotToolActivity();
    expect(activity.accept(call(rawId))).toEqual([fact("tool_started")]);
    expect(activity.accept(update(rawId, "completed"))).toEqual([fact("tool_completed")]);
  });

  it("caps distinct tools at 128, including terminal tools, and scopes IDs to the instance", () => {
    const activity = new CopilotToolActivity();
    for (let index = 1; index <= 128; index += 1) {
      expect(activity.accept(call(`synthetic-private-${index}`, "completed"))).toEqual([
        fact("tool_started", `tool-${index}`), fact("tool_completed", `tool-${index}`),
      ]);
    }
    protocolError(() => activity.accept(call("synthetic-private-overflow")), "provider_output_limit");
    expect(new CopilotToolActivity().accept(call())).toEqual([fact("tool_started")]);
  });

  it("caps all tool notifications at 512, including duplicate terminal and content-only updates", () => {
    const activity = new CopilotToolActivity();
    activity.accept(call("synthetic-private-tool", "completed"));
    for (let index = 1; index < 512; index += 1) {
      expect(activity.accept(index % 2
        ? update("synthetic-private-tool", "completed")
        : { sessionUpdate: "tool_call_update", toolCallId: "synthetic-private-tool" })).toEqual([]);
    }
    protocolError(() => activity.accept(update("synthetic-private-tool", "completed")), "provider_output_limit");
  });

  it("supports lower independent limits", () => {
    const tools = new CopilotToolActivity(1, 3);
    tools.accept(call("synthetic-private-one"));
    protocolError(() => tools.accept(call("synthetic-private-two")), "provider_output_limit");
    const updates = new CopilotToolActivity(2, 1);
    updates.accept(call());
    protocolError(() => updates.accept(update("synthetic-private-tool", "completed")), "provider_output_limit");
  });

  it("requires every started tool to settle before successful provider completion", () => {
    const activity = new CopilotToolActivity();
    expect(() => activity.assertComplete()).not.toThrow();
    activity.accept(call("synthetic-private-one"));
    activity.accept(call("synthetic-private-two"));
    protocolError(() => activity.assertComplete());
    activity.accept(update("synthetic-private-one", "completed"));
    protocolError(() => activity.assertComplete());
    activity.accept(update("synthetic-private-two", "failed"));
    expect(() => activity.assertComplete()).not.toThrow();
  });

  it("rejects mutation of a terminal kind without republishing its terminal fact", () => {
    const activity = new CopilotToolActivity();
    activity.accept(call("synthetic-private-tool", "completed", "read"));
    protocolError(() => activity.accept({
      ...update("synthetic-private-tool", "completed"), kind: "execute",
    }));
    expect(activity.accept(update("synthetic-private-tool", "completed"))).toEqual([]);
  });

  it.each(["toolCallId", "kind", "status"])("rejects an accessor in %s without calling it", (key) => {
    const input = call();
    Object.defineProperty(input, key, {
      get() { throw new Error("synthetic-private-accessor"); },
    });
    protocolError(() => new CopilotToolActivity().accept(input));
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 129, 1_000_000])(
    "rejects unbounded or invalid tool-count limit %s", (limit) => {
      protocolError(() => new CopilotToolActivity(limit));
    },
  );

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 513, 1_000_000])(
    "rejects unbounded or invalid update-count limit %s", (limit) => {
      protocolError(() => new CopilotToolActivity(1, limit));
    },
  );
});
