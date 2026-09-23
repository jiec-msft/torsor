import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  assert.equal(
    packageJson.scripts["dev:web"],
    "npm run dev --workspace @torsor/web --",
  );
  assert.equal(
    packageJson.scripts["preview:web"],
    "npm run preview --workspace @torsor/web --",
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
    assert.match(readme, /--shutdown-stdin/);
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
      assert.equal(
        hostProcess.process.child.spawnargs[
          hostProcess.process.child.spawnargs.indexOf("--port") + 1
        ],
        "0",
      );
      assert.ok(hostProcess.port > 0);
      const health = await fetchJson(`${hostProcess.origin}/health`);
      assert.deepEqual(health, { status: "ok" });
      await shutdownHostProcess(hostProcess);
      hostProcess = undefined;
    } finally {
      await forceStopManagedProcess(hostProcess?.process);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }
});

test("documented CLIs survive restart with Vite default ports occupied", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "torsor-quickstart-"));
  const directResult = join(stateDirectory, "direct-run.json");
  const proxyResult = join(stateDirectory, "proxy-run.json");
  const blockedVitePorts = [5173, 4173, 4174];
  const portBlockers = [];
  let hostProcess;
  let viteProcess;
  try {
    for (const port of blockedVitePorts) {
      const blocker = await occupyTcpPort(port);
      if (blocker) {
        portBlockers.push(blocker);
      }
    }

    hostProcess = await startHostCli(stateDirectory, "127.0.0.1");
    const completed = await runNodeCli(journeyCli, [
      "--origin",
      hostProcess.origin,
      "--result",
      directResult,
    ]);
    assert.match(completed, /Completed synthetic Run/);
    await shutdownHostProcess(hostProcess);
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

    viteProcess = await startWebWrapper("dev", hostProcess.origin);
    assert.ok(
      !blockedVitePorts.includes(Number(new URL(viteProcess.origin).port)),
    );
    await probeWebRoot(viteProcess.origin);
    const proxied = await runNodeCli(journeyCli, [
      "--origin",
      viteProcess.origin,
      "--result",
      proxyResult,
    ]);
    assert.match(proxied, /Completed synthetic Run/);
    await terminateWebWrapper(viteProcess);
    viteProcess = undefined;

    viteProcess = await startWebWrapper("preview", hostProcess.origin);
    assert.ok(
      !blockedVitePorts.includes(Number(new URL(viteProcess.origin).port)),
    );
    await probeWebRoot(viteProcess.origin);
    const previewVerified = await runNodeCli(journeyCli, [
      "--origin",
      viteProcess.origin,
      "--result",
      proxyResult,
      "--verify",
    ]);
    assert.match(previewVerified, /Verified synthetic Run/);
    await terminateWebWrapper(viteProcess);
    viteProcess = undefined;

    await shutdownHostProcess(hostProcess);
    hostProcess = undefined;
  } finally {
    await forceStopManagedProcess(viteProcess?.process);
    await forceStopManagedProcess(hostProcess?.process);
    await Promise.all(portBlockers.map(closeServer));
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("Web wrappers recover when an allocated port is taken before Vite binds", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "torsor-vite-race-"));
  const blocker = createTcpServer();
  let hostProcess;
  let viteProcess;
  try {
    await listen(blocker, 0, "127.0.0.1");
    const address = blocker.address();
    assert.ok(address && typeof address === "object");
    hostProcess = await startHostCli(stateDirectory, "127.0.0.1");
    for (const mode of ["dev", "preview"]) {
      viteProcess = await startWebWrapper(mode, hostProcess.origin, address.port);
      assert.notEqual(viteProcess.port, address.port);
      await probeWebRoot(viteProcess.origin);
      await terminateWebWrapper(viteProcess);
      viteProcess = undefined;
    }
    await shutdownHostProcess(hostProcess);
    hostProcess = undefined;
  } finally {
    await forceStopManagedProcess(viteProcess?.process);
    await forceStopManagedProcess(hostProcess?.process);
    await closeServer(blocker);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("bounded Web root probe aborts a hanging response and releases its port", async () => {
  let acceptRequest;
  const requestAccepted = new Promise((resolveRequest) => {
    acceptRequest = resolveRequest;
  });
  const server = createHttpServer(() => {
    acceptRequest();
  });
  await listen(server, 0, "127.0.0.1");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const probe = probeWebRoot(`http://127.0.0.1:${port}`, 250);
  try {
    await withTimeout(
      requestAccepted,
      1_000,
      "Hanging fixture did not accept the root request.",
    );
    await assert.rejects(
      probe,
      (error) => error?.name === "TimeoutError",
    );
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }

  const rebound = createTcpServer();
  try {
    await listen(rebound, port, "127.0.0.1");
  } finally {
    await closeServer(rebound);
  }
});

test("managed termination accepts only clean or SIGTERM exit forms", () => {
  assert.equal(isExpectedManagedTermination({ code: 0, signal: null }), true);
  assert.equal(
    isExpectedManagedTermination({ code: null, signal: "SIGTERM" }),
    true,
  );
  assert.equal(isExpectedManagedTermination({ code: 143, signal: null }), true);
  assert.equal(isExpectedManagedTermination({ code: 1, signal: null }), false);
  assert.equal(
    isExpectedManagedTermination({ code: null, signal: "SIGKILL" }),
    false,
  );
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

test("clean tracked source packs installable Kernel and agent-runtime tarballs", async () => {
  assert.ok(process.env.npm_execpath, "npm_execpath is required");
  const temporary = await mkdtemp(join(tmpdir(), "torsor-clean-pack-"));
  const source = join(temporary, "source");
  const consumer = join(temporary, "consumer");
  try {
    await mkdir(source, { recursive: true });
    const tracked = spawnSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "buffer",
      windowsHide: true,
    });
    assert.equal(tracked.status, 0, String(tracked.stderr || tracked.stdout));
    const files = tracked.stdout.toString("utf8").split("\0").filter(Boolean);
    await Promise.all(files.map(async (file) => {
      const destination = join(source, ...file.split("/"));
      await mkdir(resolve(destination, ".."), { recursive: true });
      await copyFile(join(root, ...file.split("/")), destination);
    }));
    await runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], source, 180_000);
    const kernelPack = JSON.parse(await runNpm(
      ["pack", "--json", "--workspace", "@torsor/kernel"],
      source,
      120_000,
    ))[0];
    const runtimePack = JSON.parse(await runNpm(
      ["pack", "--json", "--workspace", "@torsor/agent-runtime"],
      source,
      120_000,
    ))[0];
    assert.ok(kernelPack.files.some((file) => file.path === "dist/index.js"));
    assert.ok(runtimePack.files.some((file) => file.path === "dist/index.js"));
    assert.ok(runtimePack.files.some(
      (file) => file.path === "dist/provider-process-windows-owner.js",
    ));
    assert.ok(runtimePack.bundled?.includes("@torsor/operational-logging"));
    assert.ok(runtimePack.files.some(
      (file) =>
        file.path ===
        "node_modules/@torsor/operational-logging/dist/index.js",
    ));
    assert.ok(runtimePack.files.some(
      (file) =>
        file.path ===
        "node_modules/@torsor/operational-logging/LICENSE",
    ));
    assert.equal(runtimePack.files.some(
      (file) => file.path.startsWith("src/") ||
        file.path.startsWith("test/") ||
        file.path.includes("/src/") ||
        file.path.includes("/test/") ||
        file.path.endsWith(".node"),
    ), false);
    const kernelTarball = join(source, kernelPack.filename);
    const runtimeTarball = join(source, runtimePack.filename);
    await mkdir(consumer, { recursive: true });
    await runNpm(["init", "-y"], consumer, 30_000);
    await runNpm(
      [
        "install",
        "--no-audit",
        "--no-fund",
        kernelTarball,
        runtimeTarball,
      ],
      consumer,
      120_000,
    );
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "const runtime=await import('@torsor/agent-runtime');" +
          "if(typeof runtime.AgentRuntime!=='function')process.exit(17);",
      ],
      {
        cwd: consumer,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
    const installedRuntime = join(
      consumer, "node_modules", "@torsor", "agent-runtime",
    );
    const owner = join(installedRuntime, "dist", "provider-process-windows-owner.js");
    await access(owner);
    const runtimeManifest = JSON.parse(
      await readFile(join(installedRuntime, "package.json"), "utf8"),
    );
    assert.equal(runtimeManifest.dependencies.koffi, "3.2.0");
    const koffiManifest = JSON.parse(
      await readFile(join(consumer, "node_modules", "koffi", "package.json"), "utf8"),
    );
    assert.equal(koffiManifest.license, "MIT");
    if (process.platform === "win32") {
      const loaded = spawnSync(process.execPath, [owner], {
        cwd: consumer,
        input: Buffer.from([0xff, 0xff, 0x7f, 0x00]),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
      assert.equal(loaded.status, 125, loaded.stderr || loaded.stdout);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function runNpm(args, cwd, timeout) {
  const result = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [process.env.npm_execpath, ...args], {
      cwd,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.signal));
  return result.stdout;
}

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
      "--shutdown-stdin",
    ],
    { cwd: root, stdin: "pipe" },
  );
  try {
    const match = await managed.waitFor(
      /Torsor synthetic quickstart listening at (http:\/\/\S+)/,
      15_000,
    );
    const port = Number(new URL(match[1]).port);
    assert.ok(Number.isInteger(port) && port > 0);
    return { process: managed, origin: match[1], host, port };
  } catch (error) {
    await forceStopManagedProcess(managed);
    throw error;
  }
}

async function startWebWrapper(mode, proxyTarget, firstPort) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = attempt === 0 && firstPort !== undefined
      ? firstPort
      : await allocateTcpPort("127.0.0.1");
    try {
      return await startWebWrapperOnPort(mode, proxyTarget, port);
    } catch (error) {
      if (
        attempt === 2 ||
        !String(error).includes(`Error: Port ${port} is already in use`)
      ) {
        throw error;
      }
    }
  }
}

async function startWebWrapperOnPort(mode, proxyTarget, port) {
  assert.ok(process.env.npm_execpath, "npm_execpath is required");
  const script = mode === "preview" ? "preview:web" : "dev:web";
  const workspaceScript = mode === "preview" ? "preview" : "dev";
  const managed = startManagedProcess(
    process.execPath,
    [
      process.env.npm_execpath,
      "run",
      script,
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      processTree: true,
      env: {
        ...processEnv(),
        TORSOR_WEB_PROXY_TARGET: proxyTarget,
      },
    },
  );
  try {
    const match = await managed.waitFor(/Local:\s+(http:\/\/\S+)/, 15_000);
    const origin = match[1].replace(/\/$/, "");
    assert.match(
      managed.output,
      new RegExp(
        `> npm run ${workspaceScript} --workspace @torsor/web -- --host 127\\.0\\.0\\.1 --port ${port} --strictPort`,
      ),
    );
    assert.match(
      managed.output,
      new RegExp(
        `> vite${mode === "preview" ? " preview" : ""} --host 127\\.0\\.0\\.1 --port ${port} --strictPort`,
      ),
    );
    assert.equal(Number(new URL(origin).port), port);
    assert.deepEqual(await fetchJson(`${origin}/health`), { status: "ok" });
    return { process: managed, origin, host: "127.0.0.1", port };
  } catch (error) {
    await forceStopManagedProcess(managed);
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
    const result = await managed.waitForExit(30_000);
    assert.equal(
      result.code,
      0,
      `CLI failed with ${result.code ?? result.signal}:\n${managed.output}`,
    );
    return managed.output;
  } catch (error) {
    await forceStopManagedProcess(managed);
    throw error;
  }
}

function startManagedProcess(executable, arguments_, options) {
  const child = spawn(executable, arguments_, {
    cwd: options.cwd,
    env: options.env ?? processEnv(),
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
    detached: options.processTree && process.platform !== "win32",
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
    processTree: options.processTree ?? false,
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

async function shutdownHostProcess(hostProcess) {
  const { process, host, port } = hostProcess;
  assert.ok(process, "A running Host process is required.");
  assert.equal(process.child.exitCode, null, process.output);
  assert.equal(process.child.signalCode, null, process.output);
  assert.ok(process.child.stdin, "Host stdin must be piped.");
  process.child.stdin.end("shutdown\n");
  let result;
  try {
    result = await process.waitForExit(5_000);
  } catch (error) {
    await forceStopManagedProcess(process);
    throw error;
  }
  assert.equal(result.code, 0, process.output);
  assert.equal(result.signal, null, process.output);
  assert.match(
    process.output,
    /Torsor synthetic quickstart stopped cleanly/,
  );
  const releasedPort = createTcpServer();
  try {
    await listen(releasedPort, port, host);
  } finally {
    await closeServer(releasedPort);
  }
}

async function terminateManagedProcess(process) {
  assert.ok(process, "A managed process is required.");
  if (process.child.exitCode !== null || process.child.signalCode) {
    const result = await process.exit;
    assert.equal(result.code, 0, process.output);
    return;
  }
  assert.equal(signalManagedProcess(process, "SIGTERM"), true);
  let result;
  try {
    result = await process.waitForExit(5_000);
  } catch (error) {
    await forceStopManagedProcess(process);
    throw error;
  }
  assert.ok(
    isExpectedManagedTermination(result),
    `Unexpected managed-process exit ${result.code ?? result.signal}:\n${process.output}`,
  );
}

async function terminateWebWrapper(webProcess) {
  await terminateManagedProcess(webProcess.process);
  const releasedPort = createTcpServer();
  try {
    await listen(releasedPort, webProcess.port, webProcess.host);
  } finally {
    await closeServer(releasedPort);
  }
}

function isExpectedManagedTermination(result) {
  return (
    result.code === 0 ||
    result.signal === "SIGTERM" ||
    (result.code === 143 && result.signal === null)
  );
}

async function forceStopManagedProcess(process) {
  if (!process) {
    return;
  }
  if (
    !process.processTree &&
    (process.child.exitCode !== null || process.child.signalCode)
  ) {
    return;
  }
  signalManagedProcess(process, "SIGKILL");
  await withTimeout(
    process.exit,
    5_000,
    `Forced process-tree exit timed out:\n${process.output}`,
  );
}

function signalManagedProcess(managed, signal) {
  if (!managed.processTree) {
    return managed.child.kill(signal);
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-managed.child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  }

  const descendants = listWindowsDescendantProcessIds(managed.child.pid);
  const signaled = managed.child.kill(signal);
  for (const processId of descendants) {
    try {
      process.kill(processId, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
  return signaled;
}

function listWindowsDescendantProcessIds(rootProcessId) {
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    `Failed to inspect the managed process tree:\n${result.stderr}`,
  );
  const processes = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  const rows = Array.isArray(processes) ? processes : [processes];
  const descendants = [];
  const pending = [{ processId: rootProcessId, depth: 0 }];
  while (pending.length > 0) {
    const parent = pending.shift();
    for (const row of rows) {
      if (Number(row.ParentProcessId) !== parent.processId) {
        continue;
      }
      const child = {
        processId: Number(row.ProcessId),
        depth: parent.depth + 1,
      };
      descendants.push(child);
      pending.push(child);
    }
  }
  return descendants
    .sort((left, right) => right.depth - left.depth)
    .map(({ processId }) => processId);
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return response.json();
}

async function probeWebRoot(origin, timeoutMs = 5_000) {
  const url = `${origin}/`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  await response.text();
}

async function allocateTcpPort(host) {
  const server = createTcpServer();
  try {
    await listen(server, 0, host);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return address.port;
  } finally {
    await closeServer(server);
  }
}

async function occupyTcpPort(port) {
  const server = createTcpServer((socket) => socket.end());
  try {
    await listen(server, port, "127.0.0.1");
    return server;
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      return undefined;
    }
    throw error;
  }
}

function listen(server, port, host) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
      } else {
        resolveClose();
      }
    });
  });
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
