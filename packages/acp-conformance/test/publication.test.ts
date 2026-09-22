import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../bin/acp-conformance.mjs", import.meta.url));
const example = fileURLToPath(new URL("../examples/basic.json", import.meta.url));
const preload = new URL("./fixtures/publication-barrier.mjs", import.meta.url).href;

function start(directory: string, phase?: string) {
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  let output = "";
  const args = [...(phase ? ["--import", preload] : []), cli, "run", example, "--out", directory];
  let child!: ReturnType<typeof execFile>;
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    child = execFile(process.execPath, args, {
      timeout: 40_000, maxBuffer: 65_536,
      env: { ...process.env, ACP_ARTIFACT_TEST_PHASE: phase },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? error.killed ? -1 : Number(error.code) : 0, stdout, stderr });
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(`PUBLICATION_BARRIER ${phase}\n`)) signal();
    });
  });
  return { child, done, reached };
}

async function paused(directory: string, phase: string) {
  const run = start(directory, phase);
  await Promise.race([
    run.reached,
    run.done.then((result) => { throw new Error(`CLI exited before ${phase}: ${result.stderr}`); }),
  ]);
  return run;
}

async function interrupt(directory: string, phase: string) {
  const run = await paused(directory, phase);
  run.child.kill("SIGKILL");
  await run.done;
}

async function bundle(directory: string) {
  const root = join(directory, "basic.artifacts");
  expect((await readdir(root)).sort()).toEqual(["manifest.json", "result.json", "transcript.jsonl"]);
  expect(JSON.parse(await readFile(join(root, "result.json"), "utf8")).status).toBe("passed");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  expect(Object.keys(manifest).sort()).toEqual(["commitId", "files", "id", "kind", "schemaVersion"]);
  expect(manifest).toMatchObject({ schemaVersion: 1, kind: "acp-artifact-bundle", id: "basic" });
  expect(manifest.commitId).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.keys(manifest.files).sort()).toEqual(["result.json", "transcript.jsonl"]);
  for (const name of ["result.json", "transcript.jsonl"]) {
    const bytes = await readFile(join(root, name));
    expect(manifest.files[name]).toEqual({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  expect(JSON.stringify(manifest)).not.toContain(directory);
  return readFile(join(root, "transcript.jsonl"), "utf8");
}

async function attempt(directory: string) {
  const name = (await readdir(directory)).find((entry) => entry.startsWith(".acp-artifact-"));
  expect(name).toBeDefined();
  return join(directory, name!);
}

describe("recoverable public CLI publication (spec section 2.1)", () => {
  it("permits an unmodified retry after termination following the first result reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-"));
    try {
      await interrupt(directory, "result-reserved");
      const retry = await start(directory).done;
      expect(retry.code, retry.stderr).toBe(0);
      await bundle(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    "stage-created", "claim-reserved", "claim-partial", "claim.json-durable",
    "result.json-durable", "transcript.jsonl-durable", "manifest.json-durable", "before-publish",
  ])("recovers a terminated %s attempt without exposing a partial bundle", async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-"));
    try {
      await interrupt(directory, phase);
      expect(await readdir(directory)).not.toContain("basic.artifacts");
      const stale = await attempt(directory);
      const retry = await start(directory).done;
      expect(retry.code, retry.stderr).toBe(0);
      await bundle(directory);
      if (["stage-created", "claim-reserved", "claim-partial"].includes(phase)) {
        expect(await readdir(stale)).toBeDefined();
        expect(retry.stderr).toContain("residue was preserved");
      } else {
        expect(await readdir(directory)).toEqual(["basic.artifacts"]);
      }
      expect(retry.stdout + retry.stderr).not.toContain(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["published", "claim.json-removed"])("preserves the committed bundle after interruption at %s", async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-committed-"));
    try {
      await interrupt(directory, phase);
      await bundle(directory);
      const manifestPath = join(directory, "basic.artifacts", "manifest.json");
      const before = await readFile(manifestPath, "utf8");
      const retry = await start(directory).done;
      expect(retry.code, retry.stderr).toBe(2);
      await bundle(directory);
      expect(await readFile(manifestPath, "utf8")).toBe(before);
      if (phase === "published") expect(await readdir(directory)).toEqual(["basic.artifacts"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not reclaim a live writer's locked attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-live-"));
    const live = await paused(directory, "claim.json-durable");
    try {
      const stage = await attempt(directory);
      const claim = await readFile(join(stage, "claim.json"), "utf8");
      const winner = await start(directory).done;
      expect(winner.code, winner.stderr).toBe(0);
      expect(await readFile(join(stage, "claim.json"), "utf8")).toBe(claim);
      expect(await readFile(join(stage, "bundle", "result.json"), "utf8")).toBe("");
      await bundle(directory);
    } finally {
      live.child.kill("SIGKILL");
      await live.done;
      try {
        expect((await start(directory).done).code).toBe(2);
        expect(await readdir(directory)).toEqual(["basic.artifacts"]);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

  it("serializes concurrent recoverers and lets only one new publisher commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-recoverers-"));
    try {
      await interrupt(directory, "result.json-durable");
      const one = start(directory);
      const two = start(directory);
      const outcomes = await Promise.all([one.done, two.done]);
      expect(outcomes.map((result) => result.code).sort(), JSON.stringify(outcomes)).toEqual([0, 2]);
      expect(await readdir(directory)).toEqual(["basic.artifacts"]);
      await bundle(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("commits exactly one of two writers coordinated immediately before native publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-race-"));
    const first = await paused(directory, "before-publish");
    let second: Awaited<ReturnType<typeof paused>> | undefined;
    try {
      second = await paused(directory, "before-publish");
      expect(await readdir(directory)).not.toContain("basic.artifacts");
      first.child.stdin!.end("continue");
      second.child.stdin!.end("continue");
      const results = await Promise.all([first.done, second.done]);
      expect(results.map((result) => result.code).sort(), JSON.stringify(results)).toEqual([0, 2]);
      expect(await readdir(directory)).toEqual(["basic.artifacts"]);
      await bundle(directory);
    } finally {
      first.child.kill("SIGKILL");
      second?.child.kill("SIGKILL");
      await first.done;
      await second?.done;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a genuine collision created after staging but before native publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-late-collision-"));
    const run = await paused(directory, "before-publish");
    try {
      const final = join(directory, "basic.artifacts");
      await mkdir(final);
      await writeFile(join(final, "user"), "synthetic-concurrent-file\n");
      run.child.stdin!.end("continue");
      expect((await run.done).code).toBe(2);
      expect(await readdir(directory)).toEqual(["basic.artifacts"]);
      expect(await readdir(final)).toEqual(["user"]);
      expect(await readFile(join(final, "user"), "utf8")).toBe("synthetic-concurrent-file\n");
    } finally {
      run.child.kill("SIGKILL");
      await run.done;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses publication and deletion of staging changed while its writer was live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-live-change-"));
    const run = await paused(directory, "manifest.json-durable");
    try {
      const foreign = join(await attempt(directory), "bundle", "user");
      await writeFile(foreign, "synthetic-concurrent-content\n");
      run.child.stdin!.end("continue");
      expect((await run.done).code).toBe(2);
      expect(await readdir(directory)).not.toContain("basic.artifacts");
      expect(await readFile(foreign, "utf8")).toBe("synthetic-concurrent-content\n");
      expect((await start(directory).done).code).toBe(0);
      expect(await readFile(foreign, "utf8")).toBe("synthetic-concurrent-content\n");
      await bundle(directory);
    } finally {
      run.child.kill("SIGKILL");
      await run.done;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes cleanup interrupted after removing the first staged file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-recovery-"));
    try {
      await interrupt(directory, "before-publish");
      await interrupt(directory, "result.json-removed");
      expect(await readdir(directory)).not.toContain("basic.artifacts");
      const retry = await start(directory).done;
      expect(retry.code, retry.stderr).toBe(0);
      expect(await readdir(directory)).toEqual(["basic.artifacts"]);
      await bundle(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["file", "empty-directory", "junction"])("never replaces a genuine final %s", async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-collision-"));
    const final = join(directory, "basic.artifacts");
    try {
      if (kind === "file") await writeFile(final, "synthetic-user-file\n");
      else if (kind === "empty-directory") await mkdir(final);
      else {
        const target = join(directory, "user-directory");
        await mkdir(target);
        await writeFile(join(target, "keep"), "synthetic-user-file\n");
        await symlink(target, final, process.platform === "win32" ? "junction" : "dir");
      }
      for (let count = 0; count < 2; count++) {
        const result = await start(directory).done;
        expect(result.code).toBe(2);
        expect(result.stderr).not.toContain(directory);
        expect((await readdir(directory)).filter((name) => name.startsWith(".acp-artifact-"))).toEqual([]);
        if (kind === "file") expect(await readFile(final, "utf8")).toBe("synthetic-user-file\n");
        else if (kind === "empty-directory") expect(await readdir(final)).toEqual([]);
        else expect(await readFile(join(final, "keep"), "utf8")).toBe("synthetic-user-file\n");
      }
      await rm(final, { recursive: true });
      expect((await start(directory).done).code).toBe(0);
      await bundle(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["malformed", "oversized", "unknown-version", "extra-field", "wrong-destination", "wrong-identity", "copied"])(
    "preserves a %s claim rather than trusting its name", async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "acp-publication-untrusted-"));
      try {
        await interrupt(directory, "before-publish");
        let stage = await attempt(directory);
        const claim = JSON.parse(await readFile(join(stage, "claim.json"), "utf8"));
        if (kind === "unknown-version") claim.schemaVersion = 99;
        if (kind === "extra-field") claim.unrecognized = true;
        if (kind === "wrong-destination") claim.destination = "../synthetic-user-directory";
        if (kind === "wrong-identity") claim.directory.ino = "1";
        if (kind === "copied") {
          claim.commitId = randomUUID();
          stage = join(directory, `.acp-artifact-basic-${claim.commitId}`);
          await mkdir(stage);
        }
        const content = kind === "malformed" ? "{" : kind === "oversized" ? "x".repeat(8193) : JSON.stringify(claim) + "\n";
        await writeFile(join(stage, "claim.json"), content);
        const retry = await start(directory).done;
        expect(retry.code, retry.stderr).toBe(0);
        expect(retry.stderr).toContain("residue was preserved");
        expect(await readFile(join(stage, "claim.json"), "utf8")).toBe(content);
        await bundle(directory);
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  );

  it.each(["extra-file", "replaced-file", "hardlink", "bundle-junction", "attempt-junction"])(
    "preserves %s staging and unrelated content", async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "acp-publication-foreign-"));
      try {
        await interrupt(directory, "before-publish");
        const stage = await attempt(directory);
        const sentinel = join(directory, "user-directory");
        await mkdir(sentinel);
        await writeFile(join(sentinel, "keep"), "synthetic-user-content\n");
        let foreign = join(stage, "bundle", "foreign");
        if (kind === "extra-file") await writeFile(foreign, "synthetic-user-content\n");
        if (kind === "replaced-file") {
          foreign = join(stage, "bundle", "result.json");
          await rename(foreign, join(sentinel, "original"));
          await writeFile(foreign, "synthetic-user-content\n");
        }
        if (kind === "hardlink") {
          foreign = join(sentinel, "alias");
          await link(join(stage, "bundle", "result.json"), foreign);
        }
        if (kind.endsWith("junction")) {
          const path = kind === "bundle-junction" ? join(stage, "bundle") : stage;
          await rm(path, { recursive: true });
          await symlink(sentinel, path, process.platform === "win32" ? "junction" : "dir");
          foreign = join(path, "keep");
        }
        const before = await readFile(foreign, "utf8");
        const retry = await start(directory).done;
        expect(retry.code, retry.stderr).toBe(0);
        expect(retry.stderr).toContain("residue was preserved");
        expect(await readFile(foreign, "utf8")).toBe(before);
        expect(await readFile(join(sentinel, "keep"), "utf8")).toBe("synthetic-user-content\n");
        await bundle(directory);
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  );

  it.each([
    "fail-claim.json", "fail-result.json", "fail-transcript.jsonl", "fail-manifest.json",
    "fail-sync-claim.json", "fail-sync-result.json", "fail-sync-manifest.json",
    "fail-close", "fail-publish", "fail-cleanup",
  ])(
    "reports sanitized %s errors and permits a clean retry", async (phase) => {
      const directory = await mkdtemp(join(tmpdir(), "acp-publication-io-"));
      try {
        const failed = await start(directory, phase).done;
        expect(failed.code).toBe(2);
        expect(failed.stdout + failed.stderr).not.toContain(directory);
        expect(failed.stdout + failed.stderr).not.toContain("synthetic-private-io-detail");
        expect(await readdir(directory)).not.toContain("basic.artifacts");
        const retry = await start(directory).done;
        expect(retry.code, retry.stderr).toBe(0);
        expect(await readdir(directory)).toEqual(["basic.artifacts"]);
        await bundle(directory);
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  );

  it("reports a committed outcome explicitly when post-publication cleanup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-publication-committed-io-"));
    try {
      const failed = await start(directory, "fail-committed-cleanup").done;
      expect(failed.code).toBe(2);
      expect(failed.stderr).toContain("Artifact bundle committed");
      expect(failed.stderr).not.toContain("synthetic-private-io-detail");
      const before = await bundle(directory);
      expect((await start(directory).done).code).toBe(2);
      expect(await bundle(directory)).toBe(before);
      expect(await readdir(directory)).toEqual(["basic.artifacts"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
