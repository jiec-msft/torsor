import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createQuickstartHost,
  defaultQuickstartStateDirectory,
  repositoryRoot,
} from "../examples/working-quickstart/host.mjs";
import { runQuickstartJourney } from "../examples/working-quickstart/http-journey.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("public quickstart files and root commands stay complete", async () => {
  assert.equal(repositoryRoot, root);
  assert.equal(
    defaultQuickstartStateDirectory,
    join(root, ".torsor", "quickstart"),
  );
  const bootstrap = JSON.parse(
    await readFile(join(root, "examples", "working-quickstart", "bootstrap.json")),
  );
  assert.deepEqual(
    bootstrap.principals.map((principal) => principal.kind).sort(),
    ["agent", "human", "runtime"],
  );
  assert.equal(bootstrap.projects.length, 1);
  assert.equal(bootstrap.channels[0].projectId, bootstrap.projects[0].id);
  assert.equal(bootstrap.agents[0].principalId, "principal-orbit");
  assert.equal(bootstrap.agents[0].projectId, bootstrap.projects[0].id);

  const packageJson = JSON.parse(await readFile(join(root, "package.json")));
  for (const script of [
    "quickstart:host",
    "quickstart:http",
    "test:quickstart",
    "dev:web",
    "preview:web",
  ]) {
    assert.equal(typeof packageJson.scripts[script], "string");
  }

  const [english, chinese, serverReadme, webReadme] = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "README.zh-cn.md"), "utf8"),
    readFile(join(root, "apps", "server", "README.md"), "utf8"),
    readFile(join(root, "apps", "web", "README.md"), "utf8"),
  ]);
  for (const readme of [english, chinese]) {
    for (const command of [
      "npm ci",
      "npm run test:quickstart",
      "npm run ci",
      "npm run quickstart:host",
      "npm run quickstart:http",
      "npm run dev:web",
      "npm run preview:web",
      "acp-conformance mock",
    ]) {
      assert.match(readme, new RegExp(escapeRegExp(command)));
    }
  }
  assert.match(
    serverReadme,
    /apps\/server` as their current\s+working directory/i,
  );
  assert.match(serverReadme, /Join-Path \$repoRoot/);
  assert.match(serverReadme, /\/health/);
  assert.match(serverReadme, /X-Torsor-CSRF/);
  assert.match(webReadme, /local static preview/i);
  assert.match(webReadme, /not a production reverse proxy/i);
});

test("synthetic HTTP journey completes and remains durable after restart", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "torsor-quickstart-"));
  const resultPath = join(stateDirectory, "last-run.json");
  let running;
  try {
    running = await createQuickstartHost({ stateDirectory, port: 0 });
    const origin = await running.host.start();
    const completed = await runQuickstartJourney({ origin, resultPath });
    assert.ok(completed.elapsedMs < 5_000);
    await running.host.close();
    running = undefined;

    running = await createQuickstartHost({ stateDirectory, port: 0 });
    const restartedOrigin = await running.host.start();
    const verified = await runQuickstartJourney({
      origin: restartedOrigin,
      resultPath,
      verifyOnly: true,
    });
    assert.equal(verified.threadRootId, completed.threadRootId);
    assert.equal(verified.runId, completed.runId);
  } finally {
    await running?.host.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("public package tarballs contain the repository Apache license", async () => {
  const expectedLicense = await readFile(join(root, "LICENSE"));
  for (const workspace of [
    "@torsor/kernel",
    "@torsor/agent-runtime",
    "@torsor/acp-conformance",
  ]) {
    const packageDirectory = workspace.slice("@torsor/".length);
    assert.deepEqual(
      await readFile(join(root, "packages", packageDirectory, "LICENSE")),
      expectedLicense,
    );
    assert.ok(process.env.npm_execpath, "npm_execpath is required");
    const packed = spawnSync(
      process.execPath,
      [
        process.env.npm_execpath,
        "pack",
        "--dry-run",
        "--json",
        "--workspace",
        workspace,
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const manifest = JSON.parse(packed.stdout);
    assert.ok(
      manifest[0].files.some((file) => file.path === "LICENSE"),
      `${workspace} tarball omitted LICENSE`,
    );
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
