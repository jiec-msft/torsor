export { KernelActivationCapabilityBridge } from "./capability-bridge.js";
export {
  LocalWorktreeExecutor,
  type LocalWorktreeExecutorOptions,
  type WorktreeExecutor,
  type WorktreeProbeInput,
  type WorktreeProviderInput,
} from "./worktree-executor.js";
export {
  resolveProviderPolicy, parseProviderPolicy, serializeProviderPolicy,
  type ProviderPolicy, type ProviderPolicySelection, type ProviderEnvironmentStrategy,
} from "./provider-policy.js";
export type { WorktreeRegistration } from "./worktree-paths.js";
export {
  CopilotAcpAdapter,
  type CopilotAcpAdapterOptions,
  type CopilotAcpLaunchConfiguration,
  type CopilotAcpLimits,
} from "./copilot-acp-adapter.js";
export {
  DeterministicFakeAdapter,
  type DeterministicFakeHandler,
} from "./fake-adapter.js";
export {
  AgentRuntime,
  type AgentRuntimeHooks,
  type AgentRuntimeOptions,
  type RuntimePassResult,
} from "./runtime.js";
export {
  ProviderExecutionError,
  ProviderProtocolError,
  type ActivationCapabilityBridge,
  type AttentionDecision,
  type CompleteRunInput,
  type ProviderAdapter,
  type ProviderCapabilityProfile,
  type ProviderCause,
  type ProviderDiagnosticCode,
  type ProviderExecutionContext,
  type ProviderExecutionResult,
} from "./types.js";
