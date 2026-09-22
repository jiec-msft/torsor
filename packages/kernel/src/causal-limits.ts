import * as db from "./database.js";
import { KernelError } from "./errors.js";
import { requireRun } from "./invariants.js";
import type { KernelCommand } from "./types.js";
import { integer, optionalText, text, type Row } from "./values.js";

const serverOwnedFields = [
  "causalRootId", "parentAttentionId", "parentRunId", "delegationDepth",
  "causalLimits", "maxDepth", "maxNonTerminalRunsPerRoot",
  "causal_root_id", "parent_attention_id", "parent_run_id", "delegation_depth",
  "causal_limits", "max_depth", "max_non_terminal_runs_per_root",
  "causedByRunId", "causedByAttentionId", "caused_by_run_id", "caused_by_attention_id",
] as const;

export function rejectCausalOverrides(command: KernelCommand): void {
  const inputs: object[] = [command];
  if (command.type === "CompleteRun" && command.finalReply) {
    inputs.push(command.finalReply);
  }
  for (const input of inputs) {
    for (const field of serverOwnedFields) {
      if (field in input) {
        throw new KernelError(
          "InvalidCommand",
          `Command field ${field} is server-controlled and must not be supplied.`,
        );
      }
    }
  }
}

export function causalCapacity(kernel: db.KernelContext, causalRootId: string) {
  const limits = db.getRow(kernel, "SELECT * FROM causal_limits WHERE singleton = 1");
  if (!limits) {
    throw new KernelError("Conflict", "The database is missing its durable causal limits.");
  }
  const count = db.getRow(kernel, `SELECT COUNT(*) AS count FROM runs
    WHERE causal_root_id = ? AND state NOT IN ('Completed', 'Failed', 'Cancelled')`,
  causalRootId)!;
  return {
    causalRootId,
    maxDepth: integer(limits.max_depth),
    maxNonTerminalRunsPerRoot: integer(limits.max_non_terminal_runs_per_root),
    nonTerminalRunCount: integer(count.count),
  };
}

// Called only inside the command write transaction, before any creation effects.
export function admitRunFromAttention(kernel: db.KernelContext, attention: Row) {
  const source = db.getRow(kernel, `SELECT message.*, principal.kind AS author_kind
    FROM message_revisions AS revision
    JOIN messages AS message ON message.id = revision.message_id
    JOIN principals AS principal ON principal.id = message.author_principal_id
    WHERE revision.id = ?`, text(attention.message_revision_id));
  if (!source) {
    throw new KernelError("Conflict", "Run creation requires a durable source Message.");
  }
  const parentRunId = optionalText(source.caused_by_run_id);
  let causalRootId: string;
  let delegationDepth: number;
  if (text(source.author_kind) === "human" && parentRunId === null) {
    causalRootId = text(source.id);
    delegationDepth = 0;
  } else if (text(source.author_kind) === "agent" && parentRunId !== null) {
    const parent = requireRun(kernel, parentRunId);
    if (
      text(parent.project_id) !== text(attention.project_id) ||
      text(parent.home_channel_id) !== text(attention.channel_id) ||
      text(parent.thread_root_id) !== text(attention.thread_root_id) ||
      text(parent.owner_agent_id) !== optionalText(source.author_agent_id)
    ) {
      throw new KernelError("Conflict", "The source Message does not match its parent Run.");
    }
    causalRootId = text(parent.causal_root_id);
    delegationDepth = integer(parent.delegation_depth) + 1;
  } else {
    throw new KernelError("Conflict", "Run creation requires trustworthy Human or Run provenance.");
  }
  const capacity = causalCapacity(kernel, causalRootId);
  const provenance = {
    causalRootId,
    parentAttentionId: text(attention.id),
    parentRunId,
    delegationDepth,
  };
  const dimension = delegationDepth > capacity.maxDepth
    ? "depth"
    : capacity.nonTerminalRunCount >= capacity.maxNonTerminalRunsPerRoot
      ? "nonTerminalRuns"
      : null;
  if (dimension !== null) {
    throw new KernelError(
      "CausalLimitExceeded",
      `Run creation exceeds the causal ${dimension} limit.`,
      { ...capacity, delegationDepth, dimension },
    );
  }
  return {
    ...capacity,
    ...provenance,
    nonTerminalRunCount: capacity.nonTerminalRunCount + 1,
  };
}
