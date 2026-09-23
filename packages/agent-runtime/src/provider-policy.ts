export type ProviderPolicySelection =
  | { readonly kind: "restricted" }
  | {
      readonly kind: "trusted-local";
      readonly permissionMode: "provider-default" | "allow-all";
    };

const restrictedPolicy = Object.freeze({
  kind: "restricted",
  tools: "runtime-actions-only",
  mcp: "disabled",
  customInstructions: "disabled",
  environment: "restricted-allowlist",
  permissionMode: "deny",
} as const);

const trustedLocalPolicy = Object.freeze({
  kind: "trusted-local",
  tools: "provider-native",
  mcp: "provider-configured",
  customInstructions: "provider-configured",
  environment: "inherit-user-provider",
  permissionMode: "provider-default",
} as const);

const trustedLocalAllowAllPolicy = Object.freeze({
  ...trustedLocalPolicy,
  permissionMode: "allow-all",
} as const);

export type ProviderPolicy =
  | typeof restrictedPolicy
  | typeof trustedLocalPolicy
  | typeof trustedLocalAllowAllPolicy;

export type ProviderEnvironmentStrategy = ProviderPolicy["environment"];

// Intent only: these values grant neither launch permission nor Writer Authority.
export function resolveProviderPolicy(
  selection: ProviderPolicySelection = { kind: "restricted" },
): ProviderPolicy {
  if (matchesFields(selection, { kind: "restricted" })) {
    return restrictedPolicy;
  }
  if (matchesFields(selection, { kind: "trusted-local", permissionMode: "provider-default" })) {
    return trustedLocalPolicy;
  }
  if (matchesFields(selection, { kind: "trusted-local", permissionMode: "allow-all" })) {
    return trustedLocalAllowAllPolicy;
  }
  throw new Error("Invalid provider policy selection.");
}

export function parseProviderPolicy(input: unknown): ProviderPolicy {
  for (const policy of [restrictedPolicy, trustedLocalPolicy, trustedLocalAllowAllPolicy]) {
    if (matchesFields(input, policy)) {
      return policy;
    }
  }
  throw new Error("Invalid provider policy.");
}

export function serializeProviderPolicy(policy: ProviderPolicy): string {
  return JSON.stringify(parseProviderPolicy(policy));
}

function matchesFields(input: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  if (Reflect.ownKeys(input).length !== Object.keys(expected).length) {
    return false;
  }
  return Object.entries(expected).every(([key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor !== undefined &&
      descriptor.enumerable === true &&
      Object.hasOwn(descriptor, "value") &&
      descriptor.value === value;
  });
}
