import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hostCli = join(root, "examples", "working-quickstart", "host.mjs");
const journeyCli = join(
  root,
  "examples",
  "working-quickstart",
  "http-journey.mjs",
);
const viteCli = join(root, "node_modules", "vite", "bin", "vite.js");
const acpCli = join(
  root,
  "packages",
  "acp-conformance",
  "bin",
  "acp-conformance.mjs",
);
const acpBasicScenario = "packages/acp-conformance/examples/basic.json";
const webRoot = join(root, "apps", "web");

test("public quickstart files and root commands stay complete", async () => {
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

  const [packageJson, webPackageJson] = await Promise.all([
    readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(join(webRoot, "package.json"), "utf8").then(JSON.parse),
  ]);
  for (const script of [
    "quickstart:host",
    "quickstart:http",
    "test:quickstart",
    "dev:web",
    "preview:web",
  ]) {
    assert.equal(typeof packageJson.scripts[script], "string");
  }
  assert.match(
    packageJson.scripts["quickstart:host"],
    /node examples\/working-quickstart\/host\.mjs/,
  );
  assert.equal(
    packageJson.scripts["quickstart:http"],
    "node examples/working-quickstart/http-journey.mjs",
  );
  assert.equal(packageJson.scripts["dev:web"], "npm run dev --workspace @torsor/web");
  assert.equal(
    packageJson.scripts["preview:web"],
    "npm run preview --workspace @torsor/web",
  );
  assert.equal(webPackageJson.scripts.dev, "vite");
  assert.equal(webPackageJson.scripts.preview, "vite preview");

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
      "packages/acp-conformance/examples/basic.json",
    ]) {
      assert.match(readme, new RegExp(escapeRegExp(command)));
    }
    assert.doesNotMatch(readme, /packages\\acp-conformance/);
    assert.match(readme, /127\.0\.0\.1/);
    assert.match(readme, /::1/);
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

test("Host CLI rejects wildcard, non-loopback, and hostname binds before startup", async () => {
  for (const host of ["0.0.0.0", "::", "192.0.2.1", "localhost"]) {
    const parent = await mkdtemp(join(tmpdir(), "torsor-host-rejection-"));
    const stateDirectory = join(parent, "state");
    try {
      const result = spawnSync(
        process.execPath,
        [
          hostCli,
          "--state-dir",
          stateDirectory,
          "--host",
          host,
          "--port",
          "0",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 5_000,
          windowsHide: true,
        },
      );
      assert.equal(result.status, 1, result.stdout || result.stderr);
      assert.match(
        result.stderr,
        /--host must be the loopback literal 127\.0\.0\.1 or ::1\./,
      );
      await assert.rejects(access(stateDirectory), { code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test("Host CLI accepts the documented IPv4 and IPv6 loopback literals", async () => {
  for (const host of ["127.0.0.1", "::1"]) {
    const stateDirectory = await mkdtemp(join(tmpdir(), "torsor-loopback-"));
    let hostProcess;
    try {
      hostProcess = await startHostCli(stateDirectory, host);
      const health = await fetchJson(`${hostProcess.origin}/health`);
      assert.deepEqual(health, { status: "ok" });
    } finally {
      await stopManagedProcess(hostProcess?.process);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }
});

test("documented Host and HTTP CLIs survive restart through Vite dev and preview proxies", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "torsor-quickstart-"));
  const directResult = join(stateDirectory, "direct-run.json");
  const proxyResult = join(stateDirectory, "proxy-run.json");
  let hostProcess;
  let viteProcess;
  try {
    hostProcess = await startHostCli(stateDirectory, "127.0.0.1");
    const completed = await runNodeCli(journeyCli, [
      "--origin",
      hostProcess.origin,
      "--result",
      directResult,
    ]);
    assert.match(completed, /Completed synthetic Run/);
    await stopManagedProcess(hostProcess.process);
    hostProcess = undefined;

    hostProcess = await startHostCli(stateDirectory, "127.0.0.1");
    const verified = await runNodeCli(journeyCli, [
      "--origin",
      hostProcess.origin,
      "--result",
      directResult,
      "--verify",
    ]);
    assert.match(verified, /Verified synthetic Run/);

    viteProcess = await startVite("dev", hostProcess.origin);
    assert.equal((await fetch(`${viteProcess.origin}/`)).status, 200);
    const proxied = await runNodeCli(journeyCli, [
      "--origin",
      viteProcess.origin,
      "--result",
      proxyResult,
    ]);
    assert.match(proxied, /Completed synthetic Run/);
    await stopManagedProcess(viteProcess.process);
    viteProcess = undefined;

    viteProcess = await startVite("preview", hostProcess.origin);
    assert.equal((await fetch(`${viteProcess.origin}/`)).status, 200);
    const previewVerified = await runNodeCli(journeyCli, [
      "--origin",
      viteProcess.origin,
      "--result",
      proxyResult,
      "--verify",
    ]);
    assert.match(previewVerified, /Verified synthetic Run/);
  } finally {
    await stopManagedProcess(viteProcess?.process);
    await stopManagedProcess(hostProcess?.process);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("documented ACP mock accepts the portable scenario path without credentials", async () => {
  const output = await runNodeCli(acpCli, ["mock", acpBasicScenario]);
  assert.equal(output.trim(), "");
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
        windowsHide: true,
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

async function startHostCli(stateDirectory, host) {
  const managed = startManagedProcess(
    process.execPath,
    [
      hostCli,
      "--state-dir",
      stateDirectory,
      "--host",
      host,
      "--port",
      "0",
    ],
    { cwd: root },
  );
  try {
    const match = await managed.waitFor(
      /Torsor synthetic quickstart listening at (http:\/\/\S+)/,
      15_000,
    );
    return { process: managed, origin: match[1] };
  } catch (error) {
    await stopManagedProcess(managed);
    throw error;
  }
}

async function startVite(mode, proxyTarget) {
  const managed = startManagedProcess(
    process.execPath,
    [
      viteCli,
      ...(mode === "preview" ? ["preview"] : []),
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--strictPort",
    ],
    {
      cwd: webRoot,
      env: {
        ...processEnv(),
        TORSOR_WEB_PROXY_TARGET: proxyTarget,
      },
    },
  );
  try {
    const match = await managed.waitFor(/Local:\s+(http:\/\/\S+)/, 15_000);
    const origin = match[1].replace(/\/$/, "");
    assert.deepEqual(await fetchJson(`${origin}/health`), { status: "ok" });
    return { process: managed, origin };
  } catch (error) {
    await stopManagedProcess(managed);
    throw error;
  }
}

async function runNodeCli(script, arguments_) {
  const managed = startManagedProcess(
    process.execPath,
    [script, ...arguments_],
    { cwd: root },
  );
  try {
    const result = await managed.waitForExit(15_000);
    assert.equal(
      result.code,
      0,
      `CLI failed with ${result.code ?? result.signal}:\n${managed.output}`,
    );
    return managed.output;
  } catch (error) {
    await stopManagedProcess(managed);
    throw error;
  }
}

function startManagedProcess(executable, arguments_, options) {
  const child = spawn(executable, arguments_, {
    cwd: options.cwd,
    env: options.env ?? processEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const waiters = new Set();
  const append = (chunk) => {
    output += stripAnsi(String(chunk));
    for (const waiter of [...waiters]) {
      const match = output.match(waiter.pattern);
      if (match) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(match);
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  exit.then(
    (result) => {
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(
          new Error(
            `Process exited with ${result.code ?? result.signal} before readiness:\n${output}`,
          ),
        );
      }
    },
    (error) => {
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(error);
      }
    },
  );

  return {
    child,
    exit,
    get output() {
      return output;
    },
    waitFor(pattern, timeoutMs) {
      const existing = output.match(pattern);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolveMatch, rejectMatch) => {
        const waiter = {
          pattern,
          resolve: resolveMatch,
          reject: rejectMatch,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            rejectMatch(
              new Error(`Process readiness timed out after ${timeoutMs} ms:\n${output}`),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async waitForExit(timeoutMs) {
      const result = await withTimeout(
        exit,
        timeoutMs,
        `Process exit timed out after ${timeoutMs} ms:\n${output}`,
      );
      return result;
    },
  };
}

async function stopManagedProcess(process) {
  if (!process || process.child.exitCode !== null || process.child.signalCode) {
    return;
  }
  process.child.kill("SIGTERM");
  try {
    await process.waitForExit(5_000);
  } catch {
    process.child.kill("SIGKILL");
    await process.exit;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return response.json();
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function processEnv() {
  return { ...process.env };
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
