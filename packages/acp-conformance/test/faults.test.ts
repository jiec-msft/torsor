import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { loadScenario, runScenario, toJsonl } from "@torsor/acp-conformance";

const basic = JSON.parse(await readFile(new URL("../examples/basic.json", import.meta.url), "utf8"));

describe("bounded fault handling (spec sections 3-5)", () => {
  it.each([
    [{ kind: "malformed" }, {}, "malformed_frame"],
    [{ kind: "oversized", bytes: 2049 }, { frameBytes: 2048 }, "frame_limit"],
    [{ kind: "stderr", bytes: 4097 }, { stderrBytes: 4096 }, "stderr_limit"],
    [{ kind: "stdout-close" }, {}, "stdout_closed"],
    [{ kind: "exit", code: 7 }, {}, "stdout_closed"],
    [{ kind: "hang" }, {}, "timeout"],
    [{ kind: "stdin-close" }, {}, "stdin_closed"],
    [{ kind: "wire", message: { jsonrpc: "2.0", id: 999, result: {} } }, {}, "unexpected_response"],
    [{ kind: "wire", message: [] }, {}, "invalid_envelope"],
    [{ kind: "wire", message: { jsonrpc: "1.0", id: 1, result: {} } }, {}, "invalid_envelope"],
  ])("reports %j as %s without leaving an active provider", async (fault, limits, code) => {
    const data = structuredClone(basic);
    data.limits = limits;
    data.mock.handlers[2].actions = [{ type: "fault", fault }];
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result).toMatchObject({ status: "failed", diagnostics: [{ code, step: 5 }] });
    expect(result.transcript.at(-1)?.kind).toBe("closed");
    expect(toJsonl(result)).not.toContain("stack");
  });

  it("recognizes an expected harness failure but preserves its diagnostic", async () => {
    const data = structuredClone(basic);
    data.expectFailure = "malformed_frame";
    data.mock.handlers[2].actions = [{ type: "fault", fault: { kind: "malformed" } }];
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result).toMatchObject({ status: "passed", diagnostics: [{ code: "malformed_frame" }] });
    data.expectFailure = "timeout";
    expect((await runScenario(loadScenario(JSON.stringify(data), { format: "json" }))).status).toBe("failed");
  });

  it("rejects a partial frame at EOF, including after a successful prompt response", async () => {
    const data = structuredClone(basic);
    data.mock.onStdinClose = [
      { type: "fault", fault: { kind: "wire", message: { jsonrpc: "2.0" }, newline: false } },
    ];
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("partial_frame");
  });

  it("bounds aggregate stdout and event volume even with valid small frames", async () => {
    for (const [limits, code] of [[{ stdoutBytes: 1024 }, "stdout_limit"], [{ events: 8 }, "event_limit"]] as const) {
      const data = structuredClone(basic);
      data.limits = limits;
      data.mock.handlers[2].actions = [
        ...Array.from({ length: 20 }, () => data.mock.handlers[2].actions[0]),
        data.mock.handlers[2].actions[1],
      ];
      const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]?.code).toBe(code);
    }
  });

  it("surfaces RPC errors as protocol facts without retaining error prose", async () => {
    const data = structuredClone(basic);
    data.steps[5] = { type: "response", id: "turn", errorCode: -32000 };
    data.mock.handlers[2].actions = [{ type: "reply", errorCode: -32000 }];
    const result = await runScenario(loadScenario(JSON.stringify(data), { format: "json" }));
    expect(result.status).toBe("passed");
    expect(toJsonl(result)).toContain('"code":-32000');
    expect(toJsonl(result)).not.toContain("Synthetic provider error");
  });
});
