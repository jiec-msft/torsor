import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadScenario, runScenario, toJsonl } from "@torsor/acp-conformance";

const basic = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));
const announce = {
  type: "notify", method: "session/update",
  params: { sessionId: "synthetic-session", update: {
    sessionUpdate: "tool_call", toolCallId: "synthetic-tool", title: "Synthetic private title",
  } },
};
const permission = {
  type: "request", method: "session/request_permission",
  params: {
    sessionId: "synthetic-session", toolCall: { toolCallId: "synthetic-tool" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  },
  expect: [{ path: "/outcome/outcome", equals: "cancelled" }],
};

describe("tool identity and permission lifecycle (spec section 4)", () => {
  it.each(["orphan-update", "duplicate-tool", "empty-tool", "unknown-session", "unknown-tool"])(
    "rejects %s before acknowledging invalid permissions", async (fault) => {
      const data = structuredClone(basic);
      if (fault === "orphan-update") {
        data.mock.handlers[2].actions.unshift({
          type: "notify", method: "session/update",
          params: { sessionId: "synthetic-session", update: { sessionUpdate: "tool_call_update", toolCallId: "synthetic-tool" } },
        });
      } else if (fault === "duplicate-tool") data.mock.handlers[2].actions.unshift(announce, structuredClone(announce));
      else if (fault === "empty-tool") {
        const empty = structuredClone(announce);
        empty.params.update.toolCallId = "";
        data.mock.handlers[2].actions.unshift(empty);
      } else {
        const request = structuredClone(permission);
        if (fault === "unknown-session") request.params.sessionId = "synthetic-unknown";
        else request.params.toolCall.toolCallId = "synthetic-unknown";
        data.mock.handlers[2].actions.unshift(announce, request);
      }
      const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]?.code).toBe("protocol_state");
      expect(result.transcript.filter((event) => event.direction === "client" && event.kind === "response")).toEqual([]);
      expect(toJsonl(result)).not.toContain("Synthetic private title");
    },
  );

  it.each(["before-prompt", "after-prompt"])("rejects permission %s", async (phase) => {
    const data = structuredClone(basic);
    if (phase === "before-prompt") data.steps = data.steps.slice(0, 4);
    else data.mock.handlers[2].actions.unshift(announce);
    data.steps.push(
      { type: "notification", method: "synthetic/check" },
      { type: "update", sessionUpdate: "session_info_update" },
    );
    data.mock.handlers.push({
      kind: "notification", method: "synthetic/check", actions: [
        permission,
        { type: "notify", method: "session/update", params: {
          sessionId: "synthetic-session", update: { sessionUpdate: "session_info_update", title: "Synthetic barrier" },
        } },
      ],
    });
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("protocol_state");
    expect(result.transcript.filter((event) => event.direction === "client" && event.kind === "response")).toEqual([]);
  });

  it("does not reuse initial tool IDs in a later turn", async () => {
    const data = structuredClone(basic);
    data.mock.handlers[2].actions.unshift(announce);
    data.steps.push({ ...data.steps[4], id: "next" }, { type: "response", id: "next" });
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.diagnostics[0]?.code).toBe("protocol_state");
  });

  it.each(["scoped", "foreign-tool", "permission-race"])("checks external provider %s", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-tool-lifecycle-"));
    const marker = join(directory, "events.txt");
    try {
      const data = structuredClone(basic);
      if (mode !== "permission-race") {
        data.steps.push(
          { ...data.steps[2], id: "second" }, { type: "response", id: "second" },
          { ...data.steps[4], id: "second-turn", params: { ...data.steps[4].params, sessionId: { $ref: "second#/sessionId" } } },
          { type: "response", id: "second-turn" },
        );
      }
      const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }), {
        allowReal: true,
        provider: {
          command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/tool-provider.mjs", import.meta.url)), marker, mode],
        },
      });
      const received = (await readFile(marker, "utf8")).trim().split("\n");
      expect(received.filter((event) => event === "permission-response")).toHaveLength(mode === "scoped" ? 2 : mode === "foreign-tool" ? 1 : 0);
      expect(result.status).toBe(mode === "scoped" ? "passed" : "failed");
      if (mode !== "scoped") expect(result.diagnostics[0]?.code).toBe("protocol_state");
      else {
        expect(toJsonl(result)).toContain('"toolCallId":"tool-1"');
        expect(toJsonl(result)).toContain('"toolCallId":"tool-2"');
      }
      expect(toJsonl(result)).not.toContain("synthetic-tool");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
