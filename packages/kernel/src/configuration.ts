import * as db from "./database.js";
import { KernelError } from "./errors.js";
import * as invariants from "./invariants.js";
import type {
  CommandResult,
  JsonValue,
  KernelCommand,
  PrincipalContext,
} from "./types.js";
import { integer, text, type Row } from "./values.js";

export function updateAgentConfig(
  kernel: db.KernelContext,
  command: Extract<KernelCommand, { type: "UpdateAgentConfig" }>,
  principal: Row,
  context: PrincipalContext,
  correlationId: string,
): CommandResult {
  invariants.requireKind(kernel, principal, "human");
  requirePositiveRevision(
    command.expectedAgentConfigRevision,
    "expected Agent config revision",
  );
  const agent = invariants.requireAgent(kernel, command.agentId);
  invariants.checkRevision(
    kernel,
    integer(agent.current_config_revision),
    command.expectedAgentConfigRevision,
    "Agent config",
  );
  const configJson = serializeJsonValue(command.config);
  const revision = integer(agent.current_config_revision) + 1;
  db.run(
    kernel,
    `INSERT INTO agent_config_revisions
      (agent_id, revision, config_json, created_at)
     VALUES (?, ?, ?, ?)`,
    command.agentId,
    revision,
    configJson,
    db.now(kernel),
  );
  db.run(
    kernel,
    "UPDATE agents SET current_config_revision = ? WHERE id = ?",
    revision,
    command.agentId,
  );
  invariants.emitEvent(kernel, {
    type: "AgentConfigUpdated",
    projectId: text(agent.project_id),
    channelId: null,
    threadRootId: null,
    threadCursor: null,
    entityType: "Agent",
    entityId: command.agentId,
    actorPrincipalId: text(principal.id),
    activationId: null,
    causationId: null,
    correlationId,
    payload: {
      previousRevision: command.expectedAgentConfigRevision,
      revision,
    },
  });
  return {
    commandType: command.type,
    entityId: command.agentId,
    revision,
    relatedIds: {
      previousAgentConfigRevision: String(
        command.expectedAgentConfigRevision,
      ),
    },
  };
}

export function adoptRunConfig(
  kernel: db.KernelContext,
  command: Extract<KernelCommand, { type: "AdoptRunConfig" }>,
  principal: Row,
  context: PrincipalContext,
  correlationId: string,
): CommandResult {
  invariants.requireKind(kernel, principal, "human");
  requirePositiveRevision(command.expectedRunRevision, "expected Run revision");
  requirePositiveRevision(
    command.expectedAgentConfigRevision,
    "expected Agent config revision",
  );
  requirePositiveRevision(
    command.targetAgentConfigRevision,
    "target Agent config revision",
  );
  const run = invariants.requireMutableRun(
    kernel,
    command.runId,
    command.expectedRunRevision,
  );
  const agent = invariants.requireAgent(kernel, text(run.owner_agent_id));
  invariants.checkRevision(
    kernel,
    integer(agent.current_config_revision),
    command.expectedAgentConfigRevision,
    "Agent config",
  );
  const previousConfigRevision = integer(run.agent_config_revision);
  if (
    command.targetAgentConfigRevision <= previousConfigRevision ||
    command.targetAgentConfigRevision >
      command.expectedAgentConfigRevision
  ) {
    throw new KernelError(
      "InvalidCommand",
      "The target Agent config revision must be newer than the Run revision and not exceed the expected current Agent revision.",
    );
  }
  const target = db.getRow(
    kernel,
    `SELECT revision
       FROM agent_config_revisions
      WHERE agent_id = ? AND revision = ?`,
    text(agent.id),
    command.targetAgentConfigRevision,
  );
  if (!target) {
    throw new KernelError(
      "InvalidCommand",
      "The target Agent config revision does not exist for the Run owner.",
    );
  }
  const revision = integer(run.revision) + 1;
  db.run(
    kernel,
    `UPDATE runs
        SET agent_config_revision = ?, revision = ?, updated_at = ?
      WHERE id = ?`,
    command.targetAgentConfigRevision,
    revision,
    db.now(kernel),
    command.runId,
  );
  invariants.emitEvent(kernel, {
    type: "RunConfigAdopted",
    projectId: text(run.project_id),
    channelId: text(run.home_channel_id),
    threadRootId: text(run.thread_root_id),
    threadCursor: null,
    entityType: "Run",
    entityId: command.runId,
    actorPrincipalId: text(principal.id),
    activationId: null,
    causationId: null,
    correlationId,
    payload: {
      agentId: text(agent.id),
      previousAgentConfigRevision: previousConfigRevision,
      agentConfigRevision: command.targetAgentConfigRevision,
      runRevision: revision,
    },
  });
  return {
    commandType: command.type,
    entityId: command.runId,
    revision,
    relatedIds: {
      agentId: text(agent.id),
      agentConfigRevision: String(command.targetAgentConfigRevision),
    },
  };
}

function requirePositiveRevision(revision: number, field: string): void {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new KernelError("InvalidCommand", `${field} is invalid.`);
  }
}

function serializeJsonValue(value: JsonValue): string {
  if (!isJsonValue(value, new Set<object>())) {
    throw new KernelError(
      "InvalidCommand",
      "Agent config must be a finite JSON value.",
    );
  }
  return JSON.stringify(value);
}

function isJsonValue(value: unknown, seen: Set<object>): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.entries(value).every(
        ([, item]) => isJsonValue(item, seen),
      );
  seen.delete(value);
  return valid;
}
