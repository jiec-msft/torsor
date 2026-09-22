import { parseProviderPolicy, type ProviderPolicy } from "./provider-policy.js";

const restrictedHostNames = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "TERM",
]);

// Transient spawn input only; never attach the result to serializable policy intent.
export function buildCopilotProviderEnvironment(
  policy: ProviderPolicy,
  inherited: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const validated = parseProviderPolicy(policy);
  const inheritedEntries = Object.entries(inherited).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const overrideEntries = Object.entries(overrides);

  if (validated.environment === "restricted-allowlist") {
    for (const [name] of overrideEntries) {
      const upper = name.toUpperCase();
      if (!upper.startsWith("COPILOT_PROVIDER_") &&
        upper !== "COPILOT_PROVIDERS_CONFIG" &&
        upper !== "COPILOT_HOME") {
        throw new Error("Invalid restricted Copilot environment override.");
      }
    }
    return Object.fromEntries([
      ...inheritedEntries.filter(([name]) => restrictedHostNames.has(name.toUpperCase())),
      ...overrideEntries,
    ]);
  }

  return Object.fromEntries(
    [...inheritedEntries, ...overrideEntries].filter(([name]) => {
      const upper = name.toUpperCase();
      return !upper.startsWith("TORSOR_") &&
        upper !== "COPILOT_ALLOW_ALL" &&
        upper !== "COPILOT_ASSISTED_APPROVAL";
    }),
  );
}
