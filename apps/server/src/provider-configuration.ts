import type { ProviderPolicySelection } from "@torsor/agent-runtime";

export interface LocalProviderConfiguration {
  readonly policy: ProviderPolicySelection;
  readonly providerTimeoutMs: number;
  readonly command?: string;
  readonly cwd?: string;
  readonly worktree?: {
    readonly repositoryPath: string;
    readonly rootPath: string;
    readonly baseRevision: string;
  };
}

export function readProviderConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): LocalProviderConfiguration {
  const kind = environment.TORSOR_PROVIDER_POLICY ?? "restricted";
  const mode = environment.TORSOR_PROVIDER_PERMISSION_MODE;
  const timeout = environment.TORSOR_PROVIDER_TIMEOUT_MS;
  const providerTimeoutMs = timeout === undefined ? (kind === "trusted-local" ? 120_000 : 25_000) : Number(timeout);
  if (!Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs < 1_000 || providerTimeoutMs > 295_000) {
    throw invalidConfiguration();
  }
  const command = environment.TORSOR_COPILOT_COMMAND;
  const cwd = environment.TORSOR_PROVIDER_CWD;
  const common = { providerTimeoutMs, ...(command ? { command } : {}) };
  if (kind === "restricted") {
    if (mode !== undefined) throw invalidConfiguration();
    return { ...common, policy: { kind }, ...(cwd ? { cwd } : {}) };
  }
  if (kind !== "trusted-local" || (mode !== "provider-default" && mode !== "allow-all") || cwd !== undefined) {
    throw invalidConfiguration();
  }
  const repositoryPath = environment.TORSOR_REPOSITORY_PATH;
  const rootPath = environment.TORSOR_WORKTREE_ROOT;
  const baseRevision = environment.TORSOR_BASE_REVISION;
  if (!repositoryPath?.trim() || !rootPath?.trim() ||
      !baseRevision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseRevision)) {
    throw invalidConfiguration();
  }
  return {
    ...common, policy: { kind, permissionMode: mode },
    worktree: { repositoryPath, rootPath, baseRevision },
  };
}

function invalidConfiguration(): Error {
  return new Error("Invalid local provider configuration.");
}
