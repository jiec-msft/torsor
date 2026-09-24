import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonValue } from "@torsor/kernel";
import {
  resolveProviderPolicy, serializeProviderPolicy,
  type ProviderPolicy, type ProviderPolicySelection,
} from "./provider-policy.js";
import { buildCopilotProviderEnvironment, isRestrictedCopilotEnvironmentOverride } from "./copilot-provider-environment.js";
import { OwnedProviderProcess } from "./provider-process.js";
import { CopilotToolActivity } from "./copilot-tool-activity.js";
import { isNativeRunCancellationInterruption } from "./native-run-cancellation.js";
import type { ControlledWorktreeProcess } from "./worktree-executor.js";

import {
  normalizeProviderExecutionError,
  ProviderExecutionError,
  ProviderProtocolError,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderExecutionResult,
} from "./types.js";

export interface CopilotAcpLimits {
  readonly maxFrameBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxStreamBytes: number;
  readonly maxStderrBytes: number;
  readonly maxActivityBytes: number;
  readonly maxPendingPersistenceOperations: number;
  readonly maxJsonDepth: number;
  readonly maxActionCount: number;
  readonly maxTargetCount: number;
  readonly maxFieldLength: number;
}

export interface CopilotAcpLaunchConfiguration {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CopilotAcpAdapterOptions {
  readonly policy?: ProviderPolicySelection;
  readonly userEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly unsafeAllowCustomCommandArgs?: boolean;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly shutdownGraceMs?: number;
  readonly limits?: Partial<CopilotAcpLimits>;
}

type RpcId = string | number;

class ActionEnvelopeFormatError extends ProviderProtocolError {}

interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: RpcId;
  readonly method: string;
  readonly params?: unknown;
}

type CopilotAction =
  | { readonly type: "publish_report"; readonly idempotencyKey: string; readonly text: string }
  | { readonly type: "create_run" }
  | { readonly type: "continue_run"; readonly runId: string }
  | { readonly type: "ignore_attention"; readonly reason: string }
  | {
      readonly type: "append_activity";
      readonly kind: string;
      readonly payload: JsonValue;
      readonly retentionClass?: "durable" | "transient";
    }
  | {
      readonly type: "publish_reply";
      readonly body: string;
      readonly targetAgentIds?: readonly string[];
      readonly expectedThreadCursor?: number;
    }
  | {
      readonly type: "report_status";
      readonly status: string;
      readonly detail?: string;
    }
  | {
      readonly type: "complete";
      readonly incorporatedThroughInputSequence?: number;
      readonly finalReply?: {
        readonly body: string;
        readonly targetAgentIds?: readonly string[];
        readonly expectedThreadCursor?: number;
      };
    }
  | { readonly type: "fail"; readonly reason: string }
  | { readonly type: "wait"; readonly reason: string };

const defaultLimits: CopilotAcpLimits = {
  maxFrameBytes: 256 * 1024,
  maxStdoutBytes: 1024 * 1024,
  maxStreamBytes: 512 * 1024,
  maxStderrBytes: 16 * 1024,
  maxActivityBytes: 256 * 1024,
  maxPendingPersistenceOperations: 16,
  maxJsonDepth: 16,
  maxActionCount: 32,
  maxTargetCount: 16,
  maxFieldLength: 16 * 1024,
};

const secureCopilotArgs = [
  "--acp",
  "--stdio",
  "--no-auto-update",
  "--no-remote",
  "--no-remote-export",
  "--no-ask-user",
  "--no-custom-instructions",
  "--no-bash-env",
  "--disallow-temp-dir",
  "--disable-builtin-mcps",
  "--available-tools=torsor-runtime-action-channel",
  "--deny-tool=shell",
  "--deny-tool=write",
  "--deny-tool=url",
] as const;

const trustedCopilotArgs = [
  "--acp", "--stdio", "--no-auto-update", "--no-remote", "--no-remote-export", "--no-ask-user",
] as const;

export class CopilotAcpAdapter implements ProviderAdapter {
  readonly name = "github-copilot-cli-acp";
  readonly version = "5";
  readonly policy: ProviderPolicy;
  readonly capabilities = {
    acceptsInputWhileRunning: false,
    supportsCancel: true,
    supportsResume: false,
    supportsSessionContinuation: true,
    supportsGracefulPause: false,
    supportsIdempotentRequests: false,
  } as const;

  readonly #launch: CopilotAcpLaunchConfiguration;
  readonly #attentionLaunch: CopilotAcpLaunchConfiguration;
  readonly #shutdownGraceMs: number;
  readonly #limits: CopilotAcpLimits;

  constructor(options: CopilotAcpAdapterOptions = {}) {
    this.policy = resolveProviderPolicy(options.policy);
    if (this.policy.kind === "trusted-local" && options.cwd !== undefined) {
      throw new Error("Trusted-local cwd is derived by Runtime.");
    }
    if (options.commandArgs && !options.unsafeAllowCustomCommandArgs) {
      throw new Error(
        "Custom ACP command arguments require unsafeAllowCustomCommandArgs=true.",
      );
    }
    this.#launch = {
      command: options.command ?? "copilot",
      args: options.commandArgs
        ? [...options.commandArgs]
        : [...(this.policy.kind === "restricted" ? secureCopilotArgs : trustedCopilotArgs),
          ...(this.policy.permissionMode === "allow-all" ? ["--allow-all"] : [])],
      cwd: options.cwd ?? process.cwd(),
      environment: buildCopilotProviderEnvironment(
        this.policy, options.userEnvironment ?? process.env, options.environment,
      ),
    };
    this.#attentionLaunch = this.policy.kind === "restricted" ? this.#launch : {
      ...this.#launch,
      args: options.commandArgs ? [...options.commandArgs] : [...secureCopilotArgs],
      environment: buildCopilotProviderEnvironment(
        resolveProviderPolicy(), options.userEnvironment ?? process.env,
        Object.fromEntries(Object.entries(options.environment ?? {}).filter(
          ([name]) => isRestrictedCopilotEnvironmentOverride(name),
        )),
      ),
    };
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    this.#limits = validateLimits({
      ...defaultLimits,
      ...options.limits,
    });
  }

  getLaunchConfiguration(): CopilotAcpLaunchConfiguration {
    if (this.policy.kind === "trusted-local") {
      throw new Error("Trusted-local launch requires Runtime Worktree authority.");
    }
    return {
      command: this.#launch.command,
      args: [...this.#launch.args],
      cwd: this.#launch.cwd,
      environment: { ...this.#launch.environment },
    };
  }

  async execute(
    context: ProviderExecutionContext,
  ): Promise<ProviderExecutionResult> {
    context.signal.throwIfAborted();
    const policy = context.cause.type === "attention" ? resolveProviderPolicy() : this.policy;
    let launch = context.cause.type === "attention" ? this.#attentionLaunch : this.#launch;
    let owned: OwnedProviderProcess | undefined;
    let worktree: ControlledWorktreeProcess | undefined;
    let processHandle: ChildProcessWithoutNullStreams;
    if (policy.kind === "trusted-local") {
      if (!context.nativeExecution ||
          serializeProviderPolicy(context.nativeExecution.policy) !== serializeProviderPolicy(policy)) {
        throw new ProviderExecutionError("provider_worktree_authority_lost", "Unknown");
      }
      worktree = await context.nativeExecution.start((cwd) => {
        launch = { ...launch, cwd };
        owned = new OwnedProviderProcess(launch);
        return owned;
      });
      if (!owned) throw new ProviderExecutionError("provider_process_start_failed", "Failed");
      processHandle = owned.processHandle;
    } else {
      processHandle = spawn(launch.command, [...launch.args], {
        cwd: launch.cwd, env: { ...launch.environment },
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
    }
    const connection = new NdjsonRpcConnection(
      processHandle,
      this.#limits.maxFrameBytes,
      this.#limits.maxStdoutBytes,
    );
    let sessionId: string | null = null;
    let acceptUpdates = true;
    let restrictedPermissionRequested = false;
    let streamBytes = 0;
    let activityBytes = 0;
    let primaryError: unknown;
    let executionResult: ProviderExecutionResult | undefined;
    const tools = new CopilotToolActivity();
    const stopOwned = () => {
      if (worktree) void worktree.stop("Provider stop requested.").catch(() => undefined);
      else processHandle.kill();
    };
    const outputChunks: string[] = [];
    let stderrBytes = 0;
    const persistence = new PersistenceQueue(
      this.#limits.maxPendingPersistenceOperations,
      (error) => {
        acceptUpdates = false;
        connection.fail(error);
        stopOwned();
      },
    );

    processHandle.stderr.setEncoding("utf8");
    processHandle.stderr.on("data", (chunk: string) => {
      const bytes = Buffer.byteLength(chunk);
      if (bytes > this.#limits.maxStderrBytes - stderrBytes) {
        stderrBytes = this.#limits.maxStderrBytes;
        connection.fail(
          new ProviderExecutionError("provider_stderr_limit", "Failed"),
        );
        stopOwned();
        return;
      }
      stderrBytes += bytes;
    });

    connection.onRequest = async (request) => {
      if (request.method === "session/request_permission") {
        if (policy.kind === "restricted") restrictedPermissionRequested = true;
        if (policy.kind === "trusted-local" && policy.permissionMode === "allow-all" &&
            !context.signal.aborted && acceptUpdates) {
          const params = getRecord(request.params, "permission params");
          if (!sessionId || params.sessionId !== sessionId || !Array.isArray(params.options) ||
              params.options.length > 32) throw new ProviderProtocolError();
          worktree!.assertPublication();
          const options = params.options.map((option) => getRecord(option, "permission option"));
          const selected = options.find((option) => option.kind === "allow_always")
            ?? options.find((option) => option.kind === "allow_once");
          if (selected) return { outcome: {
            outcome: "selected",
            optionId: requireBoundedString(selected.optionId, "permission option", 256),
          } };
        }
        return { outcome: { outcome: "cancelled" } };
      }
      throw new ProviderProtocolError(
        `Copilot requested unsupported ACP client method ${request.method}.`,
      );
    };
    connection.onNotification = (notification) => {
      if (!acceptUpdates || notification.method !== "session/update") {
        return;
      }
      const params = getRecord(notification.params, "session/update params");
      const update = getRecord(params.update, "session/update update");
      assertJsonDepth(update, this.#limits.maxJsonDepth, "session update");
      const updateType = getOptionalString(update.sessionUpdate);
      if (
        updateType === "tool_call" ||
        updateType === "tool_call_update"
      ) {
        if (policy.kind === "restricted") {
          throw new ProviderProtocolError(
            "Copilot emitted tool activity despite the deny-by-default tool policy.",
            "provider_policy_violation",
          );
        }
        if (!sessionId || params.sessionId !== sessionId) {
          throw new ProviderProtocolError("Tool update belongs to another ACP session.");
        }
        if (updateType === "tool_call") outputChunks.length = 0;
        for (const activity of tools.accept(update)) {
          activityBytes = addWithinLimit(
            activityBytes, Buffer.byteLength(JSON.stringify(activity.payload)),
            this.#limits.maxActivityBytes, "persisted ACP activity",
          );
          persistence.enqueue(() => context.capabilities.appendActivity(activity.kind, activity.payload));
        }
        return;
      }
      if (updateType !== "agent_message_chunk") {
        return;
      }
      if (policy.kind === "trusted-local" && (!sessionId || params.sessionId !== sessionId)) {
        throw new ProviderProtocolError("Message update belongs to another ACP session.");
      }
      const content = getRecord(update.content, "agent message content");
      if (content.type !== "text" || typeof content.text !== "string") {
        return;
      }
      const chunkBytes = Buffer.byteLength(content.text);
      streamBytes = addWithinLimit(
        streamBytes,
        chunkBytes,
        this.#limits.maxStreamBytes,
        "ACP output stream",
      );
      outputChunks.push(content.text);
      if (policy.kind === "trusted-local") return;
      if (context.cause.type !== "run") {
        return;
      }
      const payload = {
        text: content.text,
        ...(typeof update.messageId === "string"
          ? {
              messageId: requireBoundedString(
                update.messageId,
                "messageId",
                this.#limits.maxFieldLength,
              ),
            }
          : {}),
      };
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
      activityBytes = addWithinLimit(
        activityBytes,
        payloadBytes,
        this.#limits.maxActivityBytes,
        "persisted ACP activity",
      );
      persistence.enqueue(
        () => context.capabilities.appendActivity(
          "agent_message_chunk",
          payload,
          "transient",
        ),
      );
    };

    const abort = () => {
      acceptUpdates = false;
      const reason = abortReason(context.signal);
      if (sessionId) {
        try {
          connection.notify("session/cancel", { sessionId });
        } catch {
          // The abort reason remains authoritative if the notification cannot be sent.
        }
      }
      connection.fail(reason);
      stopOwned();
    };
    context.signal.addEventListener("abort", abort, { once: true });

    try {
      if (owned) {
        await owned.started;
        void owned.providerExit.then(
          () => connection.processExited(worktree?.providerExitInterruption()),
          () => connection.fail(new ProviderExecutionError("provider_io_error", "Unknown")),
        );
      }
      context.signal.throwIfAborted();
      const initialize = getRecord(
        await connection.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: "torsor-agent-runtime",
            title: "Torsor Agent Runtime",
            version: "0.1.0",
          },
        }),
        "initialize result",
      );
      if (initialize.protocolVersion !== 1) {
        throw new ProviderProtocolError(
          `Copilot ACP selected unsupported protocol version ${String(initialize.protocolVersion)}.`,
        );
      }
      const session = getRecord(
        await connection.request("session/new", {
          cwd: launch.cwd,
          mcpServers: [],
        }),
        "session/new result",
      );
      sessionId = requireBoundedString(
        session.sessionId,
        "sessionId",
        this.#limits.maxFieldLength,
      );
      if (policy.kind === "trusted-local") {
        const selection = selectCodingMode(session);
        if (selection) await connection.request(selection.method, { sessionId, ...selection.params });
      }
      let promptResult = getRecord(
        await connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: buildPrompt(context) }],
        }),
        "session/prompt result",
      );
      if (policy.kind === "restricted") {
        assertPromptEnded(promptResult);
        try {
          parseActions(outputChunks.join(""), this.#limits);
        } catch (error) {
          if (!(error instanceof ActionEnvelopeFormatError) || restrictedPermissionRequested) {
            throw error;
          }
          outputChunks.length = 0;
          promptResult = getRecord(
            await connection.request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: buildCorrectionPrompt(context.cause.type) }],
            }),
            "session/prompt correction result",
          );
          assertPromptEnded(promptResult);
        }
      }
      connection.allowProcessExit();
      if (worktree) await worktree.finish();
      else await stopProcess(processHandle, this.#shutdownGraceMs, () => connection.endInput());
      acceptUpdates = false;
      await persistence.drain();
      connection.seal();
      if (policy.kind === "trusted-local") tools.assertComplete();
      assertPromptEnded(promptResult);
      const actions = parseActions(outputChunks.join(""), this.#limits);
      validateActionPlan(actions, context.cause.type);
      if (actions.some((action) => action.type === "publish_report") && !context.capabilities.reportArtifactsEnabled) {
        throw new ProviderProtocolError("Report Artifact storage is not configured.");
      }
      await applyActions(actions, context);
      executionResult = {};
    } catch (error) {
      primaryError = error;
    } finally {
      acceptUpdates = false;
      const stopping = worktree && primaryError !== undefined
        ? worktree.stop("Provider execution failed.") : undefined;
      try {
        await persistence.drain();
      } catch (error) {
        primaryError ??= error;
      }
      context.signal.removeEventListener("abort", abort);
      try {
        if (worktree) await stopping;
        else await stopProcess(processHandle, this.#shutdownGraceMs, () => connection.endInput());
      } catch (error) {
        primaryError ??= error;
      }
      connection.close();
    }

    if (primaryError !== undefined) {
      throw normalizeExecutionError(
        primaryError,
        context.signal,
      );
    }
    if (!executionResult) {
      throw new ProviderExecutionError(
        "provider_execution_failed",
        "Unknown",
      );
    }
    return executionResult;
  }
}

function selectCodingMode(session: Record<string, unknown>): {
  method: string; params: Record<string, string>;
} | undefined {
  // ACP config options supersede legacy modes. Only select an advertised coding
  // mode, never infer approval from labels or turn Autopilot on for Allow All.
  if (session.configOptions !== undefined) {
    if (!Array.isArray(session.configOptions) || session.configOptions.length > 64) throw new ProviderProtocolError();
    for (const value of session.configOptions) {
      const config = getRecord(value, "session config");
      if (config.id !== "mode" || config.type !== "select") continue;
      if (!Array.isArray(config.options) || config.options.length > 64) throw new ProviderProtocolError();
      const options = config.options.flatMap((option) => {
        const record = getRecord(option, "config option");
        if (record.options === undefined) return [record];
        if (!Array.isArray(record.options) || record.options.length > 64) throw new ProviderProtocolError();
        return record.options.map((item) => getRecord(item, "config value"));
      });
      const coding = options.find((option) => option.value === "agent")
        ?? options.find((option) => option.value === "interactive");
      if (coding && coding.value !== config.currentValue) return {
        method: "session/set_config_option", params: { configId: "mode", value: String(coding.value) },
      };
    }
    return undefined;
  }
  if (session.modes === undefined) return undefined;
  const modes = getRecord(session.modes, "session modes");
  if (!Array.isArray(modes.availableModes) || modes.availableModes.length > 64) throw new ProviderProtocolError();
  const available = modes.availableModes.map((mode) => getRecord(mode, "session mode"));
  const coding = available.find((mode) => mode.id === "agent") ?? available.find((mode) => mode.id === "interactive");
  return coding && coding.id !== modes.currentModeId
    ? { method: "session/set_mode", params: { modeId: String(coding.id) } } : undefined;
}

class PersistenceQueue {
  readonly #pending = new Set<Promise<void>>();
  #firstError: Error | null = null;

  constructor(
    private readonly limit: number,
    private readonly onFirstError: (error: Error) => void,
  ) {}

  enqueue(operation: () => Promise<unknown>): void {
    if (this.#firstError) {
      throw this.#firstError;
    }
    if (this.#pending.size >= this.limit) {
      throw new ProviderProtocolError(
        `ACP persistence exceeded ${this.limit} pending operations.`,
      );
    }
    let started: Promise<unknown>;
    try {
      started = operation();
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.#firstError = normalized;
      this.onFirstError(normalized);
      throw normalized;
    }
    const tracked = started.then(
      () => {},
      (error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        if (!this.#firstError) {
          this.#firstError = normalized;
          this.onFirstError(normalized);
        }
      },
    );
    this.#pending.add(tracked);
    void tracked.then(() => {
      this.#pending.delete(tracked);
    });
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
    if (this.#firstError) {
      throw this.#firstError;
    }
  }
}

class NdjsonRpcConnection {
  onNotification: (notification: RpcRequest) => void = () => {};
  onRequest: (request: RpcRequest) => Promise<unknown> = async (request) => {
    throw new ProviderProtocolError(
      `Unsupported ACP client method ${request.method}.`,
    );
  };

  #nextId = 0;
  #allowProcessExit = false;
  #shuttingDown = false;
  #closed = false;
  #sealed = false;
  #failed: Error | null = null;
  #inputEnd: Promise<void> | null = null;
  #buffer = Buffer.alloc(0);
  #stdoutBytes = 0;
  readonly #incoming = new Set<RpcId>();
  readonly #pending = new Map<
    RpcId,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly processHandle: ChildProcessWithoutNullStreams,
    private readonly maxFrameBytes: number,
    private readonly maxStdoutBytes: number,
  ) {
    processHandle.stdout.on("data", (chunk: Buffer) => {
      try {
        this.#receiveChunk(chunk);
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new ProviderProtocolError(String(error)),
        );
      }
    });
    processHandle.once("error", () => {
      this.fail(
        new ProviderExecutionError("provider_process_start_failed", "Failed"),
      );
    });
    processHandle.stdin.on("error", (error) => {
      this.fail(stdinFailure(error));
    });
    processHandle.once("exit", () => {
      if (
        !this.#allowProcessExit &&
        !this.#closed &&
        !this.#sealed &&
        !this.#failed
      ) {
        this.fail(
          new ProviderExecutionError("provider_process_exited", "Unknown"),
        );
      }
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#failed) {
      return Promise.reject(this.#failed);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#closed && !this.#failed) {
      this.#send({ jsonrpc: "2.0", method, params });
    }
  }

  fail(error: Error): void {
    if (this.#failed) {
      return;
    }
    this.#failed = error;
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  close(): void {
    this.#closed = true;
    this.processHandle.stdout.removeAllListeners("data");
    if (this.#pending.size > 0) {
      this.fail(new Error("ACP connection closed."));
    }
  }

  allowProcessExit(): void {
    this.#allowProcessExit = true;
    this.#shuttingDown = true;
  }

  processExited(error?: Error): void {
    if (!this.#allowProcessExit && !this.#closed && !this.#sealed && !this.#failed) {
      this.fail(error ?? new ProviderExecutionError("provider_process_exited", "Unknown"));
    }
  }

  endInput(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#inputEnd) {
      return this.#inputEnd;
    }
    if (
      this.processHandle.stdin.destroyed ||
      this.processHandle.stdin.writableEnded
    ) {
      this.#inputEnd = Promise.resolve();
      return this.#inputEnd;
    }
    this.#inputEnd = new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.processHandle.stdin.removeListener("finish", settle);
        this.processHandle.stdin.removeListener("close", settle);
        this.processHandle.stdin.removeListener("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        this.fail(stdinFailure(error));
        settle();
      };
      this.processHandle.stdin.once("finish", settle);
      this.processHandle.stdin.once("close", settle);
      this.processHandle.stdin.once("error", onError);
      try {
        this.processHandle.stdin.end(settle);
      } catch (error) {
        this.fail(
          stdinFailure(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
        settle();
      }
    });
    return this.#inputEnd;
  }

  seal(): void {
    if (this.#failed) {
      throw this.#failed;
    }
    if (this.#buffer.length > 0) {
      const error = new ProviderProtocolError(
        "ACP process ended with an incomplete NDJSON frame.",
      );
      this.fail(error);
      throw error;
    }
    this.#sealed = true;
    this.processHandle.stdout.removeAllListeners("data");
  }

  #receiveChunk(chunk: Buffer): void {
    if (this.#closed || this.#failed) {
      return;
    }
    this.#stdoutBytes = addWithinLimit(
      this.#stdoutBytes,
      chunk.length,
      this.maxStdoutBytes,
      "ACP stdout",
    );
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.length > this.maxFrameBytes) {
          throw new ProviderProtocolError(
            `ACP frame exceeded ${this.maxFrameBytes} bytes.`,
            "provider_output_limit",
          );
        }
        return;
      }
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.length === 0) {
        continue;
      }
      if (frame.length > this.maxFrameBytes) {
        throw new ProviderProtocolError(
          `ACP frame exceeded ${this.maxFrameBytes} bytes.`,
          "provider_output_limit",
        );
      }
      this.#receiveFrame(frame.toString("utf8"));
    }
  }

  #receiveFrame(frame: string): void {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      throw new ProviderProtocolError("ACP process emitted invalid NDJSON.");
    }
    const record = getRecord(message, "ACP message");
    if (record.jsonrpc !== "2.0") throw new ProviderProtocolError("Invalid ACP JSON-RPC version.");
    const id = Object.hasOwn(record, "id") ? requireRpcId(record.id) : undefined;
    const hasResult = Object.hasOwn(record, "result");
    const hasError = Object.hasOwn(record, "error");
    if (!Object.hasOwn(record, "method")) {
      if (id === undefined || hasResult === hasError) {
        throw new ProviderProtocolError("ACP response must have an ID and exactly one result or error.");
      }
      const pending = this.#pending.get(id);
      if (!pending) {
        throw new ProviderProtocolError("ACP response ID is unknown or already completed.");
      }
      if (hasError) {
        const error = getRecord(record.error, "ACP error");
        if (!Number.isSafeInteger(error.code) || typeof error.message !== "string") {
          throw new ProviderProtocolError("Invalid ACP error response.");
        }
      }
      this.#pending.delete(id);
      if (hasError) {
        pending.reject(
          new ProviderProtocolError("ACP request returned an error."),
        );
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (typeof record.method !== "string" || hasResult || hasError) {
      throw new ProviderProtocolError("Invalid ACP request or notification envelope.");
    }
    const request: RpcRequest = {
      jsonrpc: "2.0", method: record.method,
      ...(id !== undefined ? { id } : {}),
      ...(Object.hasOwn(record, "params") ? { params: record.params } : {}),
    };
    if (request.method === "session/request_permission" && id === undefined ||
        request.method === "session/update" && id !== undefined) {
      throw new ProviderProtocolError("ACP session message has the wrong request/notification kind.");
    }
    if (id === undefined) {
      this.onNotification(request);
      return;
    }
    if (this.#incoming.has(id)) throw new ProviderProtocolError("ACP request ID is already active.");
    this.#incoming.add(id);
    void this.onRequest(request)
      .then(
        (result) => {
          if (this.#canRespond()) {
            this.#send({ jsonrpc: "2.0", id, result });
          }
        },
        (error: unknown) => {
          if (this.#canRespond()) {
            this.#send({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: errorMessage(error) },
            });
          }
        },
      )
      .finally(() => this.#incoming.delete(id))
      .catch((error: unknown) => {
        if (!this.#shuttingDown && !this.#closed && !this.#failed) {
          this.fail(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
  }

  #canRespond(): boolean {
    return (
      !this.#shuttingDown &&
      !this.#closed &&
      !this.#failed &&
      this.processHandle.stdin.writable
    );
  }

  #send(message: unknown): void {
    if (
      this.#closed ||
      this.#failed ||
      !this.processHandle.stdin.writable
    ) {
      throw this.#failed ?? new Error("ACP connection is not writable.");
    }
    try {
      this.processHandle.stdin.write(
        `${JSON.stringify(message)}\n`,
        (error?: Error | null) => {
          if (error) {
            this.fail(stdinFailure(error));
          }
        },
      );
    } catch (error) {
      const failure = stdinFailure(
        error instanceof Error ? error : new Error(String(error)),
      );
      this.fail(failure);
      throw failure;
    }
  }
}

function requireRpcId(value: unknown): RpcId {
  if (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new ProviderProtocolError("ACP request ID must be a string or safe integer.");
}

function assertPromptEnded(result: Record<string, unknown>): void {
  const stopReason = requireBoundedString(result.stopReason, "stopReason", 64);
  if (stopReason !== "end_turn") {
    throw new ProviderExecutionError(
      stopReason === "cancelled" ? "provider_cancelled" : "provider_execution_failed",
      stopReason === "cancelled" ? "Unknown" : "Failed",
    );
  }
}

function buildCorrectionPrompt(cause: "attention" | "run"): string {
  const types = cause === "attention"
    ? "create_run, continue_run (requires runId), ignore_attention (requires reason)"
    : "append_activity, publish_reply, report_status, complete, fail, wait";
  return [
    "Your previous response was not a valid JSON action envelope. No action was applied.",
    "Use the authoritative state from the preceding prompt to decide again.",
    'Return only one JSON object with an "actions" array and no other text or Markdown.',
    'Every action must have a "type" string field.',
    `Allowed type values: ${types}. Include all required fields for your chosen action.`,
    "Do not use tools, repeat earlier output, or provide a progress message.",
  ].join("\n");
}

function buildPrompt(context: ProviderExecutionContext): string {
  const state =
    context.cause.type === "attention"
      ? {
          cause: "attention",
          attention: context.cause.attention,
          triggeringMessage: context.cause.triggeringMessage,
          triggeringRevision: context.cause.triggeringRevision,
          thread: {
            projectId: context.cause.thread.projectId,
            channelId: context.cause.thread.channelId,
            threadRootId: context.cause.thread.threadRootId,
            cursor: context.cause.thread.cursor,
            messages: context.cause.thread.messages,
          },
          eligibleRuns: context.cause.eligibleRuns,
          agent: context.agent,
        }
      : {
          cause: "run",
          run: context.cause.run,
          thread: context.cause.thread,
          agent: context.agent,
        };
  const required =
    context.cause.type === "attention"
      ? "Return exactly one of: ignore_attention(reason), continue_run(runId from eligibleRuns), or create_run. Do not infer a Run match outside eligibleRuns."
      : "End with exactly one complete, fail, or wait action.";
  const allowed =
    context.cause.type === "attention"
      ? "Allowed actions: ignore_attention, continue_run, create_run."
      : `Allowed actions: append_activity, publish_reply, report_status, complete, fail, wait.${context.capabilities.reportArtifactsEnabled
        ? " publish_report(idempotencyKey, text) may finalize a plain-text report; reuse the stable key on retries."
        : " Report Artifact storage is not configured."} Arbitrary publish_artifact descriptors are forbidden.`;
  return [
    "You are executing one bounded Torsor Activation.",
    "The JSON below is rebuilt from durable Kernel state and is authoritative.",
    "Provider sessions and model memory are never authoritative recovery state.",
    ...(context.nativeExecution ? [
      "Use your native tools to perform the requested work in the assigned working directory before returning final actions.",
      "Do not copy private tool output, credentials, environment, command paths, or session IDs into public actions.",
      "After the tools finish, return only one JSON object with an actions array and no Markdown or progress commentary.",
    ] : ["Return only one JSON object with an actions array and no Markdown."]),
    required,
    allowed,
    "Provenance, Agent identity, Run identity, revisions, Activation identity, and ProviderAttempt identity are server-bound.",
    JSON.stringify(state),
  ].join("\n");
}

function parseActions(
  output: string,
  limits: CopilotAcpLimits,
): readonly CopilotAction[] {
  const trimmed = output.trim();
  const normalized = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new ActionEnvelopeFormatError(
      "Copilot ACP did not return a valid JSON action envelope.",
    );
  }
  assertJsonDepth(parsed, limits.maxJsonDepth, "action envelope");
  let record: Record<string, unknown>;
  try {
    record = getRecord(parsed, "action envelope");
  } catch (error) {
    if (error instanceof ProviderProtocolError) throw new ActionEnvelopeFormatError();
    throw error;
  }
  if (!Array.isArray(record.actions) || record.actions.length === 0) {
    throw new ActionEnvelopeFormatError(
      "Copilot ACP action envelope must contain at least one action.",
    );
  }
  if (record.actions.length > limits.maxActionCount) {
    throw new ProviderProtocolError(
      `Copilot ACP action envelope exceeded ${limits.maxActionCount} actions.`,
    );
  }
  return record.actions.map((action) => parseAction(action, limits));
}

function parseAction(
  value: unknown,
  limits: CopilotAcpLimits,
): CopilotAction {
  let action: Record<string, unknown>;
  try {
    action = getRecord(value, "action");
  } catch (error) {
    if (error instanceof ProviderProtocolError) throw new ActionEnvelopeFormatError();
    throw error;
  }
  if (typeof action.type !== "string" || action.type.length === 0) {
    throw new ActionEnvelopeFormatError();
  }
  const type = requireBoundedString(
    action.type,
    "action.type",
    64,
  );
  switch (type) {
    case "publish_report":
      if (Object.keys(action).some((key) => !["type", "idempotencyKey", "text"].includes(key))) {
        throw new ProviderProtocolError("publish_report accepts only type, idempotencyKey and text.");
      }
      return {
        type,
        idempotencyKey: requireBoundedString(action.idempotencyKey, "action.idempotencyKey", 256),
        text: requireBoundedString(action.text, "action.text", limits.maxFieldLength),
      };
    case "create_run":
      return { type };
    case "continue_run":
      return {
        type,
        runId: requireBoundedString(
          action.runId,
          "action.runId",
          limits.maxFieldLength,
        ),
      };
    case "ignore_attention":
      return {
        type,
        reason: requireBoundedString(
          action.reason,
          "action.reason",
          limits.maxFieldLength,
        ),
      };
    case "append_activity":
      return {
        type,
        kind: requireBoundedString(
          action.kind,
          "action.kind",
          Math.min(256, limits.maxFieldLength),
        ),
        payload: toJsonValue(
          action.payload,
          limits.maxJsonDepth,
        ),
        ...(action.retentionClass === undefined
          ? {}
          : {
              retentionClass: requireEnum(
                action.retentionClass,
                ["durable", "transient"] as const,
                "action.retentionClass",
              ),
            }),
      };
    case "publish_reply":
      return {
        type,
        body: requireBoundedString(
          action.body,
          "action.body",
          limits.maxFieldLength,
        ),
        ...optionalStringArray(
          action.targetAgentIds,
          "action.targetAgentIds",
          limits,
        ),
        ...optionalNumber(action.expectedThreadCursor, "expectedThreadCursor"),
      };
    case "report_status":
      return {
        type,
        status: requireBoundedString(
          action.status,
          "action.status",
          Math.min(256, limits.maxFieldLength),
        ),
        ...(action.detail === undefined
          ? {}
          : {
              detail: requireBoundedString(
                action.detail,
                "action.detail",
                limits.maxFieldLength,
              ),
            }),
      };
    case "complete":
      return {
        type,
        ...optionalNumber(
          action.incorporatedThroughInputSequence,
          "incorporatedThroughInputSequence",
        ),
        ...(action.finalReply === undefined
          ? {}
          : { finalReply: parseReply(action.finalReply, limits) }),
      };
    case "fail":
      return {
        type,
        reason: requireBoundedString(
          action.reason,
          "action.reason",
          limits.maxFieldLength,
        ),
      };
    case "wait":
      return {
        type,
        reason: requireBoundedString(
          action.reason,
          "action.reason",
          limits.maxFieldLength,
        ),
      };
    default:
      throw new ProviderProtocolError(`Unsupported action type ${type}.`);
  }
}

async function applyActions(
  actions: readonly CopilotAction[],
  context: ProviderExecutionContext,
): Promise<void> {
  for (const action of actions) {
    if (context.signal.aborted) {
      throw abortReason(context.signal);
    }
    switch (action.type) {
      case "create_run":
        await context.capabilities.createRunFromAttention();
        break;
      case "continue_run":
        await context.capabilities.continueAttentionWithRun(action.runId);
        break;
      case "ignore_attention":
        await context.capabilities.ignoreAttention(action.reason);
        break;
      case "append_activity":
        await context.capabilities.appendActivity(
          action.kind,
          action.payload,
          action.retentionClass,
        );
        break;
      case "publish_reply":
        await context.capabilities.publishReply(action);
        break;
      case "publish_report":
        await context.capabilities.publishReport({ idempotencyKey: action.idempotencyKey, text: action.text });
        break;
      case "report_status":
        await context.capabilities.reportStatus(action.status, action.detail);
        break;
      case "complete":
        await context.capabilities.complete(action);
        break;
      case "fail":
        await context.capabilities.fail(action.reason);
        break;
      case "wait":
        await context.capabilities.wait(action.reason);
        break;
    }
  }
}

function validateActionPlan(
  actions: readonly CopilotAction[],
  causeType: ProviderExecutionContext["cause"]["type"],
): void {
  if (causeType === "attention") {
    if (
      actions.length !== 1 ||
      !["create_run", "continue_run", "ignore_attention"].includes(
        actions[0]!.type,
      )
    ) {
      throw new ProviderProtocolError(
        "An Attention Activation must return exactly one ignore_attention, continue_run, or create_run action.",
      );
    }
    return;
  }
  if (
    actions.some((action) =>
      action.type === "create_run" ||
      action.type === "continue_run" ||
      action.type === "ignore_attention"
    )
  ) {
    throw new ProviderProtocolError(
      "A Run Activation cannot contain Attention decision actions.",
    );
  }
  const terminalIndexes = actions.flatMap((action, index) =>
    action.type === "complete" ||
    action.type === "fail" ||
    action.type === "wait"
      ? [index]
      : [],
  );
  if (
    terminalIndexes.length !== 1 ||
    terminalIndexes[0] !== actions.length - 1
  ) {
    throw new ProviderProtocolError(
      "A Run Activation must contain exactly one final complete, fail, or wait action.",
    );
  }
}

function parseReply(
  value: unknown,
  limits: CopilotAcpLimits,
): {
  readonly body: string;
  readonly targetAgentIds?: readonly string[];
  readonly expectedThreadCursor?: number;
} {
  const reply = getRecord(value, "finalReply");
  return {
    body: requireBoundedString(
      reply.body,
      "finalReply.body",
      limits.maxFieldLength,
    ),
    ...optionalStringArray(
      reply.targetAgentIds,
      "finalReply.targetAgentIds",
      limits,
    ),
    ...optionalNumber(reply.expectedThreadCursor, "expectedThreadCursor"),
  };
}

function optionalStringArray(
  value: unknown,
  name: string,
  limits: CopilotAcpLimits,
): { readonly targetAgentIds?: readonly string[] } {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ProviderProtocolError(`${name} must be an array of strings.`);
  }
  if (value.length > limits.maxTargetCount) {
    throw new ProviderProtocolError(
      `${name} exceeded ${limits.maxTargetCount} entries.`,
    );
  }
  return {
    targetAgentIds: value.map((item, index) =>
      requireBoundedString(
        item,
        `${name}[${index}]`,
        limits.maxFieldLength,
      ),
    ),
  };
}

function optionalNumber<K extends string>(
  value: unknown,
  name: K,
): { readonly [P in K]?: number } {
  if (value === undefined) {
    return {};
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ProviderProtocolError(`${name} must be a non-negative integer.`);
  }
  return { [name]: value } as { readonly [P in K]?: number };
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new ProviderProtocolError(
      `${name} must be one of ${values.join(", ")}.`,
    );
  }
  return value;
}

function getRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderProtocolError(`${name} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new ProviderProtocolError(
      `${name} exceeded ${maxLength} characters.`,
    );
  }
  return value;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toJsonValue(value: unknown, maxDepth: number): JsonValue {
  assertJsonDepth(value, maxDepth, "JSON value");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, maxDepth - 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        toJsonValue(item, maxDepth - 1),
      ]),
    );
  }
  throw new ProviderProtocolError("Value is not JSON serializable.");
}

function assertJsonDepth(
  value: unknown,
  maxDepth: number,
  name: string,
  depth = 0,
): void {
  if (depth > maxDepth) {
    throw new ProviderProtocolError(
      `${name} exceeded JSON depth ${maxDepth}.`,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonDepth(item, maxDepth, name, depth + 1);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertJsonDepth(item, maxDepth, name, depth + 1);
    }
  }
}

function addWithinLimit(
  current: number,
  addition: number,
  limit: number,
  name: string,
): number {
  if (addition > limit - current) {
    throw new ProviderProtocolError(
      `${name} exceeded ${limit} bytes.`,
      "provider_output_limit",
    );
  }
  return current + addition;
}

function validateLimits(limits: CopilotAcpLimits): CopilotAcpLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Copilot ACP limit ${name} must be a positive integer.`);
    }
  }
  return limits;
}

function normalizeExecutionError(
  error: unknown,
  signal: AbortSignal,
): Error {
  if (isNativeRunCancellationInterruption(error)) {
    return error;
  }
  if (
    isNativeRunCancellationInterruption(signal.reason)
  ) {
    return normalizeProviderExecutionError(error, "Unknown");
  }
  if (signal.aborted) {
    return abortReason(signal);
  }
  return normalizeProviderExecutionError(error, "Unknown");
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason === undefined) {
    return new ProviderExecutionError("provider_cancelled", "Unknown");
  }
  if (isNativeRunCancellationInterruption(signal.reason)) {
    return signal.reason;
  }
  return normalizeProviderExecutionError(signal.reason, "Unknown");
}

async function stopProcess(
  processHandle: ChildProcessWithoutNullStreams,
  graceMs: number,
  endInput: () => Promise<void>,
): Promise<void> {
  if (isProcessClosed(processHandle)) {
    return;
  }
  const gracefulClose = waitForClose(processHandle, graceMs);
  await endInput();
  if (await gracefulClose) {
    return;
  }

  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    const terminatedClose = waitForClose(processHandle, graceMs);
    processHandle.kill();
    if (await terminatedClose) {
      return;
    }
  }
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    const forcedClose = waitForClose(processHandle, graceMs);
    processHandle.kill("SIGKILL");
    if (await forcedClose) {
      return;
    }
  }
  if (!isProcessClosed(processHandle)) {
    throw new ProviderExecutionError(
      "provider_cleanup_failed",
      "Unknown",
    );
  }
}

function stdinFailure(error: Error): ProviderExecutionError {
  void error;
  return new ProviderExecutionError(
    "provider_io_error",
    "Unknown",
  );
}

function waitForClose(
  processHandle: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (isProcessClosed(processHandle)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      processHandle.removeListener("close", onClose);
      resolve(false);
    }, timeoutMs);
    processHandle.once("close", onClose);
  });
}

function isProcessClosed(
  processHandle: ChildProcessWithoutNullStreams,
): boolean {
  return (
    (processHandle.exitCode !== null || processHandle.signalCode !== null) &&
    processHandle.stdout.destroyed &&
    processHandle.stderr.destroyed
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
