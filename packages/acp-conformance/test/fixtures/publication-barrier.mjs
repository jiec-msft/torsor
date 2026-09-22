import { readSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import koffi from "koffi";

// Test-only preload: interrupt public CLI operations at filesystem boundaries.
// No production hook, sleep, provider change, or private harness import is needed.
const phase = process.env.ACP_ARTIFACT_TEST_PHASE;
const fault = () => Object.assign(new Error("synthetic-private-io-detail"), { code: "EIO" });
function barrier(name) {
  if (phase !== name) return;
  writeSync(1, `PUBLICATION_BARRIER ${name}\n`);
  if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("Publication barrier input closed.");
}

const open = fs.open;
fs.open = async function (path, ...args) {
  const handle = await open(path, ...args);
  const name = basename(String(path));
  if (String(args[0]).startsWith("wx")) {
    if (name.endsWith("result.json")) barrier("result-reserved");
    if (name === "claim.json") barrier("claim-reserved");
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      if (phase === `fail-sync-${name}`) throw fault();
      barrier(`${name}-durable`);
    };
    if (phase === `fail-${name}`) handle.writeFile = async () => { throw fault(); };
    if (name === "result.json" && phase === "fail-close") {
      const close = handle.close.bind(handle);
      let failed = false;
      handle.close = async () => {
        await close();
        if (!failed) { failed = true; throw fault(); }
      };
    }
    if (name === "claim.json" && phase === "claim-partial") {
      handle.writeFile = async (data) => {
        await handle.write(String(data).slice(0, 24));
        await sync();
        barrier("claim-partial");
      };
    }
  }
  return handle;
};
const mkdir = fs.mkdir;
fs.mkdir = async function (path, ...args) {
  const result = await mkdir(path, ...args);
  if (basename(String(path)).startsWith(".acp-artifact-")) barrier("stage-created");
  return result;
};
const unlink = fs.unlink;
fs.unlink = async function (path) {
  if (phase === "fail-cleanup" && basename(String(path)) === "result.json") throw fault();
  if (phase === "fail-committed-cleanup" && basename(String(path)) === "claim.json") throw fault();
  await unlink(path);
  barrier(`${basename(String(path))}-removed`);
};
syncBuiltinESMExports();

const load = koffi.load;
koffi.load = function (...args) {
  const library = load(...args);
  const func = library.func.bind(library);
  return { ...library, func(...declaration) {
    const native = func(...declaration);
    if (!/renameat2|MoveFileExW/.test(declaration.join(" "))) return native;
    return (...values) => {
      barrier("before-publish");
      if (phase === "fail-publish" || phase === "fail-cleanup") throw fault();
      const result = native(...values);
      if (process.platform === "win32" ? result !== 0 : result === 0) barrier("published");
      return result;
    };
  } };
};
