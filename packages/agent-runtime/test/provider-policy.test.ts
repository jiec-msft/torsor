import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  parseProviderPolicy,
  resolveProviderPolicy,
  serializeProviderPolicy,
  type ProviderPolicy,
  type ProviderPolicySelection,
} from "../src/provider-policy.js";

const restricted = {
  kind: "restricted",
  tools: "runtime-actions-only",
  mcp: "disabled",
  customInstructions: "disabled",
  environment: "restricted-allowlist",
  permissionMode: "deny",
} as const;

const selections = [
  { kind: "restricted" },
  { kind: "trusted-local", permissionMode: "provider-default" },
  { kind: "trusted-local", permissionMode: "allow-all" },
] as const satisfies readonly ProviderPolicySelection[];

// Normative contract: docs/specs/trusted-local-provider-policy.md, sections 2 and 4.
describe("provider policy intent", () => {
  it("defaults only an omitted selection to the current restricted intent", () => {
    expect(resolveProviderPolicy()).toEqual(restricted);
    expect(resolveProviderPolicy(undefined)).toEqual(restricted);
    expect(resolveProviderPolicy({ kind: "restricted" })).toEqual(restricted);
  });

  it.each(["provider-default", "allow-all"] as const)(
    "requires explicit trusted-local intent with %s permissions",
    (permissionMode) => {
      expect(resolveProviderPolicy({ kind: "trusted-local", permissionMode })).toEqual({
        kind: "trusted-local",
        tools: "provider-native",
        mcp: "provider-configured",
        customInstructions: "provider-configured",
        environment: "inherit-user-provider",
        permissionMode,
      });
    },
  );

  it("keeps the type contract closed and correlated", () => {
    expectTypeOf<Extract<ProviderPolicy, { kind: "restricted" }>["permissionMode"]>()
      .toEqualTypeOf<"deny">();
    expectTypeOf<Extract<ProviderPolicySelection, { kind: "trusted-local" }>["permissionMode"]>()
      .toEqualTypeOf<"provider-default" | "allow-all">();
    if (false) {
      // @ts-expect-error Trusted-local requires an explicit permission selection.
      resolveProviderPolicy({ kind: "trusted-local" });
      // @ts-expect-error Restricted cannot request Allow All.
      resolveProviderPolicy({ kind: "restricted", permissionMode: "allow-all" });
    }
  });

  it.each([
    null, false, "", "trusted-local", [], {},
    { kind: "unknown" },
    { kind: "trusted-local" },
    { kind: "trusted-local", permissionMode: "deny" },
    { kind: "trusted-local", permissionMode: true },
    { kind: "restricted", permissionMode: "allow-all" },
    { kind: "restricted", permissionMode: "deny" },
    { kind: "restricted", allowAll: true },
    { kind: "trusted-local", permissionMode: "allow-all", extra: "synthetic-private-value" },
  ])("rejects invalid runtime selections without fallback or input echo (%#)", (selection) => {
    // @ts-expect-error Exercise the JavaScript boundary with invalid runtime input.
    expect(() => resolveProviderPolicy(selection)).toThrow("Invalid provider policy selection.");
  });

  it.each(selections)("round-trips fixed, frozen, bounded intent (%#)", (selection) => {
    const policy = resolveProviderPolicy(selection);
    const encoded = serializeProviderPolicy(policy);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.keys(policy)).toEqual(Object.keys(restricted));
    expect(Object.values(policy).every((value) => typeof value === "string")).toBe(true);
    expect(encoded).toMatch(/^[\x20-\x7e]+$/);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(256);
    expect(parseProviderPolicy(JSON.parse(encoded))).toEqual(policy);
    expect(serializeProviderPolicy(parseProviderPolicy(
      Object.fromEntries(Object.entries(policy).reverse()),
    ))).toBe(encoded);
    expect(encoded).toBe(JSON.stringify(policy));
    const differentMode = policy.permissionMode === "allow-all" ? "deny" : "allow-all";
    expect(() => Object.defineProperty(policy, "permissionMode", { value: differentMode })).toThrow();
    expect(resolveProviderPolicy(selection)).toEqual(policy);
  });

  it.each([
    undefined, null, [], {}, "restricted",
    { ...restricted, tools: "provider-native" },
    { ...restricted, mcp: "provider-configured" },
    { ...restricted, customInstructions: "provider-configured" },
    { ...restricted, environment: "inherit-user-provider" },
    { ...restricted, permissionMode: "allow-all" },
    { ...restricted, kind: "trusted-local" },
    { ...restricted, environment: undefined },
    { ...restricted, [Symbol("extra")]: "synthetic-private-value" },
  ])("rejects malformed or inconsistent full policies (%#)", (policy) => {
    expect(() => parseProviderPolicy(policy)).toThrow("Invalid provider policy.");
  });

  it.each(selections)("rejects missing or arbitrary-valued fields in every configuration (%#)", (selection) => {
    const policy = resolveProviderPolicy(selection);
    for (const key of Object.keys(policy)) {
      const missing = Object.fromEntries(Object.entries(policy).filter(([name]) => name !== key));
      expect(() => parseProviderPolicy(missing)).toThrow(/^Invalid provider policy\.$/);
      expect(() => parseProviderPolicy({ ...policy, [key]: "synthetic-private-value" }))
        .toThrow(/^Invalid provider policy\.$/);
    }
  });

  it.each(["environmentValues", "command", "cwd", "mcpServers", "instructions", "credentials"])(
    "rejects secret-bearing %s rather than serializing or dropping it",
    (field) => {
      const contaminated = { ...restricted, [field]: "synthetic-private-value" };
      expect(() => serializeProviderPolicy(contaminated)).toThrow(/^Invalid provider policy\.$/);
      expect(serializeProviderPolicy(resolveProviderPolicy())).not.toContain("synthetic-private-value");
    },
  );

  it("does not execute configuration accessors, serializers, or inherited configuration", () => {
    const accessor = vi.fn(() => "synthetic-private-value");
    const toJSON = vi.fn(() => "synthetic-private-value");
    const withAccessor = { ...restricted };
    Object.defineProperty(withAccessor, "tools", { get: accessor });
    expect(() => parseProviderPolicy(withAccessor)).toThrow("Invalid provider policy.");
    const withSerializer = { ...restricted, toJSON };
    expect(() => serializeProviderPolicy(withSerializer)).toThrow("Invalid provider policy.");
    expect(() => parseProviderPolicy(Object.create(restricted))).toThrow("Invalid provider policy.");
    const selection = { kind: "restricted" } as const;
    Object.defineProperty(selection, "kind", { get: accessor });
    expect(() => resolveProviderPolicy(selection)).toThrow("Invalid provider policy selection.");
    expect(accessor).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(parseProviderPolicy(Object.assign(Object.create(null), restricted))).toEqual(restricted);
  });
});
