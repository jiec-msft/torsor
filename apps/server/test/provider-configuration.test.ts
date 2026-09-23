import { describe, expect, it } from "vitest";
import { readProviderConfiguration } from "../src/provider-configuration.js";

const trusted = {
  TORSOR_PROVIDER_POLICY: "trusted-local",
  TORSOR_PROVIDER_PERMISSION_MODE: "allow-all",
  TORSOR_REPOSITORY_PATH: "synthetic-repository",
  TORSOR_WORKTREE_ROOT: "synthetic-managed-root",
  TORSOR_BASE_REVISION: "a".repeat(40),
};

describe("local Host provider configuration", () => {
  it("keeps restricted default and never selects ambient approval", () => {
    expect(readProviderConfiguration({ COPILOT_ALLOW_ALL: "true" })).toEqual({
      policy: { kind: "restricted" }, providerTimeoutMs: 25_000,
    });
  });

  it.each(["provider-default", "allow-all"])("requires explicit trusted-local %s configuration", (mode) => {
    expect(readProviderConfiguration({ ...trusted, TORSOR_PROVIDER_PERMISSION_MODE: mode })).toEqual({
      policy: { kind: "trusted-local", permissionMode: mode }, providerTimeoutMs: 120_000,
      worktree: { repositoryPath: "synthetic-repository", rootPath: "synthetic-managed-root", baseRevision: "a".repeat(40) },
    });
  });

  it.each([
    { TORSOR_PROVIDER_POLICY: "" },
    { TORSOR_PROVIDER_POLICY: "unknown" },
    { TORSOR_PROVIDER_PERMISSION_MODE: "allow-all" },
    { ...trusted, TORSOR_PROVIDER_PERMISSION_MODE: undefined },
    { ...trusted, TORSOR_PROVIDER_PERMISSION_MODE: "unknown" },
    { ...trusted, TORSOR_REPOSITORY_PATH: undefined },
    { ...trusted, TORSOR_WORKTREE_ROOT: "" },
    { ...trusted, TORSOR_BASE_REVISION: "main" },
    { ...trusted, TORSOR_PROVIDER_CWD: "synthetic-private-path" },
    { ...trusted, TORSOR_PROVIDER_TIMEOUT_MS: "0" },
    { ...trusted, TORSOR_PROVIDER_TIMEOUT_MS: "295001" },
    { ...trusted, TORSOR_PROVIDER_TIMEOUT_MS: "NaN" },
  ])("rejects invalid configuration without echo (%#)", (environment) => {
    expect(() => readProviderConfiguration(environment)).toThrow(/^Invalid local provider configuration\.$/);
  });

  it("returns only selected configuration, never credentials or arbitrary environment", () => {
    const result = readProviderConfiguration({
      ...trusted, GH_TOKEN: "synthetic-credential", TORSOR_AUTH_TOKEN: "synthetic-private-control",
      TORSOR_PROVIDER_TIMEOUT_MS: "295000",
    });
    expect(result.providerTimeoutMs).toBe(295_000);
    expect(JSON.stringify(result)).not.toContain("synthetic-credential");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-control");
  });
});
