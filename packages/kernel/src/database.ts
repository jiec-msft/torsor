import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { KernelError } from "./errors.js";
import { CURRENT_SCHEMA_VERSION, schemaSql } from "./schema.js";
import type { CausalLimits, KernelBootstrap, KernelOpenOptions } from "./types.js";
import { boundedDuration, integer, type Row } from "./values.js";

export type KernelContext = Readonly<{
  database: DatabaseSync;
  clock: () => Date;
  idFactory: (prefix: string) => string;
  activationDurationMs: number;
}>;

const schemaInitializationHookSymbol = Symbol.for(
  "torsor.kernel.schema-initialization-operation",
);
const sqliteBusyTimeoutOverrideSymbol = Symbol.for(
  "torsor.kernel.test-sqlite-busy-timeout-ms",
);

export function openKernelContext(options: KernelOpenOptions): KernelContext {
  const context: KernelContext = {
    clock: options.clock ?? (() => new Date()),
    idFactory:
      options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`),
    activationDurationMs: boundedDuration(
      options.activationDurationMs ?? 300_000,
      "activationDurationMs",
    ),
    database: new DatabaseSync(options.databasePath),
  };
  try {
    context.database.exec(
      `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${sqliteBusyTimeoutMs()};`,
    );
    initializeSchema(context, options.causalLimits);
    context.database.exec(
      `CREATE TEMP TABLE IF NOT EXISTS projection_activation_changes (
         activation_id TEXT PRIMARY KEY
       ) STRICT;`,
    );
    if (options.databasePath !== ":memory:") {
      context.database.exec("PRAGMA journal_mode = WAL;");
    }
    applyBootstrap(context, options.bootstrap);
    return context;
  } catch (error) {
    context.database.close();
    throw error;
  }
}

export function getRow(
  context: KernelContext,
  sql: string,
  ...parameters: SQLInputValue[]
): Row | undefined {
  return context.database.prepare(sql).get(...parameters) as Row | undefined;
}

export function allRows(
  context: KernelContext,
  sql: string,
  ...parameters: SQLInputValue[]
): Row[] {
  return context.database.prepare(sql).all(...parameters) as Row[];
}

export function run(
  context: KernelContext,
  sql: string,
  ...parameters: SQLInputValue[]
): number {
  return Number(context.database.prepare(sql).run(...parameters).changes);
}

export function now(context: KernelContext): string {
  return context.clock().toISOString();
}

export function translateError(error: unknown): Error {
  if (error instanceof KernelError) {
    return error;
  }
  if (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("FOREIGN KEY constraint failed"))
  ) {
    return new KernelError("Conflict", "The command conflicts with durable state.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function initializeSchema(context: KernelContext, causalLimits?: CausalLimits): void {
  initializeSchemaExec(context, "BEGIN IMMEDIATE");
  try {
    const versionRow = initializeSchemaGet(context, "PRAGMA user_version");
    const version = versionRow ? integer(versionRow.user_version) : 0;
    if (version === CURRENT_SCHEMA_VERSION) {
      context.database.exec(schemaSql);
      initializeCausalLimits(context, causalLimits, false);
      context.database.exec("COMMIT");
      return;
    }
    if (version !== 0) {
      throw new KernelError(
        "Conflict",
        `Incompatible development database schema version ${version}; expected ${CURRENT_SCHEMA_VERSION}. Stop old Torsor processes and recreate the disposable local database.`,
      );
    }
    const existing = initializeSchemaGet(
      context,
      `SELECT name
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        LIMIT 1`,
    );
    if (existing) {
      throw new KernelError(
        "Conflict",
        "The database uses an incompatible unversioned development schema. Stop old Torsor processes and recreate the disposable local database.",
      );
    }
    context.database.exec(schemaSql);
    initializeCausalLimits(context, causalLimits, true);
    context.database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    context.database.exec("COMMIT");
  } catch (error) {
    context.database.exec("ROLLBACK");
    throw translateError(error);
  }
}

function initializeCausalLimits(
  context: KernelContext,
  requested: CausalLimits | undefined,
  newDatabase: boolean,
): void {
  const defaults: CausalLimits = { maxDepth: 4, maxNonTerminalRunsPerRoot: 50 };
  const configured = requested ?? defaults;
  if (
    !Number.isSafeInteger(configured.maxDepth) || configured.maxDepth < 0 ||
    !Number.isSafeInteger(configured.maxNonTerminalRunsPerRoot) ||
    configured.maxNonTerminalRunsPerRoot < 1
  ) {
    throw new KernelError(
      "InvalidCommand",
      "Causal limits require a nonnegative safe integer maxDepth and a positive safe integer maxNonTerminalRunsPerRoot.",
    );
  }
  if (newDatabase) {
    run(context, `INSERT INTO causal_limits
      (singleton, max_depth, max_non_terminal_runs_per_root) VALUES (1, ?, ?)`,
    configured.maxDepth, configured.maxNonTerminalRunsPerRoot);
    return;
  }
  const stored = getRow(context, "SELECT * FROM causal_limits WHERE singleton = 1");
  if (!stored) {
    throw new KernelError("Conflict", "The database is missing its durable causal limits.");
  }
  if (requested && (
    integer(stored.max_depth) !== requested.maxDepth ||
    integer(stored.max_non_terminal_runs_per_root) !== requested.maxNonTerminalRunsPerRoot
  )) {
    throw new KernelError(
      "Conflict",
      "Configured causal limits differ from the durable database configuration. Reopen with matching limits or omit the override.",
    );
  }
}

function initializeSchemaExec(context: KernelContext, sql: string): void {
  recordSchemaInitializationOperation({ kind: "exec", sql });
  context.database.exec(sql);
}

function initializeSchemaGet(
  context: KernelContext,
  sql: string,
): Row | undefined {
  recordSchemaInitializationOperation({ kind: "read", sql });
  return context.database.prepare(sql).get() as Row | undefined;
}

function applyBootstrap(
  context: KernelContext,
  bootstrap?: KernelBootstrap,
): void {
  if (!bootstrap) {
    return;
  }
  context.database.exec("BEGIN IMMEDIATE");
  try {
    for (const principal of bootstrap.principals ?? []) {
      run(
        context,
        "INSERT OR IGNORE INTO principals (id, kind, display_name) VALUES (?, ?, ?)",
        principal.id,
        principal.kind,
        principal.displayName,
      );
    }
    for (const project of bootstrap.projects ?? []) {
      run(
        context,
        "INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)",
        project.id,
        project.name,
      );
    }
    for (const channel of bootstrap.channels ?? []) {
      run(
        context,
        "INSERT OR IGNORE INTO channels (id, project_id, name) VALUES (?, ?, ?)",
        channel.id,
        channel.projectId,
        channel.name,
      );
    }
    for (const agent of bootstrap.agents ?? []) {
      run(
        context,
        `INSERT OR IGNORE INTO agents
          (id, principal_id, project_id, name, current_config_revision)
         VALUES (?, ?, ?, ?, ?)`,
        agent.id,
        agent.principalId,
        agent.projectId,
        agent.name,
        agent.configRevision,
      );
      run(
        context,
        `INSERT OR IGNORE INTO agent_config_revisions
          (agent_id, revision, config_json, created_at)
         VALUES (?, ?, ?, ?)`,
        agent.id,
        agent.configRevision,
        JSON.stringify(agent.config),
        now(context),
      );
    }
    context.database.exec("COMMIT");
  } catch (error) {
    context.database.exec("ROLLBACK");
    throw translateError(error);
  }
}

function recordSchemaInitializationOperation(
  operation: Readonly<{ kind: "exec" | "read"; sql: string; }>,
): void {
  const hook = Reflect.get(globalThis, schemaInitializationHookSymbol);
  if (typeof hook === "function") {
    hook(operation);
  }
}

function sqliteBusyTimeoutMs(): number {
  if (process.env.NODE_ENV !== "test") {
    return 5_000;
  }
  const override = Reflect.get(globalThis, sqliteBusyTimeoutOverrideSymbol);
  return typeof override === "number" &&
    Number.isInteger(override) &&
    override >= 0
    ? override
    : 5_000;
}
