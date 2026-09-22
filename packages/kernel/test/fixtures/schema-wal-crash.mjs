import { DatabaseSync } from "node:sqlite";
import { schemaSql } from "../../dist/schema.js";

const [, , path, layout] = process.argv;
const database = new DatabaseSync(path);
database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
database.exec(layout === "partial"
  ? "CREATE TABLE causal_limits (singleton INTEGER PRIMARY KEY, max_depth INTEGER, max_non_terminal_runs_per_root INTEGER);"
  : schemaSql);
database.exec("INSERT INTO causal_limits VALUES (1, 4, 50); PRAGMA user_version = 15;");
if (layout === "missing-index") database.exec("DROP INDEX runs_causal_nonterminal_idx;");
if (layout === "future") database.exec("PRAGMA user_version = 99;");
process.exit(77);
