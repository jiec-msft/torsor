import { describe, expect, it } from "vitest";

import { CopilotAcpAdapter } from "../src/copilot-acp-adapter.js";
import { resolveProviderPolicy } from "../src/provider-policy.js";

describe("Copilot explicit policy launch boundary", () => {
  it("defaults to restricted and retains all existing deny flags", () => {
    const adapter = new CopilotAcpAdapter({ userEnvironment: {} });
    expect(adapter.policy).toEqual(resolveProviderPolicy());
    expect(adapter.getLaunchConfiguration().args).toEqual(expect.arrayContaining([
      "--acp", "--stdio", "--no-custom-instructions", "--no-bash-env",
      "--disable-builtin-mcps", "--available-tools=torsor-runtime-action-channel",
      "--deny-tool=shell", "--deny-tool=write", "--deny-tool=url",
    ]));
    expect(adapter.getLaunchConfiguration().environment).toEqual({});
  });

  it.each(["provider-default", "allow-all"] as const)("requires Runtime launch authority for %s", (permissionMode) => {
    const adapter = new CopilotAcpAdapter({
      policy: { kind: "trusted-local", permissionMode }, userEnvironment: {},
    });
    expect(adapter.policy).toEqual(resolveProviderPolicy({ kind: "trusted-local", permissionMode }));
    expect(() => adapter.getLaunchConfiguration()).toThrow("Trusted-local launch requires Runtime Worktree authority.");
    expect(() => new CopilotAcpAdapter({
      policy: { kind: "trusted-local", permissionMode }, cwd: "synthetic-unassigned-path", userEnvironment: {},
    })).toThrow("Trusted-local cwd is derived by Runtime.");
  });

  it("does not interpret a partial or unknown profile as Allow All", () => {
    // @ts-expect-error Exercise invalid JavaScript configuration.
    expect(() => new CopilotAcpAdapter({ policy: { kind: "trusted-local" } })).toThrow();
    // @ts-expect-error Restricted profiles cannot request Allow All.
    expect(() => new CopilotAcpAdapter({ policy: { kind: "restricted", permissionMode: "allow-all" } })).toThrow();
  });
});
