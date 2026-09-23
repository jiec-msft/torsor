import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = new URL("./trusted-local-smoke.mjs", import.meta.url);
const refusal = "Refusing real provider smoke: pass --allow-real-provider explicitly.\n";
const invalid = "Invalid smoke arguments. Use --help.\n";
const help = "Usage: npm run smoke:copilot -- --allow-real-provider\n"
  + "Runs real Copilot with native tools and explicit allow-all in a disposable synthetic repository.\n"
  + "May use network, provider credentials, configured MCP, and custom instructions.\n"
  + "Torsor is not an OS sandbox; provider-owned sessions may remain outside its cleanup.\n"
  + "Without --allow-real-provider, no resources or provider environment are accessed.\n";

function invoke(args) {
  const harness = `
    import fs from "node:fs";
    import fsp from "node:fs/promises";
    import cp from "node:child_process";
    import os from "node:os";
    import { syncBuiltinESMExports } from "node:module";
    const source = fs.readFileSync(${JSON.stringify(fileURLToPath(cli))}, "utf8");
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    const execute = new AsyncFunction(source);
    void process.stdout;
    void process.stderr;
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))}, ...${JSON.stringify(args)}];
    const forbidden = () => { throw new Error("Smoke gate accessed a forbidden resource."); };
    for (const name of ["mkdir", "mkdtemp", "rm", "writeFile", "appendFile", "open", "readFile", "readdir", "stat", "access"]) {
      if (name in fs) fs[name] = forbidden;
      if (name + "Sync" in fs) fs[name + "Sync"] = forbidden;
      if (name in fsp) fsp[name] = forbidden;
    }
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[name] = forbidden;
    os.tmpdir = forbidden;
    os.homedir = forbidden;
    syncBuiltinESMExports();
    Object.defineProperty(process, "env", { get: forbidden });
    await execute();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", harness], {
    env: {},
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("missing explicit opt-in refuses before environment, storage, Git, or provider access", () => {
  assert.deepEqual(invoke([]), { status: 2, stdout: "", stderr: refusal });
});

test("help is safe even when combined with real-provider opt-in", () => {
  for (const args of [["--help"], ["--allow-real-provider", "--help"], ["--help", "--allow-real-provider"]]) {
    assert.deepEqual(invoke(args), { status: 0, stdout: help, stderr: "" });
  }
});

test("near-miss and unknown flags cannot imply consent or expose their values", () => {
  for (const args of [
    ["--allow-real-provider=true"],
    ["--allow-real-provider", "--synthetic-private-value"],
    ["--allow-real-provider", "--allow-real-provider"],
  ]) {
    assert.deepEqual(invoke(args), { status: 2, stdout: "", stderr: invalid });
  }
});
