import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { KernelError } from "./errors.js";
import { CURRENT_SCHEMA_VERSION, schemaSql } from "./schema.js";
import { text } from "./values.js";

let expectedFingerprint: string | undefined;

export function validateSchemaContract(database: DatabaseSync): void {
  if (expectedFingerprint === undefined) {
    const reference = new DatabaseSync(":memory:");
    try {
      reference.exec(schemaSql);
      expectedFingerprint = fingerprint(reference);
    } finally {
      reference.close();
    }
  }
  if (
    fingerprint(database) !== expectedFingerprint ||
    database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" ||
    database.prepare("PRAGMA foreign_key_check").get() !== undefined
  ) {
    throw new KernelError(
      "Conflict",
      `Incompatible development database schema ${CURRENT_SCHEMA_VERSION} contract. Stop old Torsor processes and recreate the disposable local database.`,
    );
  }
  if (!database.prepare("SELECT singleton FROM kernel_runtime_state WHERE singleton = 1").get()) {
    throw new KernelError("Conflict", "The database is missing its durable runtime configuration.");
  }
}

function fingerprint(database: DatabaseSync): string {
  const tables = database.prepare(`SELECT name, type, ncol, wr, strict
    FROM pragma_table_list WHERE schema = 'main'
      AND name NOT IN ('sqlite_stat1', 'sqlite_stat4') ORDER BY name`).all();
  const objects = database.prepare(`SELECT type, name, tbl_name, sql
    FROM main.sqlite_schema WHERE name NOT IN ('sqlite_stat1', 'sqlite_stat4')
    ORDER BY type, name`).all().map((object) => ({
    ...object,
    sql: object.sql === null ? null : sqlTokens(text(object.sql)),
    ...(object.type === "table" ? {
      columns: database.prepare("SELECT * FROM pragma_table_xinfo(?, 'main') ORDER BY cid").all(text(object.name)),
      foreignKeys: database.prepare("SELECT * FROM pragma_foreign_key_list(?, 'main') ORDER BY id, seq").all(text(object.name)),
      indexes: database.prepare(`SELECT name, "unique", origin, partial
        FROM pragma_index_list(?, 'main') ORDER BY name`).all(text(object.name)),
    } : {}),
    ...(object.type === "index" ? {
      columns: database.prepare("SELECT * FROM pragma_index_xinfo(?, 'main') ORDER BY seqno").all(text(object.name)),
    } : {}),
  }));
  return createHash("sha256").update(JSON.stringify({ tables, objects })).digest("hex");
}

function sqlTokens(sql: string): readonly string[] {
  // Token boundaries matter: stripping whitespace or folding literals can accept
  // different CHECK predicates or trigger bodies. Keep quoted tokens verbatim.
  const tokens = sql.match(
    /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9$]*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|->>|->|<>|!=|==|<=|>=|\|\||<<|>>|[^\s]/g,
  ) ?? [];
  return tokens
    .filter((token) => !/^\s|^--|^\/\*/.test(token))
    .map((token) => /^[a-zA-Z_][a-zA-Z_0-9$]*$/.test(token) ? token.toLowerCase() : token);
}
