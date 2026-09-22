import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TorsorKernel } from "../src/index.js";
import { schemaSql } from "../src/schema.js";
import { bootstrap } from "./helpers.js";

describe("integrated schema contract (MVP 21.5, 22, 23.1, 25.1-25.2)", () => {
  const predecessorSchema = schemaSql.replace(
    /CREATE TABLE IF NOT EXISTS physical_worktrees[\s\S]*?(?=CREATE TABLE IF NOT EXISTS public_events)/,
    "",
  );
  const incompatibleLayouts = [
    { name: "complete schema 15 claiming version 16", sql: predecessorSchema },
    { name: "partial v16 containing only causal_limits", sql: "CREATE TABLE causal_limits (singleton INTEGER PRIMARY KEY, max_depth INTEGER, max_non_terminal_runs_per_root INTEGER);" },
    { name: "missing Worktree acquisition index", after: "DROP INDEX worktree_unsettled_execution_idx;" },
    { name: "missing Writer publication index", after: "DROP INDEX worktree_execution_activation_idx;" },
    { name: "missing Writer revocation trigger", after: "DROP TRIGGER worktree_publication_revocation_immutable;" },
    { name: "missing Worktree storage identity", after: "DELETE FROM worktree_storage_identity;" },
    { name: "invalid Worktree storage identity", after: "UPDATE worktree_storage_identity SET identity = 'invalid';" },
    { name: "altered Worktree uniqueness", replace: ["directory_identity TEXT NOT NULL UNIQUE", "directory_identity TEXT NOT NULL"] },
    { name: "altered Worktree execution fencing", replace: ["fencing_token INTEGER NOT NULL CHECK (fencing_token > 0)", "fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0)"] },
    { name: "missing index", after: "DROP INDEX runs_causal_nonterminal_idx;" },
    { name: "missing trigger", after: "DROP TRIGGER runs_causal_provenance_immutable;" },
    { name: "missing column", after: "ALTER TABLE artifacts DROP COLUMN metadata_json;" },
    { name: "missing table", after: "DROP TABLE worktree_writer_lease_events;" },
    { name: "extra table", after: "CREATE TABLE unrecognized_layout (id INTEGER PRIMARY KEY);" },
    { name: "extra trigger", after: "CREATE TRIGGER unexpected_write AFTER INSERT ON projects BEGIN DELETE FROM principals; END;" },
    { name: "extra view", after: "CREATE VIEW unrecognized_view AS SELECT * FROM artifacts;" },
    { name: "changed type", replace: ["byte_length INTEGER", "byte_length REAL"] },
    { name: "changed nullability", replace: ["media_type TEXT NOT NULL", "media_type TEXT"] },
    { name: "changed default", replace: ["next_activity_sequence INTEGER NOT NULL DEFAULT 1", "next_activity_sequence INTEGER NOT NULL DEFAULT 2"] },
    { name: "changed primary key", replace: ["PRIMARY KEY (agent_id, revision)", "UNIQUE (agent_id, revision)"] },
    { name: "changed foreign key action", replace: ["producer_run_id TEXT NOT NULL REFERENCES runs(id)", "producer_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE"] },
    { name: "changed check constraint", replace: ["byte_length <= 1048576", "byte_length <= 2097152"] },
    { name: "changed partial predicate", replace: ["WHERE state NOT IN ('Completed', 'Failed', 'Cancelled')", "WHERE state = 'Active'"] },
    { name: "changed index uniqueness", replace: ["CREATE INDEX IF NOT EXISTS runs_causal_nonterminal_idx", "CREATE UNIQUE INDEX IF NOT EXISTS runs_causal_nonterminal_idx"] },
    { name: "changed index collation and order", replace: ["ON runs(thread_root_id, created_at)", "ON runs(thread_root_id COLLATE NOCASE, created_at DESC)"] },
    { name: "changed string literal case", replace: ["'human', 'agent', 'runtime'", "'Human', 'agent', 'runtime'"] },
    { name: "changed trigger literal whitespace", replace: ["Run causal provenance is immutable", "Run causal  provenance is immutable"] },
    { name: "non-STRICT table", replace: [") STRICT;", ");"] },
    { name: "predecessor-shaped Artifact table claiming v16", after: "ALTER TABLE artifacts DROP COLUMN producer_thread_root_id; ALTER TABLE artifacts DROP COLUMN byte_length; ALTER TABLE artifacts ADD COLUMN storage_location TEXT;" },
    { name: "missing durable causal configuration", after: "DELETE FROM causal_limits;" },
    { name: "missing durable runtime configuration", after: "DELETE FROM kernel_runtime_state;" },
    { name: "future version", after: "PRAGMA user_version = 99;" },
  ];

  it.each([14, 15])("refuses predecessor version %i without modifying its bytes or logical state", async (version) => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-physical-predecessor-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const database = new DatabaseSync(databasePath);
      database.exec(version === 15 ? predecessorSchema : `
        CREATE TABLE physical_worktrees (worktree_id TEXT PRIMARY KEY, directory_path TEXT NOT NULL);
        INSERT INTO physical_worktrees VALUES ('synthetic-tree', 'synthetic-private-directory');
      `);
      if (version === 15) database.exec("INSERT INTO causal_limits VALUES (1, 4, 50);");
      database.exec(`PRAGMA user_version = ${version};`);
      database.close();
      const before = await readFile(databasePath);
      const logical = logicalSnapshot(databasePath);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => TorsorKernel.open({ databasePath, bootstrap }))
          .toThrow(`Incompatible development database schema version ${version}; expected 16.`);
        expect((await readFile(databasePath)).equals(before)).toBe(true);
        expect(logicalSnapshot(databasePath)).toEqual(logical);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(incompatibleLayouts)("refuses $name unchanged on every attempt before bootstrap/config writes", async (layout) => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-fingerprint-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const database = new DatabaseSync(databasePath);
      let ddl = layout.sql ?? schemaSql;
      if (layout.replace) {
        const [from, to] = layout.replace;
        expect(ddl).toContain(from!);
        ddl = ddl.replace(from!, to!);
      }
      database.exec(ddl);
      database.exec("INSERT INTO causal_limits VALUES (1, 4, 50); PRAGMA user_version = 16;");
      if (layout.after) database.exec(layout.after);
      database.close();
      const before = await readFile(databasePath);
      const logical = logicalSnapshot(databasePath);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => TorsorKernel.open({
          databasePath, bootstrap, causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 50 },
        }).close()).toThrow(expect.objectContaining({ code: "Conflict" }));
        expect((await readFile(databasePath)).equals(before)).toBe(true);
        expect(logicalSnapshot(databasePath)).toEqual(logical);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts harmless SQL formatting, validates SQLite metadata and never reapplies bootstrap on reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-format-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const database = new DatabaseSync(databasePath);
      database.exec(schemaSql.replaceAll("CREATE TABLE", "create /* layout */ table")
        .replaceAll("CREATE INDEX", "create\nindex").replaceAll(" NOT NULL", " not null"));
      database.exec("INSERT INTO causal_limits VALUES (1, 4, 50); PRAGMA user_version = 16; PRAGMA journal_mode = WAL;");
      database.close();
      const before = await readFile(databasePath);
      const logical = logicalSnapshot(databasePath);
      TorsorKernel.open({ databasePath, bootstrap }).close();
      TorsorKernel.open({ databasePath, bootstrap }).close();
      expect(logicalSnapshot(databasePath)).toEqual(logical);
      expect((await readFile(databasePath)).equals(before)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates schema/config/bootstrap atomically only for an empty version-0 database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-bootstrap-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const empty = new DatabaseSync(databasePath);
      empty.exec("PRAGMA user_version = 0");
      empty.close();
      const before = await readFile(databasePath);
      expect(() => TorsorKernel.open({
        databasePath, bootstrap: { channels: [{ id: "channel-invalid", projectId: "missing", name: "invalid" }] },
      })).toThrow();
      expect((await readFile(databasePath)).equals(before)).toBe(true);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
      expect(database.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
      database.close();
      TorsorKernel.open({ databasePath, bootstrap }).close();
      const initialized = logicalSnapshot(databasePath);
      TorsorKernel.open({
        databasePath,
        bootstrap: { principals: [{ id: "principal-must-not-be-inserted", kind: "human", displayName: "Synthetic" }] },
      }).close();
      expect(logicalSnapshot(databasePath)).toEqual(initialized);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a corrupt file without rewriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-corrupt-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const before = Buffer.from("Synthetic corrupt SQLite data.".repeat(200));
      await writeFile(databasePath, before);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => TorsorKernel.open({ databasePath, bootstrap })).toThrow();
        expect((await readFile(databasePath)).equals(before)).toBe(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["partial", "missing-index", "future"])("does not checkpoint or repair a crashed %s WAL database on refusal", async (layout) => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-wal-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const child = spawnSync(process.execPath, [
        fileURLToPath(new URL("./fixtures/schema-wal-crash.mjs", import.meta.url)),
        databasePath, layout,
      ], { encoding: "utf8", timeout: 10_000 });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(77);
      const before = await readFile(databasePath);
      const wal = await readFile(`${databasePath}-wal`);
      expect(wal.length).toBeGreaterThan(0);
      const logical = logicalSnapshot(databasePath);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => TorsorKernel.open({ databasePath, bootstrap }).close()).toThrow();
        expect((await readFile(databasePath)).equals(before)).toBe(true);
        expect((await readFile(`${databasePath}-wal`)).equals(wal)).toBe(true);
        expect(logicalSnapshot(databasePath)).toEqual(logical);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("initializes and reopens schema 16 with causal, Artifact and physical execution contracts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-contract-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      TorsorKernel.open({ databasePath, bootstrap }).close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
        expect(database.prepare("PRAGMA table_info(worktree_executions)").all().map((row) => row.name))
          .toEqual(expect.arrayContaining(["activation_id", "generation", "fencing_token", "authority_revoked_at"]));
        expect(database.prepare("SELECT identity FROM worktree_storage_identity").get()?.identity)
          .toMatch(/^[a-f0-9]{64}$/);
        expect(database.prepare("SELECT * FROM causal_limits").all()).toEqual([{
          singleton: 1, max_depth: 4, max_non_terminal_runs_per_root: 50,
        }]);
        const runColumns = database.prepare("PRAGMA table_info(runs)").all().map((row) => row.name);
        expect(runColumns).toEqual(expect.arrayContaining([
          "causal_root_id", "parent_attention_id", "parent_run_id", "delegation_depth",
        ]));
        const artifactColumns = database.prepare("PRAGMA table_info(artifacts)").all().map((row) => row.name);
        expect(artifactColumns).toEqual(expect.arrayContaining([
          "content_digest", "producer_run_id", "producer_activation_id",
          "producer_thread_root_id", "byte_length", "visibility_channel_id",
        ]));
        expect(artifactColumns).not.toContain("storage_location");
        const schema = database.prepare("SELECT name, sql FROM sqlite_master WHERE name IN (?, ?, ?)")
          .all("runs_causal_provenance_immutable", "runs_causal_nonterminal_idx", "artifacts");
        expect(schema.find((row) => row.name === "runs_causal_provenance_immutable")?.sql)
          .toContain("Run causal provenance is immutable");
        expect(schema.find((row) => row.name === "runs_causal_nonterminal_idx")?.sql)
          .toContain("WHERE state NOT IN ('Completed', 'Failed', 'Cancelled')");
        expect(schema.find((row) => row.name === "artifacts")?.sql)
          .toContain("CHECK (byte_length >= 0 AND byte_length <= 1048576)");
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
      TorsorKernel.open({ databasePath }).close();
      TorsorKernel.open({
        databasePath, causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 50 },
      }).close();
      expect(() => TorsorKernel.open({
        databasePath, causalLimits: { maxDepth: 4, maxNonTerminalRunsPerRoot: 51 },
      })).toThrow("Configured causal limits differ from the durable database configuration");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["causal-only", "artifact-only"])(
    "rejects %s schema 14 before DDL/bootstrap without altering its bytes",
    async (layout) => {
      const directory = await mkdtemp(join(tmpdir(), "torsor-schema-14-"));
      const databasePath = join(directory, "legacy.sqlite");
      try {
        const database = new DatabaseSync(databasePath);
        // Representative data from each incompatible version-14 contract.
        database.exec(layout === "causal-only" ? `
          CREATE TABLE causal_limits (singleton INTEGER PRIMARY KEY, max_depth INTEGER, max_non_terminal_runs_per_root INTEGER);
          INSERT INTO causal_limits VALUES (1, 4, 50);
          CREATE TABLE runs (id TEXT PRIMARY KEY, causal_root_id TEXT, parent_attention_id TEXT, parent_run_id TEXT, delegation_depth INTEGER);
          INSERT INTO runs VALUES ('run-sample', 'message-root', 'attention-sample', NULL, 0);
          CREATE TABLE artifacts (id TEXT PRIMARY KEY, storage_location TEXT);
          INSERT INTO artifacts VALUES ('artifact-sample', 'local://synthetic-report');
        ` : `
          CREATE TABLE runs (id TEXT PRIMARY KEY);
          INSERT INTO runs VALUES ('run-sample');
          CREATE TABLE artifacts (id TEXT PRIMARY KEY, producer_run_id TEXT, producer_thread_root_id TEXT, byte_length INTEGER);
          INSERT INTO artifacts VALUES ('artifact-sample', 'run-sample', 'message-root', 12);
        `);
        database.exec("PRAGMA user_version = 14");
        database.close();
        const before = await readFile(databasePath);
        const logical = logicalSnapshot(databasePath);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(() => TorsorKernel.open({ databasePath, bootstrap })).toThrow(
            "Incompatible development database schema version 14; expected 16. Stop old Torsor processes and recreate the disposable local database.",
          );
          expect((await readFile(databasePath)).equals(before)).toBe(true);
          expect(logicalSnapshot(databasePath)).toEqual(logical);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

function logicalSnapshot(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const objects = database.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all();
    const tables = objects.filter((object) => object.type === "table");
    return {
      version: database.prepare("PRAGMA user_version").get(),
      objects,
      rows: tables.map((table) => database.prepare(
        `SELECT * FROM "${String(table.name).replaceAll('"', '""')}"`,
      ).all()),
    };
  } finally {
    database.close();
  }
}
