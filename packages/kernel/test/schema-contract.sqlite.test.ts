import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { TorsorKernel } from "../src/index.js";
import { bootstrap } from "./helpers.js";

describe("integrated schema contract (MVP 21.5, 23.1, 25.1-25.2)", () => {
  it("initializes and reopens schema 15 with both causal and trusted Artifact storage contracts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "torsor-schema-contract-"));
    const databasePath = join(directory, "kernel.sqlite");
    try {
      TorsorKernel.open({ databasePath, bootstrap }).close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
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
        expect(() => TorsorKernel.open({ databasePath, bootstrap })).toThrow(
          "Incompatible development database schema version 14; expected 15. Stop old Torsor processes and recreate the disposable local database.",
        );
        expect((await readFile(databasePath)).equals(before)).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
