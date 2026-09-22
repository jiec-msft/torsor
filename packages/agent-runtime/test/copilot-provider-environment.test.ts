import { describe, expect, it } from "vitest";

import { buildCopilotProviderEnvironment } from "../src/copilot-provider-environment.js";
import { resolveProviderPolicy, serializeProviderPolicy } from "../src/provider-policy.js";

const restricted = resolveProviderPolicy();
const trusted = resolveProviderPolicy({ kind: "trusted-local", permissionMode: "provider-default" });
const allowAll = resolveProviderPolicy({ kind: "trusted-local", permissionMode: "allow-all" });

// Normative contract: docs/specs/trusted-local-provider-policy.md, sections 3 and 6.
describe("Copilot provider environment strategies", () => {
  it("retains precisely the existing restricted host allowlist without reading global environment", () => {
    const allowed = Object.fromEntries([
      "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
      "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TERM",
    ].map((name) => [name, `synthetic-${name}`]));
    expect(buildCopilotProviderEnvironment(restricted, {
      ...allowed,
      GH_TOKEN: "synthetic-credential",
      GITHUB_TOKEN: "synthetic-credential",
      COPILOT_GITHUB_TOKEN: "synthetic-credential",
      COPILOT_ALLOW_ALL: "true",
      COPILOT_ASSISTED_APPROVAL: "true",
      COPILOT_PROVIDER_SAMPLE: "synthetic-provider",
      COPILOT_HOME: "synthetic-home",
      TORSOR_AUTH_TOKEN: "synthetic-runtime-token",
      NODE_OPTIONS: "synthetic-node-option",
      BASH_ENV: "synthetic-shell-environment",
      CUSTOM_SETTING: "synthetic-setting",
    })).toEqual(allowed);
    expect(buildCopilotProviderEnvironment(restricted, {})).toEqual({});
  });

  it("accepts only existing explicit provider overrides in restricted mode", () => {
    const overrides = {
      COPILOT_PROVIDER_SAMPLE: "synthetic-provider",
      copilot_providers_config: "synthetic-config",
      COPILOT_HOME: "synthetic-home",
    };
    expect(buildCopilotProviderEnvironment(restricted, { PATH: "synthetic-path" }, overrides))
      .toEqual({ PATH: "synthetic-path", ...overrides });
  });

  it.each([
    "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "COPILOT_ALLOW_ALL",
    "copilot_assisted_approval", "TORSOR_AUTH_TOKEN", "PATH", "NODE_OPTIONS",
    "COPILOT_PROVIDER", "synthetic-private-name",
  ])("rejects restricted overrides outside the allowlist without echo (%#)", (name) => {
    expect(() => buildCopilotProviderEnvironment(restricted, {}, { [name]: "synthetic-credential" }))
      .toThrow(/^Invalid restricted Copilot environment override\.$/);
  });

  it.each([trusted, allowAll])("inherits normal user/provider environment only as transient data (%#)", (policy) => {
    const inherited = Object.freeze({
      PATH: "synthetic-path",
      GH_TOKEN: "synthetic-gh-credential",
      GITHUB_TOKEN: "synthetic-github-credential",
      COPILOT_GITHUB_TOKEN: "synthetic-copilot-credential",
      PROVIDER_API_KEY: "synthetic-provider-credential",
      COPILOT_PROVIDERS_CONFIG: "synthetic-provider-config",
      COPILOT_HOME: "synthetic-home",
      HTTPS_PROXY: "synthetic-proxy",
      NODE_OPTIONS: "synthetic-node-option",
      BASH_ENV: "synthetic-shell-environment",
      CUSTOM_SETTING: "synthetic-user-setting",
      UNSET_VALUE: undefined,
    });
    const overrides = Object.freeze({ CUSTOM_SETTING: "synthetic-override" });
    const environment = buildCopilotProviderEnvironment(policy, inherited, overrides);
    expect(environment).toEqual({
      ...inherited,
      CUSTOM_SETTING: "synthetic-override",
    });
    expect(Object.hasOwn(environment, "UNSET_VALUE")).toBe(false);
    expect(inherited.CUSTOM_SETTING).toBe("synthetic-user-setting");
    environment.GH_TOKEN = "synthetic-modification";
    expect(inherited.GH_TOKEN).toBe("synthetic-gh-credential");
    expect(serializeProviderPolicy(policy)).not.toContain("synthetic-");
    expect(Object.keys(policy)).not.toContain("environmentValues");
  });

  it.each([trusted, allowAll])("strips all internal controls and ambient approval overrides (%#)", (policy) => {
    const controls = Object.fromEntries([
      "TORSOR_DATABASE_PATH", "TORSOR_PRINCIPAL_ID", "TORSOR_ACTIVATION_ID",
      "TORSOR_AUTH_TOKEN", "TORSOR_RUNTIME_PRINCIPAL_ID", "TORSOR_PROVIDER_CWD",
      "TORSOR_COPILOT_COMMAND", "TORSOR_ARTIFACT_ROOT", "TORSOR_BOOTSTRAP_PATH",
      "TORSOR_PROJECT_IDS", "TORSOR_HOST", "TORSOR_PORT",
      "TORSOR_RUNTIME_POLL_INTERVAL_MS", "torsor_future_control", "ToRsOr_",
      "COPILOT_ALLOW_ALL", "copilot_allow_all", "Copilot_Assisted_Approval",
    ].map((name) => [name, "synthetic-control-value"]));
    expect(buildCopilotProviderEnvironment(policy, controls)).toEqual({});
    expect(buildCopilotProviderEnvironment(policy, {}, controls)).toEqual({});
    expect(buildCopilotProviderEnvironment(policy, { PATH: "synthetic-path" }, controls))
      .toEqual({ PATH: "synthetic-path" });
    expect(buildCopilotProviderEnvironment(policy, {})).toEqual({});
    expect(policy.permissionMode).not.toBe("deny");
  });

  it("filters names case-insensitively while retaining current key spelling", () => {
    expect(buildCopilotProviderEnvironment(restricted, {
      Path: "synthetic-path",
      home: "synthetic-home",
      tOrSoR_AUTH_TOKEN: "synthetic-control",
      gH_tOkEn: "synthetic-credential",
    })).toEqual({ Path: "synthetic-path", home: "synthetic-home" });
    expect(buildCopilotProviderEnvironment(trusted, {
      Path: "synthetic-path",
      gH_tOkEn: "synthetic-credential",
      tOrSoR_AUTH_TOKEN: "synthetic-control",
    }, { Path: "synthetic-override" }))
      .toEqual({ Path: "synthetic-override", gH_tOkEn: "synthetic-credential" });
  });

  it("revalidates policy before preparing environment instead of trusting structural types", () => {
    const contaminated = {
      ...restricted,
      extra: "synthetic-private-value",
    };
    expect(() => buildCopilotProviderEnvironment(contaminated, {})).toThrow("Invalid provider policy.");
  });
});
