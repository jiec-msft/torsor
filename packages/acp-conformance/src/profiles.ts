import { z } from "zod";

import { ConfigurationError } from "./schema.js";
import type { Launch } from "./process.js";

export type Provider = Launch | {
  profile: "copilot-cli-v1";
  environment?: Readonly<Record<string, string>>;
};

const environment = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32768));
const providerSchema = z.union([
  z.strictObject({
    command: z.string().min(1).max(32768).refine((value) => !/[\0\r\n]/.test(value) && !/\.(cmd|bat)$/i.test(value)),
    args: z.array(z.string().max(32768).refine((value) => !value.includes("\0"))).max(128),
    environment: environment.optional(),
  }),
  z.strictObject({ profile: z.literal("copilot-cli-v1"), environment: environment.optional() }),
]);

export function validateProvider(provider: Provider): void {
  if (!providerSchema.safeParse(provider).success) throw new ConfigurationError(["$.provider"], "Invalid provider launch configuration.");
  const reserved = /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_STATE_HOME|COPILOT_HOME|COPILOT_ALLOW_ALL|COPILOT_ASSISTED_APPROVAL|NODE_OPTIONS)$/i;
  if (Object.keys(provider.environment ?? {}).some((key) => reserved.test(key))) {
    throw new ConfigurationError(["$.provider.environment"], "Environment override would bypass process isolation or approval policy.");
  }
}

export function resolveProvider(provider: Provider, workspace: string): Launch {
  if ("command" in provider) return provider;
  return {
    command: process.platform === "win32" ? "copilot.exe" : "copilot",
    args: [
      "--acp", "--no-auto-update", "--no-remote", "--no-remote-export",
      "--no-ask-user", "--no-custom-instructions", "--no-bash-env",
      "--disallow-temp-dir", "--disable-builtin-mcps",
      "--available-tools=acp-conformance-disabled",
      "--deny-tool=shell", "--deny-tool=write", "--deny-tool=url",
      "--log-dir", workspace, "--log-level", "error",
    ],
    environment: { ...provider.environment, COPILOT_HOME: workspace },
  };
}
